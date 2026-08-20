"use strict";

/* =====================================================================
 * renderer.js —— 预览合成（Step 1e 拆 JS：纯搬移不改逻辑）
 * 职责：_makeVisualEl/_setVisualContent/_setTextContent/renderPreview/applySegMask/renderMaskOverlay
 * 依赖：store.js + media.js(PlayerManager/previewState) + player.js + timeline.js；运行时引用主 script 的 fileURL/renderMaskPanel 等。
 * 加载顺序：store→media→player→timeline→renderer→主script
 * ===================================================================== */

function _makeVisualEl(mtype) {
  const wrap = document.createElement("div");
  wrap.className = "vis-layer";
  wrap.setAttribute("data-preview-el", "1");   // 2026-08-20：预览拖动 hit-test 标记（preview-drag.js）
  wrap.style.display = "none";
  return wrap;
}

// ============================================================
// PlayerManager —— 媒体生命周期收口门面（Phase 2 / Step 1：仅建壳，行为零变化）
// ------------------------------------------------------------
// 设计定位（facade-first）：
//   本阶段 PlayerManager 只是一个「门面」，所有方法内部直接代理现有全局函数，
//   不引入任何新逻辑、不改任何调用点、不改播放行为、不修 bug、不改数据结构、不改 UI。
//   现有代码完全照旧运行——本对象目前没有任何外部调用（纯脚手架）。
//   后续各 Phase 才会：①把对应原语逻辑逐步「搬进」PlayerManager 内部；
//   ②把外部散落的媒体调用点逐个改为走 PlayerManager（最终目标：Player 之外媒体原语调用点 = 0）。
// ============================================================

// ============================================================
// PlaySession —— 播放事务状态层（Step A：v2.2 设计稿落地；详见 docs/architecture/player-session-v2-design.md）
// 纯状态容器：只存「本次播放事务」的意图 + 状态；绝不碰媒体元素 el。
// 所有媒体执行（play/pause/muted）都在 PlayerManager 内；Session 只提供 isCurrent()/canRestore() 等判断。
// ============================================================


function _setVisualContent(wrap, mtype, path, muted, volume) {
  const volKey = (volume == null ? "" : String(volume));
  if (wrap.dataset.mtype === mtype && wrap.dataset.path === path && wrap.dataset.muted === String(muted) && wrap.dataset.vol === volKey) return false; // 无变化
  wrap.innerHTML = "";
  wrap.dataset.mtype = mtype;
  wrap.dataset.path = path;
  wrap.dataset.muted = String(muted);
  wrap.dataset.vol = volKey;
  if (mtype === "video") {
    const layerKey = wrap.id || "video:?";
    const v = PlayerManager.create("video", wrap, layerKey);
    setMediaSrc(v, fileURL(path), "render-visual", layerKey);
    // 轨道静音 或 全局预览静音 → 关闭该视频段的内嵌音频
    setMediaMute(v, !!muted || previewMuted, "render-visual", (path || "visual"));
    v.volume = (volume == null ? 1 : volume);   // 段级音量（2026-08-16）
    v.playsInline = true;
  } else if (mtype === "image") {
    const img = document.createElement("img");
    img.src = fileURL(path);
    wrap.appendChild(img);
  }
  return true;
}
function _setTextContent(wrap, text) {
  if (wrap.dataset.text === text) return false;
  wrap.textContent = text;
  wrap.dataset.text = text;
  return true;
}
// Round D/F2: Seek Barrier —— 等浏览器完成一次异步 seek 且 currentTime 真正接近目标，再放行 play()。
// 用 addEventListener 一次性监听，绝不写 el.onseeked（那是 DOM 单归属属性，调用方会覆盖 resolver → Promise 永久 pending）。
// 放行条件：不在 seeking、readyState>=2、且 currentTime 与 _seekTarget 差距 <100ms；否则继续等或主动重 seek。

/* X 模型预览 z 序：main 恒定最底（10）；overlay 轨按数组顺序（overlay[0]=最顶 → 最大 zIndex）。
   替代旧的按类型硬编码（text 1000+ > sticker 520+ > video 10+）——层级由 overlay 数组顺序决定。 */
function zIndexOf(h) {
  const ovLen = (Array.isArray(Store.state.draft.overlay) ? Store.state.draft.overlay : []).length;
  if (!h || h.oi < 0) return 10;          // main（oi=-1）或 audio（oi=-2，无视觉层）
  return 100 + (ovLen - h.oi);
}

