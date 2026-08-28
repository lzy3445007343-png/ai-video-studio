/* =====================================================================
 * property/text-edit-overlay.js —— L1-14 双击文字编辑（对标 OpenCut text-edit-overlay.tsx）
 * =====================================================================
 * 预览区（播放器画布）双击文字层 → 透明 contentEditable 覆盖层（光标着色，所见即所得）→
 * 输入实时改底层 .text-layer 实现预览（无需后端 round-trip）→ 失焦 / Esc 提交一次 undo。
 * 后端零改动：内容写回归 set_segments_props 的 text 白名单字段（与 L2-02 text-panel.commitText 同通道）。
 * 不碰 Api 签名 / MCP / player / Video DSL（L0-07 红线）。
 * 依赖：Store / resolveHits / refresh / selectKey / CommandService / UiFeedback。
 * ===================================================================== */
(function () {
  let editing = null; // { ti, si, segId, textEl, overlay, original }

  function getTextHitAt(ti) {
    const us = Store.state.playheadUs;
    const hits = (typeof resolveHits === "function") ? resolveHits(us) : [];
    for (const h of hits) {
      if (h.type === "text" && h.ti === ti) return h;
    }
    return null;
  }

  function beginEdit(textEl) {
    if (editing) return;
    const ti = parseInt(String(textEl.id || "").replace(/^text:/, ""), 10);
    if (isNaN(ti)) return;
    const hit = getTextHitAt(ti);
    if (!hit) return;
    const seg = hit.seg;
    const ti2 = hit.ti, si = hit.idx, segId = seg.id || null;
    const original = seg.text || seg.name || "";

    const stack = document.getElementById("previewStack");
    if (!stack) return;

    // 进编辑态：先选中该段（让 Inspector 同步显示），再挂覆盖层
    try { if (typeof selectKey === "function") selectKey("text:" + ti2 + ":" + si); } catch (e) {}

    const overlay = document.createElement("div");
    overlay.contentEditable = "true";
    overlay.className = "text-edit-overlay";
    overlay.setAttribute("role", "textbox");
    overlay.setAttribute("aria-label", "编辑文字");
    // 定位：直接复制底层文字层的关键定位样式（与 stage zoom 无关，缩放后仍能重叠）
    overlay.style.position = "absolute";
    overlay.style.left = textEl.style.left;
    overlay.style.top = textEl.style.top;
    overlay.style.bottom = textEl.style.bottom;
    overlay.style.right = textEl.style.right;
    overlay.style.transform = textEl.style.transform;
    overlay.style.textAlign = textEl.style.textAlign;
    overlay.style.maxWidth = textEl.style.maxWidth;
    overlay.style.width = "auto";
    overlay.style.minWidth = "24px";
    overlay.style.zIndex = String((parseInt(textEl.style.zIndex || "0", 10) || 0) + 5);
    // 视觉：透明文字 + 光标着色 = OpenCut 所见即所得（底层 .text-layer 实时显示敲入的文字）
    const cs = getComputedStyle(textEl);
    overlay.style.color = "transparent";
    overlay.style.caretColor = cs.color || "#ffffff";
    overlay.style.fontFamily = cs.fontFamily;
    overlay.style.fontWeight = cs.fontWeight;
    overlay.style.fontSize = cs.fontSize;
    overlay.style.lineHeight = cs.lineHeight;
    overlay.style.letterSpacing = cs.letterSpacing;
    overlay.style.padding = cs.padding;
    overlay.style.whiteSpace = "pre-wrap";
    overlay.style.wordBreak = "break-word";
    overlay.style.outline = "2px solid #4a9eff";
    overlay.style.boxShadow = "0 0 0 1px rgba(74,158,255,0.4)";
    overlay.style.cursor = "text";
    overlay.style.boxSizing = "border-box";
    overlay.style.borderRadius = "2px";
    overlay.textContent = original;
    stack.appendChild(overlay);

    // 暂停 2s 轮询刷新（防后端 draft 覆盖编辑中预览态；对齐 _kfEditing 守卫）
    window.__textEditing = true;

    // 聚焦 + 全选
    overlay.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(overlay);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}

    // 实时预览：输入即改底层 .text-layer 文字（所见即所得，不触发后端）
    overlay.addEventListener("input", () => {
      textEl.textContent = overlay.innerText;
      textEl.dataset.text = overlay.innerText;
    });

    let done = false;
    function cleanup() {
      editing = null;
      window.__textEditing = false;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function commit() {
      if (done) return;
      done = true;
      const val = overlay.innerText;
      cleanup();
      try {
        CommandService.withTx("text-content-inline", () =>
          CommandService.run("set_segments_props",
            [{ track_type: "text", track_index: ti2, index: si, segid: segId, text: val }],
            { actor: "ui", paths: ["text.content"] }));
      } catch (e) {
        textEl.textContent = original; textEl.dataset.text = original;
        if (typeof UiFeedback !== "undefined" && UiFeedback.showToast) UiFeedback.showToast({ description: "保存文字失败：" + e, variant: "error" });
      }
      if (typeof refresh === "function") refresh();
    }
    function cancel() {
      if (done) return;
      done = true;
      textEl.textContent = original; textEl.dataset.text = original;
      cleanup();
      if (typeof refresh === "function") refresh();
    }

    overlay.addEventListener("blur", commit);
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
      // Shift+Enter 允许换行（内容文本框多行语义）
    });
    editing = { ti: ti2, si, segId, textEl, overlay, original };
  }

  function install() {
    const stack = document.getElementById("previewStack");
    if (!stack || stack.__textDblBound) return;
    stack.__textDblBound = true;
    stack.addEventListener("dblclick", (e) => {
      const t = (e.target && e.target.closest) ? e.target.closest(".text-layer") : null;
      if (t && t.classList.contains("text-layer")) beginEdit(t);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
  if (typeof window !== "undefined") window.TextEditOverlay = { beginEdit, install };
})();
