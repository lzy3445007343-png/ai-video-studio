/* =====================================================================
 * property/transform-handle.js —— C5.4 Transform Handle（缩放手柄 + 旋转手柄）
 * =====================================================================
 * 对齐 OpenCut transform-handle-controller.ts（GPT 评审 v2）：
 *   - corner-scale：distance 比等比缩放（scaleFactor = currentDistance/initialDistance）
 *     shift 锁定比例（OpenCut isShiftHeld → snappedScale=scaleFactor 无吸附）
 *   - edge-scale：旋转坐标系投影（xProjection = dx*cos+dy*sin），proposedScale = projection/baseAxisHalf
 *   - rotation：atan2 角度差（startAngle/currentAngle），归一化 ±180
 *   - 拖手柄：有动画通道的属性 → 同步更新「当前播放头」关键帧（无则新建，对齐位置拖拽 #B-04）；
 *     无动画通道 → 写静态 transform base（旧 reset 语义仅用于非KF段）。
 *   松手 commit → CommandService.withTx（位置/缩放/旋转各一条 undo；KF 同步合并进同一条 undo）
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

/* L1-15：按手柄类型 × 元素当前旋转角给出方向光标（对齐 OpenCut getResizeCursor） */
function getResizeCursor(h, rotDeg) {
  if (h === "rotation") return "grab";
  const base = {
    "edge-l": 0, "edge-r": 0, "edge-t": 90, "edge-b": 90,
    // P5-1 修正：原写 tl/br=-45、tr/bl=+45，算出来的光标与 OpenCut 正好相反
    // （复刻 .corner：tl=nwse-resize、tr=nesw-resize、bl=nesw-resize、br=nwse-resize）。
    // 现象：没旋转时拖左上角，光标显示的是 nesw，方向和实际拉伸轴不一致。
    "corner-tl": 45, "corner-br": 45, "corner-tr": -45, "corner-bl": -45,
  }[h];
  // 归一到 [0,180)
  const a = (((base + (rotDeg || 0)) % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return "ew-resize";
  if (a < 67.5) return "nwse-resize";
  if (a < 112.5) return "ns-resize";
  return "nesw-resize";
}

/* —— 计算手柄几何（完整重建 & 轻量更新共用） —— */
function _computeHandleGeometry() {
  const stack = $("previewStack");
  if (!stack) return null;
  const s = selectedSeg();
  if (!s || (s.type !== "video" && s.type !== "image")) return null;
  if (typeof isPlaying !== "undefined" && isPlaying) return null;
  const k = Store.state.selectedKey; if (!k) return null;
  const [, tti] = k.split(":");
  const rec = previewState.visualEls.get("video:" + tti);
  if (!rec || !rec.el || rec.el.style.display === "none") return null;
  const media = rec.el.querySelector("video,img"); if (!media) return null;
  const sr = stack.getBoundingClientRect(); const mr = media.getBoundingClientRect();
  const ox = mr.left - sr.left, oy = mr.top - sr.top, mw = mr.width, mh = mr.height;
  if (mw < 1 || mh < 1) return null;
  const t = resolveTransform(s, Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)));
  const rot = (t.r || 0) * Math.PI / 180;
  const rp = (dx, dy) => [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot)];
  const cxs = ox + mw / 2, cys = oy + mh / 2;
  const hw = mw / 2, hh = mh / 2;
  const corners = [["tl", -hw, -hh], ["tr", hw, -hh], ["br", hw, hh], ["bl", -hw, hh]];
  const edges = [["r", hw, 0], ["l", -hw, 0], ["b", 0, hh]];
  const [rx, ry] = rp(0, -(hh + 26));
  return { s, t, rot, rp, cxs, cys, hw, hh, ox, oy, mw, mh, corners, edges, rx, ry };
}

