/* =====================================================================
 * property/interaction-kernel.js —— Interaction Kernel（C2，GPT 评审 v2）
 * =====================================================================
 * 目标：用户操作产生的临时状态统一管理（document state 与 interaction state 分离）。
 *   - OverlayState：通用 path overlay（segId → { path: value }）——与 C1 Property Kernel 的 path 打通，
 *     缩放/旋转/框选/多选未来都进 overlay（v2 升级，不再拖动专属）
 *   - GestureSession 基类：生命周期状态机 pending → active → ended（commit/cancel 是方法不是状态）
 *   - InteractionManager：唯一会话入口 begin(type, session)（顶掉旧会话防并发）
 *     + Refresh Lock（blocksRefresh/notePendingRefresh/takePendingRefresh）——refresh 管道不知道具体操作
 * 约束（GPT sign-off）：
 *   - kernel 不知道 seg/previewStack/renderer/pointer 坐标（DragSession 在 preview-drag.js）
 *   - 不预留 Resize/Rotate 代码（只保证可 extends GestureSession）
 *   - 不碰 undo transaction（C3）
 * 依赖：无（纯内核，业务在各自 session）
 * ===================================================================== */

/* ---------- 1. OverlayState：通用 path overlay（L0-03 收口到 PreviewState 统一共享预览态）---------- */
const OverlayState = {
  set: (segId, path, value) => PreviewState.set(segId, path, value),
  get: (segId, path) => PreviewState.get(segId, path),
  seg: (segId) => (PreviewState.has(segId) ? PreviewState._overlay[segId] : null),
  clear: (segId) => PreviewState.clear(segId),
  clearAll: () => PreviewState.clearAll(),
};

/* ---------- 2. GestureSession 基类 ---------- */
class GestureSession {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.state = "pending";      // pending → active → ended（生命周期；commit/cancel 是方法）
  }
  onPointerMove(e) {}            // 子类：超阈值转 active
  onPointerUp(e) { this.commit(); }
  onPointerCancel() { this.cancel(); }
  commit() { this.state = "ended"; }      // 子类覆写：真正落库
  cancel() { this.state = "ended"; }      // 子类覆写：丢弃
  destroy() {}                   // 子类覆写：释放资源
}

/* ---------- 3. InteractionManager：唯一入口 + Refresh Lock ---------- */
const InteractionManager = {
  activeSession: null,
  _pendingRefresh: false,
  begin(type, session) {
    this.end();                    // 顶掉旧会话（防并发）
    session._type = type || "generic";
    this.activeSession = session;
    console.log("[Interaction] begin " + session._type);
  },
  end() {
    if (this.activeSession) {
      this.activeSession.destroy();
      this.activeSession = null;
    }
  },
  commit() { const s = this.activeSession; if (s) s.commit(); this.end(); },
  cancel() { const s = this.activeSession; if (s) s.cancel(); this.end(); },
  handleMove(e) { if (this.activeSession) this.activeSession.onPointerMove(e); },
  handleUp(e) { if (this.activeSession) this.activeSession.onPointerUp(e); },
  handleCancel() { this.cancel(); },
  // Refresh Lock（v2 上移）：交互期间任何 refresh 都应被锁（拖动/框选/旋转统一）
  blocksRefresh() { return !!this.activeSession; },
  notePendingRefresh() { this._pendingRefresh = true; },
  takePendingRefresh() { const p = this._pendingRefresh; this._pendingRefresh = false; return p; },
  // 渲染层问：这个目标是否正被交互覆盖（renderer 跳过接管）
  isActiveOn(targetId) {
    return !!(this.activeSession && this.activeSession.ctx &&
              this.activeSession.ctx.target && this.activeSession.ctx.target.id === targetId);
  },
};