function renderPreview(s) {
  const stack = $("previewStack");
  const ph = $("previewPlaceholder");
  const us = Store.state.playheadUs;
  const hits = resolveHits(us);
  const hasVisual = hits.some(h => (h.type === "video" || h.type === "image" || h.type === "text") && !isTrackHidden(h.type, h.ti) && !h.seg.hidden);
  // 视觉层：按轨道层级排列，上层（高 ti）在上；跳过本地无素材的占位段（避免空 src 报错并挡住下层视频）
  // 隐藏的 video/text 轨在预览中不渲染（对齐 OpenCut element-bounds.ts 过滤逻辑）
  const visualHits = hits.filter(h => h.type === "video" && resolveSegPath(h.seg) && !isTrackHidden(h.type, h.ti) && !h.seg.hidden);
  const textHits = hits.filter(h => h.type === "text" && !isTrackHidden(h.type, h.ti) && !h.seg.hidden);
  const activeVisualKeys = new Set();

  // 每条 video 轨道一个容器；同轨内当前最多一个段命中
  for (const h of visualHits) {
    const layerKey = "video:" + h.ti;
    activeVisualKeys.add(layerKey);
    let rec = previewState.visualEls.get(layerKey);
    if (!rec) {
      const wrap = _makeVisualEl(h.seg.type);
      wrap.id = layerKey;   // 2026-08-16：wrap 必须带 id（_setVisualContent 用 wrap.id 作 layerKey，空 id → "video:?" → setMediaSrc/destroy key 错位）
      stack.appendChild(wrap);
      rec = { el: wrap, key: layerKey, prepare: null, slotState: "EMPTY" };   // C.5：双槽结构初始化（prepare=后台预加载槽，slotState=状态机）
      previewState.visualEls.set(layerKey, rec);
    }
    // 音量：C1.2 走 PropertyResolver（动画覆盖静态，旧通道名 volume 兼容；对齐 OpenCut 动画通道覆盖 base）
    const _vol = (typeof resolveProperty === "function")
      ? resolveProperty(h.seg, "audio.volume", Math.max(0, Math.min(us - h.seg.start, h.seg.duration)))
      : (h.seg.volume == null ? 1 : h.seg.volume);
    const changed = _setVisualContent(rec.el, h.seg.type, resolveSegPath(h.seg), isTrackMuted(h.type, h.ti) || h.seg.muted, _vol);
    rec.el.style.display = "";
    rec.el.style.zIndex = zIndexOf(h);
    rec.key = h.key;
    rec.seg = h.seg;
    applyKfTransform(rec.el, h.seg, Math.max(0, Math.min(us - h.seg.start, h.seg.duration)));
    applySegMask(h.seg, h.key, rec.el);   // 遮罩：把 mask 形状挂成 clip-path（对齐 OpenCut masks）
    // 切源后等 canplay 再 seek；平时直接 seek
    if (changed) {
      rec.el.dataset.pendingSeek = "1";
      rec.el._pendingSeg = h.seg;
      const media = rec.el.firstElementChild;
      if (media) {
    const onReady = () => {
        if (rec.el.dataset.pendingSeek) {
          PlayerManager.seek(media, h.seg, Store.state.playheadUs);
          if (isPlaying) media.onseeked = () => { mediaClockReady = true; };
          rec.el.dataset.pendingSeek = "";
        }
        // play() 不在 oncanplay 里调：统一交给 playAllMedia() 在 startPlay 点击手势（或 sticky-activation 跨段）内播放。
      };
      media.oncanplay = onReady;
      // 2026-08-16 真机修复：**去掉 onloadedmetadata 绑定**——loadedmetadata 触发时 readyState=1（仅 metadata），
      // WebView2 在 readyState<2 时设 currentTime 会被吞（日志实锤：seek to=5.524 ready=1 后 play 从 0 起播）。
      // 只有 canplay（readyState>=2 有数据可播）时才 seek 才生效。
      // 兜底：若元素在绑定前已 canplay（startPlay 早已建好元素），事件不再触发 → 就绪则立即执行。
      if (media.readyState >= 2) onReady();
      }
    } else {
      const media = rec.el.firstElementChild;
      if (media && h.seg.type !== "image") {
        // B.5.4-1：re-seek 时不再写 muted（与激活门双写）。活动媒体由激活门/play 生命周期统一负责；renderPreview 顶部(1566/1572)已按轨道/预览静音设好。
        PlayerManager.seek(media, h.seg, us);
        if (isPlaying) media.onseeked = () => { mediaClockReady = true; };
      }
    }
  }
  // 隐藏当前未命中的视觉轨道
  for (const [layerKey, rec] of previewState.visualEls) {
    if (!activeVisualKeys.has(layerKey)) rec.el.style.display = "none";
  }

  // C.5-2（MediaSlot 预加载）：每轨 active 命中后，调度后台 prepare 槽预加载"下一段"——
  // 提前建元素+seek+等 ready（用户不可见），切段时 swap 无感（根治 WebView2 seek 到缓冲外触发管线重置）。
  for (const h of visualHits) {
    const rec = previewState.visualEls.get("video:" + h.ti);
    if (rec) preloadNextVideoSlot(rec, h.ti, h.seg.start || 0);
  }

  // 文本层：每条 text 轨道一个文本 div
  const activeTextKeys = new Set();
  for (const h of textHits) {
    const layerKey = "text:" + h.ti;
    activeTextKeys.add(layerKey);
    let rec = previewState.textEls.get(layerKey);
    if (!rec) {
      const el = document.createElement("div");
      el.className = "text-layer";
      el.style.display = "none";
      stack.appendChild(el);
      rec = { el };
      previewState.textEls.set(layerKey, rec);
    }
    _setTextContent(rec.el, h.seg.text || h.seg.name || "");
    rec.el.style.display = "";
    rec.el.style.zIndex = zIndexOf(h);
    rec.key = h.key;
    // 字幕预览样式：底部居中、白字粗体、自动换行、可选黑底（对齐 OpenCut）
    const sub = h.seg.sub_style || {};
    if (h.seg.text) {
      rec.el.style.left = "50%";
      rec.el.style.top = "auto";
      rec.el.style.bottom = sub.bg ? "6%" : "5%";
      rec.el.style.transform = "translateX(-50%)";
      rec.el.style.textAlign = "center";
      rec.el.style.color = sub.color || "#ffffff";
      rec.el.style.fontWeight = sub.bold === false ? "normal" : "bold";
      rec.el.style.maxWidth = "82%";
      rec.el.style.lineHeight = "1.35";
      rec.el.style.padding = sub.bg ? "2px 10px" : "0";
      rec.el.style.background = sub.bg ? (sub.bg_color || "#000000") : "transparent";
      rec.el.style.borderRadius = sub.bg ? "6px" : "0";
      rec.el.style.fontSize = ((sub.font_size || 10) / 10 * 26) + "px";
      rec.el.style.textShadow = "0 1px 2px rgba(0,0,0,.6)";
    }
  }
  for (const [layerKey, rec] of previewState.textEls) {
    if (!activeTextKeys.has(layerKey)) rec.el.style.display = "none";
  }

  // 贴纸层：每条贴纸轨一个 <img> 叠加（高于视频、低于文本），按 transform 定位/缩放/旋转/透明/翻转
  const stickerHits = hits.filter(h => h.type === "sticker" && resolveSegPath(h.seg) && !isTrackHidden(h.type, h.ti) && !h.seg.hidden);
  const activeStickerKeys = new Set();
  const stackH = ($("previewStack").clientHeight || 540);
  for (const h of stickerHits) {
    const layerKey = "sticker:" + h.ti;
    activeStickerKeys.add(layerKey);
    let rec = previewState.stickerEls.get(layerKey);
    if (!rec) {
      const el = document.createElement("div");
      el.className = "sticker-layer";
      el.style.display = "none";
      const img = document.createElement("img");
      el.appendChild(img);
      $("previewStack").appendChild(el);
      rec = { el, img };
      previewState.stickerEls.set(layerKey, rec);
    }
    const tf = h.seg.transform || {};
    const baseH = 0.4 * stackH;   // scale=1 时贴纸占画布高度 40%（与导出 STICKER_BASE_HEIGHT_RATIO 对齐）
    const natW = h.seg.natural_w || 1, natH = h.seg.natural_h || 1;
    const ar = (natW && natH) ? (natW / natH) : 1;
    const hpx = baseH * (tf.scale || 1);
    const wpx = hpx * ar;
    rec.el.style.width = wpx + "px";
    rec.el.style.height = hpx + "px";
    rec.el.style.display = "";
    rec.el.style.zIndex = zIndexOf(h);
    rec.el.style.opacity = (tf.opacity != null ? tf.opacity : 1);
    rec.el.style.transform =
      "translate(-50%,-50%) " +
      "translate(" + ((tf.x || 0) * 50) + "%," + ((tf.y || 0) * 50) + "%) " +
      "rotate(" + (tf.rotation || 0) + "deg) " +
      "scale(" + (tf.flipH ? -1 : 1) + "," + (tf.flipV ? -1 : 1) + ")";
    if (rec.img.dataset.src !== fileURL(resolveSegPath(h.seg))) {
      rec.img.src = fileURL(resolveSegPath(h.seg));
      rec.img.dataset.src = fileURL(resolveSegPath(h.seg));
    }
  }
  for (const [layerKey, rec] of previewState.stickerEls) {
    if (!activeStickerKeys.has(layerKey)) rec.el.style.display = "none";
  }

  // 音频层（Phase C-2，2026-08-16）：audio 轨发声交给 AudioEngine（Web Audio），不再维护 <audio> 元素。
  // 声音调度完全由 AudioEngine.setClips(audioClips, playheadUs) 负责（startPlay/seek 时喂入）。
  // 保留 audioHits 计算仅用于"是否有音频命中"的语义判断（后续可做 audio 轨波形高亮），元素不再创建。
  const audioHits = hits.filter(h => h.type === "audio" && resolveSegPath(h.seg) && !isTrackMuted(h.type, h.ti) && !h.seg.muted);
  // Phase C-2：清理旧元素（老存档/旧逻辑建的 audio 元素一次性清空；之后 audioEls 保持为空，由 AudioEngine 接管）
  if (previewState.audioEls.size > 0) {
    for (const key of [...previewState.audioEls.keys()]) PlayerManager.destroy(key);
  }
  void audioHits;

  // 占位显隐
  ph.style.display = hasVisual ? "none" : "";

  // 注意：play() 不在这里触发——startPlay 已显式调 playAllMedia()，跨段续播由 playTick 跨段分支调用。
  // 若此处也调，会导致同一媒体被反复 play → AbortError（反复播/卡顿根因之一）。
  applyEffects();        // ★ Phase C：特效段合成（盖在素材层/整栈上的滤镜）
  renderMaskOverlay();   // 选中段有遮罩时画把手（拖拽用）
}