/* —— 轻量更新已有手柄（交互进行中不重建 DOM，只改坐标/旋转） —— */
function _updateTransformHandles() {
  const ov = _transformOverlay();
  if (!ov || ov.dataset.ready !== "1") return false;
  const g = _computeHandleGeometry();
  if (!g) return false;
  const { t, cxs, cys, hw, hh, rp, corners, edges, rx, ry } = g;
  const box = ov.querySelector(".th-box");
  if (!box) return false;
  box.setAttribute("x", cxs - hw); box.setAttribute("y", cys - hh);
  box.setAttribute("width", g.mw); box.setAttribute("height", g.mh);
  box.setAttribute("transform", `rotate(${t.r || 0} ${cxs} ${cys})`);
  const groups = Array.from(ov.querySelectorAll("[data-h]"));
  const kinds = [
    ...corners.map(([k, dx, dy]) => { const [x, y] = rp(dx, dy); return { kind: "corner-" + k, x: cxs + x, y: cys + y }; }),
    ...edges.map(([k, dx, dy]) => { const [x, y] = rp(dx, dy); return { kind: "edge-" + k, x: cxs + x, y: cys + y }; }),
    { kind: "rotation", x: cxs + rx, y: cys + ry }
  ];
  for (const item of kinds) {
    const grp = groups.find(el => el.getAttribute("data-h") === item.kind);
    if (!grp) continue;
    const hit = grp.querySelector(".th-handle-hit");
    if (hit) { hit.setAttribute("cx", item.x.toFixed(1)); hit.setAttribute("cy", item.y.toFixed(1)); hit.style.cursor = getResizeCursor(item.kind, t.r || 0); }
    if (item.kind.startsWith("rot")) {
      const vis = grp.querySelector(".th-handle.rot");
      if (vis) { vis.setAttribute("cx", item.x.toFixed(1)); vis.setAttribute("cy", item.y.toFixed(1)); }
      const ic = grp.querySelector(".th-rot-icon");
      if (ic) ic.setAttribute("transform", `translate(${(item.x - 6).toFixed(1)} ${(item.y - 6).toFixed(1)}) scale(0.5)`);
    } else if (item.kind.startsWith("corner")) {
      const vis = grp.querySelector(".th-corner");
      if (vis) { vis.setAttribute("x", (item.x - 5).toFixed(1)); vis.setAttribute("y", (item.y - 5).toFixed(1)); vis.setAttribute("transform", `rotate(${t.r || 0} ${item.x.toFixed(1)} ${item.y.toFixed(1)})`); }
    } else {
      const vis = grp.querySelector(".th-handle.edge");
      if (vis) { vis.setAttribute("cx", item.x.toFixed(1)); vis.setAttribute("cy", item.y.toFixed(1)); }
    }
  }
  const line = ov.querySelector(".th-rotline");
  if (line) { line.setAttribute("x1", cxs); line.setAttribute("y1", cys); line.setAttribute("x2", cxs + rx); line.setAttribute("y2", cys + ry); }
  return true;
}

