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

/* 辅助函数（C2 迁移时保留，供 DragSession 使用）
 * ★ KET（2026-08-22）：_previewLocalUs 保留作 fallback，正式路径走 EditContext.lockEditTime()
 *   （GPT §7/§8：一次手势只锁定一个 editTime，X/Y 都用 context.localUs） */
function _previewLocalUs(seg) {
  // B2.1 收口：统一走 TimelineMapper（global→local 钳制），不散落手写换算
  return (typeof TimelineMapper !== "undefined") ? TimelineMapper.playheadLocal(seg)
       : Math.max(0, Math.min(Store.state.playheadUs - seg.start, seg.duration));
}
function _previewHasAnim(seg, path) {
  const a = (seg.animations || {})[path];
  return !!(a && a.keys && a.keys.length);
}
function _previewScale() {
  // C5.1：统一显示缩放（legacy=stackW/cp.W 宽适配，viewport=fitScale×zoom）
  if (typeof PreviewCoordinate !== "undefined") return PreviewCoordinate.displayScale();
  const stack = $("previewStack");
  const cp = canvasPxJS();
  const w = stack ? stack.getBoundingClientRect().width : 0;
  return (w && cp.W) ? w / cp.W : 1;
}

/* L1-16：拖动激活阈值（逻辑像素，对齐 OpenCut MIN_DRAG_DISTANCE=0.5；按显示缩放换算，手感一致） */
const MIN_DRAG_DISTANCE = 0.5;

/* L1-06：预览区对齐线渲染（消费 SnapEngine.snapPreviewPosition 返回的 lines）。
 * 引擎返回 lines：axis="vertical" → 竖线（x=pos），axis="horizontal" → 横线（y=pos）；
 * pos 是相对画布中心的逻辑坐标（center=0, left=-W/2, right=W/2），经 PreviewCoordinate.toOverlay 转屏幕 px。
 * 注意：不与 renderer.js 的 SVGNS 重名（classic 脚本共享全局词法作用域，重声明即报错），故用 SVG_NS。 */
const SVG_NS = "http://www.w3.org/2000/svg";
function renderPreviewSnapGuides(lines) {
  const stack = $("previewStack");
  if (!stack) return;
  let g = $("previewSnapGuides");
  if (!g) {
    g = document.createElementNS(SVG_NS, "svg");
    g.id = "previewSnapGuides";
    g.setAttribute("class", "preview-snap-guides");
    stack.appendChild(g);
  }
  const W = stack.clientWidth, H = stack.clientHeight;
  g.setAttribute("width", W); g.setAttribute("height", H);
  while (g.firstChild) g.removeChild(g.firstChild);
  if (!lines || !lines.length) return;
  const map = (lx, ly) => PreviewCoordinate.toOverlay(lx, ly);
  for (const ln of lines) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("stroke", "rgba(255,255,255,.7)");
    l.setAttribute("stroke-width", "1");
    if (ln.axis === "vertical") {
      const x = map(ln.pos, 0).x;
      l.setAttribute("x1", x); l.setAttribute("x2", x);
      l.setAttribute("y1", 0); l.setAttribute("y2", H);
    } else {
      const y = map(0, ln.pos).y;
      l.setAttribute("y1", y); l.setAttribute("y2", y);
      l.setAttribute("x1", 0); l.setAttribute("x2", W);
    }
    g.appendChild(l);
  }
}
function hidePreviewSnapGuides() { const g = $("previewSnapGuides"); if (g) while (g.firstChild) g.removeChild(g.firstChild); }