/* ---------- 特效合成（Phase C：特效只是 Graph 上的 Node，renderer 只调用 effects.js 纯函数） ---------- */
// 把当前激活的特效段应用到预览 DOM：逐片段特效挂素材层 filter/opacity，调整层挂整栈 previewStack。
// 仅调用 computeEffectStyle（纯函数，不写滤镜逻辑），守住 Timeline Kernel → Playback Graph → Renderer 单向。
function applyEffects() {
  const stack = $("previewStack");
  if (!stack) return;
  const draft = Store.state.draft;
  const hasEffect = (Array.isArray(draft.overlay) ? draft.overlay : []).some(tr => tr && tr.type === "effect" && Array.isArray(tr.segs) && tr.segs.length > 0);
  if (!draft || !hasEffect) {
    // 无特效轨：复位整栈 + 视觉层 filter，避免残留旧特效
    stack.style.filter = "";
    stack.style.opacity = "";
    for (const rec of previewState.visualEls.values()) rec.el.style.filter = "";
    return;
  }
  let effectNodes = [];
  try {
    effectNodes = (buildPlaybackGraph(draft, Store.state.materials).effectNodes) || [];
  } catch (e) { return; }
  // 收集 segKey -> 元素（video 层 rec.key = "video:ti:si"，image 段也走 video 轨同 wrap）
  const layerByKey = {};
  for (const [lk, rec] of previewState.visualEls) {
    if (rec && rec.key) layerByKey[rec.key] = rec.el;
  }
  const res = computeEffectStyle(effectNodes, Store.state.playheadUs, layerByKey);
  // 先复位所有视觉层 filter（opacity 不在此清零，交给 applyKfTransform / 特效 opacity 决定）
  for (const rec of previewState.visualEls.values()) rec.el.style.filter = "";
  for (const [key, f] of Object.entries(res.layerFilters)) {
    const el = layerByKey[key]; if (el) el.style.filter = f;
  }
  for (const [key, op] of Object.entries(res.layerOpacity)) {
    const el = layerByKey[key]; if (el) el.style.opacity = String(op);
  }
  stack.style.filter = res.stackFilter || "";
  stack.style.opacity = (res.stackOpacity !== 1) ? String(res.stackOpacity) : "";
}

