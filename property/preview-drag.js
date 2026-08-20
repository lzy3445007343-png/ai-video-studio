/* =====================================================================
 * property/preview-drag.js —— 预览拖动（Step2+3+4，对齐 OpenCut preview-interaction）
 * =====================================================================
 * 链路（GPT 评审 v2）：
 *   pointerdown → hit-test（closest [data-preview-el] → previewState.visualEls）
 *     → 选中联动（目标未选中则 selectKey 单选，OpenCut beginDragFromPending 语义）
 *     → 记录起始快照（鼠标偏移/起始 transform/localUs 快照）
 *   pointermove → 位移超阈值(3px)进拖动 → PreviewInteraction 持有 override（interactionDraft）
 *     （不碰 seg/后端；renderer 读 PreviewInteraction 应用拖动值）
 *   pointerup → commit：
 *     无动画通道 → update_segment_transform({transform})；有动画通道 → add_keyframe(localSnap)
 *     → 若拖动期间被 refresh 锁缓存了 pendingRefresh → 补一次 refresh
 *   P0（2026-08-20，GPT 评审）：Refresh Lock——拖动期间 refresh() 见 PreviewInteraction.active
 *     直接 return 并置 pendingRefresh，pointerup 后补刷。杜绝 500ms 轮询替换 draft 覆盖拖动预览。
 *   P1（2026-08-20）：PreviewInteraction 独立交互状态对象替代 dataset.dragActive（DOM 不持有状态）。
 *   v2 约束：播放中禁止拖动（编辑/播放分离）；第一版只拖 video/image；单击(3px 内)=只选中
 * 依赖：previewState/Store/selectKey/resolveTransform/canvasPxJS/kfSegArgs（全局）
 * ===================================================================== */

/* —— 交互状态（P1：document state 与 interaction state 分离） —— */
const PreviewInteraction = {
  active: false,
  segId: null,
  override: null,          // {x, y} 拖动中的值（interactionDraft）
  pendingRefresh: false,   // 拖动期间被锁的 refresh 请求（P0 refresh lock）
  begin(segId) { this.active = true; this.segId = segId; this.override = null; },
  update(x, y) { this.override = { x, y }; },
  dragging(seg) { return this.active && seg && seg.id === this.segId; },
  end() {
    const need = this.pendingRefresh;
    this.active = false; this.segId = null; this.override = null; this.pendingRefresh = false;
    return need;   // 返回是否需要在 commit 后补一次 refresh
  },
};

let previewDrag = null;

function _previewLocalUs(seg) {
  return Math.max(0, Math.min(Store.state.playheadUs - seg.start, seg.duration));
}
function _previewHasAnim(seg, path) {
  const a = (seg.animations || {})[path];
  return !!(a && a.keys && a.keys.length);
}
function _previewScale() {
  const stack = $("previewStack");
  const cp = canvasPxJS();
  const w = stack ? stack.getBoundingClientRect().width : 0;
  return (w && cp.W) ? w / cp.W : 1;
}

