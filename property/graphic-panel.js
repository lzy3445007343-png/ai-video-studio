/* =====================================================================
 * property/graphic-panel.js —— L2-04 Graphic 段样式 tab（对标 OpenCut ShapeTab）
 * =====================================================================
 * 渲染选中 type="graphic" 段的「样式」面板：描边(开关/宽度/颜色) / 填充色 / 圆角。
 * - 描边宽度 / 圆角 / 描边色 / 填充色 均支持关键帧（◆ 走 toggleKf / toggleGraphicColorKf，受 L2-10 范围门控）。
 * - 编辑语义对齐 text-panel.buildStyleKfRow：focus→锁时间，input→本地临时态预览，
 *   blur/Enter→一次 Command Transaction（KF 走 add_keyframe，base 走 set_segments_props params 扩展）。
 * 不碰 Api 签名/MCP/player/Video DSL（L0-07 红线）：base 写走既有 set_segments_props 的
 *   params 扩展（语义扩展，不新增命令）；KF 走既有 add_keyframe（分支 A white-list 扩展）。
 * 依赖：selectedSeg / Store / CommandService / PreviewState / KfChannel / TimelineMapper /
 *       toggleKf / kfDiamondSVG / round2 / createEditContext / ExprParse / renderPreview /
 *       ColorPickerField / ColorPickerUtils / kfSegArgs / call / refresh。
 * ===================================================================== */