/* ---------- 播放 / 暂停 ---------- */
// C.5-2（MediaSlot 预加载调度，2026-08-16）：
// 给轨 rec 的 prepare 槽加载"同轨 start 大于当前段的最小 start"段（下一段）。
// 状态机：EMPTY→LOADING→READY（canplay 且 currentTime 到位）/ STUCK（失败，降级由切段兜底）。
// 后台槽纪律：display:none + muted + 不参与 playAllMedia（playAllMedia 只遍历 rec.el active 槽）。
// 数据源：buildPlaybackGraph(Store.state.draft, Store.state.materials).videoNodes（Playback Graph 平铺，含 startUs/srcStartUs/srcEndUs/path）。
let _preloadSeq = 0;
function preloadNextVideoSlot(rec, ti, currentStartUs) {
  if (!rec) return;
  // 1. 找下一段（同轨 start > 当前段 start 的最小 start）
  let nextNode = null;
  try {
    const graph = buildPlaybackGraph(Store.state.draft, Store.state.materials);
    for (const n of (graph.videoNodes || [])) {
      if (n.trackKey !== "video:" + ti) continue;
      if (n.type === "image") continue;   // 图片是 <img> 渲染，无需后台 <video> 预解码（否则 STUCK 且无效）
      if (n.startUs > currentStartUs && (!nextNode || n.startUs < nextNode.startUs)) nextNode = n;
    }
  } catch (e) { return; }
  // 2. 无下一段：prepare 槽复位 EMPTY（清掉旧 prepare）
  if (!nextNode) {
    if (rec.prepare && rec.slotState !== "EMPTY") {
      PlayerManager._destroyWrap(rec.prepare);
      rec.prepare = null;
      rec.slotState = "EMPTY";
    }
    return;
  }
  // 3. 已 READY 且目标没变：不动（避免每帧重建）
  if (rec.slotState === "READY" && rec._preloadKey === nextNode.key) return;
  // 4. 目标变了：清旧 prepare，重新走 LOADING
  if (rec.prepare && rec._preloadKey !== nextNode.key) {
    PlayerManager._destroyWrap(rec.prepare);
    rec.prepare = null;
  }
  // 5. 建 prepare wrap（display:none 后台槽）
  if (!rec.prepare) {
    const wrap = _makeVisualEl("video");
    wrap.id = "preload:" + ti;
    wrap.style.display = "none";
    const stack = $("previewStack");
    if (stack) stack.appendChild(wrap);
    rec.prepare = wrap;
  }
  rec._preloadKey = nextNode.key;
  if (rec.slotState === "LOADING") return;   // 已在加载中，等 canplay 回调推进
  rec.slotState = "LOADING";
  // 6. 建 video 元素 + 设 src + muted（后台不发声）
  let media = rec.prepare.firstElementChild;
  if (!media || media.tagName !== "VIDEO") {
    rec.prepare.innerHTML = "";
    media = PlayerManager.create("video", rec.prepare, "preload:" + ti);
    setMediaMute(media, true, "preload", "preload:" + ti);
    media.playsInline = true;
  }
  const path = resolveSegPath({ material_id: null, path: nextNode.path });
  if (!path) { rec.slotState = "STUCK"; return; }
  setMediaSrc(media, fileURL(path), "preload", "preload:" + ti);
  // 7. canplay 后 seek 到下一段源窗口起点（后台定位，用户不可见；seek 失败不影响当前播放）
  const _seq = ++_preloadSeq;
  media.oncanplay = () => {
    if (rec.slotState !== "LOADING" || rec._preloadKey !== nextNode.key) return;
    PlayerManager.seek(media, { start: nextNode.startUs, src_start: nextNode.srcStartUs, src_end: nextNode.srcEndUs, duration: nextNode.durationUs, speed: nextNode.speed }, nextNode.startUs);
    // 等 seek 落位确认（canplay 后 readyState>=2，seek 生效）→ READY
    const _s = _seq;
    setTimeout(() => {
      if (_s !== _preloadSeq) return;
      if (rec.slotState !== "LOADING") return;
      const ok = media.readyState >= 2 && Math.abs((media.currentTime || 0) - (nextNode.srcStartUs / 1e6)) < 0.15;
      rec.slotState = ok ? "READY" : "STUCK";
      if (ok) console.log("[MediaSlot] prepare READY", nextNode.key, "at", (nextNode.srcStartUs / 1e6).toFixed(1));
      else console.warn("[MediaSlot] prepare STUCK", nextNode.key, "ready=", media.readyState, "cur=", (media.currentTime || 0).toFixed(3));
    }, 400);
  };
  // 兜底：canplay 可能已过（同一文件已缓冲）→ 立即检查
  if (media.readyState >= 2) media.oncanplay();
}