function onPreviewDragDown(e) {
  if (isPlaying) return;                                    // v2：播放中禁止拖动
  const t = e.target;
  const wrap = t && t.closest ? t.closest("[data-preview-el]") : null;
  if (!wrap || !wrap.id) return;
  const rec = previewState.visualEls.get(wrap.id);
  if (!rec || !rec.seg || rec.el.style.display === "none") return;
  const seg = rec.seg;
  if (seg.type !== "video" && seg.type !== "image") return; // 第一版只拖 video/image
  // 选中联动（OpenCut beginDragFromPending：目标未选中 → 单选）
  if (Store.state.selectedKey !== rec.key) selectKey(rec.key);
  const tr = resolveTransform(seg, _previewLocalUs(seg));
  const rect = wrap.getBoundingClientRect();
  PreviewInteraction.begin(seg.id);
  previewDrag = {
    seg, el: wrap, key: rec.key,
    startCX: e.clientX, startCY: e.clientY,
    offX: e.clientX - rect.left, offY: e.clientY - rect.top,   // 抓哪拖哪
    startX: tr.x, startY: tr.y,
    moved: false, last: null,
    localSnap: _previewLocalUs(seg),
    hasAnimX: _previewHasAnim(seg, "transform.positionX"),
    hasAnimY: _previewHasAnim(seg, "transform.positionY"),
  };
  try { $("previewStack").setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (e.cancelable) e.preventDefault();
}

function onPreviewDragMove(e) {
  if (!previewDrag) return;
  const dx = e.clientX - previewDrag.startCX;
  const dy = e.clientY - previewDrag.startCY;
  if (!previewDrag.moved && Math.hypot(dx, dy) < 3) return;   // 单击阈值（3px 内=选中）
  previewDrag.moved = true;
  const sc = _previewScale();
  const nx = Math.round((previewDrag.startX + dx / sc) * 100) / 100;
  const ny = Math.round((previewDrag.startY + dy / sc) * 100) / 100;
  previewDrag.last = { x: nx, y: ny };
  // interactionDraft（P1）：值存 PreviewInteraction，renderer 读它应用；不碰 seg/后端
  PreviewInteraction.update(nx, ny);
  const t = resolveTransform(previewDrag.seg, previewDrag.localSnap);
  const el = previewDrag.el;
  el.style.transform = "translate(" + (nx * sc) + "px," + (ny * sc) + "px) scale(" + t.sx + "," + t.sy + ") rotate(" + t.r + "deg)";
  if (e.cancelable) e.preventDefault();
}

function onPreviewDragUp(e) {
  if (!previewDrag) return;
  const drag = previewDrag;
  previewDrag = null;
  const needRefresh = PreviewInteraction.end();              // P0：释放 refresh 锁，取回被缓存的 pendingRefresh
  if (!drag.moved || !drag.last) {                           // 单击 → 只做选中（已 selectKey）
    if (needRefresh) refresh();
    return;
  }
  const nx = drag.last.x, ny = drag.last.y;
  if (drag.hasAnimX || drag.hasAnimY) {
    // 有动画通道 → 在当前 localSnap 处打关键帧（与面板 addKfAtPlayhead 同命令）
    const k = drag.key.split(":");
    const type = k[0], ti = +k[1], idx = +k[2];
    const jobs = [];
    if (drag.hasAnimX) jobs.push(call("add_keyframe", type, ti, idx, "transform.positionX", drag.localSnap, nx, "linear"));
    if (drag.hasAnimY) jobs.push(call("add_keyframe", type, ti, idx, "transform.positionY", drag.localSnap, ny, "linear"));
    Promise.all(jobs).then(() => refresh()).catch(err => console.error("[preview-drag] add_keyframe 失败:", err));
  } else {
    // 无动画通道 → 写 seg.transform（合并保留其他字段）
    const tr = drag.seg.transform || {};
    const next = {
      x: nx, y: ny,
      scaleX: tr.scaleX != null ? tr.scaleX : 1,
      scaleY: tr.scaleY != null ? tr.scaleY : 1,
      rotation: tr.rotation != null ? tr.rotation : 0,
      opacity: tr.opacity != null ? tr.opacity : 1,
    };
    call("update_segment_transform", { segid: drag.seg.id, transform: next })
      .then(refresh)
      .catch(err => console.error("[preview-drag] 写 transform 失败:", err));
  }
}

function onPreviewDragCancel() {
  if (!previewDrag) return;
  previewDrag = null;
  const needRefresh = PreviewInteraction.end();
  if (needRefresh) refresh();
}

function bindPreviewDrag() {
  const stack = $("previewStack");
  if (!stack) return;
  stack.addEventListener("pointerdown", onPreviewDragDown);
  stack.addEventListener("pointermove", onPreviewDragMove);
  stack.addEventListener("pointerup", onPreviewDragUp);
  stack.addEventListener("pointercancel", onPreviewDragCancel);
}
if (typeof window !== "undefined") {
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", bindPreviewDrag);
  else bindPreviewDrag();
}
