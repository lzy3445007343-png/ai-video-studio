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
let _clipEffPanel = null;
const _effTimers = {};

function renderEffectPanelPF() {
  const nameEl = $("effSegName"), emptyEl = $("effEmpty"), ctrlsEl = $("effCtrls");
  const s = selectedSeg();
  if (!s) {
    if (_effPropPanel) { _effPropPanel.destroy(); _effPropPanel = null; }
    if (_clipEffPanel) { _clipEffPanel.destroy(); _clipEffPanel = null; }
    emptyEl.style.display = ""; ctrlsEl.style.display = "none"; nameEl.textContent = "";
    return;
  }
  // 独立特效段：保留既有面板逻辑（L2-03 不破坏）
  if (s.type === "effect") {
    if (_clipEffPanel) { _clipEffPanel.destroy(); _clipEffPanel = null; }
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
    return;
  }
  // 视频/图片段：Clip 级特效列表（L2-03）
  if (s.type === "video" || s.type === "image") {
    if (_effPropPanel) { _effPropPanel.destroy(); _effPropPanel = null; }
    emptyEl.style.display = "none"; ctrlsEl.style.display = "";
    const vidId = Store.state.selectedSegId || s.id || "";
    const clips = collectClipEffects(vidId);
    nameEl.textContent = (s.name || (s.type === "video" ? "视频" : "图片")) + " · 特效列表";
    if (!_clipEffPanel) {
      _clipEffPanel = new PropertyPanel({
        host: ctrlsEl,
        keyFn: (c) => {
          const ids = (c.clips || []).map(x => x.seg.id + ":" + x.trIndex + ":" + x.idx + ":" + (x.seg.hidden ? "H" : "N")).join(",");
          return (c.selId || "") + "|" + ids;
        },
        buildFields: (c) => buildClipEffectFields(c),
        updateFields: (fields, c) => updateClipEffectFields(fields, c),
      });
    }
    _clipEffPanel.render({ s, selId: vidId, clips });
    return;
  }
  // 其他类型：空态
  if (_effPropPanel) { _effPropPanel.destroy(); _effPropPanel = null; }
  if (_clipEffPanel) { _clipEffPanel.destroy(); _clipEffPanel = null; }
  emptyEl.style.display = ""; ctrlsEl.style.display = "none"; nameEl.textContent = "";
}

/* —— L2-03 Clip 级特效列表：收集绑定到某段的特效段（target.seg_id 稳定匹配） —— */
function collectClipEffects(segId) {
  const out = [];
  if (!segId) return out;
  const overlay = (Store.state.draft && Store.state.draft.overlay) || [];
  for (let trIndex = 0; trIndex < overlay.length; trIndex++) {
    const tr = overlay[trIndex];
    if (!tr || tr.type !== "effect") continue;
    const segs = tr.segs || [];
    for (let idx = 0; idx < segs.length; idx++) {
      const seg = segs[idx];
      const t = seg.target || {};
      if (t.seg_id === segId) out.push({ seg, trIndex, idx, meta: (Store.state.effects && Store.state.effects[seg.effect_type]) || null });
    }
  }
  return out;
}

