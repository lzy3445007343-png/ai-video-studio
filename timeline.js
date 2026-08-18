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
  const d = Store.state.draft;
  ["video", "audio", "text"].forEach(type => {
    (d[type] || []).forEach((segs, ti) => segs.forEach((s, idx) => fn(s, type, ti, idx)));
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
  (Store.state.draft.effect || []).forEach(track => (track || []).forEach(s => {
    const end = s.start + s.duration; if (end > maxUs) maxUs = end;
  }));
  return Math.max((maxUs / 1e6) * pps() + 200, $("tlScroll").clientWidth);
}
function buildTracks() {
  // 对齐 OpenCut 的轨道显示顺序：overlay(叠加) 在上、main(主场景) 居中、audio/text 在下。
  // 注意：video 数据数组里 video[0] 永远是主轨（后端 _insert_track 保护，不允许插到主轨之上）；
  // 因此「拖视频到主轨上方」= 在数据索引 1 处新建覆盖轨，渲染时画到主轨之上。
  const d = Store.state.draft, out = [];
  // 剪映层级约定：文本/贴纸/特效 在最上层（盖住视频），视频居中，音频最下。
  // 这里只调整「时间轴轨道的显示顺序」，不影响预览 z 序（预览里文本 zIndex 已恒高于视频）。
  const t = d.text || [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] && t[i].length > 0) out.push({ type: "text", ti: i, label: "文本轨" + (i + 1), segs: t[i] });
  }
  // 贴纸轨：显示在文本轨之下、视频轨之上（与预览 z 序一致：文本 > 贴纸 > 视频）
  const st = d.sticker || [];
  for (let i = 0; i < st.length; i++) {
    if (st[i] && st[i].length > 0) out.push({ type: "sticker", ti: i, label: "贴纸轨" + (i + 1), segs: st[i] });
  }
  // 特效轨：显示在贴纸轨之下、视频轨之上（特效是盖在素材上的图层，时间轴顺序与预览 z 序一致：文本>贴纸>特效>视频）
  // 恒显示（至少第 0 轨）：否则空轨时不渲染特效轨 DOM，用户既看不到也拖不进特效
  const ef = d.effect || [];
  const efLanes = ef.length || 1;
  for (let i = 0; i < efLanes; i++) {
    out.push({ type: "effect", ti: i, label: "特效轨" + (i + 1), segs: ef[i] || [] });
  }
  const v = d.video || [];
  // 先叠加轨(i>0，仅非空显示，高索引在上)，再主轨(i=0，恒显示)
  for (let i = v.length - 1; i >= 1; i--) {
    if (v[i] && v[i].length > 0) out.push({ type: "video", ti: i, label: "叠加" + i, segs: v[i] });
  }
  out.push({ type: "video", ti: 0, label: "主场景", segs: (v[0] || []) });
  const a = d.audio || [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] && a[i].length > 0) out.push({ type: "audio", ti: i, label: "音轨" + (i + 1), segs: a[i] });
  }
  return out;
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

function typeGroupRange(type) {
  // 返回 type 在显示顺序里的 [gTop, gBottom]；gBottom 是该类型最后一条已有轨的显示下标
  const tracks = buildTracks();
  let gTop = -1, gBottom = -1;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].type === type) { if (gTop < 0) gTop = i; gBottom = i; }
  }
  return { gTop, gBottom, n: tracks.length };
}

function clampTargetDisplay(type, targetDisplayIndex) {
  // 把新建轨的目标显示位钳制到该类型自己的显示组内（避免新建轨插错组、渲染错位）
  if (type === "video") {
    const { gTop, gBottom } = typeGroupRange("video");
    if (gTop < 0) return Math.max(0, targetDisplayIndex);
    // 视频组：新覆盖轨 ∈ [gTop, gBottom-1]（gBottom 是主场景，不能在主场景之下）
    return Math.max(gTop, Math.min(gBottom - 1, targetDisplayIndex));
  }
  const { gTop, gBottom, n } = typeGroupRange(type);
  if (gTop < 0) {
    // 该类型当前无轨：放到其自然默认位（text/贴纸/effect 在视频之上→0；audio 在底部→n）
    return (type === "audio") ? Math.max(0, n) : 0;
  }
  // 非视频：新轨 ∈ [gTop, gBottom+1]（gBottom+1 = 追加到该类型组底部）
  return Math.max(gTop, Math.min(gBottom + 1, targetDisplayIndex));
}

