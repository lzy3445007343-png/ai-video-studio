/* =====================================================================
 * property/text-panel.js —— L2-02 文本可编辑样式 tab（对标 OpenCut TextTab）
 * =====================================================================
 * 渲染选中 text 段的「样式」面板：内容 / 排版(字号·字距·对齐·粗体·颜色) / 背景。
 * - 字号/字距/颜色 支持关键帧（◆ 走 toggleKf / toggleColorKf，受 L2-10 范围门控）。
 * - 编辑语义对齐 kf-panel.buildKfRow：focus→锁时间，input→本地临时态预览，
 *   blur/Enter→一次 Command Transaction（KF 走 add_keyframe，base 走 set_segments_props sub_style）。
 * - 颜色复用 L2-07 的 ColorPickerField + previewColor/commitColor（无帧分支已接 sub_style.color）。
 * 不碰 Api 签名/MCP/player/Video DSL（L0-07 红线）：base 写走既有 set_segments_props 的
 *   sub_style 扩展（语义扩展，不新增命令）；KF 走既有 add_keyframe（分支 A 白名单扩展）。
 * 依赖：selectedSeg / Store / CommandService / PreviewState / KfChannel /
 *       TimelineMapper.isPlayheadWithinRange / toggleKf / toggleColorKf /
 *       ColorPickerField / ColorPickerUtils / resolveColorAtTime / commitColor。
 * ===================================================================== */
