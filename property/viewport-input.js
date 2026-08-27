/* =====================================================================
 * property/viewport-input.js —— C5.3 Viewport Input（画布输入手势）
 * =====================================================================
 * 约定（2026-08-20 用户拍板，防与时间轴冲突）：
 *   Ctrl/Meta+滚轮 = 画布缩放（本文件，对齐 OpenCut；时间轴缩放改 Ctrl+Shift+滚轮）
 *   Shift+滚轮 = 时间轴横向滚动（同上，不抢）
 *   Alt/Cmd+滚轮 = 画布缩放（本文件，指数平滑 + RAF 防抖）
 *   中键拖拽     = 画布平移（本文件，zoom>1 才可平移，对齐 OpenCut canPan）
 *   左键拖素材   = DragSession（preview-drag.js，本文件不碰）
 *
 * 依赖：PreviewCoordinate（preview-coordinate.js）/ syncZoomUI（HTML 全局）
 * ===================================================================== */
let _panning = null;   // {pointerId, startX, startY} 中键平移会话

function bindViewportInput() {
  const stack = $("previewStack");
  if (!stack) return;
  if (typeof PreviewCoordinate === "undefined") return;

  /* 1. Alt/Cmd+滚轮 → 缩放（指数平滑，对齐 OpenCut zoom.ts: zoomFactor=exp(-delta/300)） */
  stack.addEventListener("wheel", e => {
    if (PreviewCoordinate.mode !== "viewport") return;
    if (!(e.ctrlKey || e.metaKey)) return;          // L1-12（分支 A，对齐 OpenCut）：Ctrl/Meta+滚轮=画布缩放；Shift 留给时间轴横向滚动
    e.preventDefault();
    const factor = Math.exp(-e.deltaY / 300);
    PreviewCoordinate.scaleZoom(factor);
    if (typeof syncZoomUI === "function") syncZoomUI();
  }, { passive: false });

  /* 2. 中键拖拽 → 平移（zoom>1 才可，panByScreenDelta 内部有 clamp） */
  stack.addEventListener("pointerdown", e => {
    if (e.button !== 1) return;                    // 只接管中键
    if (PreviewCoordinate.mode !== "viewport") return;
    e.preventDefault();
    _panning = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      centerX0: PreviewCoordinate.centerX, centerY0: PreviewCoordinate.centerY,
    };
    try { stack.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  stack.addEventListener("pointermove", e => {
    if (!_panning || e.pointerId !== _panning.pointerId) return;
    const dx = e.clientX - _panning.startX, dy = e.clientY - _panning.startY;
    PreviewCoordinate.panByScreenDelta(dx, dy);    // 内含 zoom<=1 拒绝 + clampAxis
    if (typeof syncZoomUI === "function") syncZoomUI();
  });
  stack.addEventListener("pointerup", e => {
    if (_panning && e.pointerId === _panning.pointerId) _panning = null;
  });
  stack.addEventListener("pointercancel", () => { _panning = null; });
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", bindViewportInput);
  else bindViewportInput();
}
