/* =====================================================================
 * property/speed-panel.js —— speed 面板迁移（Property Framework v1，Phase 2）
 * =====================================================================
 * 同 audio 迁移方式：PropertyPanel 生命周期 + 内联 PropertyField + PropertyDraft。
 * 结构 key(段身份/单批量) 相同 → 只 updateFields；key 变化 → destroy+buildFields 重建。
 * 事件 Field.on 统一登记（unmount 统一解绑）；速度输入 PropertyDraft 两阶段。
 * 函数名 renderSpeedTabPF 避免与旧 renderSpeedTab 冲突（旧代码 Phase 4 清理）。
 * 依赖：PropertyPanel/PropertyField/PropertyDraft + HTML 内 buildSegRefs/renderPreview + Store。
 */
let _speedPropPanel = null;

function renderSpeedTabPF() {
  const bodyEl = $("spdBody"), nameEl = $("spdSegName");
  if (!bodyEl) return;
  // 编辑中(速度输入框正聚焦)跳过重建,保住焦点 —— 对齐 OpenCut usePropertyDraft 两阶段
  if (document.activeElement && bodyEl.contains(document.activeElement)) return;
  const refs = buildSegRefs();
  if (!refs.length) {
    if (_speedPropPanel) { _speedPropPanel.destroy(); _speedPropPanel = null; }
    bodyEl.innerHTML = '<div class="insp-empty" style="padding:24px;text-align:center;color:var(--muted)">未选中片段</div>';
    if (nameEl) nameEl.textContent = "";
    return;
  }
  const isBatch = refs.length > 1;
  const allMedia = refs.every(r => r.seg && (r.seg.type === "video" || r.seg.type === "audio"));
  if (!allMedia) {
    if (_speedPropPanel) { _speedPropPanel.destroy(); _speedPropPanel = null; }
    bodyEl.innerHTML = '<div class="insp-empty" style="padding:24px;text-align:center;color:var(--muted)">仅视频/音频段可变速' + (isBatch ? "（批量需全选视频/音频）" : "") + '</div>';
    if (nameEl) nameEl.textContent = "";
    return;
  }
  const s = refs[0].seg;
  const selId = refs[0].segid || (refs[0].type + ":" + refs[0].ti + ":" + refs[0].idx);
  if (!_speedPropPanel) {
    _speedPropPanel = new PropertyPanel({
      host: bodyEl,
      keyFn: (c) => c.selId + "|" + (c.isBatch ? "B" : "S"),
      buildFields: (c) => buildSpeedFields(c),
      updateFields: (fields, c) => updateSpeedFields(fields, c),
      onMount: (c) => { if (c.nameEl) c.nameEl.textContent = c.isBatch ? (" " + c.refs.length + " 个片段") : (" " + ((c.s && c.s.name) || "")); },
    });
  }
  _speedPropPanel.render({ refs, s, selId, isBatch, nameEl });
}

