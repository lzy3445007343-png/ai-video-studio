/* =====================================================================
 * property/transform-handle.js —— C5.4 Transform Handle（缩放手柄 + 旋转手柄）
 * =====================================================================
 * 对齐 OpenCut transform-handle-controller.ts（GPT 评审 v2）：
 *   - corner-scale：distance 比等比缩放（scaleFactor = currentDistance/initialDistance）
 *     shift 锁定比例（OpenCut isShiftHeld → snappedScale=scaleFactor 无吸附）
 *   - edge-scale：旋转坐标系投影（xProjection = dx*cos+dy*sin），proposedScale = projection/baseAxisHalf
 *   - rotation：atan2 角度差（startAngle/currentAngle），归一化 ±180
 *   - 拖手柄 = 改静态 transform（清动画通道，OpenCut buildCornerScaleAnimationReset 语义）
 *   松手 commit → CommandService.withTx（一条 undo）
 * 依赖：GestureSession/InteractionManager/OverlayState（interaction-kernel.js）
 *       resolveTransform/applyKfTransform（renderer.js）CommandService（command.js）
 * ===================================================================== */
let transformOverlayReady = false;

function _transformOverlay() {
  let ov = $("transformOverlay");
  if (!ov) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.id = "transformOverlay";
    svg.setAttribute("class", "transform-overlay");
    svg.setAttribute("viewBox", "0 0 1 1");
    const stack = $("previewStack");
    if (stack) stack.appendChild(svg);
    ov = svg;
  }
  return ov;
}

/* —— 渲染选中 video/image 段的手柄（选中态/非播放时） —— */
function renderTransformHandles() {
  // 2026-08-20 修复：交互进行中（缩放/旋转 session active）绝不重建 overlay——
  // 否则按住的手柄元素被 innerHTML="" 销毁，pointerup 丢失 → session 永不结束 → "鼠标进预览框就停不下来"。
  if (typeof InteractionManager !== "undefined" && InteractionManager.activeSession) return;
  const ov = _transformOverlay();
  if (!ov) return;
  ov.innerHTML = "";
  const stack = $("previewStack");
  if (!stack) return;
  const W = stack.clientWidth || 1, H = stack.clientHeight || 1;
  ov.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const s = selectedSeg();
  if (!s || (s.type !== "video" && s.type !== "image")) return;
  if (typeof isPlaying !== "undefined" && isPlaying) return;   // 播放中不显示手柄
  const k = Store.state.selectedKey; if (!k) return;
  const [, tti] = k.split(":");
  const rec = previewState.visualEls.get("video:" + tti);
  if (!rec || !rec.el || rec.el.style.display === "none") return;
  const media = rec.el.querySelector("video,img"); if (!media) return;
  const sr = stack.getBoundingClientRect(); const mr = media.getBoundingClientRect();
  const ox = mr.left - sr.left, oy = mr.top - sr.top, mw = mr.width, mh = mr.height;
  if (mw < 1 || mh < 1) return;
  // 当前 transform（含关键帧插值）→ 旋转角度用于手柄布置
  const t = resolveTransform(s, Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)));
  const rot = (t.r || 0) * Math.PI / 180;
  const rp = (dx, dy) => [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot)];
  const cxs = ox + mw / 2, cys = oy + mh / 2;
  const hw = mw / 2, hh = mh / 2;
  // 选中框
  const box = document.createElementNS(SVGNS, "rect");
  box.setAttribute("class", "th-box");
  box.setAttribute("x", cxs - hw); box.setAttribute("y", cys - hh);
  box.setAttribute("width", mw); box.setAttribute("height", mh);
  box.setAttribute("transform", `rotate(${t.r || 0} ${cxs} ${cys})`);
  ov.appendChild(box);
  // 8 手柄（4 角 + 4 边）+ 顶部旋转手柄
  const mk = (kind, x, y) => {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("class", "th-handle" + (kind.startsWith("rot") ? " rot" : ""));
    c.setAttribute("data-h", kind);
    c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1)); c.setAttribute("r", 6);
    ov.appendChild(c);
  };
  const corners = [["tl", -hw, -hh], ["tr", hw, -hh], ["br", hw, hh], ["bl", -hw, hh]];
  for (const [k, dx, dy] of corners) { const [x, y] = rp(dx, dy); mk("corner-" + k, cxs + x, cys + y); }
  const edges = [["r", hw, 0], ["l", -hw, 0], ["t", 0, -hh], ["b", 0, hh]];
  for (const [k, dx, dy] of edges) { const [x, y] = rp(dx, dy); mk("edge-" + k, cxs + x, cys + y); }
  const [rx, ry] = rp(0, -(hh + 26));
  const line = document.createElementNS(SVGNS, "line");
  line.setAttribute("class", "th-rotline");
  line.setAttribute("x1", cxs); line.setAttribute("y1", cys);
  line.setAttribute("x2", (cxs + rx)); line.setAttribute("y2", (cys + ry));
  ov.appendChild(line);
  mk("rotation", cxs + rx, cys + ry);
  ov.dataset.ready = "1";
}

