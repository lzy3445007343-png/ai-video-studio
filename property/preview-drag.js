/* =====================================================================
 * property/preview-drag.js —— 预览拖动（DragSession，C2 迁移）
 * =====================================================================
 * 链路（C2 v2，GPT 评审）：
 *   pointerdown → hit-test（closest [data-preview-el] → previewState.visualEls）
 *     → 选中联动（目标未选中则 selectKey 单选，OpenCut beginDragFromPending 语义）
 *     → InteractionManager.begin("preview-transform", new DragSession(ctx))
 *   pointermove → manager.handleMove → DragSession：位移超阈值(3px)转 active
 *     → OverlayState.set(segId, "transform.positionX/Y", v)（interactionDraft，不碰 seg/后端）
 *     → 直接写 el.style.transform（拖动跟手）
 *   pointerup → manager.handleUp → DragSession.commit()：
 *     无动画通道 → setProperty + update_segment_transform（位置参数，弹回修复 6b06e2b 不回归）
 *     有动画通道 → add_keyframe（位置参数）
 *     → manager.end() → destroy：OverlayState.clear + pendingRefresh 补刷
 *   pointercancel → manager.handleCancel → cancel()（不落库）
 *   v2 约束：播放中禁止拖动；第一版只拖 video/image；单击(3px 内)=只选中
 * 依赖：InteractionManager/GestureSession/OverlayState（interaction-kernel.js）
 *       previewState/Store/selectKey/resolveTransform/canvasPxJS（全局）
 * ===================================================================== */

/* —— DragSession（kernel 不知道业务，DragSession 留在 preview-drag.js） —— */

/* 辅助函数（C2 迁移时保留，供 DragSession 使用） */
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