function dataInsertIndexFromTargetDisplay(type, targetDisplayIndex, draft) {
  // 由「新轨在显示顺序中的目标位 targetDisplayIndex」反推后端 _insert_track 需要的数据索引。
  // 预览（targetDisplayIndex）与实际（dataInsertIndex→_insert_track→重渲染）严格同源，保证一致。
  if (type === "video") {
    const v = draft.video || [[]];
    const L = v.length;
    // 插入一条后显示 = (L_after-1) - data，L_after = L+1 → data = L - targetDisplayIndex
    let ins = L - targetDisplayIndex;
    return Math.max(1, Math.min(ins, L)); // can't go below main; clamp 到 [1, L]
  }
  // audio/text/effect/sticker：显示顺序 == 数据顺序（且连续成组，display = gTop + data_index）
  const { gTop } = typeGroupRange(type);
  const len = (draft[type] || []).length;
  if (gTop < 0) return Math.max(0, Math.min(targetDisplayIndex, len));
  let dataIdx = targetDisplayIndex - gTop; // display = gTop + data_index → 反推
  return Math.max(0, Math.min(dataIdx, len));
}

function _makeNewDrop(tracks, dragType, refDisplayIndex, above) {
  const targetRaw = above ? refDisplayIndex : refDisplayIndex + 1;
  const targetDisplayIndex = clampTargetDisplay(dragType, targetRaw);
  const dataInsertIndex = dataInsertIndexFromTargetDisplay(dragType, targetDisplayIndex, Store.state.draft);
  return {
    kind: "new", type: dragType,
    displayIndex: targetDisplayIndex,
    dataTi: null, dataInsertIndex: dataInsertIndex,
    targetExisting: false,
  };
}

function computeDrop(e, dragType) {
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
    if (block.includes(t.type)) {
      // 落入同类型已有轨
      return { kind: "existing", type: t.type, displayIndex: insideIdx, dataTi: t.ti, dataInsertIndex: null, targetExisting: true };
    }
    // 落在不兼容的已有轨：上半→新轨在其上方，下半→新轨在其下方（OpenCut 同式）
    const el = trackElOf(t);
    const r = el.getBoundingClientRect();
    const topHalf = (y < r.top + r.height / 2);
    return _makeNewDrop(tracks, dragType, insideIdx + (topHalf ? 0 : 1), !topHalf);
  }
  // 2) 所有轨之上 / 之下
  if (tracks.length === 0) return _makeNewDrop(tracks, dragType, 0, true);
  const firstEl = trackElOf(tracks[0]); const lastEl = trackElOf(tracks[tracks.length - 1]);
  const firstR = firstEl.getBoundingClientRect(); const lastR = lastEl.getBoundingClientRect();
  if (y < firstR.top) return _makeNewDrop(tracks, dragType, 0, true);
  if (y > lastR.bottom) return _makeNewDrop(tracks, dragType, tracks.length, false);
  // 3) 两条轨之间的间隙：在两条轨正中间新建一条轨（displayIndex = i+1）
  //    不再按拖动方向归属到上/下某一条，避免「 preview 和实际落位不一致」
  for (let i = 0; i < tracks.length - 1; i++) {
    const a = trackElOf(tracks[i]).getBoundingClientRect();
    const b = trackElOf(tracks[i + 1]).getBoundingClientRect();
    if (y > a.bottom && y < b.top) {
      return _makeNewDrop(tracks, dragType, i + 1, true);
    }
  }
  return _makeNewDrop(tracks, dragType, tracks.length, false);
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

