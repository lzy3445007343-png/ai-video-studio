"use strict";

/* =====================================================================
 * timeline.js —— 时间轴渲染（Step 1d 拆 JS：从 工作台v0.8时间轴.html 拆出，纯搬移不改逻辑）
 * 职责：时间轴几何/渲染（forEachSeg/contentWidth/buildTracks/segGeom/makeSeg/renderTimeline/
 *       positionPlayhead/seekPlayhead/drawAllWaves）。
 * 依赖：store.js（Store/$）+ player.js 变量（isPlaying 等，运行时）；引用主 script 的
 *      renderMedia/dragGhost/ensurePlayheadVisible/updateKfLiveValues（运行时调用）。
 * 加载顺序：store.js → media.js → player.js → timeline.js → HTML 主 script。
 * ===================================================================== */

function forEachSeg(fn) {
  // X 模型：遍历 main/overlay/audio 全部段（fn(seg, type, ti, idx)），ti = 该类型内序号（video 覆盖轨从 1 起）
  const d = Store.state.draft;
  const main = (d.main && typeof d.main === "object") ? (d.main.segs || []) : [];
  main.forEach((s, idx) => fn(s, "video", 0, idx));
  const typeCount = {};
  (Array.isArray(d.overlay) ? d.overlay : []).forEach(tr => {
    if (!tr || !Array.isArray(tr.segs)) return;
    const type = tr.type || "video";
    typeCount[type] = (typeCount[type] || 0) + 1;
    const ti = (type === "video") ? typeCount[type] : (typeCount[type] - 1);
    tr.segs.forEach((s, idx) => fn(s, type, ti, idx));
  });
  (Array.isArray(d.audio) ? d.audio : []).forEach((a, ti) => {
    if (a && typeof a === "object") (a.segs || []).forEach((s, idx) => fn(s, "audio", ti, idx));
  });
}

// UI 对齐 OpenCut 标尺（2026-08-16 两级刻度版）：label 主刻度（120px 间隔带文字）+ tick 细分刻度（18px 间隔）
// 算法对齐 OpenCut ruler-utils.ts：findOptimalInterval 取满足最小像素间距的最密档。
const RULER_LABEL_MULT = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]; // 秒
const RULER_TICK_DIV = [10, 5, 4, 2, 1];  // tick = label / 10 / 5 / 4 / 2 / 1（保证整除，label 永远落在 tick 上）
function _findRulerInterval(p, minPx, mults) {
  for (const m of mults) { if (p * m >= minPx) return m; }
  return mults[mults.length - 1];
}
function rulerConfig(p) {
  const labelInterval = _findRulerInterval(p, 120, RULER_LABEL_MULT);
  let tickInterval = labelInterval;
  for (const d of RULER_TICK_DIV) {
    const c = labelInterval / d;
    if (p * c >= 18) { tickInterval = c; break; }
  }
  return { labelInterval, tickInterval };
}
// 渲染两级刻度：细刻度 .tick.minor（无文字）+ 主刻度 .tick.major（带 mm:ss 文字）
function renderRuler(p, totalSec) {
  const ruler = document.getElementById("ruler");
  if (!ruler) return;
  const { labelInterval, tickInterval } = rulerConfig(p);
  ruler.innerHTML = "";
  const n = Math.ceil(totalSec / tickInterval) + 1;
  for (let i = 0; i <= n; i++) {
    const t = i * tickInterval;
    const isLabel = Math.abs(t / labelInterval - Math.round(t / labelInterval)) < 1e-6;
    const tick = document.createElement("div");
    tick.className = isLabel ? "tick major" : "tick minor";
    tick.style.left = (t * p) + "px";
    if (isLabel) tick.innerHTML = "<span>" + rulerLabel(t * 1e6, p) + "</span>";
    ruler.appendChild(tick);
  }
}
function rulerLabel(us, p) {
  const s = us / 1e6, m = Math.floor(s / 60), sec = s - m * 60;
  if (p >= 500) return String(m).padStart(2, "0") + ":" + sec.toFixed(3).padStart(6, "0");
  return String(m).padStart(2, "0") + ":" + String(Math.round(sec)).padStart(2, "0");
}
function contentWidth() {
  let maxUs = 10e6;
  forEachSeg(s => { const end = s.start + s.duration; if (end > maxUs) maxUs = end; });
  // 特效段也可能比视频长（如整片调整层），纳入内容宽度计算，避免条被裁到画布外
  (Array.isArray(Store.state.draft.overlay) ? Store.state.draft.overlay : []).forEach(tr => {
    if (!tr || tr.type !== "effect" || !Array.isArray(tr.segs)) return;
    tr.segs.forEach(s => {
      const end = s.start + s.duration; if (end > maxUs) maxUs = end;
    });
  });
  return Math.max((maxUs / 1e6) * pps() + 200, $("tlScroll").clientWidth);
}
function buildTracks() {
  // X 模型（2026-08-18 用户拍板，对齐 OpenCut SceneTracks）：
  //   draft.overlay = 混排池 [{type, segs}, ...]，数组顺序即 z 序（0=最顶）
  //   draft.main = 主场景 {segs}（恒定，只装 video/image）
  //   draft.audio = [{segs}, ...]
  // 外部命令仍用 (type, ti) 语义：ti = 该类型内序号（video 覆盖轨 ti 从 1 起，0=主场景）。
  const d = Store.state.draft, out = [];
  const overlay = Array.isArray(d.overlay) ? d.overlay : [];
  // overlay 直映（数组顺序 = z 序，不需要 layer_order 排序）
  const counters = {};
  for (const tr of overlay) {
    if (!tr || !Array.isArray(tr.segs)) continue;
    const type = tr.type || "video";
    const cnt = (counters[type] || 0) + 1;
    counters[type] = cnt;
    const ti = (type === "video") ? cnt : (cnt - 1);   // video 覆盖轨 ti 从 1 起
    const labelBy = { text: "文本轨", sticker: "贴纸轨", effect: "特效轨", video: "叠加" };
    // A2（2026-08-19）：轨带稳定 tid（来自草稿轨 dict，A1 后端已生成）——提交命令可用 tid 定位目标轨
    out.push({ type: type, ti: ti, label: (labelBy[type] || type) + cnt, segs: tr.segs, oi: out.length, tid: tr.tid });
  }
  // 主场景恒在 overlay 之下（恒定，video ti=0）
  const main = (d.main && typeof d.main === "object") ? (d.main.segs || []) : [];
  out.push({ type: "video", ti: 0, label: "主场景", segs: main, main: true, tid: (d.main && d.main.tid) });
  // audio 恒在底部
  const a = Array.isArray(d.audio) ? d.audio : [];
  for (let i = 0; i < a.length; i++) {
    const segs = (a[i] && typeof a[i] === "object") ? (a[i].segs || []) : [];
    out.push({ type: "audio", ti: i, label: "音轨" + (i + 1), segs: segs, tid: (a[i] && a[i].tid) });
  }
  return out;
}
/* overlay 区轨数（主场景之前的所有轨）= overlay 数组长度 */
function overlayCount() {
  const tracks = buildTracks();
  const mi = tracks.findIndex(t => t.type === "video" && t.ti === 0);
  return mi >= 0 ? mi : tracks.length;
}