// 静音按钮状态同步（C.5-2 编辑时保护：updateMuteBtn 函数头）
function updateMuteBtn() {
  const btn = $("muteBtn");
  if (!btn) return;
  btn.textContent = previewMuted ? "🔇" : "🔊";
  btn.title = previewMuted ? "已静音，点击恢复声音" : "静音";
  btn.classList.toggle("muted", previewMuted);
}

/* ---------- 渲染：Skill 区（只读 Store） ---------- */
function renderSkill(s) {
  const body = $("skillModalBody");
  if (!s.selectedKey) { body.innerHTML = '<div class="empty">暂未接入 Skill<br>选中素材后这里显示可执行的剪辑 Skill</div>'; return; }
  body.innerHTML =
    '<div class="skill-item"><div class="t">口播精剪</div><div class="d">自动去停顿/口水词，保留语义</div></div>' +
    '<div class="skill-item"><div class="t">字幕生成</div><div class="d">识别语音生成字幕片段</div></div>' +
    '<div class="skill-item"><div class="t">转场建议</div><div class="d">根据前后片段推荐转场</div></div>';
}

/* ---------- 渲染：MCP 状态 ---------- */
function renderMcp(s) {
  const m = s.meta.mcp;
  $("mcpDot").classList.toggle("on", !!m.connected);
  $("mcpName").textContent = m.connected ? ("已连接 · " + (m.agent || "agent")) : "未连接";
}

/* ===================== 遮罩 masks（对齐 OpenCut masks 数据模型） ===================== */
const SVGNS = "http://www.w3.org/2000/svg";
// 形状 + 支持的把手（pos 位置 / rot 旋转 / scale 缩放 / edges 边 / corners 角）
const MASK_SHAPES = [
  { type: "rectangle", name: "矩形", feats: { pos: 1, rot: 1, scale: 1, edges: 1 } },
  { type: "ellipse", name: "椭圆", feats: { pos: 1, rot: 1, scale: 1, edges: 1 } },
  { type: "star", name: "星形", feats: { pos: 1, rot: 1, scale: 1, edges: 1 } },
  { type: "heart", name: "爱心", feats: { pos: 1, rot: 1, scale: 1, edges: 1 } },
  { type: "diamond", name: "菱形", feats: { pos: 1, rot: 1, scale: 1, edges: 1 } },
  { type: "split", name: "线性", feats: { pos: 1, rot: 1, scale: 0, edges: 0 } },
  { type: "cinematic-bars", name: "电影黑边", feats: { pos: 1, rot: 1, scale: 0, edges: 1 } },
];
const MASK_EXPORTABLE = { rectangle: 1, ellipse: 1, star: 1, heart: 1, split: 1 };

// 把归一化参数换算成 0..1 objectBoundingBox 几何（未旋转；旋转交给 clipPathTransform）
function maskGeom(p) {
  const scale = p.scale || 1;
  return {
    cx: 0.5 + (p.centerX || 0),
    cy: 0.5 + (p.centerY || 0),
    w: Math.max(0.001, (p.width || 0.6) * scale),
    h: Math.max(0.001, (p.height || 0.6) * scale),
  };
}
// 形状本体路径（不含外框；反转时由 maskClipPathD 拼外框）
function maskShapePathD(type, g) {
  const { cx, cy, w, h } = g; const rx = w / 2, ry = h / 2;
  if (type === "rectangle") return `M ${cx - rx},${cy - ry} H ${cx + rx} V ${cy + ry} H ${cx - rx} Z`;
  if (type === "ellipse") return `M ${cx},${cy - ry} A ${rx},${ry} 0 1,1 ${cx},${cy + ry} A ${rx},${ry} 0 1,1 ${cx},${cy - ry} Z`;
  if (type === "diamond") return `M ${cx},${cy - ry} L ${cx + rx},${cy} L ${cx},${cy + ry} L ${cx - rx},${cy} Z`;
  if (type === "star") {
    const N = 10, inner = 0.45; let d = "";
    for (let i = 0; i < N; i++) {
      const outer = i % 2 === 0; const rX = outer ? rx : rx * inner; const rY = outer ? ry : ry * inner;
      const a = i * Math.PI / 5 - Math.PI / 2;
      const x = cx + rX * Math.cos(a), y = cy + rY * Math.sin(a);
      d += (i === 0 ? "M" : "L") + ` ${x.toFixed(4)},${y.toFixed(4)} `;
    }
    return d + "Z";
  }
  if (type === "heart") {
    let d = ""; const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps * Math.PI * 2;
      const hx = 16 * Math.sin(t) ** 3;
      const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const x = cx + (hx / 17) * rx, y = cy - (hy / 17) * ry;
      d += (i === 0 ? "M" : "L") + ` ${x.toFixed(4)},${y.toFixed(4)} `;
    }
    return d + "Z";
  }
  if (type === "split") return `M 0,0 H 1 V ${cy} H 0 Z`;              // 上半平面（默认遮挡下方）
  if (type === "cinematic-bars") return `M 0,${cy - ry} H 1 V ${cy + ry} H 0 Z`; // 横向带
  return "";
}
function maskClipPathD(type, g, inverted) {
  const shape = maskShapePathD(type, g);
  if (!inverted) return shape;
  return `M 0,0 H 1 V 1 H 0 Z ` + shape;   // 外框 - 形状 → evenodd 反转
}
// 给某段的预览媒体层挂 clip-path（剪映草稿每段单遮罩）
function applySegMask(seg, key, recEl) {
  recEl.style.clipPath = ""; recEl.style.webkitClipPath = "";
  const ms = seg.masks || [];
  if (!ms.length) return;
  const m = ms[0]; const p = m.params; const g = maskGeom(p);
  const d = maskClipPathD(m.type, g, p.inverted);
  const clipId = "cp-" + key;
  const defs = $("maskDefsDefs"); if (!defs) return;
  // key 可能含 '.' (如 video-0.0)，#cp-video-0.0 不是合法 CSS selector；用 getElementById 取
  const old = document.getElementById(clipId); if (old) old.remove();
  const cp = document.createElementNS(SVGNS, "clipPath");
  cp.setAttribute("id", clipId);
  cp.setAttribute("clipPathUnits", "objectBoundingBox");
  cp.setAttribute("clipPathTransform", `rotate(${p.rotation || 0} 0.5 0.5)`);
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("d", d);
  path.setAttribute("clip-rule", p.inverted ? "evenodd" : "nonzero");
  cp.appendChild(path); defs.appendChild(cp);
  recEl.style.clipPath = `url(#${clipId})`;
  recEl.style.webkitClipPath = `url(#${clipId})`;
}

