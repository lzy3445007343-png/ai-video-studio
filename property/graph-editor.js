/* =====================================================================
 * property/graph-editor.js —— L2-05 缓动曲线编辑器（对标 OpenCut GraphEditorPopover）
 * =====================================================================
 * 编辑选中关键帧 → 下一相邻关键帧 之间的贝塞尔缓动（segmentToNext/leftHandle/rightHandle）。
 * - 数据层：update_keyframe 已支持 segment_to_next/left_handle/right_handle（L0-08 埋位）；
 *   求值：前端 kfVal + 后端 _kf_interp 均已加 bezier 分支（segmentToNext==="bezier" 走三次贝塞尔）。
 * - 拖控制柄实时预览（直接改 in-memory key.handle + renderPreview，kfVal 已 bezier 感知）；
 *   松手一次事务 update_keyframe（一次手势一条 undo）。
 * - 预设：6 内置（Smooth/Ease out/Ease in/In out/Pop/Linear），点击即提交。
 * 不碰 Api 签名/MCP/player/Video DSL（导出侧 bezier 映射属 Video DSL 护城河，本次不动，预览端先闭环）。
 * 依赖：selectedSeg / Store / kfSegArgs / update_keyframe(call) / renderPreview / KfChannel /
 *       bezierValue（HTML 全局，与后端同款数学）。
 * ===================================================================== */