/* —— 渲染选中 video/image 段的手柄（选中态/非播放时） —— */
function renderTransformHandles() {
  const ov = _transformOverlay();
  if (!ov) return;
  const stack = $("previewStack");
  if (!stack) return;
  // 2026-08-29 修复：交互进行中（位置拖拽/缩放/旋转 session active）不做完整重建——
  // 否则按住的手柄元素被 innerHTML="" 销毁，pointerup 丢失 → session 永不结束。
  // 改为轻量更新：只改已有 SVG 元素的坐标/旋转，不动 DOM 结构。
  if (typeof InteractionManager !== "undefined" && InteractionManager.activeSession) {
    if (_updateTransformHandles()) return;
    // 轻量更新失败（overlay 未就绪）→ 不回退到完整重建，避免销毁手柄
    return;
  }
  ov.innerHTML = "";
  const W = stack.clientWidth || 1, H = stack.clientHeight || 1;
  ov.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const g = _computeHandleGeometry();
  if (!g) return;
  const { t, cxs, cys, hw, hh, rp, corners, edges, rx, ry } = g;
  // 选中框
  const box = document.createElementNS(SVGNS, "rect");
  box.setAttribute("class", "th-box");
  box.setAttribute("x", cxs - hw); box.setAttribute("y", cys - hh);
  box.setAttribute("width", g.mw); box.setAttribute("height", g.mh);
  box.setAttribute("transform", `rotate(${t.r || 0} ${cxs} ${cys})`);
  ov.appendChild(box);
  // 8 手柄（4 角 + 4 边）+ 顶部旋转手柄
  // L1-16：命中层（r=9 透明，pointer-events:auto）包视觉层（r=6，pointer-events:none）；
  //        data-h 挂在 g 上，命中层在外 3px 仍可命中；光标由 L1-15 getResizeCursor 决定。
  // P5-1（2026-08-28）对齐 OpenCut-UI-复刻.html：
  //   角 = 10x10 纯白方块（rx=1，对应复刻 .corner 的 border-radius:1px），并绕自身中心再转一次，
  //        保证元素被旋转后角块仍与框边平行（位置已由 rp() 转过，这里只转朝向）；
  //   旋转柄 = 20px 白圆 + 12px 黑色 rotate-cw 图标（复刻 .rot-handle 是白圆黑图标）；
  //   边 = 8px 白圆点（OpenCut 没有边手柄，这是我们的 edge-scale 能力，视觉上弱化）。
  // 旧版统一是「12px 白圆 + 1.4px 蓝描边」，旋转柄是黄圆，看不出角/边/旋转的区别。
  const mk = (kind, x, y) => {
    const grp = document.createElementNS(SVGNS, "g");
    grp.setAttribute("data-h", kind);
    const hit = document.createElementNS(SVGNS, "circle");
    hit.setAttribute("class", "th-handle-hit");
    hit.setAttribute("cx", x.toFixed(1)); hit.setAttribute("cy", y.toFixed(1));
    hit.setAttribute("r", kind.startsWith("rot") ? 12 : 9);   // 旋转柄视觉 r=10，命中区必须比它大
    hit.style.cursor = getResizeCursor(kind, t.r || 0);
    grp.appendChild(hit);
    if (kind.startsWith("rot")) {
      const vis = document.createElementNS(SVGNS, "circle");
      vis.setAttribute("class", "th-handle rot");
      vis.setAttribute("cx", x.toFixed(1)); vis.setAttribute("cy", y.toFixed(1)); vis.setAttribute("r", 10);
      grp.appendChild(vis);
      const ic = document.createElementNS(SVGNS, "g");
      ic.setAttribute("class", "th-rot-icon");
      ic.setAttribute("transform", `translate(${(x - 6).toFixed(1)} ${(y - 6).toFixed(1)}) scale(0.5)`);
      ic.innerHTML = '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>';
      grp.appendChild(ic);
    } else if (kind.startsWith("corner")) {
      const vis = document.createElementNS(SVGNS, "rect");
      vis.setAttribute("class", "th-corner");
      vis.setAttribute("x", (x - 5).toFixed(1)); vis.setAttribute("y", (y - 5).toFixed(1));
      vis.setAttribute("width", 10); vis.setAttribute("height", 10); vis.setAttribute("rx", 1);
      vis.setAttribute("transform", `rotate(${t.r || 0} ${x.toFixed(1)} ${y.toFixed(1)})`);
      grp.appendChild(vis);
    } else {
      const vis = document.createElementNS(SVGNS, "circle");
      vis.setAttribute("class", "th-handle edge");
      vis.setAttribute("cx", x.toFixed(1)); vis.setAttribute("cy", y.toFixed(1)); vis.setAttribute("r", 4);
      grp.appendChild(vis);
    }
    ov.appendChild(grp);
  };
  for (const [k, dx, dy] of corners) { const [x, y] = rp(dx, dy); mk("corner-" + k, cxs + x, cys + y); }
  for (const [k, dx, dy] of edges) { const [x, y] = rp(dx, dy); mk("edge-" + k, cxs + x, cys + y); }
  const line = document.createElementNS(SVGNS, "line");
  line.setAttribute("class", "th-rotline");
  line.setAttribute("x1", cxs); line.setAttribute("y1", cys);
  line.setAttribute("x2", (cxs + rx)); line.setAttribute("y2", (cys + ry));
  ov.appendChild(line);
  mk("rotation", cxs + rx, cys + ry);
  ov.dataset.ready = "1";
}