class DragSession extends GestureSession {
  constructor(ctx) {
    super(ctx);
    this.moved = false;
  }
  onPointerMove(e) {
    const c = this.ctx;
    c.pointer.currentX = e.clientX; c.pointer.currentY = e.clientY;
    const dx = e.clientX - c.pointer.startX, dy = e.clientY - c.pointer.startY;
    if (!this.moved && Math.hypot(dx, dy) < 3) return;   // 单击阈值（3px 内=选中）
    this.moved = true;
    this.state = "active";
    const sc = _previewScale();
    // 从 path 快照算新值（v2：snapshot 是 path 化的，与 C1 kernel 对齐）
    const nx = Math.round((c.snapshot["transform.positionX"] + dx / sc) * 100) / 100;
    const ny = Math.round((c.snapshot["transform.positionY"] + dy / sc) * 100) / 100;
    OverlayState.set(c.target.id, "transform.positionX", nx);
    OverlayState.set(c.target.id, "transform.positionY", ny);
    const t = resolveTransform(c.seg, c.localSnap);
    c.el.style.transform = "translate(" + (nx * sc) + "px," + (ny * sc) + "px) scale(" + t.sx + "," + t.sy + ") rotate(" + t.r + "deg)";
    if (e.cancelable) e.preventDefault();
  }
  onPointerUp(e) {
    if (e.cancelable) e.preventDefault();
    if (!this.moved) { InteractionManager.end(); return; }   // 单击 → 仅选中（已 selectKey）
    InteractionManager.commit();   // session.commit() 落库 + end()（destroy → clear overlay + 补刷）
  }
  commit() {
    const c = this.ctx;
    const nx = OverlayState.get(c.target.id, "transform.positionX");
    const ny = OverlayState.get(c.target.id, "transform.positionY");
    if (nx === undefined || ny === undefined) return;        // 没拖过 → 不落库
    const k = c.key.split(":");
    const args = { track_type: k[0], track_index: +k[1], index: +k[2] };
    const paths = ["transform.positionX", "transform.positionY"];
    if (c.hasAnimX || c.hasAnimY) {
      // 有动画通道 → 在当前 localSnap 处打关键帧（事务：一次拖动 = 一条 undo）
      const jobs = [];
      if (c.hasAnimX) jobs.push(CommandService.run("add_keyframe", Object.assign({}, args, {
        path: "transform.positionX", time_us: c.localSnap, value: nx, seg_mode: "linear",
      }), { actor: "ui", paths: ["transform.positionX"] }));
      if (c.hasAnimY) jobs.push(CommandService.run("add_keyframe", Object.assign({}, args, {
        path: "transform.positionY", time_us: c.localSnap, value: ny, seg_mode: "linear",
      }), { actor: "ui", paths: ["transform.positionY"] }));
      CommandService.withTx("drag-transform-kf", () => Promise.all(jobs).then(rs => {
        const bad = rs.find(r => !r || r.ok === false);
        if (bad) return { ok: false, error: (bad.error || "add_keyframe 失败") };
        return { ok: true };
      }), { onError: e => console.error("[preview-drag] add_keyframe 失败:", e) });
    } else {
      // 无动画通道 → 写静态 transform（C1.3：setProperty 统一 params + legacy mirror）
      const seg = c.seg;
      setProperties(seg, {
        "transform.positionX": nx,
        "transform.positionY": ny,
      });
      // 后端落盘（合并保留其他字段，从 params/旧字段取）
      const tr = seg.transform || {};
      const next = {
        x: nx, y: ny,
        scaleX: (typeof getProperty === "function") ? getProperty(seg, "transform.scaleX") : (tr.scaleX != null ? tr.scaleX : 1),
        scaleY: (typeof getProperty === "function") ? getProperty(seg, "transform.scaleY") : (tr.scaleY != null ? tr.scaleY : 1),
        rotation: (typeof getProperty === "function") ? getProperty(seg, "transform.rotate") : (tr.rotation != null ? tr.rotation : 0),
        opacity: (typeof getProperty === "function") ? getProperty(seg, "transform.opacity") : (tr.opacity != null ? tr.opacity : 1),
      };
      // 位置参数经 execute 包装：execute(cmd_id, args_dict) → fn(**args)——args 键名=Python 签名参数名
      CommandService.withTx("drag-transform", () => CommandService.run("update_segment_transform", Object.assign({}, args, {
        segid: c.target.id, transform: next,
      }), { actor: "ui", paths }), { onError: e => console.error("[preview-drag] 写 transform 失败:", e) });
    }
  }
  cancel() { /* 不落库，丢弃 overlay */ }
  destroy() {
    OverlayState.clear(this.ctx.target.id);
    const need = InteractionManager.takePendingRefresh();
    if (need) refresh();           // 拖动中被锁的 refresh 补刷（commit 已 .then(refresh) 时重复一次，幂等无害）
  }
}

/* —— 薄壳事件 handler（语义与 C2 前完全一致） —— */
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
  // v2 ctx 三层：pointer（鼠标）/ target（操作对象）/ snapshot（事务前 path 快照）
  // DragSession 专属引用（seg/el/key/localSnap/hasAnimX/Y）放 ctx 顶层
  const ctx = {
    pointer: { id: e.pointerId, startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY },
    target: { type: "segment", id: seg.id },
    seg, el: wrap, key: rec.key,
    offX: e.clientX - rect.left, offY: e.clientY - rect.top,   // 抓哪拖哪
    snapshot: { "transform.positionX": tr.x, "transform.positionY": tr.y },
    localSnap: _previewLocalUs(seg),
    hasAnimX: _previewHasAnim(seg, "transform.positionX"),
    hasAnimY: _previewHasAnim(seg, "transform.positionY"),
  };
  InteractionManager.begin("preview-transform", new DragSession(ctx));
  try { $("previewStack").setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (e.cancelable) e.preventDefault();
}
function onPreviewDragMove(e) { if (typeof InteractionManager !== "undefined") InteractionManager.handleMove(e); }
function onPreviewDragUp(e) { if (typeof InteractionManager !== "undefined") InteractionManager.handleUp(e); }
function onPreviewDragCancel() { if (typeof InteractionManager !== "undefined") InteractionManager.handleCancel(); }

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
