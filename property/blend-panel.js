/* =====================================================================
 * property/blend-panel.js —— L2-01 Blend 融合模式 tab（对标 OpenCut BlendTab）
 * =====================================================================
 * 渲染选中 video/image 段的「融合」面板：融合模式下拉（normal/multiply/...）。
 * - blend 不做关键帧（静态段内字段，对齐 OpenCut blend 非动画语义）。
 * - 编辑语义：focus→锁时间；change→一次 Command Transaction（set_segments_props blend_mode）；
 *   option hover→PreviewState 临时预览，mouseleave 还原（对齐其它面板的预览约定）。
 * 不碰 Api 签名/MCP/player/Video DSL（L0-07 红线）：blend_mode 作为段内字段，
 *   经既有 set_segments_props 的 blend_mode 扩展落盘（白名单校验，不新增命令）。
 * 依赖：selectedSeg / Store / CommandService / PreviewState / renderPreview /
 *       kfDiamondSVG（占位不渲染）/ ColorPickerField（无）/ showToolTab。
 * 渲染器实际绘制 blend 模式属 Video DSL 护城河，本面板只负责数据/交互（预览依赖渲染器支持）。
 * ===================================================================== */
(function () {
  // 与 main.py BLEND_MODES 对齐（内部名 → 展示名）
  const BLEND_OPTIONS = [
    ["normal", "正常"], ["multiply", "正片叠底"], ["screen", "滤色"], ["overlay", "叠加"],
    ["darken", "变暗"], ["lighten", "变亮"], ["color_dodge", "颜色减淡"], ["color_burn", "颜色加深"],
    ["soft_light", "柔光"], ["hard_light", "强光"], ["difference", "差值"], ["exclusion", "排除"],
    ["hue", "色相"], ["saturation", "饱和度"], ["color", "颜色"], ["luminosity", "明度"],
  ];

  function renderBlendPanelPF() {
    const host = document.getElementById("blendPanel");
    if (!host) return;
    const s = selectedSeg();
    if (!s || (s.type !== "video" && s.type !== "image")) {
      host.innerHTML = '<div class="kf-empty-hint">仅视频/图片段可设置融合模式。</div>'; return;
    }
    const cur = (s.blend_mode && BLEND_OPTIONS.some(o => o[0] === s.blend_mode)) ? s.blend_mode : "normal";

    host.innerHTML = "";
    const row = document.createElement("div");
    row.className = "text-row";
    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = "融合模式";
    const sel = document.createElement("select");
    sel.className = "insp-select";
    BLEND_OPTIONS.forEach(([v, l]) => {
      const o = document.createElement("option"); o.value = v; o.textContent = l;
      if (v === cur) o.selected = true; sel.appendChild(o);
    });
    // 悬停预览（option mouseenter/mouseleave）
    sel.querySelectorAll("option").forEach(opt => {
      opt.addEventListener("mouseenter", () => previewBlend(s, opt.value));
      opt.addEventListener("mouseleave", () => previewBlend(s, cur));
    });
    sel.addEventListener("change", () => commitBlend(s, sel.value));
    sel.addEventListener("blur", () => previewBlend(s, cur));   // 失焦还原到已提交值
    row.appendChild(lab); row.appendChild(sel);
    host.appendChild(row);

    const hint = document.createElement("div");
    hint.className = "kf-empty-hint";
    hint.style.marginTop = "8px";
    hint.textContent = "融合模式决定该段与下层画面的混合方式（如正片叠底/滤色）。实际画面混合由渲染器绘制。";
    host.appendChild(hint);
  }

  function previewBlend(s, mode) {
    if (typeof PreviewState !== "undefined") {
      PreviewState.set(s.id, "blendMode", mode);
      PreviewState.notifyPreviewConsumers(s.id);
    }
    if (typeof renderPreview === "function") renderPreview();
  }
  function commitBlend(s, mode) {
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (!k || k.length < 3) return;
    CommandService.withTx("blend-mode", () =>
      CommandService.run("set_segments_props",
        [{ track_type: k[0], track_index: +k[1], index: +k[2], segid: s.id, blend_mode: mode }],
        { actor: "ui", paths: ["blend_mode"] }));
  }

  if (typeof window !== "undefined") window.renderBlendPanelPF = renderBlendPanelPF;
})();