(function () {
  const DEFAULTS = { font_size: 10.0, bold: true, color: "#ffffff", align: 1, bg: false, bg_color: "#000000" };
  const ALIGN_OPTS = [["0", "左对齐"], ["1", "居中"], ["2", "右对齐"]];

  function renderTextPanelPF() {
    const host = document.getElementById("textPanel");
    if (!host) return;
    const s = selectedSeg();
    if (!s || s.type !== "text") { host.innerHTML = '<div class="kf-empty-hint">未选中文本段。</div>'; return; }
    const sub = Object.assign({}, DEFAULTS, s.sub_style || {});
    const anims = s.animations || {};

    host.innerHTML = "";
    // —— 内容 ——
    host.appendChild(fieldBlock("内容", (() => {
      const ta = document.createElement("textarea");
      ta.className = "insp-textarea";
      ta.value = s.text || "";
      ta.rows = 3;
      ta.addEventListener("blur", () => commitText(ta.value));
      ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); } });
      return ta;
    })()));

    // —— 排版：字号 / 字距（带 ◆ KF）——
    host.appendChild(buildStyleKfRow(s, anims, "text.fontSize", "字号", 0.5, 10, "font_size"));
    host.appendChild(buildStyleKfRow(s, anims, "text.letterSpacing", "字距", 0.1, 0, "letter_spacing"));

    // —— 对齐 / 粗体 ——
    host.appendChild(fieldBlock("对齐", (() => {
      const sel = document.createElement("select");
      sel.className = "insp-select";
      ALIGN_OPTS.forEach(([v, l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l;
        if (String(sub.align) === v) o.selected = true; sel.appendChild(o);
      });
      sel.addEventListener("change", () => writeTextBase("align", parseInt(sel.value, 10)));
      return sel;
    })()));
    host.appendChild(fieldBlock("粗体", buildSwitch(sub.bold, v => writeTextBase("bold", v))));

    // —— 颜色（带 ◆ KF，复用 L2-07）——
    host.appendChild(buildColorBlock(s, anims));

    // —— 背景 ——
    const bgEnabled = !!sub.bg;
    const bgWrap = document.createElement("div");
    bgWrap.className = "text-bg-wrap";
    const bgSwitch = buildSwitch(bgEnabled, v => {
      writeTextBase("bg", v);
      bgColorBlock.style.opacity = v ? "" : "0.5";
      bgColorBlock.style.pointerEvents = v ? "" : "none";
    });
    bgWrap.appendChild(fieldBlock("背景", bgSwitch));
    const bgColorBlock = buildColorField(sub.bg_color || "#000000", hex => writeTextBase("bg_color", hex));
    bgColorBlock.style.marginLeft = "16px";
    if (!bgEnabled) { bgColorBlock.style.opacity = "0.5"; bgColorBlock.style.pointerEvents = "none"; }
    bgWrap.appendChild(bgColorBlock);
    host.appendChild(bgWrap);
  }

  /* —— 工具：字段块（label + 控件） —— */
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
  function buildColorField(hex, onCommit) {
    const wrap = document.createElement("span");
    wrap.className = "kf-color-wrap";
    const cp = new ColorPickerField({ value: hex, onCommit });
    cp.mount(wrap);
    return wrap;
  }

  /* —— 带 ◆ 的标量样式行（字号/字距），编辑语义对齐 buildKfRow —— */
  function buildStyleKfRow(s, anims, path, label, step, def, subField) {
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

    // 编辑语义（对齐 buildKfRow）
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
        CommandService.withTx("text-kf-edit", () =>
          CommandService.run("add_keyframe",
            { track_type: k[0], track_index: +k[1], index: +k[2], path, time_us: local, value: v, seg_mode: "linear", seg_id: segId },
            { actor: "ui", paths: [path] }));
      } else {
        writeTextBase(subField, v);   // base 落 seg.sub_style.<subField>
      }
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); inp.blur(); } });
    row.appendChild(block);
    return row;
  }

  /* —— 颜色块（◆ 复用 toggleColorKf；base 走 commitColor 的 sub_style.color 分支） —— */
  function buildColorBlock(s, anims) {
    const row = document.createElement("div");
    row.className = "text-row text-row-color";
    const inRange = TimelineMapper.isPlayheadWithinRange(s);
    const hasKf = ["text.color.r", "text.color.g", "text.color.b", "text.color.a"].some(p => KfChannel.isAnimated(s, p));
    const cur = hasKf ? resolveColorAtTime(s, TimelineMapper.playheadLocal(s)) : (s.sub_style && s.sub_style.color) || "#ffffff";
    const tog = document.createElement("button");
    tog.className = "kf-kf-toggle" + (hasKf ? " is-active" : "");
    tog.innerHTML = kfDiamondSVG("dia", "currentColor");
    tog.title = hasKf ? "删除颜色关键帧" : "在播放头处打颜色关键帧";
    if (!inRange) { tog.disabled = true; tog.style.opacity = "0.5"; tog.style.pointerEvents = "none"; tog.title = "播放头不在元素范围内，无法打/删关键帧"; }
    tog.addEventListener("click", () => toggleColorKf("text.color"));
    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = "颜色";
    const wrap = document.createElement("span"); wrap.className = "kf-color-wrap";
    const cp = new ColorPickerField({
      value: cur,
      onPreview: hex => { if (hasKf && inRange && typeof previewColor === "function") previewColor(hex); },
      onCommit: hex => { if (typeof commitColor === "function") commitColor(hex); },
    });
    cp.mount(wrap);
    const inner = document.createElement("div"); inner.className = "text-row-inner";
    inner.appendChild(tog); inner.appendChild(lab); inner.appendChild(wrap);
    row.appendChild(inner);
    return row;
  }

  /* —— base 写回：set_segments_props 的 sub_style 扩展（不新增 Api） —— */
  function writeTextBase(field, value) {
    const s = selectedSeg(); if (!s) return;
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (!k || k.length < 3) return;
    CommandService.withTx("text-style", () =>
      CommandService.run("set_segments_props",
        [{ track_type: k[0], track_index: +k[1], index: +k[2], segid: s.id, sub_style: { [field]: value } }],
        { actor: "ui", paths: ["text." + field] }));
  }
  function commitText(text) {
    const s = selectedSeg(); if (!s) return;
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (!k || k.length < 3) return;
    CommandService.withTx("text-content", () =>
      CommandService.run("set_segments_props",
        [{ track_type: k[0], track_index: +k[1], index: +k[2], segid: s.id, text: text }],
        { actor: "ui", paths: ["text.content"] }));
  }

  if (typeof window !== "undefined") window.renderTextPanelPF = renderTextPanelPF;
})();