/* =====================================================================
 * ResizeSession —— 角/边缩放（extends GestureSession，对齐 OpenCut corner/edge scale）
 * ===================================================================== */
class ResizeSession extends GestureSession {
  constructor(ctx) { super(ctx); }
  // 2026-08-20 修复：必须覆写 onPointerUp——基类只 commit 不 end（activeSession 残留）
  // → 松手后鼠标移动仍触发 onPointerMove（"停不下来"）。与 DragSession 对齐：InteractionManager.commit()
  onPointerUp(e) {
    if (e.cancelable) e.preventDefault();
    InteractionManager.commit();   // session.commit() 落库 + end()（destroy → clear overlay + activeSession=null）
  }
  onPointerMove(e) {
    const c = this.ctx;
    const t = resolveTransform(c.seg, c.localSnap);
    let nsx = t.sx, nsy = t.sy;
    if (c.h.startsWith("corner")) {
      // OpenCut corner-scale：distance 比等比缩放（scaleX/scaleY 同乘 factor）
      // 统一屏幕坐标：anchor/initialDist 都是屏幕像素，dx/dy 不除 sc
      const dx = e.clientX - c.anchorCX, dy = e.clientY - c.anchorCY;
      const curDist = Math.sqrt(dx * dx + dy * dy) || 1;
      const factor = curDist / c.initialDist;
      nsx = Math.max(0.05, c.startSX * factor);
      nsy = Math.max(0.05, c.startSY * factor);
      if (e.shiftKey) {   // shift 锁定比例：以 start 比例统一
        const pr = c.startSY / (c.startSX || 1);
        nsy = nsx * pr;
      }
    } else {
      // OpenCut edge-scale：旋转坐标投影 → 单轴（proposedScale = projection/baseAxisHalf）
      const dx = e.clientX - c.anchorCX, dy = e.clientY - c.anchorCY;
      const rot = (t.r || 0) * Math.PI / 180;
      const proj = c.h === "edge-r" || c.h === "edge-l"
        ? (dx * Math.cos(rot) + dy * Math.sin(rot)) * (c.h === "edge-l" ? -1 : 1)
        : (-dx * Math.sin(rot) + dy * Math.cos(rot)) * (c.h === "edge-t" ? -1 : 1);
      if (c.h === "edge-r" || c.h === "edge-l") {
        nsx = Math.max(0.05, proj / ((c.startW || 1) / 2));
      } else {
        nsy = Math.max(0.05, proj / ((c.startH || 1) / 2));
      }
    }
    OverlayState.set(c.target.id, "transform.scaleX", Math.round(nsx * 100) / 100);
    OverlayState.set(c.target.id, "transform.scaleY", Math.round(nsy * 100) / 100);
    // 实时预览：位置不动（renderer 已定位），只覆盖 scale（拖动中 applyKfTransform 见 isActiveOn 跳过）
    const el = c.el;
    el.style.transform = "scale(" + nsx + "," + nsy + ") rotate(" + (t.r || 0) + "deg)";
    renderTransformHandles();   // 手柄跟随
    if (e.cancelable) e.preventDefault();
  }
  commit() {
    const c = this.ctx;
    const nsx = OverlayState.get(c.target.id, "transform.scaleX");
    const nsy = OverlayState.get(c.target.id, "transform.scaleY");
    if (nsx === undefined || nsy === undefined) return;
    const seg = c.seg;
    setProperties(seg, { "transform.scaleX": nsx, "transform.scaleY": nsy });
    const k = c.key.split(":");
    const next = {
      scaleX: nsx, scaleY: nsy,
      rotation: (typeof getProperty === "function") ? getProperty(seg, "transform.rotate") : 0,
    };
    CommandService.withTx("resize-transform", () =>
      CommandService.run("update_segment_transform",
        { track_type: k[0], track_index: +k[1], index: +k[2], segid: c.target.id, transform: next },
        { actor: "ui", paths: ["transform.scaleX", "transform.scaleY"] })
    );
  }
  destroy() {
    OverlayState.clear(this.ctx.target.id);   // 对齐 DragSession：交互结束清 overlay，防残留
    renderTransformHandles();
  }
}