(function () {
  const VB_W = 164, VB_H = 118, PAD = 14;
  const SNAP = 0.06;   // 控制柄吸附 0/1 阈值（占比）
  const PRESETS = {
    "Smooth":   { rh: [0.33, 0.0], lh: [-0.33, 0.0] },
    "Ease out": { rh: [0.10, 0.0], lh: [-0.55, 0.0] },
    "Ease in":  { rh: [0.55, 0.0], lh: [-0.10, 0.0] },
    "In out":   { rh: [0.42, 0.0], lh: [-0.42, 0.0] },
    "Pop":      { rh: [0.30, 0.45], lh: [-0.30, -0.45] },
    "Linear":   { rh: [0.0, 0.0], lh: [0.0, 0.0] },
  };

  // 选中态 → 段信息；返回 {ok, reason, seg, ch, keys, i, a, b, vmin, vmax, spanT}
  function resolveSegment() {
    const s = selectedSeg();
    if (!s || !selectedKf.path || !selectedKf.id) return { ok: false, reason: "未选中关键帧" };
    const ch = (s.animations || {})[selectedKf.path];
    if (!ch || !ch.keys || !ch.keys.length) return { ok: false, reason: "该属性无关键帧" };
    if (ch.type === "discrete") return { ok: false, reason: "discrete 通道（布尔/枚举）无缓动曲线" };
    const keys = ch.keys.slice().sort((x, y) => x.t - y.t);
    const i = keys.findIndex(k => k.id === selectedKf.id);
    if (i < 0) return { ok: false, reason: "找不到选中的关键帧" };
    if (i >= keys.length - 1) return { ok: false, reason: "选中关键帧之后需有相邻关键帧才能编辑缓动" };
    const a = keys[i], b = keys[i + 1];
    if (a.seg === "hold") return { ok: false, reason: "台阶(hold) 段无缓动效果" };
    const spanT = Math.max(1, b.t - a.t);
    let vmin = Math.min(a.v, b.v), vmax = Math.max(a.v, b.v);
    const m = Math.max(0.5, (vmax - vmin) * 0.15);
    vmin -= m; vmax += m;
    return { ok: true, seg: s, ch, keys, i, a, b, vmin, vmax, spanT };
  }

  function xFor(t, a, spanT) { return PAD + ((t - a.t) / spanT) * (VB_W - 2 * PAD); }
  function yFor(v, vmin, vmax) { return PAD + (1 - (v - vmin) / (vmax - vmin)) * (VB_H - 2 * PAD); }

  function openGraphEditor() {
    const r = resolveSegment();
    if (!r.ok) { if (typeof toast === "function") toast(r.reason); else alert(r.reason); return; }
    const { a, b, vmin, vmax, spanT } = r;
    const pop = document.createElement("div");
    pop.className = "graph-editor-pop";
    pop.style.cssText = "position:fixed;z-index:9999;left:50%;top:50%;transform:translate(-50%,-50%);background:#1e1e1e;color:#eee;border:1px solid #444;border-radius:10px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);";
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${VB_W} ${VB_H}`);
    svg.setAttribute("width", "328"); svg.setAttribute("height", "236");
    svg.style.background = "#161616"; svg.style.borderRadius = "6px";

    const x0 = xFor(a.t, a, spanT), y0 = yFor(a.v, vmin, vmax);
    const x3 = xFor(b.t, a, spanT), y3 = yFor(b.v, vmin, vmax);
    const rh = a.rightHandle || { dt: 0, dv: 0 }, lh = b.leftHandle || { dt: 0, dv: 0 };
    const cx0 = x0 + rh.dt / spanT * (VB_W - 2 * PAD), cy0 = y0 - rh.dv / (vmax - vmin) * (VB_H - 2 * PAD);
    const cx1 = x3 + lh.dt / spanT * (VB_W - 2 * PAD), cy1 = y3 - lh.dv / (vmax - vmin) * (VB_H - 2 * PAD);

    // 对角线（线性参考）
    const diag = document.createElementNS(svgNS, "line");
    diag.setAttribute("x1", x0); diag.setAttribute("y1", y0); diag.setAttribute("x2", x3); diag.setAttribute("y2", y3);
    diag.setAttribute("stroke", "#555"); diag.setAttribute("stroke-dasharray", "4 3");
    svg.appendChild(diag);
    // 曲线
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "#4aa3ff"); path.setAttribute("stroke-width", "2");
    svg.appendChild(path);
    // 控制柄连线
    const lineR = document.createElementNS(svgNS, "line");
    const lineL = document.createElementNS(svgNS, "line");
    [lineR, lineL].forEach(l => { l.setAttribute("stroke", "#888"); l.setAttribute("stroke-width", "1"); svg.appendChild(l); });
    // 端点 + 控制柄
    const mkDot = (x, y, color) => { const c = document.createElementNS(svgNS, "circle"); c.setAttribute("r", "3.5"); c.setAttribute("cx", x); c.setAttribute("cy", y); c.setAttribute("fill", color); c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", "1"); svg.appendChild(c); return c; };
    mkDot(x0, y0, "#ffd24d"); mkDot(x3, y3, "#ffd24d");
    const hR = mkDot(cx0, cy0, "#4aa3ff"); hR.style.cursor = "grab";
    const hL = mkDot(cx1, cy1, "#4aa3ff"); hL.style.cursor = "grab";

    function drawCurve() {
      const _rh = a.rightHandle || { dt: 0, dv: 0 }, _lh = b.leftHandle || { dt: 0, dv: 0 };
      const _cx0 = x0 + _rh.dt / spanT * (VB_W - 2 * PAD), _cy0 = y0 - _rh.dv / (vmax - vmin) * (VB_H - 2 * PAD);
      const _cx1 = x3 + _lh.dt / spanT * (VB_W - 2 * PAD), _cy1 = y3 - _lh.dv / (vmax - vmin) * (VB_H - 2 * PAD);
      path.setAttribute("d", `M ${x0} ${y0} C ${_cx0} ${_cy0} ${_cx1} ${_cy1} ${x3} ${y3}`);
      lineR.setAttribute("x1", x0); lineR.setAttribute("y1", y0); lineR.setAttribute("x2", _cx0); lineR.setAttribute("y2", _cy0);
      lineL.setAttribute("x1", x3); lineL.setAttribute("y1", y3); lineL.setAttribute("x2", _cx1); lineL.setAttribute("y2", _cy1);
      hR.setAttribute("cx", _cx0); hR.setAttribute("cy", _cy0);
      hL.setAttribute("cx", _cx1); hL.setAttribute("cy", _cy1);
    }
    drawCurve();

    function startDrag(which, e) {
      e.preventDefault();
      const move = ev => {
        const rect = svg.getBoundingClientRect();
        const scaleX = VB_W / rect.width, scaleY = VB_H / rect.height;
        const mx = (ev.clientX - rect.left) * scaleX, my = (ev.clientY - rect.top) * scaleY;
        let dtPx, dvPx;
        if (which === "r") { dtPx = mx - x0; dvPx = my - y0; }
        else { dtPx = mx - x3; dvPx = my - y3; }
        let dt = dtPx / (VB_W - 2 * PAD) * spanT;
        let dv = -dvPx / (VB_H - 2 * PAD) * (vmax - vmin);
        // 吸附 0（手柄与端点重合 → 线性）
        if (Math.abs(dt) < SNAP * spanT) dt = 0;
        if (Math.abs(dv) < SNAP * (vmax - vmin)) dv = 0;
        dt = Math.max(-spanT, Math.min(spanT, dt));
        dv = Math.max(-(vmax - vmin) * 1.5, Math.min((vmax - vmin) * 1.5, dv));
        if (which === "r") a.rightHandle = { dt, dv };
        else b.leftHandle = { dt, dv };
        drawCurve();
        if (typeof renderPreview === "function") renderPreview();
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        commit();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }
    hR.addEventListener("mousedown", e => startDrag("r", e));
    hL.addEventListener("mousedown", e => startDrag("l", e));

    function commit() {
      const seg = selectedSeg(); if (!seg) return;
      const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
      if (!k || k.length < 3) return;
      const rh = a.rightHandle || { dt: 0, dv: 0 }, lh = b.leftHandle || { dt: 0, dv: 0 };
      const isLinear = (rh.dt === 0 && rh.dv === 0 && lh.dt === 0 && lh.dv === 0);
      const segNext = isLinear ? "linear" : "bezier";
      CommandService.withTx("graph-easing", () => {
        CommandService.run("update_keyframe",
          { track_type: k[0], track_index: +k[1], index: +k[2], path: selectedKf.path, keyframe_id: a.id,
            right_handle: rh, segment_to_next: segNext, seg_id: seg.id },
          { actor: "ui", paths: [selectedKf.path] });
        CommandService.run("update_keyframe",
          { track_type: k[0], track_index: +k[1], index: +k[2], path: selectedKf.path, keyframe_id: b.id,
            left_handle: lh, seg_id: seg.id },
          { actor: "ui", paths: [selectedKf.path] });
      });
    }

    // 预设栏
    const presets = document.createElement("div");
    presets.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;";
    Object.keys(PRESETS).forEach(name => {
      const btn = document.createElement("button");
      btn.textContent = name;
      btn.style.cssText = "flex:1;min-width:60px;padding:4px 6px;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;cursor:pointer;font-size:12px;";
      btn.addEventListener("click", () => {
        const p = PRESETS[name];
        a.rightHandle = { dt: p.rh[0] * spanT, dv: p.rh[1] * (vmax - vmin) };
        b.leftHandle = { dt: p.lh[0] * spanT, dv: p.lh[1] * (vmax - vmin) };
        drawCurve();
        commit();
      });
      presets.appendChild(btn);
    });
    const close = document.createElement("button");
    close.textContent = "关闭"; close.style.cssText = "margin-top:8px;width:100%;padding:5px;background:#333;color:#eee;border:1px solid #555;border-radius:4px;cursor:pointer;";
    close.addEventListener("click", () => pop.remove());

    const title = document.createElement("div");
    title.textContent = "缓动曲线 · " + selectedKf.path;
    title.style.cssText = "font-size:13px;margin-bottom:8px;opacity:.9;";
    pop.appendChild(title); pop.appendChild(svg); pop.appendChild(presets); pop.appendChild(close);
    document.body.appendChild(pop);
  }

  if (typeof window !== "undefined") window.openGraphEditor = openGraphEditor;
  if (typeof window !== "undefined") window.graphEditorCanOpen = () => resolveSegment().ok;
})();