/* X 模型段列表定位：(type, ti) → segs 数组（不存在返回 null；video ti=0 → main） */
function draftSegs(type, ti) {
  const d = Store.state.draft;
  if (type === "audio") {
    const a = (Array.isArray(d.audio) ? d.audio : [])[ti];
    return (a && typeof a === "object") ? (a.segs || []) : null;
  }
  if (type === "video" && ti === 0) {
    const m = d.main;
    return (m && typeof m === "object") ? (m.segs || []) : [];
  }
  const overlay = Array.isArray(d.overlay) ? d.overlay : [];
  let cnt = 0;
  const target = (type === "video") ? (ti - 1) : ti;
  for (let i = 0; i < overlay.length; i++) {
    if ((overlay[i] || {}).type === type) {
      if (cnt === target) return (overlay[i].segs || []);
      cnt++;
    }
  }
  return null;
}

/* A 方案（2026-08-18）：按稳定段 id 全草稿定位段（main/overlay/audio）——不受 ti 漂移影响 */
function segById(segid) {
  if (!segid) return null;
  const d = Store.state.draft;
  const main = (d.main && typeof d.main === "object") ? (d.main.segs || []) : [];
  for (const s of main) if (s && s.id === segid) return s;
  for (const tr of (Array.isArray(d.overlay) ? d.overlay : [])) {
    if (!tr || !Array.isArray(tr.segs)) continue;
    for (const s of tr.segs) if (s && s.id === segid) return s;
  }
  for (const a of (Array.isArray(d.audio) ? d.audio : [])) {
    if (a && typeof a === "object") for (const s of (a.segs || [])) if (s && s.id === segid) return s;
  }
  return null;
}

/* X 模型轨道 meta 定位：(type, ti) → _track_meta 里对应 dict（video ti=0→main，video ti>=1→overlay 第 ti-1 条 video 轨） */
function trackMeta(type, ti) {
  const meta = Store.state.draft._track_meta || {};
  if (type === "audio") return (meta.audio || [])[ti] || {};
  if (type === "video" && ti === 0) return meta.main || {};
  const overlay = Store.state.draft.overlay || [];
  let cnt = 0;
  const target = (type === "video") ? (ti - 1) : ti;
  for (let i = 0; i < overlay.length; i++) {
    if ((overlay[i] || {}).type === type) {
      if (cnt === target) return (meta.overlay || [])[i] || {};
      cnt++;
    }
  }
  return {};
}

/* ============ 统一落点模型（对齐 OpenCut resolveTrackPlacement） ============
   单一 displayIndex 真源：buildTracks() 返回的数组下标，0=最顶层，依次向下。
   所有拖拽落点 / 新建轨 / 预览注入，先算 displayIndex，再映射回各类型数据索引。
   关键不变量：预览（targetDisplayIndex）+ 落点线（computeDrop 输出）+ 后端实际插入（dataInsertIndex→_insert_track）严格同源，
   保证「预览 / 落点 / 实际三位一体」。 */

