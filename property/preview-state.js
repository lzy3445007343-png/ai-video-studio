/* =====================================================================
 * property/preview-state.js —— L0-03 前端共享预览态（preview/commit 两阶段）
 * =====================================================================
 * 对齐 OpenCut previewOverlay / previewTracks：连续交互（Player 拖元素 / Inspector 拖参 /
 * 时间轴拖 KF marker）期间，临时态写入本 overlay，不污染正式数据（seg.params/seg.animations）；
 * Player / Timeline / Inspector 三方经 getPreviewSeg 读取同一份预览态 → 三方一致；
 * 松手 commitPreview 落库并清 overlay；Esc/pointercancel discardPreview 零污染回退。
 *
 * 与既有 OverlayState 的关系：interaction-kernel.js 的 OverlayState 已委托本模块，
 * drag/resize/rotate 的 OverlayState.set/get/clear 即写同一份 overlay。
 *
 * 不碰 Api / draft_state.json / seg_id / track_type / 播放器内核 / Video DSL。
 * 依赖：无（纯前端容器；消费者在各自模块经 window.PreviewState 访问）。
 * ===================================================================== */
const PreviewState = {
  /* segId -> { "transform.scaleX": 1.5, "__kf__transform.positionX": {keys:[...]}, ... }
   * 普通属性路径存预览值；KF 通道以 "__kf__<path>" 为键存整通道（供插值/渲染）。 */
  _overlay: {},
  _subs: [],   // 订阅者：(segId) => void

  /* —— 写入方（连续交互临时态，不污染正式数据）——
   * set：普通属性路径预览值（如 transform.scaleX / audio.volume / opacity）
   * setPreviewChannel：KF 通道预览（整通道 keys） */
  set(segId, path, value) {
    if (segId == null) return;
    let o = this._overlay[segId];
    if (!o) o = this._overlay[segId] = {};
    o[path] = value;
    this._notify(segId);
  },
  setPreviewChannel(segId, path, channel) {
    if (segId == null) return;
    let o = this._overlay[segId];
    if (!o) o = this._overlay[segId] = {};
    o["__kf__" + path] = channel;
    this._notify(segId);
  },
  get(segId, path) {
    const o = this._overlay[segId];
    return o ? o[path] : undefined;
  },
  /* 读取某属性的预览通道（供 KF 图 / 时间轴 marker / 渲染层） */
  previewChannel(segId, path) {
    const o = this._overlay[segId];
    return o ? o["__kf__" + path] : undefined;
  },
  has(segId) { return !!(segId != null && this._overlay[segId]); },
  clear(segId) {
    if (segId != null && this._overlay[segId]) {
      delete this._overlay[segId];
      this._notify(segId);
    }
  },
  clearAll() { this._overlay = {}; },

  /* —— 合并读取（等价 OpenCut getPreviewTracks 元素级实现）——
   * 返回 seg 与 overlay 合并的浅视图：overlay（普通路径 + KF 通道）优先于 seg。
   * 无 overlay 时原样返回 seg（空闲态零开销、行为不变）。 */
  getPreviewSeg(seg) {
    if (!seg || seg.id == null || !this._overlay[seg.id]) return seg;
    const o = this._overlay[seg.id];
    const view = Object.assign({}, seg);
    if (view.animations && typeof view.animations === "object") {
      view.animations = Object.assign({}, view.animations);
    } else {
      view.animations = {};
    }
    for (const key in o) {
      if (key.indexOf("__kf__") === 0) {
        const path = key.slice(6);
        view.animations[path] = o[key];         // 预览通道覆盖（供 applyKfTransform 插值）
      } else {
        setNested(view, key, o[key]);           // 普通属性路径合并
      }
    }
    return view;
  },

  /* —— 订阅（供 L1-10 三方联动注册消费方）—— */
  subscribe(fn) {
    if (typeof fn === "function") this._subs.push(fn);
    return () => {
      const i = this._subs.indexOf(fn);
      if (i >= 0) this._subs.splice(i, 1);
    };
  },
  notifyPreviewConsumers(segId) { this._notify(segId); },
  _notify(segId) {
    for (const fn of this._subs) {
      try { fn(segId); } catch (e) { /* 订阅者异常不影响交互 */ }
    }
  },

  /* —— 提交 / 丢弃（一致于 OpenCut commitPreview / discardPreview）——
   * commitPreview：执行落库回调，无论成败都清 overlay（临时态不残留）。
   * discardPreview：仅清 overlay（Esc/pointercancel 零污染回退）。 */
  commitPreview(segId, commitFn) {
    try { if (typeof commitFn === "function") commitFn(segId); }
    finally { this.clear(segId); }
  },
  discardPreview(segId) { this.clear(segId); },
};

/* 路径写入工具："transform.scaleX" → view.transform.scaleX = v */
function setNested(obj, path, value) {
  const parts = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

if (typeof window !== "undefined") window.PreviewState = PreviewState;
