/* =====================================================================
 * property/preview-coordinate.js —— Canvas Coordinate Kernel（C5.1，GPT 评审 v2）
 * =====================================================================
 * 定位：预览画布的统一坐标系内核（不是 DOM 组件）——素材属性(x,y,scale) → viewport
 * transform → screen。未来手柄/对齐/吸附/框选/网格全部依赖它。
 *
 * 双轨迁移（GPT 最大护栏，同 C4 legacy/slice 思想）：
 *   mode = "legacy"   → 旧换算（现状，stackW/cp.W 宽适配 + 画布中心 + 位移）
 *   mode = "viewport" → 新换算（fitScale=min(vw/cw, vh/ch) 完整适配 + center + scale）
 *   渲染代码统一走 toOverlay()；zoom=1 且 view 比例==画布比例时两轨数学等价
 *   （非等价场景 viewport 是修复：legacy 在比例不匹配时位移失真）。
 *   验证等价后切 viewport 并删 legacy（Strangler）。
 *
 * 依赖：canvasPxJS（HTML 全局，读 draft.canvas.ratio）/$（store.js）
 * ===================================================================== */

const PreviewCoordinate = {
  /* —— 双轨模式（C5.2 前保持 legacy = 现状无感） —— */
  mode: "legacy",            // "legacy" | "viewport"

  /* —— viewport 状态（C5.2 Viewport 阶段启用） —— */
  zoom: 1,                   // 用户缩放倍率（1 = fit）
  centerX: 540, centerY: 304, // 画布中心（逻辑坐标，平移时变；随画布比例重置）
  fitScale: 1,               // 适配缩放 = min(vw/canvasW, vh/canvasH)

  get scale() { return this.fitScale * this.zoom; },
  canvasSize() { return canvasPxJS(); },          // {W, H} 画布逻辑尺寸
  viewportRect() {
    const s = $("previewStack");
    return s ? s.getBoundingClientRect() : { width: 1, height: 1, left: 0, top: 0 };
  },
  _vw() { return this.viewportRect().width; },
  _vh() { return this.viewportRect().height; },
  _legacyScale() { const cp = this.canvasSize(); return this._vw() / cp.W; },

  /* —— canvas 原点（屏幕坐标）：viewport 模式下画布左上角 —— */
  origin() {
    return {
      x: this._vw() / 2 - this.centerX * this.scale,
      y: this._vh() / 2 - this.centerY * this.scale,
    };
  },

  /* —— 换算（对齐 OpenCut preview-coords.ts） —— */
  canvasToOverlay(cx, cy) {
    const o = this.origin();
    return { x: o.x + cx * this.scale, y: o.y + cy * this.scale };
  },
  screenToCanvas(sx, sy) {
    const r = this.viewportRect();
    return {
      x: this.centerX + (sx - r.left - this._vw() / 2) / this.scale,
      y: this.centerY + (sy - r.top - this._vh() / 2) / this.scale,
    };
  },
  /* 素材位置（相对画布中心）→ 屏幕坐标 */
  positionToOverlay(px, py) {
    const cp = this.canvasSize();
    return this.canvasToOverlay(cp.W / 2 + px, cp.H / 2 + py);
  },

  /* —— legacy 旧换算（现状基线）：素材中心 = 画布中心 + 位移 —— */
  legacyPositionToOverlay(px, py) {
    const sc = this._legacyScale();
    return { x: this._vw() / 2 + px * sc, y: this._vh() / 2 + py * sc };
  },

  /* —— 统一入口（渲染代码只认这个） —— */
  toOverlay(px, py) {
    return this.mode === "viewport"
      ? this.positionToOverlay(px, py)
      : this.legacyPositionToOverlay(px, py);
  },

  /* —— 显示缩放（renderer 用；legacy=宽适配 sc，viewport=fitScale×zoom） —— */
  displayScale() {
    return this.mode === "viewport" ? this.scale : this._legacyScale();
  },

  /* =====================================================================
   * C5.2 Viewport 控制（对齐 OpenCut preview-viewport.tsx）
   * ===================================================================== */
  ZOOM_MIN: 0.25,
  ZOOM_MAX: 16,
  ZOOM_STEP: 1.25,

  // fitScale 随画布比例/容器尺寸更新（applyCanvasRatio 已把 stack 设成画布 fit 尺寸）
  refreshFitScale() {
    const cp = this.canvasSize();
    this.fitScale = (cp.W && this._vw()) ? Math.min(this._vw() / cp.W, this._vh() / cp.H) : 1;
    return this.fitScale;
  },
  _clampZoom(z) { return Math.max(this.ZOOM_MIN, Math.min(this.ZOOM_MAX, z)); },
  scaleZoom(factor) { this.zoom = this._clampZoom(this.zoom * factor); this.invalidate(); },
  zoomIn() { this.scaleZoom(this.ZOOM_STEP); },
  zoomOut() { this.scaleZoom(1 / this.ZOOM_STEP); },
  fitToScreen() { this.zoom = 1; this.resetPan(); this.invalidate(); },
  setActualSize() { const fs = this.refreshFitScale(); this.zoom = this._clampZoom(fs > 0 ? 1 / fs : 1); this.invalidate(); },
  setViewportPercent(percent) {
    const fs = this.refreshFitScale();
    this.zoom = this._clampZoom(fs > 0 ? percent / 100 / fs : 1);
    this.invalidate();
  },
  get zoomPercent() { return Math.round(this.displayScale() * 100); },
  resetPan() {
    const cp = this.canvasSize();
    this.centerX = cp.W / 2; this.centerY = cp.H / 2;
  },
  // 平移（center 偏移 + clamp 画布边界内，对齐 OpenCut clampViewportCenter）
  panByScreenDelta(dx, dy) {
    if (this.zoom <= 1 || (dx === 0 && dy === 0)) return;
    const cp = this.canvasSize();
    const s = this.scale;
    this.centerX = this._clampAxis(cp.W, this.centerX + dx / s, this._vw() / (2 * s));
    this.centerY = this._clampAxis(cp.H, this.centerY + dy / s, this._vh() / (2 * s));
    this.invalidate();
  },
  _clampAxis(axisSize, center, halfSpan) {
    if (halfSpan >= axisSize / 2) return axisSize / 2;
    return Math.max(halfSpan, Math.min(axisSize - halfSpan, center));
  },
  // 通知渲染（viewport 变化 → 预览重绘；频率低可接受全量，或后续切片定向）
  invalidate() {
    if (typeof renderAll === "function") { try { renderAll(Store.state); } catch (e) { console.error("[PreviewCoordinate] invalidate 渲染失败:", e); } }
  },
};