function trackElOf(tr) {
  // 由 display track 反查 DOM .track（按 type+ti 唯一定位，避免依赖渲染顺序）
  return document.querySelector('#tlContent .track[data-type="' + tr.type + '"][data-ti="' + tr.ti + '"]');
}

function dragTypeBlock(dragType) {
  // 拖拽类型能落入的「已有同类型轨」集合
  if (dragType === "video") return ["video"];
  if (dragType === "audio") return ["audio"];
  if (dragType === "text") return ["text"];
  if (dragType === "effect") return ["effect"];
  if (dragType === "sticker") return ["sticker"];
  return ["video"];
}

/* 新建轨解析（X 模型 2026-08-18：overlay 数组顺序即 z 序）
   direction: "above"/"below"（新轨在 preferredDisplay 轨的上方/下方）
   preferredDisplay: 命中轨的 displayIndex（buildTracks 全数组下标）
   → insertIndex = overlay 数组下标（= overlay 区 displayIndex），直接传给后端 _insert_track。
   预览（displayIndex）/ 落位（dataInsertIndex）/ 后端插入严格同源——不再需要视频组倒序换算。
   audio 特殊：新建音轨 append 到 audio 数组末尾（dataInsertIndex=null → 后端 _ensure_track(-1)）。 */
function resolveNewDrop(direction, preferredDisplay, tracks, dragType) {
  if (dragType === "audio") {
    return { kind: "new", type: "audio", displayIndex: 999, dataTi: null, dataInsertIndex: null, insertPosition: direction, targetExisting: false };
  }
  const oCount = overlayCount();
  const rawIns = direction === "above" ? preferredDisplay : preferredDisplay + 1;
  const insertIndex = Math.max(0, Math.min(rawIns, oCount));
  return {
    kind: "new", type: dragType,
    displayIndex: insertIndex, dataTi: null, dataInsertIndex: insertIndex,
    insertPosition: direction, targetExisting: false,
  };
}

/* ============ 统一落点模型（OpenCut 风格 drag direction 归属间隙） ============
   verticalDragDirection: "up" | "down" | null（库拖入用 dragstartY vs 当前 Y 算出；轴内移动同理）
   atTimeUs: 落点时间位（库拖入 = clientX 换算；轴内移动 = d.curLeftUs）。库拖入 + 落点
              已被占用 → 不弹到该轨末尾，改为「新建同类型轨预览」（2026-08-18 用户要求）。
   isLibrary: 库拖入为 true（做落点冲突检测）；轴内移动为 false（同轨挪动不误判）。
   间隙归属：
   - up    → 间隙归属上方轨（i）       → "above" preferredDisplay i
   - down  → 间隙归属下方轨（i+1）     → "below" preferredDisplay i+1
   - null  → 默认 up 语义（保留兼容）
   所有轨之上/之下：固定 above/below（与拖动方向无关）
   reorder 已撤（2026-08-18 用户拍板）：拖已有段命中不兼容已有轨 = 新建同类型轨预览（夹到
   两条轨中间），不再做 z 序重排——预览/落位/后端插入严格同源。 */