(function () {
  function renderGraphicPanelPF() {
    const host = document.getElementById("graphicPanel");
    if (!host) return;
    const s = selectedSeg();
    if (!s || s.type !== "graphic") { host.innerHTML = '<div class="kf-empty-hint">未选中图形段。</div>'; return; }
    const params = Object.assign({ stroke: {}, fill: {}, radius: 0 }, s.params || {});
    const stroke = Object.assign({ enabled: true, width: 4.0, color: { r: 1, g: 1, b: 1, a: 1 } }, params.stroke || {});
    const fill = Object.assign({ color: { r: 0, g: 0.47, b: 1, a: 1 } }, params.fill || {});
    const anims = s.animations || {};

    host.innerHTML = "";

    // —— 描边开关 ——
    host.appendChild(fieldBlock("描边", buildSwitch(stroke.enabled, v => writeParamsBase({ stroke: { enabled: v } }))));

    // —— 描边宽度（带 ◆ KF）——
    host.appendChild(buildGraphicKfRow(s, anims, "params.stroke.width", "描边宽度", 0.5, 4.0,
      v => writeParamsBase({ stroke: { width: v } })));

    // —— 描边颜色（带 ◆ KF，复用 ColorPickerField）——
    host.appendChild(buildGraphicColorBlock(s, anims, "params.stroke.color", "描边色"));

    // —— 填充色（带 ◆ KF）——
    host.appendChild(buildGraphicColorBlock(s, anims, "params.fill.color", "填充色"));

    // —— 圆角（带 ◆ KF）——
    host.appendChild(buildGraphicKfRow(s, anims, "params.radius", "圆角", 1, 0,
      v => writeParamsBase({ radius: v })));
  }

  /* —— 工具：字段块 —— */
  function fieldBlock(label, control) {
    const row = document.createElement("div");
    row.className = "text-row";
    const lab = document.createElement("span");
    lab.className = "lab"; lab.textContent = label;
    row.appendChild(lab); row.appendChild(control);
    return row;
  }
  function buildSwitch(on, onChange) {
    const sw = document.createElement("input");
    sw.type = "checkbox"; sw.className = "insp-switch"; sw.checked = !!on;
    sw.addEventListener("change", () => onChange(sw.checked));
    return sw;
  }

  /* —— 带 ◆ 的标量行（描边宽度/圆角），编辑语义对齐 buildKfRow —— */
  function buildGraphicKfRow(s, anims, path, label, step, def, writeBase) {
    const row = document.createElement("div");
    row.className = "text-row text-row-kf";
    const inRange = TimelineMapper.isPlayheadWithinRange(s);
    const channelOn = KfChannel.isAnimated(s, path);
    const hitOn = KfChannel.hitAtPlayhead(s, path, TimelineMapper.playheadLocal(s));
    const cur = getEffectivePropertyValue(s, path, TimelineMapper.playheadLocal(s)).value;
    const shown = (cur == null) ? def : cur;

    const tog = document.createElement("button");
    tog.className = "kf-kf-toggle" + (hitOn ? " is-active" : "");
    tog.innerHTML = kfDiamondSVG("dia", "currentColor");
    tog.title = hitOn ? "删除当前位置关键帧" : "在播放头处打关键帧";
    if (!inRange) { tog.disabled = true; tog.style.opacity = "0.5"; tog.style.pointerEvents = "none"; tog.title = "播放头不在元素范围内，无法打/删关键帧"; }
    tog.addEventListener("click", () => toggleKf(path));

    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number"; inp.step = step; inp.className = "val"; inp.value = round2(shown);
    const block = document.createElement("div");
    block.className = "text-row-inner";
    block.appendChild(tog); block.appendChild(lab); block.appendChild(inp);

    let _draft = null, _editCtx = null;
    inp.addEventListener("focus", () => {
      _kfEditing = true;
      const seg = selectedSeg();
      if (seg && typeof createEditContext === "function" && Store.state.selectedKey) _editCtx = createEditContext(Store.state.selectedKey);
    });
    inp.addEventListener("mousedown", e => { e.preventDefault(); inp.focus(); inp.select(); });
    inp.addEventListener("input", () => {
      const v = (typeof ExprParse !== "undefined") ? ExprParse.parseNumeric(inp.value) : parseFloat(inp.value);
      if (isNaN(v)) return;
      const seg = selectedSeg(); if (!seg) return;
      const hasKf = KfChannel.isAnimated(seg, path) && inRange;
      const local = (_editCtx && _editCtx.editTime) ? _editCtx.editTime.localUs : TimelineMapper.playheadLocal(seg);
      _draft = { v, hasKf, local };
      if (hasKf) KfChannel.upsertLocal(seg, path, local, v, "linear");
      else if (typeof PreviewState !== "undefined") PreviewState.set(seg.id, path, v);
      if (typeof PreviewState !== "undefined") PreviewState.notifyPreviewConsumers(seg.id);
      renderPreview();
    });
    inp.addEventListener("blur", () => {
      _kfEditing = false;
      if (!_draft) return;
      const { v, hasKf, local } = _draft; _draft = null; _editCtx = null;
      const seg = selectedSeg(); if (!seg) return;
      if (typeof PreviewState !== "undefined") PreviewState.discardPreview(seg.id);
      const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
      if (!k || k.length < 3) return;
      const segId = seg.id;
      if (hasKf) {
        CommandService.withTx("graphic-kf-edit", () =>
          CommandService.run("add_keyframe",
            { track_type: k[0], track_index: +k[1], index: +k[2], path, time_us: local, value: v, seg_mode: "linear", seg_id: segId },
            { actor: "ui", paths: [path] }));
      } else {
        writeBase(v);   // base 落 seg.params
      }
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); inp.blur(); } });
    row.appendChild(block);
    return row;
  }

  /* —— 颜色块（◆ 复用 toggleGraphicColorKf；base 走 writeGraphicColorBase） —— */
  function buildGraphicColorBlock(s, anims, pathBase, label) {
    const row = document.createElement("div");
    row.className = "text-row text-row-color";
    const inRange = TimelineMapper.isPlayheadWithinRange(s);
    const hasKf = ["r", "g", "b", "a"].map(c => pathBase + "." + c).some(p => KfChannel.isAnimated(s, p));
    const cur = hasKf ? resolveGraphicColorAtTime(s, pathBase, TimelineMapper.playheadLocal(s))
                      : paramsColorToHex(readParamsColor(s, pathBase));
    const tog = document.createElement("button");
    tog.className = "kf-kf-toggle" + (hasKf ? " is-active" : "");
    tog.innerHTML = kfDiamondSVG("dia", "currentColor");
    tog.title = hasKf ? "删除颜色关键帧" : "在播放头处打颜色关键帧";
    if (!inRange) { tog.disabled = true; tog.style.opacity = "0.5"; tog.style.pointerEvents = "none"; tog.title = "播放头不在元素范围内，无法打/删关键帧"; }
    tog.addEventListener("click", () => toggleGraphicColorKf(pathBase));
    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = label;
    const wrap = document.createElement("span"); wrap.className = "kf-color-wrap";
    const cp = new ColorPickerField({
      value: cur,
      onPreview: hex => { if (hasKf && inRange) previewGraphicColor(s, pathBase, hex); },
      onCommit: hex => writeGraphicColorBase(pathBase, hex),
    });
    cp.mount(wrap);
    const inner = document.createElement("div"); inner.className = "text-row-inner";
    inner.appendChild(tog); inner.appendChild(lab); inner.appendChild(wrap);
    row.appendChild(inner);
    return row;
  }

  /* —— params 颜色读取 / 转换 —— */
  function readParamsColor(s, pathBase) {
    const parts = pathBase.slice("params.".length).split(".");   // ["stroke","color"]
    let o = s.params;
    for (const p of parts) o = (o == null) ? undefined : o[p];
    return o || { r: 1, g: 1, b: 1, a: 1 };
  }
  function paramsColorToHex(c) {
    const r = Math.round((c.r == null ? 1 : c.r) * 255);
    const g = Math.round((c.g == null ? 1 : c.g) * 255);
    const b = Math.round((c.b == null ? 1 : c.b) * 255);
    const h = n => n.toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }
  function hexToParamsColor(hex) {
    return ColorPickerUtils.hexToRgba(hex);   // 返回 {r,g,b,a}，分量 0~1（与 text.color 同约定）
  }

  /* —— base 写回：set_segments_props 的 params 扩展（不新增 Api） —— */
  function writeParamsBase(patch) {
    const s = selectedSeg(); if (!s) return;
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (!k || k.length < 3) return;
    CommandService.withTx("graphic-params", () =>
      CommandService.run("set_segments_props",
        [{ track_type: k[0], track_index: +k[1], index: +k[2], segid: s.id, params: patch }],
        { actor: "ui", paths: ["params"] }));
  }
  function writeGraphicColorBase(pathBase, hex) {
    const parts = pathBase.slice("params.".length).split(".");   // ["stroke","color"]
    const col = hexToParamsColor(hex);
    const patch = {}; let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = { r: col.r, g: col.g, b: col.b, a: col.a };
    writeParamsBase(patch);
  }

  /* —— 颜色关键帧：四分量合并成单 ◆（对齐 L2-07 toggleColorKf，但 path 前缀可配） —— */
  function toggleGraphicColorKf(pathBase) {
    const s = selectedSeg(); if (!s) return;
    if (!TimelineMapper.isPlayheadWithinRange(s)) return;   // L2-10 门控
    const local = TimelineMapper.playheadLocal(s);
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (!k || k.length < 3) return;
    const args = kfSegArgs();
    const segId = Store.state.selectedSegId;
    const paths = ["r", "g", "b", "a"].map(c => pathBase + "." + c);
    const anims = s.animations || {};
    const hit = paths.some(p => KfChannel.hitAtPlayhead(s, p, local));
    if (hit) {
      // [2026-08-30 修复] 原裸 call 绕过 CommandService；改同事务原子删。
      CommandService.withTx("graphic-color-toggle-rm", () => {
        paths.forEach(p => {
          const keys = (anims[p] && anims[p].keys) ? anims[p].keys : [];
          const hk = keys.find(kk => Math.abs((kk.t || 0) - local) <= KfChannel.KF_HIT_TOLERANCE_US);
          if (hk) CommandService.run("remove_keyframe",
            { track_type: k[0], track_index: +k[1], index: +k[2], path: p, keyframe_id: hk.id, seg_id: segId, playhead_us: Store.state.playheadUs },
            { actor: "ui", paths: [p] });
        });
      });
      setTimeout(() => refresh(), 60);
    } else {
      const cur = resolveGraphicColorAtTime(s, pathBase, local);
      const { r, g, b, a } = hexToParamsColor(cur);
      const vals = [r, g, b, a];
      // [2026-08-30 修复] 原 call(...).then() 递归链非原子（withTx 在异步链前关闭）。改同步 for 循环四写，同事务原子提交。
      CommandService.withTx("graphic-color-kf", () => {
        for (let i = 0; i < 4; i++) {
          CommandService.run("add_keyframe",
            { track_type: k[0], track_index: +k[1], index: +k[2], path: paths[i], time_us: local, value: vals[i], seg_mode: "linear" },
            { actor: "ui", paths: [paths[i]] });
        }
      });
      setTimeout(() => refresh(), 60);
    }
  }
  function resolveGraphicColorAtTime(s, pathBase, local) {
    const base = readParamsColor(s, pathBase);
    const out = {};
    ["r", "g", "b", "a"].forEach(c => {
      const p = pathBase + "." + c;
      out[c] = KfChannel.isAnimated(s, p) ? (kfVal(s.animations, p, local) ?? base[c]) : base[c];
    });
    return paramsColorToHex(out);
  }
  function previewGraphicColor(s, pathBase, hex) {
    const col = hexToParamsColor(hex);
    ["r", "g", "b", "a"].forEach(c => {
      const p = pathBase + "." + c;
      if (typeof PreviewState !== "undefined") PreviewState.set(s.id, p, col[c]);
    });
    if (typeof PreviewState !== "undefined") PreviewState.notifyPreviewConsumers(s.id);
    renderPreview();
  }

  if (typeof window !== "undefined") window.renderGraphicPanelPF = renderGraphicPanelPF;
})();