// 遮罩属性面板（选中单段时显示）

// 字幕来源：优先选中段（视频/音频），否则项目主视频轨/音频轨第一段
function getAsrSource() {
  const s = selectedSeg();
  if (s && (s.type === "video" || s.type === "audio")) { const p = resolveSegPath(s); if (p) return { path: p, name: s.name }; }
  const d = Store.state.draft || {};
  const main = (d.main && typeof d.main === "object") ? (d.main.segs || []) : [];
  for (const seg of main) { const p = resolveSegPath(seg); if (p) return { path: p, name: seg.name }; }
  for (const tr of (Array.isArray(d.overlay) ? d.overlay : [])) {
    if (tr && tr.type === "video") for (const seg of (tr.segs || [])) { const p = resolveSegPath(seg); if (p) return { path: p, name: seg.name }; }
  }
  for (const a of (Array.isArray(d.audio) ? d.audio : [])) {
    if (a && typeof a === "object") for (const seg of (a.segs || [])) { const p = resolveSegPath(seg); if (p) return { path: p, name: seg.name }; }
  }
  return null;
}

function renderSubtitlePanel() {
  const emptyEl = $("subEmpty"), ctrlsEl = $("subCtrls"), srcEl = $("subSource"), nameEl = $("subSegName");
  const src = getAsrSource();
  if (!src) { emptyEl.style.display = ""; ctrlsEl.style.display = "none"; nameEl.textContent = ""; return; }
  emptyEl.style.display = "none"; ctrlsEl.style.display = "";
  srcEl.textContent = src.name || src.path; srcEl.title = src.path || "";
  nameEl.textContent = "";
}

// 贴纸面板：① 添加控件（新建轨 / 选图 / 添加到播放头）② 选中贴纸段时显示变换滑块
let stPickPath = null;   // 当前选中的本地贴纸图片路径（来自原生对话框）
function renderStickerPanel() {
  const emptyEl = $("stickerEmpty"), ctrlsEl = $("stickerCtrls");
  const s = selectedSeg();
  const isSticker = s && s.type === "sticker";
  // 有任意贴纸轨 / 已选贴纸 → 显示控件；否则显示空提示
  const hasStickerTrack = (Store.state.draft.overlay || []).some(tr => tr && tr.type === "sticker" && Array.isArray(tr.segs) && tr.segs.length > 0);
  if (!hasStickerTrack && !isSticker) { emptyEl.style.display = ""; ctrlsEl.style.display = "none"; return; }
  emptyEl.style.display = "none"; ctrlsEl.style.display = "";
  // 选中贴纸 → 回填变换滑块
  const tf = isSticker ? (s.transform || {}) : {};
  const selName = $("stSelName"), tfBox = $("stTf");
  if (isSticker) {
    selName.style.display = ""; selName.textContent = s.name || "贴纸";
    tfBox.style.display = "";
    const setR = (id, vid, v, dig) => { $(id).value = v; $(vid).textContent = (dig ? Math.round(v * 100) / 100 : v); };
    setR("stX", "stXV", tf.x || 0, true);
    setR("stY", "stYV", tf.y || 0, true);
    setR("stScale", "stScaleV", tf.scale || 1, true);
    setR("stRot", "stRotV", tf.rotation || 0, false);
    setR("stOp", "stOpV", tf.opacity != null ? tf.opacity : 1, true);
    $("stFlipH").checked = !!tf.flipH;
    $("stFlipV").checked = !!tf.flipV;
  } else {
    selName.style.display = "none"; tfBox.style.display = "none";
  }
}

