/* =====================================================================
 * property/effect-panel.js —— effect 面板迁移（Property Framework v1，Phase 3）
 * =====================================================================
 * PropertyPanel 生命周期管理滑块区（#effCtrls）：
 *   - 结构 key(段身份+特效类型+参数集合) 相同 → 只 updateFields（SliderField.update 只改值）
 *   - key 变化 → destroy+buildFields 重建
 * 滑块用 SliderField：input→preview（改内存 params）/ change→commit（debounce 250ms 调 update_effect）
 * 删除按钮保留 id=effRemove（无委托依赖，Field.on 统一解绑）
 * 函数名 renderEffectPanelPF 避免与旧 renderEffectPanel 冲突。
 * 依赖：PropertyPanel/PropertyField/SliderField + parseRange/rangeStep(HTML) + Store/call/selectKey/refresh。
 */
let _effPropPanel = null;
const _effTimers = {};

function renderEffectPanelPF() {
  const nameEl = $("effSegName"), emptyEl = $("effEmpty"), ctrlsEl = $("effCtrls");
  const s = selectedSeg();
  if (!s || s.type !== "effect") {
    if (_effPropPanel) { _effPropPanel.destroy(); _effPropPanel = null; }
    emptyEl.style.display = ""; ctrlsEl.style.display = "none"; nameEl.textContent = "";
    return;
  }
  emptyEl.style.display = "none"; ctrlsEl.style.display = "";
  const meta = (Store.state.effects && Store.state.effects[s.effect_type]) || null;
  nameEl.textContent = (meta ? meta.label : s.effect_type) || "";
  const key = Store.state.selectedKey || "";
  const selId = s.id || key;
  const paramKeys = meta && meta.params ? Object.keys(meta.params).join(",") : "";
  if (!_effPropPanel) {
    _effPropPanel = new PropertyPanel({
      host: ctrlsEl,
      keyFn: (c) => c.selId + "|" + (c.s.effect_type || "") + "|" + c.paramKeys,
      buildFields: (c) => buildEffectFields(c),
      updateFields: (fields, c) => updateEffectFields(fields, c),
    });
  }
  _effPropPanel.render({ s, selId, paramKeys, meta, key });
}

/* —— 滑块区 Field 树构建（结构变化时才调用） —— */
function buildEffectFields(c) {
  const { s, meta, key } = c;
  const tgt = s.target || { type: "adjustment" };
  const tgtLabel = tgt.type === "adjustment" ? "调整层（整段时间轴）"
    : tgt.type === "clip" ? ("绑定片段 " + (tgt.track != null ? tgt.track : 0) + ":" + (tgt.si != null ? tgt.si : 0))
    : tgt.type === "track" ? ("轨 " + (tgt.ti != null ? tgt.ti : 0)) : "全局";
  const parts = key.split(":");
  const ti = parts[1] != null ? parseInt(parts[1]) : null;
  const idx = parts[2] != null ? parseInt(parts[2]) : null;
  const fields = [];

  fields.push(new PropertyField({
    id: "eff-tgt",
    buildDom: () => { const d = document.createElement("div"); d.className = "insp-sub"; d.textContent = "作用对象：" + tgtLabel; return d; },
  }));

  if (meta && meta.params) {
    fields.push(new PropertyField({
      id: "eff-title",
      buildDom: () => { const d = document.createElement("div"); d.className = "insp-sub"; d.textContent = "参数"; return d; },
    }));
    const cur = s.params || {};
    for (const pname in meta.params) {
      const pm = meta.params[pname];
      const rr = parseRange(pm.range); const mn = rr[0], mx = rr[1];
      const step = rangeStep(mn, mx);
      const def = (pm.default != null) ? pm.default : mn;
      const val = (cur[pname] != null) ? cur[pname] : def;
      fields.push(new SliderField({
        id: "eff-" + pname,
        label: pm.label || pname,
        value: val,
        min: mn, max: mx, step,
        onPreview: (v) => {
          if (s.params) s.params[pname] = v;       // 拖动中改内存（保留）
          if (typeof renderPreview === "function") renderPreview();   // L1-20：实时预览（路线 B：直接重渲；L0-03 落地后收敛到 getPreviewSeg 隔离 overlay）
        },
        onCommit: (v) => {                                            // L1-20：去 250ms debounce，松手即提交一条 undo
          if (ti == null || idx == null) return;
          clearTimeout(_effTimers[pname]);
          CommandService.withTx("effect-param-" + pname, () =>
            call("update_effect", ti, idx, { params: { [pname]: v } }, Store.state.selectedSegId).then(refresh),
          { onError: e => console.error("[effect-panel] update_effect 失败:", e) });
        },
      }));
    }
  } else {
    fields.push(new PropertyField({
      id: "eff-status",
      buildDom: () => { const d = document.createElement("div"); d.className = "insp-status"; d.textContent = "该特效暂无可调参数。"; return d; },
    }));
  }

  fields.push(new PropertyField({
    id: "eff-remove",
    buildDom: () => {
      const b = document.createElement("button");
      b.className = "insp-gen"; b.id = "effRemove";
      b.style.cssText = "background:#3a2326;color:#ff9b9b";
      b.textContent = "删除特效";
      return b;
    },
    bind: (fld) => {
      fld.on(fld.el, "click", () => {
        if (ti == null || idx == null) return;
        call("remove_effect", ti, idx, Store.state.selectedSegId).then(() => { selectKey(null); refresh(); });
      });
    },
  }));

  return fields;
}

/* —— key 相同时只更新值（SliderField.update 跳过正在拖动的滑块） —— */
function updateEffectFields(fields, c) {
  const { s, meta } = c;
  const cur = s.params || {};
  fields.forEach(f => {
    if (f.id && f.id.indexOf("eff-") === 0 && f instanceof SliderField) {
      const pname = f.id.slice(4);
      const pm = meta && meta.params ? meta.params[pname] : null;
      if (!pm) return;
      const rr = parseRange(pm.range);
      const def = (pm.default != null) ? pm.default : rr[0];
      const val = (cur[pname] != null) ? cur[pname] : def;
      f.update(val);
    }
  });
}
