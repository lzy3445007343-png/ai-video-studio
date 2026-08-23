/* =====================================================================
 * property/audio-panel.js —— audio 面板迁移（Property Framework v1，Phase 2）
 * =====================================================================
 * 用 PropertyPanel 生命周期 + 内联 PropertyField + PropertyDraft 重写：
 *   - 结构 key(段身份/单批量/是否带音量关键帧) 相同 → 只 updateFields（Field.update 只改值）
 *   - key 变化 → destroy + buildFields 重建 Field 树（切换段/批量/关键帧开关）
 *   - 事件用 Field.on 统一登记（unmount 统一解绑，无泄漏）
 *   - 输入用 PropertyDraft 两阶段：input→preview（内存态+预览渲染）/ blur·Enter→commit（后端落库）
 * 函数名 renderAudioTabPF 避免与旧 renderAudioTab 冲突（旧代码 Phase 4 清理）。
 * 依赖：PropertyPanel/PropertyField/PropertyDraft（property/ 已加载）+ HTML 内 buildSegRefs/kfVal/volToDb/dbToVol/
 *       setVolKfLocal/toggleVolKf/callKVF/renderPreview + Store/AudioEngine。
 */
let _audioPropPanel = null;

function renderAudioTabPF() {
  const bodyEl = $("audBody"), nameEl = $("audSegName");
  if (!bodyEl) return;
  // 焦点守卫：输入框聚焦时跳过整个渲染(保护已输入内容与光标)
  const ae = document.activeElement;
  if (ae && bodyEl.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;

  const refs = buildSegRefs();
  if (!refs.length) {
    if (_audioPropPanel) { _audioPropPanel.destroy(); _audioPropPanel = null; }
    bodyEl.innerHTML = '<div class="insp-empty" style="padding:24px;text-align:center;color:var(--muted)">未选中片段</div>';
    if (nameEl) nameEl.textContent = "";
    return;
  }
  const isBatch = refs.length > 1;
  const allMedia = refs.every(r => r.seg && (r.seg.type === "video" || r.seg.type === "audio"));
  if (!allMedia) {
    if (_audioPropPanel) { _audioPropPanel.destroy(); _audioPropPanel = null; }
    bodyEl.innerHTML = '<div class="insp-empty" style="padding:24px;text-align:center;color:var(--muted)">音量仅适用于视频/音频段' + (isBatch ? "（批量需全选视频/音频）" : "") + '</div>';
    if (nameEl) nameEl.textContent = "";
    return;
  }
  const s = refs[0].seg;
  const selId = refs[0].segid || (refs[0].type + ":" + refs[0].ti + ":" + refs[0].idx);
  const anims = s.animations || {};
  const hasVolKf = !!(anims.volume && anims.volume.keys && anims.volume.keys.length);
  if (!_audioPropPanel) {
    _audioPropPanel = new PropertyPanel({
      host: bodyEl,
      keyFn: (c) => c.selId + "|" + (c.isBatch ? "B" : "S") + "|" + (c.hasVolKf ? "K" : "N"),
      buildFields: (c) => buildAudioFields(c),
      updateFields: (fields, c) => updateAudioFields(fields, c),
      onMount: (c) => { if (c.nameEl) c.nameEl.textContent = c.isBatch ? (" " + c.refs.length + " 个片段") : (" " + ((c.s && c.s.name) || "")); },
    });
  }
  _audioPropPanel.render({ refs, s, selId, isBatch, hasVolKf, nameEl });
}

/* —— Field 树构建（结构变化时才调用；每个 Field 的 DOM 只在 mount 创建一次） —— */
function buildAudioFields(c) {
  const { s, isBatch, hasVolKf } = c;
  const baseVol = (s.volume == null ? 1 : s.volume);
  const muted = !!s.muted;
  const local = Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration));
  const anims = s.animations || {};
  const curVol = hasVolKf ? (kfVal(anims, "volume", local) != null ? kfVal(anims, "volume", local) : baseVol) : baseVol;
  const db = volToDb(curVol);

  // 音量 NumberField（分贝）+ ◆关键帧按钮 + 复位（一个 Field 装完整 Section，视觉不变）
  const volField = new PropertyField({
    id: "audVol",
    buildDom: () => {
      const wrap = document.createElement("div");
      wrap.className = "insp-section";
      wrap.innerHTML =
        '<div class="insp-section-head open"><span class="chev">▼</span><span class="t">音量</span></div>' +
        '<div class="insp-section-body"><div class="inner">' +
          (isBatch ? '<div class="insp-batch-hint">批量应用于 ' + c.refs.length + ' 个片段（关键帧仅单段支持）</div>' : '') +
          '<div class="insp-field">' +
            '<div class="insp-field-label">音量' +
              (isBatch ? '' : '<button class="tog' + (hasVolKf ? " on" : "") + '" id="audVolKf" title="开/关音量关键帧（在播放头处打点）">◆</button>') +
            '</div>' +
            '<div class="insp-num"><span class="ic">🔊</span>' +
              '<input type="text" inputmode="decimal" id="audVol" value="' + db.toFixed(1) + '">' +
              '<span class="unit">分贝</span>' +
              '<button class="reset" id="audVolReset" title="恢复默认 0.0 分贝">↺</button>' +
            '</div>' +
            (hasVolKf ? '<div id="audVolKfHint" style="font-size:11px;color:var(--muted);margin-top:4px">已开启音量关键帧 · 当前值随播放头打点</div>' : '') +
          '</div>' +
        '</div></div>';
      return wrap;
    },
    write: (el, v) => {
      const inp = el.querySelector("#audVol");
      if (inp && document.activeElement !== inp) inp.value = Number(v).toFixed(1);
      const kfBtn = el.querySelector("#audVolKf");
      if (kfBtn) kfBtn.classList.toggle("on", !!hasVolKf);
      const hint = el.querySelector("#audVolKfHint");
      if (hint) hint.style.display = hasVolKf ? "" : "none";
    },
    bind: (fld) => {
      const inp = fld.el.querySelector("#audVol");
      if (!inp) return;
      const kfBtn = fld.el.querySelector("#audVolKf");
      const rst = fld.el.querySelector("#audVolReset");
      // 两阶段（PropertyDraft）：input→preview（内存态+预览渲染），blur/Enter→commit（后端落库）
      fld._draft = new PropertyDraft({
        parse: raw => { const n = parseFloat(raw); if (isNaN(n)) return null; return Math.max(-60, Math.min(6, n)); },
        getValue: () => { const n = parseFloat(inp.value); return isNaN(n) ? 0 : n; },
        preview: previewAudioVolume,
        commit: commitAudioVolume,
      });
      fld.on(inp, "input", e => fld._draft.onInput(e.target.value));
      fld.on(inp, "blur", () => { fld._draft.onCommit(); fld.update(fld._draft.value); });
      fld.on(inp, "keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
      if (rst) fld.on(rst, "click", () => { inp.value = "0.0"; fld._draft.onInput("0.0"); fld._draft.onCommit(); });
      if (kfBtn) fld.on(kfBtn, "click", () => { const r = buildSegRefs(); if (r.length) toggleVolKf(r); });
    },
  });

  // 静音开关（内联 Field；最小集不抽 ToggleField，等 Phase 3-4 需要时再抽）
  const muteField = new PropertyField({
    id: "audMute",
    buildDom: () => {
      const row = document.createElement("div");
      row.className = "insp-field";
      row.innerHTML = '<div class="insp-switch-row"><span class="lab">静音</span><div id="audMute" class="insp-switch' + (muted ? " on" : "") + '" title="静音/恢复"></div></div>';
      return row;
    },
    write: (el, v) => { const sw = el.querySelector(".insp-switch"); if (sw) sw.classList.toggle("on", !!v); },
    bind: (fld) => {
      const sw = fld.el.querySelector(".insp-switch");
      if (sw) fld.on(sw, "click", () => toggleAudioMute(sw));
    },
  });

  return [volField, muteField];
}