// 片段几何：优先用拖拽临时态，否则用草稿真实位置
function segGeom(s, type, ti, idx) {
  let leftUs = s.start, rightUs = s.start + s.duration;
  const d = Store.state.drag;
  const k = type + ":" + ti + ":" + idx;
  if (d && d.key === k && d.moved) {
    if (d.mode === "move") { leftUs = d.curLeftUs; rightUs = d.curLeftUs + s.duration; } // 移动：保持时长，仅平移
    else if (d.mode === "resize") { if (d.side === "left") leftUs = d.curLeftUs; else rightUs = d.curRightUs; }
  }
  // 整组缩放预览：以 pivot 为不动边，按 factor 缩放选中段的位置与时长
  const gs = Store.state.groupScale;
  if (gs && Store.state.selectedKeys.includes(k)) {
    const ns = gs.pivot + (leftUs - gs.pivot) * gs.factor;
    leftUs = ns; rightUs = ns + s.duration * gs.factor;
  } else if (d && d.isGroup && d.moved && d.mode === "move" && Store.state.selectedKeys.includes(k) && k !== d.key) {
    // 整组移动预览：非锚点段横向跟随锚点的 dUs（保持相对布局）
    leftUs = s.start + d.groupDeltaUs; rightUs = leftUs + s.duration;
  }
  return { leftUs, widthUs: rightUs - leftUs };
}
function makeSeg(s, type, ti, idx, overrideLeftUs, forceDragging) {
  const key = type + ":" + ti + ":" + idx;
  const g = segGeom(s, type, ti, idx);
  const leftUs = (overrideLeftUs != null) ? overrideLeftUs : g.leftUs;
  const dragging = !!forceDragging || (Store.state.drag && Store.state.drag.mode === "move" && Store.state.drag.moved && Store.state.drag.key === key);
  const seg = document.createElement("div");
  seg.className = "seg" + (type === "effect" ? " effect" : "") + (Store.state.selectedKeys.includes(key) ? " sel" : "") + (dragging ? " dragging" : "");
  seg.dataset.key = key;
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
      bgStyle = "background:" + getCssVar("--seg-video");
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
  seg.innerHTML =
    fillHtml +
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
  // 拖拽中：被拖段从源轨取出，渲染到目标轨（预览，不写真实数据）
  const drag = Store.state.drag;
  const isMove = drag && drag.mode === "move" && drag.moved;
  const dragKey = isMove ? drag.key : null;
  // 目标轨（existing = 真实落点轨；new = 预览轨 ti=-1）；统一由 computeDrop 输出驱动，保证预览/实际一致
  const targetType = isMove ? drag.type : null;
  const targetTi = isMove ? ((drag.targetKind === "existing") ? drag.targetDataTi : -1) : null;
  // 构建待渲染轨道列表（显示顺序：叠加→主轨→音频→文本/特效…）
  const tracks = buildTracks();
  // 拖拽预览（轴内段移动）：目标=新建轨 → 按 targetDisplayIndex 绝对注入「预览轨」（与 computeDrop/后端同源），松手才真正建。
  // 素材/特效库拖入的新建轨预览由 HTML overlay 承担（showTrackPreview 只移动位置），不进 buildTracks ——
  // 否则 dragover 每 mousemove 全量重建时间轴 DOM，产生阻尼感（2026-08-18 审计结论）。
  const needPreview = isMove && drag.targetKind === "new" && typeof drag.targetDisplayIndex === "number";
  if (needPreview) {
    const pType = drag.type;
    const pDisplay = drag.targetDisplayIndex;
    const labelBy = { video: "叠加", audio: "音轨", text: "文本轨", effect: "特效轨", sticker: "贴纸轨" };
    const previewTrack = { type: pType, ti: -1, label: (labelBy[pType] || "轨") + "预览", segs: [], preview: true };
    const di = Math.max(0, Math.min(pDisplay, tracks.length));
    tracks.splice(di, 0, previewTrack);
  }
  tracks.forEach(tr => {
    const label = document.createElement("div");
    label.className = "track-label";
    label.dataset.type = tr.type; label.dataset.ti = tr.ti;
    const meta = ((Store.state.draft._track_meta || {})[tr.type] || []);
    const m = meta[tr.ti] || {};
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
    if (tr.preview) track.classList.add("drop-preview");
    else if (isMove && targetType && targetTi != null && tr.type === targetType && tr.ti === targetTi) track.classList.add("drop-target");
    let childCount = 0;
    // 目标轨/预览轨：先放被拖段（用源坐标 + 覆盖左边界，保持时长）
    if (isMove && targetType && targetTi != null && tr.type === targetType && tr.ti === targetTi) {
      const ds = findSeg(drag.type, drag.ti, drag.idx);
      if (ds) { track.appendChild(makeSeg(ds, drag.type, drag.ti, drag.idx, drag.curLeftUs, true)); childCount++; }
    }
    tr.segs.forEach((seg, idx) => {
      const k = tr.type + ":" + tr.ti + ":" + idx;
      if (isMove && k === dragKey) return;            // 源轨跳过被拖段
      track.appendChild(makeSeg(seg, tr.type, tr.ti, idx));
      childCount++;
    });
    if (!childCount) { const hEl = document.createElement("div"); hEl.className = "empty-hint"; track.appendChild(hEl); }
    content.appendChild(track);
  });
  // 移动预览：蓝色落点线（显示在拖拽时间位置，对齐 OpenCut 的 drop 指示）
  // 仅移动态管理此线；素材导入的原生拖拽由 showDropPreview/hideDropPreview 控制，互不打架
  if (isMove) {
    const line = $("dropLine");
    line.style.display = "";
    line.style.left = (drag.curLeftUs / 1e6 * pps()) + "px";
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
