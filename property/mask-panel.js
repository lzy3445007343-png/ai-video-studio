/* =====================================================================
 * property/mask-panel.js —— mask 面板迁移（Property Framework v1，Phase 3）
 * =====================================================================
 * PropertyPanel 生命周期管理滑块区（#maskCtrls）：
 *   - 结构 key(段身份+遮罩实例 id) 相同 → 只 updateFields（SliderField.update 只改值）
 *   - key 变化 → destroy+buildFields 重建（切换段/换形状/换遮罩实例）
 * shapes 区(#maskShapes)保持结构守卫（事件已委托 maskShapes，无需重绑）
 * 滑块用 SliderField（无 data-k，与 bindEvents 的 maskCtrls 委托不冲突——
 *   委托只认 data-k 滑块/#maskInv/data-act=remove，这些我们保留）
 * 事件：SliderField 自带 input→preview / change→commit（两阶段）
 * 函数名 renderMaskPanelPF 避免与 renderer.js 旧 renderMaskPanel 冲突。
 * 依赖：PropertyPanel/PropertyField/SliderField + MASK_SHAPES/MASK_EXPORTABLE/renderMaskOverlay(renderer.js)
 *       + selectedSeg/renderPreview(HTML) + Store/call。
 */
let _maskPropPanel = null;

function renderMaskPanelPF() {
  const nameEl = $("maskSegName"), shapesEl = $("maskShapes"), ctrlsEl = $("maskCtrls"), emptyEl = $("maskEmpty");
  const s = selectedSeg();
  const ok = s && (s.type === "video" || s.type === "image");
  if (!ok) {
    if (_maskPropPanel) { _maskPropPanel.destroy(); _maskPropPanel = null; }
    emptyEl.style.display = ""; shapesEl.style.display = "none"; ctrlsEl.style.display = "none"; nameEl.textContent = "";
    return;
  }
  emptyEl.style.display = "none"; shapesEl.style.display = "flex"; nameEl.textContent = s.name || "";
  const cur = (s.masks && s.masks[0]) || null;
  const shape = cur ? cur.type : "";
  const selId = s.id || (Store.state.selectedKey || "");
  // shapes 区：结构(段身份+形状类型)不变时只更新高亮（事件已委托 maskShapes）
  if (shapesEl.__key !== selId + "|" + shape) {
    shapesEl.__key = selId + "|" + shape;
    shapesEl.innerHTML = MASK_SHAPES.map(sh =>
      `<button data-type="${sh.type}" class="${cur && cur.type === sh.type ? "on" : ""}">${sh.name}</button>`).join("");
  } else {
    shapesEl.querySelectorAll("button[data-type]").forEach(b => b.classList.toggle("on", b.dataset.type === shape));
  }
  if (!cur) {
    if (_maskPropPanel) { _maskPropPanel.destroy(); _maskPropPanel = null; }
    ctrlsEl.style.display = "none";
    return;
  }
  ctrlsEl.style.display = "";
  if (!_maskPropPanel) {
    _maskPropPanel = new PropertyPanel({
      host: ctrlsEl,
      keyFn: (c) => c.selId + "|" + c.cur.id,
      buildFields: (c) => buildMaskFields(c),
      updateFields: (fields, c) => updateMaskFields(fields, c),
    });
  }
  _maskPropPanel.render({ cur, s, selId });
}

/* —— 滑块区 Field 树构建（结构变化时才调用） —— */
function buildMaskFields(c) {
  const { cur } = c;
  const p = cur.params;
  const feats = MASK_SHAPES.find(x => x.type === cur.type).feats;
  const fields = [];
  const mkSlider = (key, label, min, max, step) => new SliderField({
    id: "mask-" + key,
    label,
    value: p[key] || 0,
    min, max, step,
    onPreview: (v) => previewMaskParam(key, v),   // 拖动中每帧预览（内存+遮罩渲染），不落库
    onCommit: (v) => commitMaskParam(key, v),     // 松手才落库
  });
  if (feats.pos) { fields.push(mkSlider("centerX", "X", -2, 2, 0.01)); fields.push(mkSlider("centerY", "Y", -2, 2, 0.01)); }
  if (feats.edges) { fields.push(mkSlider("width", "宽", 0.01, 2, 0.01)); fields.push(mkSlider("height", "高", 0.01, 2, 0.01)); }
  if (feats.scale) fields.push(mkSlider("scale", "缩放", 0.05, 5, 0.01));
  fields.push(mkSlider("rotation", "旋转", 0, 360, 1));
  fields.push(mkSlider("feather", "羽化", 0, 100, 1));
  // 反转 checkbox（保留 #maskInv，bindEvents 委托继续处理点击）
  fields.push(new PropertyField({
    id: "mask-inv",
    buildDom: () => {
      const d = document.createElement("div");
      d.className = "chk";
      d.innerHTML = '<input type="checkbox" id="maskInv" ' + (p.inverted ? "checked" : "") + '><label for="maskInv">反转遮罩（保留外部）</label>';
      return d;
    },
    write: (el, v) => { const cb = el.querySelector("#maskInv"); if (cb) cb.checked = !!v; },
  }));
  // 导出提示 + 删除按钮（保留 data-act=remove，委托继续处理）
  fields.push(new PropertyField({
    id: "mask-remove",
    buildDom: () => {
      const d = document.createElement("div");
      const exp = MASK_EXPORTABLE[cur.type]
        ? "导出剪映：支持（矩形/椭圆/星形/爱心/线性）。"
        : "导出剪映：该形状剪映基础遮罩无对应，仅本软件预览。";
      d.innerHTML = '<div class="expnote">' + exp + '</div><button class="rm" data-act="remove">删除遮罩</button>';
      return d;
    },
  }));
  return fields;
}

/* —— key 相同时只更新值（SliderField.update 跳过正在拖动的滑块） —— */
function updateMaskFields(fields, c) {
  const { cur } = c;
  const p = cur.params;
  fields.forEach(f => {
    if (f.id && f.id.indexOf("mask-") === 0 && f instanceof SliderField) {
      const key = f.id.slice(5);
      f.update(p[key] || 0);
    } else if (f.id === "mask-inv") {
      f.update(!!p.inverted);
    }
  });
}

/* —— mask 交互（每次取最新段引用） —— */
function maskRef() {
  const s = selectedSeg();
  if (!s || !s.masks || !s.masks.length) return null;
  const k = Store.state.selectedKey; if (!k) return null;
  return { s, key: k };
}
// 预览：只改内存+实时渲染，不落库（对齐 OpenCut onPreview）
function previewMaskParam(k, v) {
  const m = maskRef(); if (!m) return;
  m.s.masks[0].params[k] = v;
  renderPreview();
  if (typeof renderMaskOverlay === "function") renderMaskOverlay();
}
// 提交：松手才落库（对齐 OpenCut onCommit）
function commitMaskParam(k, v) {
  const m = maskRef(); if (!m) return;
  const [type, ti, idx] = m.key.split(":");
  call("update_mask_param", type, +ti, +idx, m.s.masks[0].id, k, v).then(refresh);
}