/* =====================================================================
 * 缩放公共常量 / 辅助（2026-08-29 修复「拖手柄手感不跟手 + 素材比例被写坏」）
 * =====================================================================
 * 历史 bug（两个叠加，同一次修复）：
 *  ① 坐标系混用：按下时 anchorCX = mr.left - sr.left（相对 previewStack），
 *     移动时 dx = e.clientX（视口坐标）- anchorCX → dx 恒定偏移 sr.left（约 250px）。
 *     后果：离中心越近畸变越大；edge 的 proj 甚至会变负 → clamp 成下限 0.01 落盘。
 *  ② 基准量取错：corner 用 hypot(startW,startH)/2、edge 用 startW/2 ——
 *     都假设「鼠标正好压在手柄几何点上」。但手柄命中区有 18px，且 getBoundingClientRect
 *     在元素旋转后返回的是**包围盒**（比元素本身大）→ 按下瞬间 factor≠1，素材先跳一下。
 * 修法：统一到视口坐标 + 基准量改为「按下瞬间鼠标到中心的真实距离/投影」的比值法。
 * ===================================================================== */
const MIN_SCALE = 0.02;   // 缩放可写库下限（低于此值素材已不可见，判定为异常）
const MAX_SCALE = 50;     // 缩放可写库上限（防御性，正常操作远达不到）

/* 缩放落库闸门：宁可"没反应"也不把异常值写进工程文件 */
function isSaneScale(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_SCALE && v <= MAX_SCALE;
}

/* 内联 KF 通道判定（不依赖 preview-drag.js 的 _previewHasAnim，避免脚本加载顺序红线）。
 * 与 _previewHasAnim 语义一致：segment.animations[path].keys 存在且非空 → 视为有动画通道。 */
function _hasAnim(seg, path) {
  return !!(seg && seg.animations && seg.animations[path]
    && Array.isArray(seg.animations[path].keys) && seg.animations[path].keys.length);
}

/* 边手柄投影：把「鼠标相对中心的位移」投影到该边对应的旋转轴上。
 * 与 OpenCut 的 xProjection/yProjection 同思路；因本处改用比值法，只求投影长度。 */