function computeDrop(e, dragType, verticalDragDirection, atTimeUs, isLibrary, excludeSegId) {
  verticalDragDirection = verticalDragDirection || null;
  isLibrary = !!isLibrary;
  const tracks = buildTracks();
  const block = dragTypeBlock(dragType);
  const y = e.clientY;
  // 1) 命中某条已有轨
  let insideIdx = -1;
  for (let i = 0; i < tracks.length; i++) {
    const el = trackElOf(tracks[i]);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom) { insideIdx = i; break; }
  }
  if (insideIdx >= 0) {
    const t = tracks[insideIdx];
    // D1（2026-08-19）：主场景（video ti=0）= 普通视频轨，素材可自由拖入/拖出（OpenCut 同款）。
    // 不再禁止并入——之前"主场景恒定=禁入"是需求理解偏差，用户要的是"永远存在但不拦素材"。
    if (block.includes(t.type)) {
      // 库拖入 + 目标轨隐藏（hidden）→ 不落隐藏轨（否则段不可见，用户以为"松手后没了"），改新建同类型轨
      if (isLibrary && trackMeta(t.type, t.ti).hidden) {
        const el = trackElOf(t);
        const r = el.getBoundingClientRect();
        const topHalf = (y < r.top + r.height / 2);
        return resolveNewDrop(topHalf ? "above" : "below", insideIdx, tracks, dragType);
      }
      // D2（2026-08-19）：落点被占用 → 新建同类型轨（OpenCut canPlaceTimeSpansOnTrack 语义）。
      // 库拖入 & 已有段拖动都检测（之前只有库拖入检测；已有段直接 existing 导致重叠落位观感乱）。
      // excludeSegId = 被拖段自身（同轨移动时不算占用）。
      if (atTimeUs != null && trackBusyAt(t, atTimeUs, excludeSegId)) {
        const el = trackElOf(t);
        const r = el.getBoundingClientRect();
        const topHalf = (y < r.top + r.height / 2);
        return resolveNewDrop(topHalf ? "above" : "below", insideIdx, tracks, dragType);
      }
      return {
        kind: "existing", type: t.type,
        displayIndex: insideIdx, dataTi: t.ti, dataInsertIndex: null,
        insertPosition: null, targetExisting: true,
      };
    }
    // 落在不兼容的已有轨：统一「新建同类型轨预览」（库拖入 & 轴内移动都走 new，夹到目标位）
    const el = trackElOf(t);
    const r = el.getBoundingClientRect();
    const topHalf = (y < r.top + r.height / 2);
    return resolveNewDrop(topHalf ? "above" : "below", insideIdx, tracks, dragType);
  }
  // 2) 所有轨之上 / 之下
  if (tracks.length === 0) {
    // 空时间轴：第一个目标轨固定 above（主场景之上）
    return resolveNewDrop("above", 0, tracks, dragType);
  }
  const firstR = trackElOf(tracks[0]).getBoundingClientRect();
  const lastR = trackElOf(tracks[tracks.length - 1]).getBoundingClientRect();
  if (y < firstR.top) {
    // 所有轨之上：固定 above（最顶位置新建）
    return resolveNewDrop("above", 0, tracks, dragType);
  }
  if (y > lastR.bottom) {
    // 所有轨之下：固定 below（最底位置新建）
    return resolveNewDrop("below", tracks.length - 1, tracks, dragType);
  }
  // 3) 两条轨之间的间隙：按 verticalDragDirection 归属上/下轨（OpenCut 同款）
  for (let i = 0; i < tracks.length - 1; i++) {
    const a = trackElOf(tracks[i]).getBoundingClientRect();
    const b = trackElOf(tracks[i + 1]).getBoundingClientRect();
    if (y > a.bottom && y < b.top) {
      let direction, preferredDisplay;
      if (verticalDragDirection === "up") {
        direction = "above";
        preferredDisplay = i;       // 归属上方轨
      } else if (verticalDragDirection === "down") {
        direction = "below";
        preferredDisplay = i + 1;   // 归属下方轨
      } else {
        // 拖动方向未知：回退到"above preferredDisplay i"（向上默认，与旧行为兼容）
        direction = "above";
        preferredDisplay = i;
      }
      return resolveNewDrop(direction, preferredDisplay, tracks, dragType);
    }
  }
  return resolveNewDrop("below", tracks.length - 1, tracks, dragType);
}

function displayRowCenterY(displayIndex) {
  // 库拖入时把「新建轨道」提示定位到目标显示行的垂直中心
  const tracks = buildTracks();
  if (tracks.length === 0) return 60;
  if (displayIndex <= 0) { const r = trackElOf(tracks[0]).getBoundingClientRect(); return r.top + r.height / 2; }
  if (displayIndex >= tracks.length) { const r = trackElOf(tracks[tracks.length - 1]).getBoundingClientRect(); return r.bottom + 18; }
  const r = trackElOf(tracks[displayIndex]).getBoundingClientRect();
  return r.top + r.height / 2;
}

/* D4（2026-08-19）：目标轨顶部 Y（OpenCut getDropLineY 同款——蓝线画在目标轨顶部，不画中心）。
   displayIndex 为 buildTracks 输出下标；越界时取首/末轨边界。 */
function displayRowTopY(displayIndex) {
  const tracks = buildTracks();
  if (tracks.length === 0) return 40;
  if (displayIndex <= 0) { const r = trackElOf(tracks[0]).getBoundingClientRect(); return r.top; }
  if (displayIndex >= tracks.length) { const r = trackElOf(tracks[tracks.length - 1]).getBoundingClientRect(); return r.bottom + 4; }
  const r = trackElOf(tracks[displayIndex]).getBoundingClientRect();
  return r.top;
}

/* A3（2026-08-19）：(type, ti) → 轨道稳定 tid（buildTracks 轨的 tid；找不到返回 null） */
function trackTidOf(type, ti) {
  const tr = buildTracks().find(t => t.type === type && t.ti === ti);
  return tr ? (tr.tid || null) : null;
}

/* 落点冲突检测：该轨在 atTimeUs 处是否已有素材覆盖（库拖入不弹末尾，改新建轨） */
function trackBusyAt(track, atTimeUs, excludeSegId) {
  const segs = track.segs || [];
  for (const s of segs) {
    if (excludeSegId && s.id === excludeSegId) continue;  // 被拖段自身不算占用（同轨移动）
    if (atTimeUs >= s.start && atTimeUs < s.start + s.duration) return true;
  }
  return false;
}

