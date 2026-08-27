/* =====================================================================
 * property/ui-feedback.js —— L0-11 公共 UI 反馈层（M3）
 * =====================================================================
 * 替换工作台 15 处 alert 壳（保留错误原文到 description），统一反馈出口。
 * 本卡实装最高频的 Toast（showToast / dismissToast / updateToast / toastPromise）；
 * 其余接口（Tooltip / Dialog / Shortcuts / Overlay / DegradedBanner）仅定义签名，
 * 供 L1/L2 消费，不在此实现交互体。
 * 纯前端，不触碰 Api / draft_state.json / seg_id / track_type / 播放器内核。
 * ===================================================================== */
const UiFeedback = (function () {
  const ROOT_ID = "ui-feedback-root";

  /* 容器：覆盖全屏、pointer-events:none（不挡操作）；Toast 自身 pointer-events:auto。 */
  function root() {
    let el = document.getElementById(ROOT_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = ROOT_ID;
      el.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:10000;";
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  /* —— Toast 实装 —— */
  function showToast(opts) {
    const o = (typeof opts === "string") ? { description: opts } : (opts || {});
    const r = root();
    const node = document.createElement("div");
    node.className = "ui-toast" + (o.variant ? " ui-toast-" + o.variant : "");
    node.style.cssText =
      "position:absolute;left:50%;bottom:48px;transform:translateX(-50%);max-width:80vw;" +
      "pointer-events:auto;background:rgba(28,28,30,.94);color:#fff;padding:10px 14px;border-radius:10px;" +
      "font:13px/1.5 system-ui,-apple-system,'Microsoft YaHei',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);" +
      "display:flex;gap:10px;align-items:flex-start;";
    if (o.variant === "error") node.style.borderLeft = "3px solid #ff4d4f";
    else if (o.variant === "success") node.style.borderLeft = "3px solid #52c41a";
    else if (o.variant === "warn") node.style.borderLeft = "3px solid #faad14";

    if (o.title) {
      const t = document.createElement("div");
      t.style.cssText = "font-weight:600;margin-bottom:2px;";
      t.textContent = o.title;
      node.appendChild(t);
    }
    const msg = document.createElement("span");
    msg.textContent = o.description || "";
    msg.style.whiteSpace = "pre-wrap";   // 保留原文换行（如导出成功明细）
    node.appendChild(msg);

    let timer = 0;
    function dismiss() { if (timer) clearTimeout(timer); if (node.parentNode) node.remove(); }
    if (o.duration !== 0) timer = setTimeout(dismiss, o.duration || 2600);
    r.appendChild(node);
    return { dismiss, node };
  }

  function dismissToast(handle) { if (handle && handle.dismiss) handle.dismiss(); }
  function updateToast(handle, opts) {
    if (!handle || !handle.node) return;
    const o = opts || {};
    if (o.description != null) handle.node.lastChild.textContent = o.description;
    if (o.title != null) {
      let t = handle.node.querySelector("div");
      if (!t) { t = document.createElement("div"); t.style.cssText = "font-weight:600;margin-bottom:2px;"; handle.node.insertBefore(t, handle.node.firstChild); }
      t.textContent = o.title;
    }
  }

  /* 把 Promise 包成 pending→done/error 三段 Toast（L1/L2 导入/导出流程可用）。 */
  function toastPromise(p, { pending, done, error } = {}) {
    const h = showToast(pending || "处理中…");
    return Promise.resolve(p).then(v => { dismissToast(h); showToast(done || "完成"); return v; })
      .catch(e => {
        dismissToast(h);
        showToast({ description: (error || "失败") + "：" + (e && e.message != null ? e.message : e), variant: "error" });
        throw e;
      });
  }

  /* —— 其余接口签名（供 L1/L2 消费，本卡不实现交互体）——
   * 仅占位，避免 L1/L2 接线时报 undefined；具体 UI 在对应层落地。 */
  function showTooltip(anchor, text) { /* L1：悬浮提示，挂 anchor 附近 */ }
  function openDialog(opts) { /* L1：模态对话框（确认/输入） */ }
  function openShortcutsDialog() { /* L1：快捷键面板 */ }
  function openOverlay(content) { /* L1：全屏覆盖（如大图预览） */ }
  function maybeShowDegradedBanner(reason) { /* L2：降级提示横幅 */ }

  return {
    showToast, dismissToast, updateToast, toastPromise,
    showTooltip, openDialog, openShortcutsDialog, openOverlay, maybeShowDegradedBanner,
  };
})();
if (typeof window !== "undefined") window.UiFeedback = UiFeedback;