function projOf(h, dx, dy, rotDeg) {
  const rot = (rotDeg || 0) * Math.PI / 180;
  if (h === "edge-r" || h === "edge-l") {
    return (dx * Math.cos(rot) + dy * Math.sin(rot)) * (h === "edge-l" ? -1 : 1);
  }
  return (-dx * Math.sin(rot) + dy * Math.cos(rot)) * (h === "edge-t" ? -1 : 1);
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
    // 位移：视口坐标系（anchorCX/CY 已在 onTransformHandleDown 统一为视口坐标）
    const dx = e.clientX - c.anchorCX, dy = e.clientY - c.anchorCY;
    // ★ 比值法（2026-08-29 修复）：一律「当前量 / 按下时量」× 起始 scale。
    //   好处：① 按下瞬间 factor=1，素材不跳 ② 与元素像素尺寸无关（不受旋转包围盒影响）
    //         ③ 无量纲，与画布 zoom/fit 无关 ④ 不会算出负值。
    if (c.h.startsWith("corner")) {
      // OpenCut corner-scale：distance 比等比缩放（scaleX/scaleY 同乘 factor）
      const curDist = Math.sqrt(dx * dx + dy * dy) || 1;
      const factor = curDist / c.initialDist;
      nsx = Math.max(MIN_SCALE, c.startSX * factor);
      nsy = Math.max(MIN_SCALE, c.startSY * factor);
      // Q4 分支A（用户 2026-08-27 裁定）：移除 Shift 锁比例，Shift 仅用于禁用吸附（对齐 OpenCut）
    } else {
      // OpenCut edge-scale：旋转坐标投影 → 单轴
      const proj = projOf(c.h, dx, dy, t.r || 0);
      // 分母保护：按下时鼠标若恰好落在中心轴上，initialProj≈0 会让 factor 爆掉
      const denom = Math.abs(c.initialProj) < 1 ? 1 : c.initialProj;
      const factor = proj / denom;
      if (c.h === "edge-r" || c.h === "edge-l") {
        nsx = Math.max(MIN_SCALE, c.startSX * factor);
      } else {
        nsy = Math.max(MIN_SCALE, c.startSY * factor);
      }
    }
    // L1-08 整数比例吸附（Shift 禁用吸附时跳过）
    if (!SnapEngine.isShiftDisabled(e)) {
      const snapped = SnapEngine.snapScaleAxes(nsx, nsy);
      nsx = snapped.sx; nsy = snapped.sy;
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
    // ★ 落库闸门（2026-08-29）：历史上因坐标系 bug 把 scaleX 写成 0.01 并落盘，
    //   重启后素材变成一条竖线——用户一直以为是"重启弄坏的"，实际是上一次拖手柄就写坏了。
    //   这里对落库值做合理性检查，越界就整笔丢弃：宁可"拖了没反应"，也不写坏工程文件。
    if (!isSaneScale(nsx) || !isSaneScale(nsy)) {
      console.warn("[transform] 缩放落库值异常已丢弃", { nsx, nsy, startSX: c.startSX, startSY: c.startSY, h: c.h });
      return;
    }
    const seg = c.seg;
    // P7-KF语义②（2026-08-29）：KF 段缩放拖拽 → 与位置拖拽 #B-04 对齐，同步更新「当前播放头 localUs」
    //   的关键帧（无则新建）；无 scale 动画通道才走旧 reset 语义（清通道 + 写 base）。
    const localUs = c.localSnap;
    const kfPaths = ["transform.scaleX", "transform.scaleY"].filter(p => _hasAnim(seg, p));
    setProperties(seg, { "transform.scaleX": nsx, "transform.scaleY": nsy });  // base 始终同步写（非KF时刻/参数面板一致）
    const k = c.key.split(":");
    const next = {
      scaleX: nsx, scaleY: nsy,
      rotation: (typeof getProperty === "function") ? getProperty(seg, "transform.rotate") : 0,
    };
    CommandService.withTx("resize-transform", () => {
      CommandService.run("update_segment_transform",
        { track_type: k[0], track_index: +k[1], index: +k[2], segid: c.target.id, transform: next },
        { actor: "ui", paths: ["transform.scaleX", "transform.scaleY"] });
      // scale 通道：拖拽更新当前播放头关键帧（add_keyframe 严格同帧更新已有 KF，否则新建）
      for (const p of kfPaths) {
        const v = (p === "transform.scaleX") ? nsx : nsy;
        CommandService.run("add_keyframe", {
          track_type: k[0], track_index: +k[1], index: +k[2],
          path: p, time_us: localUs, value: v, seg_mode: "linear", seg_id: c.target.id,
        }, { actor: "ui" });
      }
    }, { onError: e => console.error("[transform] 写 scale/KF 失败:", e) });
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
    let nr = Math.round((c.startR + delta) * 10) / 10;
    // L0-04：旋转 90°±5° 吸附（SnapEngine.snapRotation；按住 Shift 临时关闭吸附）
    if (!SnapEngine.isShiftDisabled(e)) nr = SnapEngine.snapRotation(nr);
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
    // P7-KF语义②（2026-08-29）：KF 段旋转拖拽 → 与位置/缩放对齐，同步更新当前播放头关键帧（无则新建）；
    //   无 rotate 动画通道才写 base。
    const localUs = c.localSnap;
    const kfPaths = ["transform.rotate"].filter(p => _hasAnim(seg, p));
    setProperties(seg, { "transform.rotate": nr });  // base 始终同步写
    const k = c.key.split(":");
    const next = {
      rotation: nr,
      scaleX: (typeof getProperty === "function") ? getProperty(seg, "transform.scaleX") : 1,
      scaleY: (typeof getProperty === "function") ? getProperty(seg, "transform.scaleY") : 1,
    };
    CommandService.withTx("rotate-transform", () => {
      CommandService.run("update_segment_transform",
        { track_type: k[0], track_index: +k[1], index: +k[2], segid: c.target.id, transform: next },
        { actor: "ui", paths: ["transform.rotate"] });
      for (const p of kfPaths) {
        CommandService.run("add_keyframe", {
          track_type: k[0], track_index: +k[1], index: +k[2],
          path: p, time_us: localUs, value: nr, seg_mode: "linear", seg_id: c.target.id,
        }, { actor: "ui" });
      }
    }, { onError: e => console.error("[transform] 写 rotate/KF 失败:", e) });
  }
  destroy() {
    OverlayState.clear(this.ctx.target.id);
    renderTransformHandles();
  }
}