// 片段几何：优先用拖拽临时态，否则用草稿真实位置
// A 方案（2026-08-18）：被拖段匹配改用稳定段 id（d.segId === s.id），不再依赖 key 的 ti（折叠后 ti 会漂移）
function segGeom(s, type, ti, idx) {
  let leftUs = s.start, rightUs = s.start + s.duration;
  const d = Store.state.drag;
  const k = type + ":" + ti + ":" + idx;
  const isDraggingSeg = d && d.segId && s.id && d.segId === s.id;
  if (isDraggingSeg && d.moved) {
    if (d.mode === "move") { leftUs = d.curLeftUs; rightUs = d.curLeftUs + s.duration; } // 移动：保持时长，仅平移
    else if (d.mode === "resize") { if (d.side === "left") leftUs = d.curLeftUs; else rightUs = d.curRightUs; }
  }
  // 整组缩放预览：以 pivot 为不动边，按 factor 缩放选中段的位置与时长
  const gs = Store.state.groupScale;
  if (gs && Store.state.selectedKeys.includes(k)) {
    const ns = gs.pivot + (leftUs - gs.pivot) * gs.factor;
    leftUs = ns; rightUs = ns + s.duration * gs.factor;
  } else if (d && d.isGroup && d.moved && d.mode === "move" && Store.state.selectedKeys.includes(k) && !isDraggingSeg) {
    // 整组移动预览：非锚点段横向跟随锚点的 dUs（保持相对布局）
    leftUs = s.start + d.groupDeltaUs; rightUs = leftUs + s.duration;
  }
  return { leftUs, widthUs: rightUs - leftUs };
}
function makeSeg(s, type, ti, idx, overrideLeftUs, forceDragging) {
  const key = type + ":" + ti + ":" + idx;
  const g = segGeom(s, type, ti, idx);
  const leftUs = (overrideLeftUs != null) ? overrideLeftUs : g.leftUs;
  const dragging = !!forceDragging || (Store.state.drag && Store.state.drag.mode === "move" && Store.state.drag.moved && Store.state.drag.segId && s.id && Store.state.drag.segId === s.id);
  const seg = document.createElement("div");
  const isSel = (Store.state.selectedSegId && s.id && Store.state.selectedSegId === s.id) || Store.state.selectedKeys.includes(key);
  seg.className = "seg" + (type === "effect" ? " effect" : "") + (isSel ? " sel" : "") + (dragging ? " dragging" : "");
  seg.dataset.key = key;
  seg.dataset.segid = s.id || "";   // A 方案：DOM 也带稳定段 id，拖动定位不依赖 ti
  seg.dataset.leftUs = leftUs;        // 缩放重定位用：存原始时间值，避免播放期重建 timeline DOM
  seg.dataset.widthUs = g.widthUs;
  seg.style.left = (leftUs / 1e6 * pps()) + "px";
  seg.style.width = Math.max(8, g.widthUs / 1e6 * pps()) + "px";
  // 视频/图片：OpenCut 同款胶片条平铺——单张缩略图按 16:9 瓦片横向 repeat-x，
  // 叠一层 repeating-linear-gradient 画出瓦片间的暗缝，让它明确读作「一排连续小图」而非一张拉宽图。
  // 瓦片高度 = 片段实际高度（轨道高 - 上下 4px 内边距），宽度 = 高 × 16/9，随轨道高度自适应。
  let bgStyle = "";      // 背景样式字符串（放入 div.fill 的 style）
  let waveCanvas = "";   // 波形 canvas（替代 div.fill）
  const th = TRACK_H - 8;   // 片段可视高度 = 轨道高 - 上下各 4px 内边距
  const tileW = th * 16 / 9;
  if (type === "video" || type === "image") {
    // 视频段需要显式缩略图（抽帧 jpg），不能 fallback 到视频源文件本身：
    // CSS background-image 不会用视频文件渲染，fallback 到 path 只会导致黑底。
    let raw = type === "image" ? s.path : (Store.state.thumbMap[s.path] || "");
    const bg = raw ? fileURL(raw) : "";
    if (bg) {
      bgStyle =
        "background-image:url('" + bg + "'), repeating-linear-gradient(to right, transparent, transparent calc(" + tileW + "px - 1px), rgba(0,0,0,.30) calc(" + tileW + "px - 1px), rgba(0,0,0,.30) " + tileW + "px);" +
        "background-size:" + tileW + "px " + th + "px, " + tileW + "px " + th + "px;" +
        "background-repeat:repeat-x, repeat-x;background-position:left center, left center;";
    } else {
      // 无缩略图时仍走 tile 平铺（暗缝 + 平铺底色）——保留「胶片条」视觉，而非整块色块
      bgStyle =
        "background-image:repeating-linear-gradient(to right, " + getCssVar("--seg-video") + " 0px, " + getCssVar("--seg-video") + " calc(" + tileW + "px - 1px), rgba(0,0,0,.35) calc(" + tileW + "px - 1px), rgba(0,0,0,.35) " + tileW + "px);" +
        "background-size:" + tileW + "px " + th + "px;" +
        "background-repeat:repeat-x;background-position:left center;";
    }
  } else if (type === "audio") {
    // 有峰值数据 → 用 canvas 画真实波形（OpenCut 同款：bar 宽 1px + 间隙 1px、上下对称）；否则降级为色块
    const peaks = Store.state.waveMap[s.path];
    if (peaks && peaks.length) {
      // 波形必须按源素材区间 [src_start, src_end] 绘制：split/trim 后 start 会变，但峰值数组始终对应原素材 0s 起点。
      // 2026-08-17 根治：src_end 推导（防 trim 脏 src_end 导致波形被拉伸——用户实测"拉长后波形只是拉伸"）
      const srcStartUs = s.src_start || 0;
      const srcEndUs = deriveSrcEndUs(srcStartUs, s.duration || 0, s.speed || 1);
      const srcDurSec = Math.max(0.001, (srcEndUs - srcStartUs) / 1e6);
      waveCanvas = '<canvas class="fill wave" data-path="' + (s.path || "") + '" data-src-start="' + srcStartUs + '" data-src-end="' + srcEndUs + '" data-dur="' + srcDurSec + '"></canvas>';
    } else {
      bgStyle = "background:" + getCssVar("--seg-audio");
    }
  }
  else if (type === "text") bgStyle = "background:" + getCssVar("--seg-text");
  else if (type === "sticker") {
    const bg = s.path ? fileURL(s.path) : "";
    if (bg) {
      bgStyle = "background-image:url('" + bg + "'); background-size:contain; background-position:center; background-repeat:no-repeat;";
    } else {
      bgStyle = "background:" + getCssVar("--seg-text");
    }
  } else if (type === "effect") {
    bgStyle = "background:" + getCssVar("--seg-effect");
  }
  let headerTxt;
  if (type === "effect") {
    // 头部显示「特效类型 · 作用目标」：调整层=盖整栈；clip=绑某素材段
    const tgt = (s.target && s.target.type === "adjustment") ? "调整层"
              : (s.target && s.target.type === "clip") ? ("片段" + (s.target.ti || 0) + ":" + (s.target.si || 0))
              : (s.target && s.target.type === "track") ? ("轨" + (s.target.ti || 0)) : "全局";
    headerTxt = "✦ " + (s.name || s.effect_type || "特效") + " · " + tgt;
  } else {
    headerTxt = type === "text" ? (s.text || s.name || "文本") : (s.name || "");
  }
  const speedBadge = (s.speed && s.speed !== 1) ? ('<div class="speed-badge">' + s.speed + 'x</div>') : '';
  const stBadge = (type === "sticker") ? '<div class="badge">贴</div>' : '';
  const fillHtml = waveCanvas || ('<div class="fill" style="' + bgStyle + '"></div>');
  // 关键帧 marker（2026-08-20，对齐 OpenCut timeline-element.tsx KeyframeIndicator：白色菱形选中变蓝）
  // 遍历所有动画通道，按 key.time 在段内绝对定位一个 8x8 菱形（钳制 0..duration 防溢出，seg overflow:hidden 会裁切段外的）
  let kfMarkersHtml = "";
  if (s.animations) {
    const durSec = (s.duration || 0) / 1e6;
    for (const path in s.animations) {
      const ch = s.animations[path];
      if (!ch || !ch.keys || !ch.keys.length) continue;
      for (const k of ch.keys) {
        const tSec = Math.max(0, Math.min(durSec, (k.time || 0) / 1e6));
        const xPx = tSec * pps();
        kfMarkersHtml += '<div class="kf-marker" data-path="' + path + '" data-kftime="' + (k.time || 0) + '" style="left:' + xPx + 'px"></div>';
      }
    }
  }
  seg.innerHTML =
    fillHtml +
    kfMarkersHtml +
    '<div class="hdr">' + headerTxt + '</div>' +
    speedBadge + stBadge +
    (key === Store.state.selectedKey ? '<div class="handle l"></div><div class="handle r"></div>' : '');
  return seg;
}
function renderTimeline(s) {
  const content = $("tlContent"), labels = $("tlLabels"), ruler = $("ruler");
  const scrollWrap = $("tlScroll");
  // 销毁前记住滚动位置，避免 refresh() 重绘后弹回顶部/左侧
  const savedTop = scrollWrap.scrollTop;
  const savedLeft = scrollWrap.scrollLeft;
  // 销毁旧片段/轨道/标签（标尺/播放头/落点线常驻，不碰）
  [...content.querySelectorAll(".track, .seg")].forEach(e => e.remove());
  [...labels.querySelectorAll(".track-label")].forEach(e => e.remove());

  const w = contentWidth();
  content.style.width = w + "px";
  ruler.style.width = w + "px";
  ruler.innerHTML = "";
  const totalSec = w / pps();
  renderRuler(pps(), totalSec);
  // 书签标记（对齐 OpenCut bookmarks.tsx：标尺顶部小红旗，点击跳转、双击切换、右键删除）
  (Store.state.bookmarks || []).forEach(b => {
    const bm = document.createElement("div");
    bm.className = "bm-mark";
    bm.style.left = (b.us / 1e6 * pps()) + "px";
    bm.dataset.us = b.us;
    bm.title = (b.name || "书签") + " · " + usToTime(b.us);
    ruler.appendChild(bm);
  });
  // 拖拽中：被拖段实时显示在目标位置（OpenCut previewElements 语义——段跟手，无虚线预览轨）
  const drag = Store.state.drag;
  const isMove = drag && drag.mode === "move" && drag.moved;
  const dragKey = isMove ? drag.key : null;
  const targetType = isMove ? drag.type : null;
  const targetTi = isMove ? ((drag.targetKind === "existing") ? drag.targetDataTi : null) : null;
  // 构建待渲染轨道列表（overlay 直映：叠加→主轨→音频）
  const tracks = buildTracks();
  // D3（2026-08-19）：无「预览轨道」弹动（OpenCut 同款）——段跟手 + 落点线即可。
  // new（拖到间隙/空白）= 被拖段留在源轨跟手 X，DragLine 横线指示新轨 Y；松手才新建轨。
  tracks.forEach(tr => {
    const label = document.createElement("div");
    label.className = "track-label";
    label.dataset.type = tr.type; label.dataset.ti = tr.ti;
    const m = trackMeta(tr.type, tr.ti);
    const showMute = tr.type === "video" || tr.type === "audio";
    const showHide = tr.type === "video" || tr.type === "text" || tr.type === "sticker" || tr.type === "effect";
    let icons = "";
    if (showMute) {
      const on = !m.muted;
      icons += '<span class="icon' + (on ? "" : " off") + '" data-act="mute" title="静音/取消静音">' + (on ? "🔊" : "🔇") + '</span>';
    }
    if (showHide) {
      const on = !m.hidden;
      icons += '<span class="icon' + (on ? "" : " off") + '" data-act="hide" title="显示/隐藏">' + (on ? "👁" : "🚫") + '</span>';
    }
    // 轨道锁定（2026-08-16 对齐 OpenCut TrackLabelsPanel lock）：锁定的轨禁止编辑
    icons += '<span class="icon' + (m.locked ? " off" : "") + '" data-act="lock" title="锁定/解锁轨道（锁定后禁止编辑该轨）">' + (m.locked ? "🔒" : "🔓") + '</span>';
    label.innerHTML = icons + '<span class="name">' + tr.label + '</span>';
    labels.appendChild(label);
    const track = document.createElement("div");
    track.className = "track";
    track.dataset.type = tr.type; track.dataset.ti = tr.ti;
    if (m.hidden) track.classList.add("track-hidden");
    if (m.muted && (tr.type === "audio" || tr.type === "video")) track.classList.add("track-muted");
    if (isMove && targetType && targetTi != null && tr.type === targetType && tr.ti === targetTi) track.classList.add("drop-target");
    let childCount = 0;
    // 被拖段显示位置（OpenCut previewElements）：existing → 目标轨；new → 留在源轨跟手 X（落点线指示新轨 Y）
    // A 方案：用稳定段 id 定位被拖段（drag.segId），不依赖 key 的 ti
    if (isMove && targetType && targetTi != null && tr.type === targetType && tr.ti === targetTi) {
      const ds = segById(drag.segId);
      if (ds) { track.appendChild(makeSeg(ds, drag.type, drag.ti, drag.idx, drag.curLeftUs, true)); childCount++; }
    }
    tr.segs.forEach((seg, idx) => {
      // 源轨跳过被拖段：仅 existing（段已实时显示在目标轨）；new（新建轨）段留在源轨跟手 X
      if (isMove && drag.segId && seg.id && drag.segId === seg.id && drag.targetKind === "existing") return;
      track.appendChild(makeSeg(seg, tr.type, tr.ti, idx));
      childCount++;
    });
    if (!childCount) { const hEl = document.createElement("div"); hEl.className = "empty-hint"; track.appendChild(hEl); }
    content.appendChild(track);
  });
  // 移动预览：蓝色落点竖线（X 时间位）+ new 时 DragLine 横线（新轨目标 Y 位置）；拖动结束清理残留
  if (isMove) {
    const line = $("dropLine");
    line.style.display = "";
    line.style.left = (drag.curLeftUs / 1e6 * pps()) + "px";
    if (drag.targetKind === "new" && typeof drag.targetDisplayIndex === "number") {
      showDragLine(displayRowTopY(drag.targetDisplayIndex));   // D4：落点线在目标轨顶部（OpenCut getDropLineY）
    } else {
      hideDragLine();
    }
  } else {
    hideDragLine();
    const line = $("dropLine");
    if (line) line.style.display = "none";
   
  }
  positionPlayhead();
  drawAllWaves();
  requestAnimationFrame(drawAllWaves);   // 兜底：同步布局尚未完成时，下一帧再画一次
  // 重绘完成后恢复滚动位置，并与左侧标签锁定
  scrollWrap.scrollTop = savedTop;
  scrollWrap.scrollLeft = savedLeft;
  // 水平滚动条只出现在右侧 tlScroll 底部，左侧 labels 需补一个等高的 spacer 放在 label 列表末尾（底部填充），
  // 才能让 labels 与 content 的垂直滚动范围完全一致，且轨道行与右侧一一对齐（对齐 OpenCut TrackLabelsPanel）。
  // 注意：spacer 绝不能放在 label 列表「前面」，否则会给所有轨道整体下移一个滚动条高度，导致上下错位。
  const scrollbarH = scrollWrap.offsetHeight - scrollWrap.clientHeight;
  const spacer = $("labelScrollbarSpacer");
  if (spacer) {
    labels.appendChild(spacer); // 移到 label 列表之后，作为底部填充
    spacer.style.height = (scrollbarH > 0 ? scrollbarH : 0) + "px";
  }
  labels.scrollTop = savedTop;
  renderGroupBox();   // 选中≥1 段时绘制整组缩放包围盒（含左右把手）
}
function positionPlayhead() { $("playhead").style.left = (Store.state.playheadUs / 1e6 * pps()) + "px"; ensurePlayheadVisible(); if (!isPlaying) updateKfLiveValues(); }
// 播放头导航统一入口：clamp 到 [0, 总时长] 后改 Store 并立即重绘蓝线+时间码（对齐 OpenCut playback.seek）。
// 播放头是纯前端状态，不进草稿、不被 get_state 轮询覆盖，故导航只需改 Store；无需后端 set_playhead。
function seekPlayhead(us) {
  const max = totalDurationUs();
  const clamped = Math.max(0, Math.min(max, Math.round(us)));
  Store.set({ playheadUs: clamped });
  positionPlayhead(); renderTimecode();
  if (!isPlaying) applyKfLiveAll();   // 拖动播放头时实时刷新关键帧动画
  else { playStartUs = clamped; playStartWall = performance.now(); }   // Step5：播放中拖拽重锚墙钟，修 Bug B 回弹（下一帧 wallUs≈clamped，不再被旧锚点覆盖）
}