class DragSession extends GestureSession {
  constructor(ctx) {
    super(ctx);
    this.moved = false;
  }
  onPointerMove(e) {
    const c = this.ctx;
    c.pointer.currentX = e.clientX; c.pointer.currentY = e.clientY;
    const dx = e.clientX - c.pointer.startX, dy = e.clientY - c.pointer.startY;
    const sc = _previewScale();
    if (!this.moved && Math.hypot(dx, dy) < MIN_DRAG_DISTANCE / sc) return;   // L1-16：0.5 逻辑像素激活（分支 A）
    this.moved = true;
    this.state = "active";
    // 从 path 快照算新值（v2：snapshot 是 path 化的，与 C1 kernel 对齐）
    let nx = Math.round((c.snapshot["transform.positionX"] + dx / sc) * 100) / 100;
    let ny = Math.round((c.snapshot["transform.positionY"] + dy / sc) * 100) / 100;
    // L1-06：预览区位置吸附（中心 + 四边对齐线，8 屏像素阈值；Shift 临时禁用吸附）。
    // 消费 SnapEngine.snapPreviewPosition（注意签名是 options 对象 {W,H,scale}，非位置参数）。
    if (typeof SnapEngine !== "undefined" && !SnapEngine.isShiftDisabled(e)) {
      const cp = canvasPxJS();
      const r = SnapEngine.snapPreviewPosition(nx, ny, { W: cp.W, H: cp.H, scale: sc });
      nx = r.x; ny = r.y;
      this._snapLines = r.lines;
      renderPreviewSnapGuides(this._snapLines);
    } else {
      this._snapLines = null;
      hidePreviewSnapGuides();
    }
    OverlayState.set(c.target.id, "transform.positionX", nx);
    OverlayState.set(c.target.id, "transform.positionY", ny);
    const t = resolveTransform(c.seg, c.localSnap);
    // C5.1：统一坐标定位（素材中心 = toOverlay，wrap 左上 = 中心 - 尺寸/2）
    const pos = PreviewCoordinate.toOverlay(nx, ny);
    const w = c.el.offsetWidth || 0, h = c.el.offsetHeight || 0;
    c.el.style.left = (pos.x - w / 2) + "px";
    c.el.style.top = (pos.y - h / 2) + "px";
    c.el.style.transform = "scale(" + t.sx + "," + t.sy + ") rotate(" + t.r + "deg)";
    // 2026-08-29 修复：拖位置时白框/手柄实时跟随素材（此前 DragSession 未刷新 overlay，
    // 且 renderTransformHandles 在 activeSession 期间直接 return，导致素材走了白框留原地）。
    if (typeof renderTransformHandles === "function") renderTransformHandles();
    if (e.cancelable) e.preventDefault();
  }
  onPointerUp(e) {
    if (e.cancelable) e.preventDefault();
    hidePreviewSnapGuides(); this._snapLines = null;   // L1-06：松手清理对齐线（先于 commit，避免残留）
    if (!this.moved) { InteractionManager.end(); return; }   // 单击 → 仅选中（已 selectKey）
    InteractionManager.commit();   // session.commit() 落库 + end()（destroy → clear overlay + 补刷）
  }
  commit() {
    const c = this.ctx;
    // FIX-2 防御（2026-08-20 真机反馈）：previewState.visualEls 的 rec.key 可能 stale
    // （段已删/折叠但 wrap 残留于 previewState，renderer.js:142 rec.key=h.key 无清理路径）。
    // 用 c.key 反查 Store 验证段仍在；不在则 warn + skip，避免刷'video[0] 没有第 1 段'日志+无效 add_keyframe。
    if (typeof findSegByKey === "function" && !findSegByKey(c.key)) {
      console.warn("[preview-drag] commit 跳过：段已不存在", c.key);
      return;
    }
    const nx = OverlayState.get(c.target.id, "transform.positionX");
    const ny = OverlayState.get(c.target.id, "transform.positionY");
    if (nx === undefined || ny === undefined) return;        // 没拖过 → 不落库
    const k = c.key.split(":");
    const args = { track_type: k[0], track_index: +k[1], index: +k[2] };
    const paths = ["transform.positionX", "transform.positionY"];
    const seg = c.seg;
    // ★ #B-04/#1 修复（2026-08-29，audit_log 为证）：KF 段拖拽"弹回"根因=只写 base，
    //   播放头处画面由 KF 插值决定→拖了看不见（用户 13:31 会话：拖 14 次每次只写 base、从不碰 KF）。
    //   修复：positionX/Y 有动画通道时，拖拽同步更新「当前播放头 localUs」的关键帧（无则新建），
    //   松手后播放头处显示=拖后值→不再弹回。base 仍同步写（非KF时刻/参数面板一致）。
    const localUs = (c.editCtx && c.editCtx.editTime) ? c.editCtx.editTime.localUs : _previewLocalUs(seg);
    const kfPaths = paths.filter(p => _previewHasAnim(seg, p));
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
    CommandService.withTx("drag-transform", () => {
      CommandService.run("update_segment_transform", Object.assign({}, args, {
        segid: c.target.id, transform: next,
      }), { actor: "ui", paths });
      // KF 通道：拖拽更新当前播放头关键帧（add_keyframe 严格同帧更新已有 KF，否则新建）
      for (const p of kfPaths) {
        const v = (p === "transform.positionX") ? nx : ny;
        CommandService.run("add_keyframe", {
          track_type: k[0], track_index: +k[1], index: +k[2],
          path: p, time_us: localUs, value: v, seg_mode: "linear", seg_id: c.target.id,
        }, { actor: "ui" });
      }
    }, { onError: e => console.error("[preview-drag] 写 transform/KF 失败:", e) });
  }
  cancel() { hidePreviewSnapGuides(); this._snapLines = null; if (this.ctx && this.ctx.target) PreviewState.discardPreview(this.ctx.target.id); }  // L1-06/L0-03：不落库，丢弃 overlay + 对齐线
  destroy() {
    OverlayState.clear(this.ctx.target.id);
    const need = InteractionManager.takePendingRefresh();
    if (need) refresh();           // 拖动中被锁的 refresh 补刷（commit 已 .then(refresh) 时重复一次，幂等无害）
  }
}