/* =====================================================================
 * RotateSession —— 旋转（extends GestureSession，对齐 OpenCut rotation）
 * ===================================================================== */
class RotateSession extends GestureSession {
  constructor(ctx) { super(ctx); }
  // 2026-08-20 修复：同 ResizeSession——必须覆写 onPointerUp，基类只 commit 不 end
  onPointerUp(e) {
    if (e.cancelable) e.preventDefault();
    InteractionManager.commit();
  }
  onPointerMove(e) {
    const c = this.ctx;
    const el = c.el; const t = resolveTransform(c.seg, c.localSnap);
    // 元素中心（屏幕）
    const mr = el.getBoundingClientRect();
    const cx = mr.left + mr.width / 2, cy = mr.top + mr.height / 2;
    const curAng = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    let delta = curAng - c.startAng;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const nr = Math.round((c.startR + delta) * 10) / 10;
    OverlayState.set(c.target.id, "transform.rotate", nr);
    // 实时预览：位置不动，只覆盖 rotate
    el.style.transform = "scale(" + (t.sx || 1) + "," + (t.sy || 1) + ") rotate(" + nr + "deg)";
    renderTransformHandles();
    if (e.cancelable) e.preventDefault();
  }
  commit() {
    const c = this.ctx;
    const nr = OverlayState.get(c.target.id, "transform.rotate");
    if (nr === undefined) return;
    const seg = c.seg;
    setProperties(seg, { "transform.rotate": nr });
    const k = c.key.split(":");
    const next = {
      rotation: nr,
      scaleX: (typeof getProperty === "function") ? getProperty(seg, "transform.scaleX") : 1,
      scaleY: (typeof getProperty === "function") ? getProperty(seg, "transform.scaleY") : 1,
    };
    CommandService.withTx("rotate-transform", () =>
      CommandService.run("update_segment_transform",
        { track_type: k[0], track_index: +k[1], index: +k[2], segid: c.target.id, transform: next },
        { actor: "ui", paths: ["transform.rotate"] })
    );
  }
  destroy() {
    OverlayState.clear(this.ctx.target.id);
    renderTransformHandles();
  }
}

/* —— 手柄 pointerdown → 启动 Resize/Rotate session —— */
function onTransformHandleDown(e) {
  const hEl = e.target;
  const h = hEl && hEl.getAttribute ? hEl.getAttribute("data-h") : null;
  if (!h) return;
  if (typeof isPlaying !== "undefined" && isPlaying) return;   // 播放中禁止
  e.stopPropagation(); e.preventDefault();
  const s = selectedSeg(); if (!s) return;
  const k = Store.state.selectedKey; if (!k) return;
  const [, tti] = k.split(":");
  const rec = previewState.visualEls.get("video:" + tti);
  if (!rec || !rec.el) return;
  const stack = $("previewStack"); const sr = stack.getBoundingClientRect();
  const mr = rec.el.getBoundingClientRect();
  const t = resolveTransform(s, Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)));
  const startW = mr.width || 1, startH = mr.height || 1;
  const ctx = {
    pointer: { id: e.pointerId, startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY },
    target: { type: "segment", id: s.id },
    seg: s, el: rec.el, key: k,
    h, startSX: t.sx, startSY: t.sy, startR: t.r,
    startW, startH,
    anchorCX: mr.left - sr.left + startW / 2,
    anchorCY: mr.top - sr.top + startH / 2,
    initialDist: Math.hypot(startW, startH) / 2,   // corner 初始对角距离（中心到角）
    localSnap: Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)),
    startAng: Math.atan2((e.clientY - (mr.top + startH / 2)), (e.clientX - (mr.left + startW / 2))) * 180 / Math.PI,
  };
  if (h === "rotation") {
    InteractionManager.begin("rotate-transform", new RotateSession(ctx));
  } else {
    InteractionManager.begin("resize-transform", new ResizeSession(ctx));
  }
  try { $("previewStack").setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
}

function bindTransformHandles() {
  const ov = _transformOverlay();
  if (!ov) return;
  if (transformOverlayReady) return;
  transformOverlayReady = true;
  ov.addEventListener("pointerdown", onTransformHandleDown);
  // overlay 永远存在（初始隐藏），渲染逻辑管内容
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", bindTransformHandles);
  else bindTransformHandles();
}