// 音频波形绘制：对齐 OpenCut audio-waveform.tsx（bar 宽 1px + 间隙 1px、上下对称、按振幅×高度）。
// 后端已算好每秒 WAVE_DENSITY 个 RMS 振幅点，前端按像素密度把每个 bar 覆盖的时间区间取最大振幅画竖条；
// 缩放时 pxPerSec 变化、bar 数变化，但振幅点不变 → 波形始终清晰。
const WAVE_DENSITY = 60; // 与后端 _extract_audio_peaks(density=60) 对齐
const WAVE_GAIN = 0.70;  // 最响的 bar 只用到轨道高度的 70%，留出上下边距，避免实心块
function drawAllWaves() {
  const canvases = document.querySelectorAll("#tlContent canvas.wave");
  const MAX = 16000;  // 浏览器 canvas 缓冲区硬上限（约 16384px）。超长片段若不钳制，
                      // c.width 超限后浏览器只渲染前面能容纳的部分 → 波形「前面有、后面断」。
                      // 钳制后整段 peaks 重采样进缓冲区，再由 CSS 拉伸到片段真实宽度显示（对齐 OpenCut 只绘可视区的效果）。
  const dpr = window.devicePixelRatio || 1;
  canvases.forEach(c => {
    const peaks = Store.state.waveMap[c.dataset.path];
    const w = c.clientWidth, h = c.clientHeight;
    if (!peaks || !peaks.length || w <= 0 || h <= 0) return;
    const dur = parseFloat(c.dataset.dur) || 1;
    const srcStartUs = parseFloat(c.dataset.srcStart) || 0;
    const srcEndUs = parseFloat(c.dataset.srcEnd) || (srcStartUs + dur * 1e6);
    const srcDur = Math.max(0.001, (srcEndUs - srcStartUs) / 1e6); // 实际用于映射 peaks 的源素材时长
    let bufW = Math.round(w * dpr);
    if (bufW > MAX) bufW = MAX;          // 关键：超长片段钳制缓冲区宽度
    let bufH = Math.round(h * dpr);
    if (c.width !== bufW) c.width = bufW;
    if (c.height !== bufH) c.height = bufH;
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);  // 直接用设备像素坐标绘制
    ctx.clearRect(0, 0, bufW, bufH);
    const color = getCssVar("--wave");
    ctx.fillStyle = color;
    const barStep = 2;                    // 每 2 缓冲区像素一个 bar（对齐 OpenCut BAR_STEP=2）
    const bars = Math.max(1, Math.floor(bufW / barStep));
    for (let i = 0; i < bars; i++) {
      const bx = i * barStep;
      // 把缓冲区坐标换算成「源素材内时间」（秒），再映射到 peaks 索引 → split/trim 后波形仍对齐真实音频内容
      const t0 = srcStartUs / 1e6 + (bx / bufW) * srcDur;
      const t1 = srcStartUs / 1e6 + ((i + 1) * barStep / bufW) * srcDur;
      let i0 = Math.floor(t0 * WAVE_DENSITY);
      let i1 = Math.floor(t1 * WAVE_DENSITY);
      if (i0 < 0) i0 = 0;
      if (i1 >= peaks.length) i1 = peaks.length - 1;
      if (i1 < i0) i1 = i0;
      let v = 0;
      for (let j = i0; j <= i1; j++) if (peaks[j] > v) v = peaks[j]; // 取区间最大，避免漏掉鼓点/峰值
      const barH = v * WAVE_GAIN * bufH;
      if (barH < 1) continue;
      const by = (bufH - barH) / 2;       // 上下对称
      ctx.fillRect(bx, by, 1, barH);
    }
    // 中线：让波形对称感更明显，也更能看出强弱起伏
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, bufH / 2 - 0.5, bufW, 1);
  });
}