/* —— 薄壳事件 handler（语义与 C2 前完全一致） —— */
function onPreviewDragDown(e) {
  if (e.button !== 0) return;                                   // C5.3：只接管左键（中键=画布平移 viewport-input.js）
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
  // ── KF-AUDIT（2026-08-22，GPT 评审要求的时间链路审计）──────────────
  // 一次 preview-drag 手势的"唯一时间 ID"：pointerdown 时锁定，全程不变。
  // 目的：证明 X/Y 两个 add_keyframe 用的是不是同一个 localSnap / playheadUs。
  const gestureId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // ★ KET（2026-08-22）：EditContext 统一入口——lockEditTime() 锁定 immutable 时间基准，
  //   X/Y 都用 ctx.localUs（GPT §8：一次 Gesture 只产生一个 EditTimeContext）。
  //   fallback：旧版无 EditContext 时退回 _previewLocalUs（jsdom 冒烟兼容）。
  const editCtx = (typeof createEditContext === "function") ? createEditContext(rec.key) : null;
  const _localDown = editCtx ? editCtx.editTime.localUs : _previewLocalUs(seg);
  console.log("[KF-AUDIT] preview-drag pointerdown", JSON.stringify({
    gestureId, segStart: seg.start, segDur: seg.duration,
    playheadUs: Store.state.playheadUs, localSnap: _localDown,
    editCtx: !!editCtx,
  }));
  // ────────────────────────────────────────────────────────────────────
  // v2 ctx 三层：pointer（鼠标）/ target（操作对象）/ snapshot（事务前 path 快照）
  // DragSession 专属引用（seg/el/key/localSnap/hasAnimX/Y）放 ctx 顶层
  const ctx = {
    pointer: { id: e.pointerId, startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY },
    target: { type: "segment", id: seg.id },
    seg, el: wrap, key: rec.key, gestureId, editCtx,
    offX: e.clientX - rect.left, offY: e.clientY - rect.top,   // 抓哪拖哪
    snapshot: { "transform.positionX": tr.x, "transform.positionY": tr.y },
    localSnap: _localDown,
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