function buildClipEffectFields(c) {
  const { s, clips } = c;
  const fields = [];
  if (!clips.length) {
    fields.push(new PropertyField({
      id: "clip-eff-empty",
      buildDom: () => {
        const d = document.createElement("div");
        d.className = "insp-empty";
        d.style.cssText = "padding:24px;text-align:center;color:var(--muted)";
        d.textContent = "该片段暂无挂接的特效。";
        const btn = document.createElement("button");
        btn.id = "clipEffAdd"; btn.className = "insp-gen"; btn.style.cssText = "margin-top:12px";
        btn.textContent = "去特效面板添加";
        d.appendChild(btn);
        return d;
      },
      bind: (fld) => {
        const b = fld.el.querySelector("#clipEffAdd");
        if (b) fld.on(b, "click", () => { if (typeof showToolTab === "function") showToolTab("effects"); });
      },
    }));
    return fields;
  }
  for (const item of clips) {
    const { seg, trIndex, idx, meta } = item;
    const label = (meta && meta.label) || seg.effect_type || "特效";
    const hidden = !!seg.hidden;
    const head = new PropertyField({
      id: "clip-eff-head-" + seg.id,
      buildDom: () => {
        const sec = document.createElement("div");
        sec.className = "insp-section";
        sec.style.opacity = hidden ? "0.5" : "1";
        const h = document.createElement("div");
        h.className = "insp-section-head open";
        const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▼";
        const t = document.createElement("span"); t.className = "t"; t.textContent = label;
        const eye = document.createElement("button");
        eye.className = "icon-btn"; eye.id = "clipEffEye-" + seg.id;
        eye.title = hidden ? "显示特效" : "停用特效";
        eye.textContent = hidden ? "显示" : "隐藏";
        const del = document.createElement("button");
        del.className = "insp-gen"; del.id = "clipEffDel-" + seg.id;
        del.style.cssText = "background:#3a2326;color:#ff9b9b;margin-left:8px";
        del.textContent = "删除";
        h.appendChild(chev); h.appendChild(t); h.appendChild(eye); h.appendChild(del);
        sec.appendChild(h);
        return sec;
      },
      bind: (fld) => {
        const eye = fld.el.querySelector("#clipEffEye-" + seg.id);
        const del = fld.el.querySelector("#clipEffDel-" + seg.id);
        if (eye) fld.on(eye, "click", () => {
          CommandService.withTx("clip-eff-toggle", () =>
            call("update_effect", trIndex, idx, { hidden: !hidden }, seg.id).then(refresh),
          { onError: e => console.error("[clip-effect] toggle 失败:", e) });
        });
        if (del) fld.on(del, "click", () => {
          call("remove_effect", trIndex, idx, seg.id).then(() => { refresh(); });
        });
      },
    });
    fields.push(head);
    if (meta && meta.params) {
      const cur = seg.params || {};
      for (const pname in meta.params) {
        const pm = meta.params[pname];
        const rr = parseRange(pm.range); const mn = rr[0], mx = rr[1];
        const step = rangeStep(mn, mx);
        const def = (pm.default != null) ? pm.default : mn;
        const val = (cur[pname] != null) ? cur[pname] : def;
        fields.push(new SliderField({
          id: "clip-eff-param::" + seg.id + "::" + pname,
          label: pm.label || pname,
          value: val, min: mn, max: mx, step,
          onPreview: (v) => {
            if (seg.params) seg.params[pname] = v;
            if (typeof PreviewState !== "undefined") PreviewState.notifyPreviewConsumers(seg.id);
            if (typeof renderPreview === "function") renderPreview();
          },
          onCommit: (v) => {
            CommandService.withTx("clip-effect-param-" + pname, () =>
              call("update_effect", trIndex, idx, { params: { [pname]: v } }, seg.id).then(refresh),
            { onError: e => console.error("[clip-effect] update_effect 失败:", e) });
          },
        }));
      }
    }
  }
  return fields;
}

function updateClipEffectFields(fields, c) {
  const { clips } = c;
  fields.forEach(f => {
    if (f instanceof SliderField) {
      const m = f.id.match(/^clip-eff-param::(.+)::(.+)$/);
      if (!m) return;
      const segId = m[1], pname = m[2];
      const item = clips.find(x => x.seg.id === segId);
      if (!item || !item.seg.params) return;
      const pm = item.meta && item.meta.params ? item.meta.params[pname] : null;
      if (!pm) return;
      const rr = parseRange(pm.range);
      const def = (pm.default != null) ? pm.default : rr[0];
      const val = (item.seg.params[pname] != null) ? item.seg.params[pname] : def;
      f.update(val);
    }
  });
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
          if (s.params) s.params[pname] = v;       // 拖动中改内存（保留现有预览行为）
          if (typeof PreviewState !== "undefined") PreviewState.notifyPreviewConsumers(s.id);  // L0-03/L1-20：通知三方（基础设施）
          if (typeof renderPreview === "function") renderPreview();   // 预览跟手
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
