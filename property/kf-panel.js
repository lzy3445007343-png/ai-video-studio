/* =====================================================================
 * property/kf-panel.js —— keyframe 面板迁移（Property Framework v1，Phase 4）
 * =====================================================================
 * PropertyPanel 生命周期管理行列表（#kfRows）：
 *   - 结构 key(段身份+每通道开/关状态) 相同 → 只 updateFields（行 Field.update 只改值/◆高亮）
 *   - key 变化(切换段/通道开关) → destroy+buildFields 重建
 * 每行 = 一个内联 PropertyField（◆toggle + label + 值输入框 + ＋add）：
 *   - ◆ toggle → toggleKf(path)；＋ add → addKfAtPlayhead(path, val)
 *   - Field.on 统一解绑（unmount 无泄漏）
 * kfGraph 曲线图 / kfSel 选中帧编辑 保持原逻辑（动态内容，不属持久化控件）
 * 函数名 renderKfPanelPF 避免与旧 renderKfPanel 冲突。
 * 依赖：PropertyPanel/PropertyField + KF_PATHS_BY_TYPE/kfVal/toggleKf/addKfAtPlayhead/
 *       renderKfGraph/renderKfSel/round2(HTML) + Store/selectedSeg。
 */
let _kfPropPanel = null;

function renderKfPanelPF() {
  const nameEl = $("kfSegName"), rowsEl = $("kfRows"), graphEl = $("kfGraph"),
        selEl = $("kfSel"), emptyEl = $("kfEmpty"), hintEl = $("kfHint");
  const s = selectedSeg();
  const KF_VISUAL = ["video", "image", "sticker"];   // 视觉元素支持 transform 关键帧
  if (!s || !KF_VISUAL.includes(s.type)) {
    // 非视觉类型：audio 无画面位移；text 字段在字幕面板；其他不支持 transform 关键帧
    if (_kfPropPanel) { _kfPropPanel.destroy(); _kfPropPanel = null; }
    selectedKf = { path: null, id: null };
    nameEl.textContent = "";
    selEl.style.display = "none"; hintEl.style.display = "none"; graphEl.style.display = "none";
    if (s && s.type === "audio") {
      emptyEl.style.display = "none"; rowsEl.style.display = "";
      rowsEl.innerHTML = '<div style="padding:16px 8px;font-size:11px;color:var(--muted);text-align:center;line-height:1.6">音频段不支持位移/缩放/旋转关键帧（无画面）；调音量请切到 🔊 audio tab。</div>';
    } else if (s && s.type === "text") {
      emptyEl.style.display = "none"; rowsEl.style.display = "";
      rowsEl.innerHTML = '<div style="padding:16px 8px;font-size:11px;color:var(--muted);text-align:center;line-height:1.6">文本段的字号/颜色等字段在字幕面板（💬 sub tab），不在 transform 关键帧里。</div>';
    } else {
      emptyEl.style.display = ""; rowsEl.style.display = "none";
    }
    return;
  }
  emptyEl.style.display = "none"; rowsEl.style.display = ""; graphEl.style.display = "";
  hintEl.style.display = ""; nameEl.textContent = s.name || "";
  const anims = s.animations || {};
  const local = Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration));
  const paths = KF_PATHS_BY_TYPE[s.type] || [];
  const selId = s.id || (Store.state.selectedKey || "");
  // 结构 key：段身份 + 每通道开/关状态（通道开关变化 → 行结构变化 → 重建；值变化 → 只 update）
  const stateKey = paths.map(([path]) => (anims[path] && anims[path].keys && anims[path].keys.length ? "1" : "0")).join("");
  if (!_kfPropPanel) {
    _kfPropPanel = new PropertyPanel({
      host: rowsEl,
      keyFn: (c) => c.selId + "|" + c.stateKey,
      buildFields: (c) => buildKfFields(c),
      updateFields: (fields, c) => updateKfFields(fields, c),
    });
  }
  _kfPropPanel.render({ s, selId, stateKey, anims, local, paths });
  // 曲线图 / 选中帧编辑（动态内容，独立管理）
  renderKfGraph(s);
  if (selectedKf.path && selectedKf.id && anims[selectedKf.path] && anims[selectedKf.path].keys
      && anims[selectedKf.path].keys.some(k => k.id === selectedKf.id)) {
    renderKfSel(s);
  } else { selEl.style.display = "none"; selectedKf = { path: null, id: null }; }
}

/* —— 行列表 Field 树构建（结构变化时才调用；每行一个 Field，DOM 只在 mount 创建一次） —— */
function buildKfFields(c) {
  const { anims, local, paths } = c;
  const fields = [];
  for (const [path, lab, step, def] of paths) {
    const on = !!(anims[path] && anims[path].keys && anims[path].keys.length);
    const cur = kfVal(anims, path, local);
    const shown = cur == null ? def : cur;
    fields.push(new PropertyField({
      id: "kf-" + path,
      buildDom: () => {
        const row = document.createElement("div");
        row.className = "kf-row"; row.dataset.path = path;
        row.innerHTML =
          '<button class="tog' + (on ? " on" : "") + '" data-act="tog" title="开/关该属性动画">◆</button>' +
          '<span class="lab">' + lab + '</span>' +
          '<input class="val" data-act="val" value="' + round2(shown) + '" step="' + step + '">' +
          '<button class="add" data-act="add" title="在播放头处添加关键帧">＋</button>';
        return row;
      },
      write: (el, v) => {
        const inp = el.querySelector('[data-act="val"]');
        if (inp && document.activeElement !== inp) inp.value = round2(v);
        const tog = el.querySelector('[data-act="tog"]');
        if (tog) tog.classList.toggle("on", !!(anims[path] && anims[path].keys && anims[path].keys.length));
      },
      bind: (fld) => {
        const tog = fld.el.querySelector('[data-act="tog"]');
        const add = fld.el.querySelector('[data-act="add"]');
        if (tog) fld.on(tog, "click", () => toggleKf(path));
        if (add) fld.on(add, "click", () => {
          const v = fld.el.querySelector('[data-act="val"]').value;
          addKfAtPlayhead(path, v);
        });
      },
    }));
  }
  return fields;
}

/* —— key 相同时只更新值/高亮（跳过正在编辑的输入框） —— */
function updateKfFields(fields, c) {
  const { anims, local, paths } = c;
  let i = 0;
  fields.forEach(f => {
    if (!f.id || f.id.indexOf("kf-") !== 0) return;
    const path = f.id.slice(3);
    const cur = kfVal(anims, path, local);
    const def = paths[i] ? paths[i][3] : 0; i++;
    const shown = cur == null ? def : cur;
    f.update(shown);
  });
}
