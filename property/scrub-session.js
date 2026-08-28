/* =====================================================================
 * property/scrub-session.js —— L1-17 通用 drag-to-scrub（ScrubSession + attachScrub）
 * =====================================================================
 * 对齐 OpenCut components/ui/number-field.tsx：数字字段（速度/音量/KF值/位移/旋转/透明度）
 * 左侧 icon 按住左右拖动改值（无需聚焦输入框，手感一致）。
 *
 * 设计（遵守 R3 边界 + 复用 InteractionKernel）：
 *   - 复用 interaction-kernel.js 的 GestureSession（生命周期 pending→active→ended）
 *     + InteractionManager.begin（单会话互斥 + refresh 锁：scrub 期间 previewActive() 为真，
 *       2s 轮询 refresh 自动停摆，无需各面板自行加 _scrubbing 守卫）。
 *   - Pointer Lock 锁定鼠标：movementX 增量累积；首帧跳过（锁定瞬间 movementX 可能异常）。
 *   - 两阶段对齐 PropertyDraft：onScrub(v) 走 preview（实时、不落库）；onScrubEnd(v) 走 commit（一条 undo）。
 *   - Esc / pointercancel → onCancel（内存态回退到起始值，零污染）。
 *   - 锁丢失（Esc/切窗/失焦）→ 提交（防值卡中间态），与已验证的 speed-panel 内联行为一致。
 * 不碰 Api / draft schema / seg_id / track_type / MCP / 播放器内核 / Video DSL。
 * 依赖：interaction-kernel.js（GestureSession/InteractionManager）、全局 refresh()。
 * ===================================================================== */

/* —— 分段灵敏度（对齐 OpenCut scrubRanges）：跨段自动切换消耗像素 —— */
function scrubAcrossRanges(start, px, ranges) {
  let v = start, remain = px;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (v < r.from) v = r.from;          // 钳到当前段下界
    if (v > r.to) continue;              // 已在更高速段，跳过
    const span = r.to - v;
    const pxForSpan = span * r.pxPerUnit;
    if (remain <= pxForSpan) {
      v += remain / r.pxPerUnit;
      remain = 0; break;
    } else {
      v = r.to; remain -= pxForSpan;      // 吃完本段，进入下一段
    }
  }
  if (remain > 0) {                       // 超出最高段后按最后一段灵敏度继续消耗
    const last = ranges[ranges.length - 1];
    v += remain / last.pxPerUnit;
  }
  const lo = ranges[0].from, hi = ranges[ranges.length - 1].to;
  return Math.max(lo, Math.min(hi, v));
}

/* —— ScrubSession：一次 drag-to-scrub 手势的临时态会话 —— */
class ScrubSession extends GestureSession {
  constructor(ctx) {
    super(ctx);
    this.el = ctx.el;
    this._start = (ctx.start != null) ? ctx.start : 0;
    this._sens = (ctx.sensitivity != null) ? ctx.sensitivity : 0.5;   // flat 灵敏度：每 px 改变值
    this._ranges = ctx.ranges || null;                                // 分段灵敏度（覆盖 flat）
    this._onScrub = ctx.onScrub || function () {};
    this._onEnd = ctx.onScrubEnd || function () {};
    this._onCancel = ctx.onCancel || function () {};
    this._cum = 0;
    this._last = this._start;
    this._primed = false;     // 首帧跳过标记
    this._ended = false;
    this._addListeners();
  }
  _compute(px) {
    if (this._ranges) return scrubAcrossRanges(this._start, px, this._ranges);
    return this._start + px * this._sens;
  }
  onPointerMove(e) {
    if (!this._primed) { this._primed = true; return; }   // 首帧跳过（Pointer Lock 激活瞬间 movementX 异常）
    this._cum += e.movementX;
    this._last = this._compute(this._cum);
    this._onScrub(this._last);
  }
  onPointerUp(e) { this.commit(); }
  onPointerCancel() { this.cancel(); }
  commit() {
    if (this._ended) return;
    this._ended = true;
    try { this._onEnd(this._last); }
    finally { this._teardown(); }
  }
  cancel() {
    if (this._ended) return;
    this._ended = true;
    try { this._onCancel(this._start); }   // 传起始值，确保回退到本次手势起点
    finally { this._teardown(); }
  }
  _teardown() {
    if (this._cleanup) { this._cleanup(); this._cleanup = null; }
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
  }
  destroy() {
    this._teardown();
    // 拖动中被 InteractionManager 锁的 refresh 补刷（幂等无害）
    const need = InteractionManager.takePendingRefresh();
    if (need) refresh();
  }
  _addListeners() {
    const onMove = (ev) => { if (InteractionManager.activeSession === this) InteractionManager.handleMove(ev); };
    const onUp = (ev) => { if (InteractionManager.activeSession === this) InteractionManager.handleUp(ev); };
    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); if (InteractionManager.activeSession === this) InteractionManager.handleCancel(); }
    };
    const onLock = () => {
      // 锁丢失（Esc/切窗/失焦）→ 提交，防值卡中间态（与 speed-panel 内联一致）
      if (!document.pointerLockElement && InteractionManager.activeSession === this) InteractionManager.handleUp({});
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerlockchange", onLock);
    this._cleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerlockchange", onLock);
    };
  }
}

/* —— attachScrub：把 icon 元素接成 scrub 手柄 ——
 * opts: { getStart?:()=>number, sensitivity?:number, ranges?:[{from,to,pxPerUnit}],
 *         onScrub:(v)=>void, onScrubEnd:(v)=>void, onCancel:()=>void } */
function attachScrub(iconEl, opts) {
  if (!iconEl) return;
  iconEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const start = (typeof opts.getStart === "function") ? opts.getStart() : (opts.start || 0);
    const session = new ScrubSession({
      el: iconEl,
      start: start,
      sensitivity: opts.sensitivity,
      ranges: opts.ranges || null,
      onScrub: opts.onScrub,
      onScrubEnd: opts.onScrubEnd,
      onCancel: opts.onCancel,
    });
    InteractionManager.begin("scrub-value", session);   // 单会话互斥 + refresh 锁
    try { iconEl.requestPointerLock(); } catch (err) { /* 降级：无 Pointer Lock 仍可用 movementX（指针在窗口内移动） */ }
  });
}

if (typeof window !== "undefined") {
  window.ScrubSession = ScrubSession;
  window.attachScrub = attachScrub;
  window.scrubAcrossRanges = scrubAcrossRanges;
}
