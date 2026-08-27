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

  /* —— Tooltip：自绘悬浮提示，替代原生 title（L0-11 组件契约）——
   * anchor: HTMLElement；text: string。挂 anchor 下方，鼠标移出/3.5s 后消失。 */
  function showTooltip(anchor, text) {
    if (!anchor || !text) return null;
    const node = document.createElement("div");
    node.className = "ui-tooltip";
    node.textContent = text;
    node.style.cssText =
      "position:fixed;z-index:10002;pointer-events:none;max-width:240px;" +
      "background:rgba(28,28,30,.96);color:#fff;padding:6px 9px;border-radius:7px;" +
      "font:12px/1.45 system-ui,-apple-system,'Microsoft YaHei',sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);" +
      "white-space:pre-wrap;";
    document.body.appendChild(node);
    const r = anchor.getBoundingClientRect();
    let left = r.left + r.width / 2 - node.offsetWidth / 2;
    let top = r.bottom + 8;
    left = Math.max(6, Math.min(left, window.innerWidth - node.offsetWidth - 6));
    if (top + node.offsetHeight > window.innerHeight) top = r.top - node.offsetHeight - 8;
    node.style.left = left + "px";
    node.style.top = top + "px";
    let timer = setTimeout(() => node.remove(), 3500);
    anchor.addEventListener("mouseleave", () => { clearTimeout(timer); node.remove(); }, { once: true });
    return { dismiss() { clearTimeout(timer); node.remove(); } };
  }

  /* —— Dialog：模态对话框（确认/输入），遮罩 blur≥4px（L0-11 组件契约）——
   * opts: { title, body(字符串|Node), actions:[{label,value,variant}], onClose(value) }
   * 返回 { close() }。 */
  function openDialog(opts) {
    const o = opts || {};
    const mask = document.createElement("div");
    mask.className = "ui-dialog-mask";
    mask.style.cssText =
      "position:fixed;inset:0;z-index:10003;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.45);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);";
    const box = document.createElement("div");
    box.className = "ui-dialog";
    box.style.cssText =
      "min-width:280px;max-width:80vw;background:#1f1f22;color:#fff;border-radius:12px;padding:18px 20px;" +
      "font:14px/1.6 system-ui,-apple-system,'Microsoft YaHei',sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.5);";
    if (o.title) {
      const t = document.createElement("div");
      t.style.cssText = "font-weight:600;font-size:15px;margin-bottom:10px;";
      t.textContent = o.title;
      box.appendChild(t);
    }
    const body = document.createElement("div");
    body.style.marginBottom = "16px";
    if (typeof o.body === "string") {
      body.textContent = o.body;
      box.appendChild(body);
    } else if (o.body && o.body.nodeType) {
      box.appendChild(o.body);
    } else {
      box.appendChild(body);
    }
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";
    const actions = o.actions || [{ label: "确定", value: "ok", variant: "primary" }];
    const handle = { close() { if (mask.parentNode) mask.remove(); } };
    actions.forEach(a => {
      const btn = document.createElement("button");
      btn.textContent = a.label;
      btn.style.cssText =
        "padding:7px 16px;border:0;border-radius:8px;cursor:pointer;font:14px system-ui;" +
        (a.variant === "primary" ? "background:#3b82f6;color:#fff;" : "background:#3a3a3f;color:#ddd;");
      btn.onclick = () => { handle.close(); if (o.onClose) o.onClose(a.value); };
      bar.appendChild(btn);
    });
    box.appendChild(bar);
    mask.appendChild(box);
    document.body.appendChild(mask);
    return handle;
  }

  /* —— ShortcutsDialog：列快捷键（L0-11 组件契约）——
   * 通过 openDialog 渲染，避免重复造弹窗；数据来自 SHORTCUTS 表（无则给默认）。 */
  function openShortcutsDialog() {
    const rows = (window.SHORTCUTS || [
      ["Space", "播放/暂停"], ["J/K/L", "后退/暂停/前进"], ["←/→", "逐帧"],
      ["Home/End", "到开头/结尾"], ["Ctrl+Z/Y", "撤销/重做"], ["Ctrl+D", "复制段"],
      ["Delete", "删除段"], ["Ctrl+滚轮", "画布缩放"], ["Ctrl+Shift+滚轮", "时间轴缩放"],
    ]);
    const list = document.createElement("div");
    list.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:6px 18px;font-size:13px;";
    rows.forEach(([k, v]) => {
      const kk = document.createElement("div");
      kk.style.cssText = "font-family:ui-monospace,monospace;color:#9cd;";
      kk.textContent = k;
      const vv = document.createElement("div");
      vv.textContent = v;
      list.appendChild(kk); list.appendChild(vv);
    });
    return openDialog({ title: "快捷键", body: list });
  }

  /* —— Overlay：全屏覆盖（如大图预览，L0-11 组件契约）—— */
  function openOverlay(content) {
    const mask = document.createElement("div");
    mask.className = "ui-overlay";
    mask.style.cssText = "position:fixed;inset:0;z-index:10004;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);";
    if (content && content.nodeType) mask.appendChild(content);
    document.body.appendChild(mask);
    mask.addEventListener("click", e => { if (e.target === mask) mask.remove(); });
    return { close() { if (mask.parentNode) mask.remove(); } };
  }

  /* —— DegradedBanner：降级提示横幅（L2，先落地轻量版，L0-11 组件契约）—— */
  function maybeShowDegradedBanner(reason) {
    if (!reason) return;
    const id = "ui-degraded-banner";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:10001;padding:6px 12px;text-align:center;" +
        "background:#7a5b00;color:#fff;font:12px system-ui;pointer-events:none;";
      document.body.appendChild(el);
    }
    el.textContent = reason;
  }

  return {
    showToast, dismissToast, updateToast, toastPromise,
    showTooltip, openDialog, openShortcutsDialog, openOverlay, maybeShowDegradedBanner,
  };
})();
if (typeof window !== "undefined") window.UiFeedback = UiFeedback;