let maskDrag = null;
function renderMaskOverlay() {
  const ov = $("maskOverlay"); if (!ov) return;
  const W = ov.clientWidth || 1, H = ov.clientHeight || 1;
  ov.setAttribute("viewBox", `0 0 ${W} ${H}`);
  ov.innerHTML = "";
  const s = selectedSeg();
  if (!s || !s.masks || !s.masks.length) return;
  if (s.type !== "video" && s.type !== "image") return;
  const k = Store.state.selectedKey; if (!k) return;
  const [, tti] = k.split(":");
  const rec = previewState.visualEls.get("video:" + tti);
  if (!rec || !rec.el) return;
  const media = rec.el.querySelector("video,img"); if (!media) return;
  const stack = $("previewStack"); const sr = stack.getBoundingClientRect(); const mr = media.getBoundingClientRect();
  const ox = mr.left - sr.left, oy = mr.top - sr.top, mw = mr.width, mh = mr.height;
  if (mw < 1 || mh < 1) return;
  const m = s.masks[0]; const p = m.params; const g = maskGeom(p);
  const cxs = ox + g.cx * mw, cys = oy + g.cy * mh;
  const hw = g.w * mw / 2, hh = g.h * mh / 2;
  const rot = (p.rotation || 0) * Math.PI / 180;
  const rp = (dx, dy) => [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot)];
  const feats = MASK_SHAPES.find(x => x.type === m.type).feats;
  // 包围盒（轴对齐，便于看清；旋转时把手会旋转）
  const box = document.createElementNS(SVGNS, "rect");
  box.setAttribute("class", "mbox");
  box.setAttribute("x", cxs - hw); box.setAttribute("y", cys - hh);
  box.setAttribute("width", hw * 2); box.setAttribute("height", hh * 2);
  box.setAttribute("transform", `rotate(${p.rotation || 0} ${cxs} ${cys})`);
  ov.appendChild(box);
  const handle = (kind, x, y, cls) => {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("class", "mhandle " + (cls || "")); c.setAttribute("data-h", kind);
    c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("r", 6);
    ov.appendChild(c);
  };
  if (feats.pos) handle("pos", cxs, cys, "");
  if (feats.rot) {
    const [rx, ry] = rp(0, -(hh + 24));
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("class", "mrotline"); line.setAttribute("x1", cxs); line.setAttribute("y1", cys);
    line.setAttribute("x2", cxs + rx); line.setAttribute("y2", cys + ry); ov.appendChild(line);
    handle("rot", cxs + rx, cys + ry, "rot");
  }
  if (feats.edges) {
    const [elx, ely] = rp(-hw, 0); handle("edge-l", cxs + elx, cys + ely, "");
    const [erx, ery] = rp(hw, 0); handle("edge-r", cxs + erx, cys + ery, "");
    const [etx, ety] = rp(0, -hh); handle("edge-t", cxs + etx, cys + ety, "");
    const [ebx, eby] = rp(0, hh); handle("edge-b", cxs + ebx, cys + eby, "");
  }
  if (feats.scale) { const [sx, sy] = rp(hw, hh); handle("scale", cxs + sx, cys + sy, "scale"); }
}

// 把手拖拽：实时改 Store seg 预览，松手提交后端（单次 undo）
function onMaskHandleDown(e) {
  const h = e.target.getAttribute("data-h"); if (!h) return;
  e.stopPropagation(); e.preventDefault();
  const s = selectedSeg(); if (!s || !s.masks || !s.masks.length) return;
  const k = Store.state.selectedKey; if (!k) return;
  const [type, ti, idx] = k.split(":");
  const m = s.masks[0];
  const rec = previewState.visualEls.get("video:" + ti);
  if (!rec || !rec.el) return;
  const media = rec.el.querySelector("video,img");
  const stack = $("previewStack"); const sr = stack.getBoundingClientRect(); const mr = media.getBoundingClientRect();
  const mw = mr.width, mh = mr.height;
  const start = JSON.parse(JSON.stringify(m.params));
  const startX = e.clientX, startY = e.clientY;
  const cx0 = mr.left - sr.left + (0.5 + start.centerX) * mw;
  const cy0 = mr.top - sr.top + (0.5 + start.centerY) * mh;
  const startAng = Math.atan2(startY - cy0, startX - cx0) * 180 / Math.PI;
  maskDrag = { type, ti, idx, maskId: m.id, h, start, startX, startY, mw, mh, startAng, cx0, cy0, seg: s };
  window.addEventListener("pointermove", onMaskHandleMove);
  window.addEventListener("pointerup", onMaskHandleUp);
}
function onMaskHandleMove(e) {
  if (!maskDrag) return;
  const d = maskDrag; const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
  const p = d.seg.masks[0].params;   // 实时改同一对象（预览用）
  if (d.h === "pos") {
    p.centerX = d.start.centerX + dx / d.mw;
    p.centerY = d.start.centerY + dy / d.mh;
  } else if (d.h === "rot") {
    const ang = Math.atan2(e.clientY - d.cy0, e.clientX - d.cx0) * 180 / Math.PI;
    let nr = d.start.rotation + (ang - d.startAng);
    nr = ((nr % 360) + 360) % 360; p.rotation = nr;
  } else if (d.h === "scale") {
    const dist = Math.hypot(dx, dy); const base = Math.hypot(d.start.width * d.mw / 2, d.start.height * d.mh / 2) || 1;
    const sc = Math.max(0.05, Math.min(5, d.start.scale * (1 + dist / base)));
    p.scale = sc;
  } else if (d.h.startsWith("edge-")) {
    if (d.h === "edge-l" || d.h === "edge-r") {
      const sign = d.h === "edge-r" ? 1 : -1;
      p.width = Math.max(0.01, d.start.width + sign * dx * 2 / d.mw);
    } else {
      const sign = d.h === "edge-b" ? 1 : -1;
      p.height = Math.max(0.01, d.start.height + sign * dy * 2 / d.mh);
    }
  }
  renderPreview(); renderMaskOverlay();
}
function onMaskHandleUp() {
  if (!maskDrag) return;
  const d = maskDrag; maskDrag = null;
  window.removeEventListener("pointermove", onMaskHandleMove);
  window.removeEventListener("pointerup", onMaskHandleUp);
  const finalParams = JSON.parse(JSON.stringify(d.seg.masks[0].params));
  call("update_mask", d.type, +d.ti, +d.idx, d.maskId, finalParams).then(refresh);
}

