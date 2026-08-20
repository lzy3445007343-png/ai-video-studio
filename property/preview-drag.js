/* =====================================================================
 * property/preview-drag.js —— 预览拖动（Step2+3+4，对齐 OpenCut preview-interaction）
 * =====================================================================
 * 链路（GPT 评审 v2）：
 *   pointerdown → hit-test（closest [data-preview-el] → previewState.visualEls）
 *     → 选中联动（目标未选中则 selectKey 单选，OpenCut beginDragFromPending 语义）
 *     → 记录起始快照（鼠标偏移/起始 transform/localUs 快照）
 *   pointermove → 位移超阈值(3px)进拖动 → 只改 el.style + data-dragActive 标记
 *     （interactionDraft：不碰 seg/后端，refresh 替换 seg 对象也不丢；renderer 跳过该元素）
 *   pointerup → 恢复 renderer 接管 → commit：
 *     无动画通道 → set_segments_props({transform:{x,y,...}})（后端写 seg.transform）
 *     有动画通道 → add_keyframe(path, localSnap, value)（当前播放头处打点）
 *   v2 约束：播放中禁止拖动（编辑/播放分离）；第一版只拖 video/image；单击(3px 内)=只选中
 * 依赖：previewState/Store/selectKey/resolveTransform/canvasPxJS/kfSegArgs（全局）
 * ===================================================================== */
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
  const t = resolveTransform(previewDrag.seg, previewDrag.localSnap);
  const el = previewDrag.el;
  // interactionDraft：只改 DOM + 标记（不碰 seg/后端；refresh 替换 seg 也不丢；applyKfTransform 见标记跳过）
  el.dataset.dragActive = "1";
  el.style.transform = "translate(" + (nx * sc) + "px," + (ny * sc) + "px) scale(" + t.sx + "," + t.sy + ") rotate(" + t.r + "deg)";
  if (e.cancelable) e.preventDefault();
}

function onPreviewDragUp(e) {
  if (!previewDrag) return;
  const drag = previewDrag;
  previewDrag = null;
  delete drag.el.dataset.dragActive;                        // 恢复 renderer 接管
  if (!drag.moved || !drag.last) return;                    // 单击 → 只做选中（已 selectKey）
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
  delete previewDrag.el.dataset.dragActive;
  previewDrag = null;
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