/* —— 手柄 pointerdown → 启动 Resize/Rotate session —— */
function onTransformHandleDown(e) {
  // L1-16：data-h 现挂在 g 上；视觉圆 pointer-events:none，必须沿 DOM 树向上找最近的 [data-h]
  const hEl = e.target && e.target.closest ? e.target.closest("[data-h]") : null;
  const h = hEl ? hEl.getAttribute("data-h") : null;
  if (!h) return;
  if (typeof isPlaying !== "undefined" && isPlaying) return;   // 播放中禁止
  e.stopPropagation(); e.preventDefault();
  const s = selectedSeg(); if (!s) return;
  const k = Store.state.selectedKey; if (!k) return;
  const [, tti] = k.split(":");
  const rec = previewState.visualEls.get("video:" + tti);
  if (!rec || !rec.el) return;
  const mr = rec.el.getBoundingClientRect();
  const t = resolveTransform(s, Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)));
  const startW = mr.width || 1, startH = mr.height || 1;
  // ★ 中心一律用「视口坐标」（clientX/clientY 体系），与 pointermove 的 e.clientX/Y 同坐标系。
  //   修复前是 mr.left - sr.left（相对 previewStack）→ 与 e.clientX 混用，dx/dy 恒定偏移 ~250px。
  const anchorCX = mr.left + startW / 2;
  const anchorCY = mr.top + startH / 2;
  const ctx = {
    pointer: { id: e.pointerId, startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY },
    target: { type: "segment", id: s.id },
    seg: s, el: rec.el, key: k,
    h, startSX: t.sx, startSY: t.sy, startR: t.r,
    startW, startH,
    anchorCX, anchorCY,
    // ★ 基准量改「按下瞬间鼠标到中心的真实距离 / 真实投影」，而非元素尺寸。
    //   修复后按下瞬间 factor 恒为 1 → 素材不跳变；且与旋转包围盒、画布 zoom 都无关。
    initialDist: Math.hypot(e.clientX - anchorCX, e.clientY - anchorCY) || 1,
    initialProj: projOf(h, e.clientX - anchorCX, e.clientY - anchorCY, t.r || 0),
    localSnap: Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)),
    startAng: Math.atan2(e.clientY - anchorCY, e.clientX - anchorCX) * 180 / Math.PI,
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