/* —— Field 树构建（结构变化时才调用） —— */
function buildSpeedFields(c) {
  const { s, isBatch } = c;
  const sp = (s.speed == null ? 1 : s.speed);
  const pitch = !!s.change_pitch;
  const spd = Math.round(sp * 100) / 100;

  // 速度 NumberField（0.01~5x）+ 复位（一个 Field 装完整 Section，视觉不变）
  const spdField = new PropertyField({
    id: "spdVal",
    buildDom: () => {
      const wrap = document.createElement("div");
      wrap.className = "insp-section";
      wrap.innerHTML =
        '<div class="insp-section-head open"><span class="chev">▼</span><span class="t">速度</span></div>' +
        '<div class="insp-section-body"><div class="inner">' +
          (isBatch ? '<div class="insp-batch-hint">批量应用于 ' + c.refs.length + ' 个片段</div>' : '') +
          '<div class="insp-field">' +
            '<div class="insp-field-label">速度</div>' +
            '<div class="insp-num"><span class="ic">⏩</span>' +
              '<input type="text" inputmode="decimal" id="spdVal" value="' + spd + '">' +
              '<span class="unit">x</span>' +
              '<button class="reset" id="spdValReset" title="恢复默认 1x">↺</button>' +
            '</div>' +
          '</div>' +
          '<div class="insp-field">' +
            '<div class="insp-switch-row"><span class="lab">变音（音调随速度）</span>' +
            '<div id="spdPitch" class="insp-switch' + (pitch ? " on" : "") + '" title="变音开=慢放声音变低沉，关=保持原调"></div></div>' +
          '</div>' +
          '<div class="empty-hint" style="margin-top:4px">变速改变时间轴时长，预览/导出均生效</div>' +
        '</div></div>';
      return wrap;
    },
    write: (el, v) => {
      const inp = el.querySelector("#spdVal");
      if (inp && document.activeElement !== inp) inp.value = Math.round(v * 100) / 100;
      const pitchEl = el.querySelector("#spdPitch");
      if (pitchEl) pitchEl.classList.toggle("on", !!v);
    },
    bind: (fld) => {
      const inp = fld.el.querySelector("#spdVal");
      if (!inp) return;
      const rst = fld.el.querySelector("#spdValReset");
      const pitchEl = fld.el.querySelector("#spdPitch");
      // 两阶段：input→preview（内存+预览渲染），blur/Enter→commit（后端落库）
      fld._draft = new PropertyDraft({
        parse: raw => { const n = parseFloat(raw); if (isNaN(n)) return null; return Math.max(0.01, Math.min(5, n)); },
        getValue: () => { const n = parseFloat(inp.value); return isNaN(n) ? 1 : n; },
        preview: previewSpeed,
        commit: commitSpeed,
      });
      fld.on(inp, "input", e => fld._draft.onInput(e.target.value));
      fld.on(inp, "blur", () => { fld._draft.onCommit(); fld.update(fld._draft.value); });
      fld.on(inp, "keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      if (rst) fld.on(rst, "click", () => { inp.value = "1"; fld._draft.onInput("1"); fld._draft.onCommit(); });
      if (pitchEl) fld.on(pitchEl, "click", () => toggleSpeedPitch(pitchEl));
    },
  });

  return [spdField];
}

/* —— key 相同时只更新值（Field.update，绝不重建 DOM） —— */
function updateSpeedFields(fields, c) {
  const { s, isBatch, refs, nameEl } = c;
  const sp = (s.speed == null ? 1 : s.speed);
  const pitch = !!s.change_pitch;
  fields.forEach(f => {
    if (f.id === "spdVal") { f.update(Math.round(sp * 100) / 100); f._write2 ? null : null; }
  });
  // 变音开关状态同步（spdVal field 的 write 里也带 pitch，但值更新时单独同步更明确）
  if (fields[0] && fields[0].el) {
    const pitchEl = fields[0].el.querySelector("#spdPitch");
    if (pitchEl) pitchEl.classList.toggle("on", pitch);
  }
  if (nameEl) nameEl.textContent = isBatch ? (" " + refs.length + " 个片段") : (" " + (s.name || ""));
}

/* —— speed 交互（每次取最新段引用） —— */
function liveSpeedRefs() { const r = buildSegRefs(); return r.length ? r : null; }

// 预览：仅改内存+实时预览,不提交后端(对齐 OpenCut onPreview)
function previewSpeed(v) {
  v = Math.max(0.01, Math.min(5, v));
  const refs = liveSpeedRefs(); if (!refs) return;
  refs.forEach(r => { if (r.seg) setProperty(r.seg, "speed.rate", v); });  // C1.3：统一走 setProperty
  renderPreview();
}
// 提交：失焦/回车才落库(对齐 OpenCut onCommit)
function commitSpeed(v) {
  v = Math.max(0.01, Math.min(5, v));
  const refs = liveSpeedRefs(); if (!refs) return;
  if (refs.length > 1) call("set_segments_props", refs.map(r => ({ segid: r.segid, props: { speed: v } }))).then(refresh);
  else call("set_segment_speed", refs[0].type, refs[0].ti, refs[0].idx, v, null, refs[0].segid).then(refresh);
}
// 变音：本地态先变(即时反馈)，再提交后端
function toggleSpeedPitch(pitchEl) {
  const refs = liveSpeedRefs(); if (!refs) return;
  const next = !refs[0].seg.change_pitch;
  refs.forEach(r => { if (r.seg) r.seg.change_pitch = next; });
  if (pitchEl) pitchEl.classList.toggle("on", next);
  if (refs.length > 1) call("set_segments_props", refs.map(r => ({ segid: r.segid, props: { change_pitch: next } }))).then(refresh);
  else call("set_segment_speed", refs[0].type, refs[0].ti, refs[0].idx, refs[0].seg.speed || 1, next, refs[0].segid).then(refresh);
}