/* 关键帧动画（Step 2b 收尾：从 HTML 迁入，纯搬移）——updateKfLiveValues/applyKfTransform/applyKfLiveAll */
function updateKfLiveValues() {
  const s = selectedSeg(); if (!s || !["video", "image", "sticker"].includes(s.type)) return;
  const anims = s.animations || {};
  const rowsEl = $("kfRows"); if (!rowsEl || rowsEl.style.display === "none") return;
  const local = Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration));
  rowsEl.querySelectorAll(".kf-row").forEach(row => {
    const path = row.dataset.path;
    const cur = kfVal(anims, path, local);
    const def = KF_PATHS.find(p => p[0] === path)[3];
    const inp = row.querySelector('[data-act="val"]');
    if (inp && document.activeElement !== inp) inp.value = round2(cur == null ? def : cur);
  });
}

// 把段的关键帧动画实时应用到预览元素（translate/scale/rotate/opacity）
// ★ v2 (2026-08-20) Transform Schema：三层解析 animation → params → legacy → default
// ★ C1.2 (2026-08-20)：读取走 PropertyResolver（唯一属性访问协议）——kfVal(animations[path])
//    → params[path] → legacy 旧字段 → default；与 kernel 的 transform.rotate 路径对齐。
// ⚠️ 贴纸(sticker)渲染仍用旧 seg.transform {x,y,scale,rotation,opacity,flipH,flipV}(百分比)，
//    renderer.js:215 独立处理，不经过本函数——旧结构统一到新 Schema 列为遗留(待后续单独处理)。
function resolveTransform(seg, localUs) {
  return {
    x:  resolveProperty(seg, "transform.positionX", localUs),
    y:  resolveProperty(seg, "transform.positionY", localUs),
    sx: resolveProperty(seg, "transform.scaleX", localUs),
    sy: resolveProperty(seg, "transform.scaleY", localUs),
    r:  resolveProperty(seg, "transform.rotate", localUs),
    o:  resolveProperty(seg, "transform.opacity", localUs),
  };
}

function applyKfTransform(el, seg, localUs) {
  // P1（2026-08-20）：拖动覆盖——PreviewInteraction 持有拖动中的值，renderer 读它应用（interactionDraft）
  // 替代旧 dataset.dragActive 方案（DOM 不持有交互状态）；refresh 锁(P0)保证拖动期间后端不回来覆盖。
  if (typeof PreviewInteraction !== "undefined" && PreviewInteraction.dragging(seg) && PreviewInteraction.override) {
    const t = resolveTransform(seg, localUs);
    const stack = $("previewStack"); const rect = stack ? stack.getBoundingClientRect() : null;
    const cp = canvasPxJS();
    const sc = (rect && rect.width) ? rect.width / cp.W : 1;
    const d = PreviewInteraction.override;
    el.style.transform = "translate(" + (d.x * sc) + "px," + (d.y * sc) + "px) scale(" + t.sx + "," + t.sy + ") rotate(" + t.r + "deg)";
    return;
  }
  const t = resolveTransform(seg, localUs);
  const stack = $("previewStack"); const rect = stack ? stack.getBoundingClientRect() : null;
  const cp = canvasPxJS();
  const sc = (rect && rect.width) ? rect.width / cp.W : 1;
  el.style.transform = "translate(" + (t.x * sc) + "px," + (t.y * sc) + "px) scale(" + t.sx + "," + t.sy + ") rotate(" + t.r + "deg)";
  el.style.opacity = t.o;
}

// 每帧把当前播放头处的关键帧动画应用到所有可见预览元素（播放/拖动时实时动画）。
// renderPreview 只在跨段切源时重建，同段播放不重跑 applyKfTransform，故需独立每帧调用。
function applyKfLiveAll() {
  const us = Store.state.playheadUs;
  for (const rec of previewState.visualEls.values()) {
    if (!rec.seg || rec.el.style.display === "none") continue;
    const local = Math.max(0, Math.min(us - rec.seg.start, rec.seg.duration));
    applyKfTransform(rec.el, rec.seg, local);
  }
  applyEffects();   // ★ Phase C：特效用播放头每帧重算（关键帧动画/静态都覆盖）
  // 音量关键帧实时增益（audio 轨由 AudioEngine 接管，每帧刷新）
  if (typeof AudioEngine !== "undefined" && AudioEngine.updateLiveGains) AudioEngine.updateLiveGains(us);
}