/* —— key 相同时只更新值（Field.update，绝不重建 DOM） —— */
function updateAudioFields(fields, c) {
  const { s, hasVolKf, isBatch, refs, nameEl } = c;
  const baseVol = (s.volume == null ? 1 : s.volume);
  const anims = s.animations || {};
  const local = Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration));
  const curVol = hasVolKf ? (kfVal(anims, "volume", local) != null ? kfVal(anims, "volume", local) : baseVol) : baseVol;
  const db = volToDb(curVol);
  fields.forEach(f => {
    if (f.id === "audVol") f.update(db);
    else if (f.id === "audMute") f.update(!!s.muted);
  });
  if (nameEl) nameEl.textContent = isBatch ? (" " + refs.length + " 个片段") : (" " + (s.name || ""));
}

/* —— audio 交互（每次取最新段引用：Store 刷新会替换 draft/段对象，build 闭包引用会过期） —— */
function liveAudioRefs() { const r = buildSegRefs(); return r.length ? r : null; }
function audioLocal(s) { return Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration)); }
function audioHasKf(s) { return !!(s.animations && s.animations.volume && s.animations.volume.keys && s.animations.volume.keys.length); }

// 预览：仅改内存+实时预览,不提交后端(对齐 OpenCut onPreview)
function previewAudioVolume(dbv) {
  try {
    const v = Math.max(0, Math.min(2, dbToVol(dbv)));
    const refs = liveAudioRefs(); if (!refs) return;
    const s = refs[0].seg;
    if (audioHasKf(s)) setVolKfLocal(s, audioLocal(s), v);   // 改当前播放头处的音量关键帧
    else refs.forEach(r => { if (r.seg) setProperty(r.seg, "audio.volume", v); });  // C1.3：统一走 setProperty
    renderPreview();
    if (typeof AudioEngine !== "undefined" && AudioEngine.updateLiveGains) AudioEngine.updateLiveGains(Store.state.playheadUs);
  } catch (e) { console.error("[audio] preview 失败:", e); }
}
// 提交：失焦/回车才落库(对齐 OpenCut onCommit)
function commitAudioVolume(dbv) {
  try {
    const v = Math.max(0, Math.min(2, dbToVol(dbv)));
    const refs = liveAudioRefs(); if (!refs) return;
    const s = refs[0].seg;
    if (audioHasKf(s)) callKVF(refs, "volume", audioLocal(s), v, "linear").then(refresh).catch(e => console.error("[audio] add_keyframe 失败:", e));
    else if (refs.length > 1) call("set_segments_props", refs.map(r => ({ segid: r.segid, props: { volume: v } }))).then(refresh).catch(e => console.error("[audio] 批量音量失败:", e));
    else call("set_segment_volume", refs[0].type, refs[0].ti, refs[0].idx, v, refs[0].segid).then(refresh).catch(e => console.error("[audio] set_segment_volume 失败:", e));
  } catch (e) { console.error("[audio] commit 失败:", e); }
}
// 静音：本地态先变(即时反馈,对齐 OpenCut 本地态先变)，再提交后端
function toggleAudioMute(sw) {
  const refs = buildSegRefs(); if (!refs.length) return;
  const next = !refs[0].seg.muted;
  refs.forEach(r => { if (r.seg) r.seg.muted = next; });
  if (sw) sw.classList.toggle("on", next);
  const done = () => refresh().catch(e => console.error("[audio] mute 刷新失败:", e));
  if (refs.length > 1) call("set_segments_props", refs.map(r => ({ segid: r.segid, props: { muted: next } }))).then(done);
  else call("set_segment_flag", refs[0].type, refs[0].ti, refs[0].idx, "muted", next, refs[0].segid).then(done);
}
