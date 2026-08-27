/* =====================================================================
 * property/kf-panel.js —— keyframe 面板（UI 对齐 OpenCut，2026-08-20）
 * =====================================================================
 * UI 重构：按 OpenCut 截图分两个 section
 *   - 变换 section：位置 X/Y · 缩放 W/H · 旋转
 *   - 融合 section：不透明度
 * 每字段 UI：◆ 按钮(开/关关键帧) + label + 值输入 + ＋打点(可选)
 *   - ◆ 实心蓝=开 / 空心灰=关（参考 OpenCut 截图 keyframe-toggle）
 * 渲染策略（UI 阶段，朴素方案）：
 *   - 段切换/通道开关变化 → 整体 rebuild innerHTML（接 toggleKf/addKfAtPlayhead）
 *   - 播放头移动 → 只 update value，跳过正在编辑的 input（避免吞输入）
 *   - 不走 PropertyPanel 框架（property/* 通用层），KF 面板结构特殊走自己的渲染器
 * 保留底层调用：toggleKf / addKfAtPlayhead / kfVal / renderKfGraph / renderKfSel
 * 函数名 renderKfPanelPF 避免与旧 renderKfPanel 冲突。
 * ===================================================================== */

/* 字段分组定义（OpenCut 风格：transform 组 + blending 组） */
const KF_GROUPS = [
  {
    title: "变换",
    icon: "↗",
    pairs: [
      // 横向并排的对（参考 OpenCut 截图：W↔H、X↔Y）
      [["transform.scaleX", "宽度 W", 0.1, 1], ["transform.scaleY", "高度 H", 0.1, 1]],
      [["transform.positionX", "X", 10, 0], ["transform.positionY", "Y", 10, 0]],
    ],
    singles: [
      ["transform.rotate", "旋转", 5, 0],
    ],
  },
  {
    title: "融合",
    icon: "◐",
    pairs: [],
    singles: [
      ["transform.opacity", "不透明度", 0.1, 1],
    ],
  },
];

let _kfPropPanel = null;
let _kfLastKey = null;          // 上一次 build 的结构 key
let _kfBuildDirty = false;       // 标记整体重建
let _kfSecCollapsed = { 0: false, 1: false };  // section 折叠状态（按组下标）
// B1（GPT 定案）：KF 输入框聚焦时置 true → refresh() 暂停 draft 替换（防本地临时态被 500ms 轮询覆盖），blur 后恢复
let _kfEditing = false;

function renderKfPanelPF() {
  const nameEl = $("kfSegName"), rowsEl = $("kfRows"), graphEl = $("kfGraph"),
        selEl = $("kfSel"), emptyEl = $("kfEmpty"), hintEl = $("kfHint");
  const s = selectedSeg();
  const KF_VISUAL = ["video", "image", "sticker"];
  if (!s || !KF_VISUAL.includes(s.type)) {
    if (_kfPropPanel) { _kfPropPanel.destroy(); _kfPropPanel = null; }
    _kfLastKey = null;
    selectedKf = { path: null, id: null };
    nameEl.textContent = "";
    selEl.style.display = "none"; hintEl.style.display = "none"; graphEl.style.display = "none";
    if (s && s.type === "audio") {
      emptyEl.style.display = "none"; rowsEl.style.display = "";
      rowsEl.innerHTML = '<div class="kf-empty-hint">音频段不支持位移/缩放/旋转关键帧（无画面）；调音量请切到 🔊 audio tab。</div>';
    } else if (s && s.type === "text") {
      emptyEl.style.display = "none"; rowsEl.style.display = "";
      rowsEl.innerHTML = '<div class="kf-empty-hint">文本段的字号/颜色等字段在字幕面板（💬 sub tab），不在 transform 关键帧里。</div>';
    } else {
      emptyEl.style.display = ""; rowsEl.style.display = "none";
    }
    return;
  }
  emptyEl.style.display = "none"; rowsEl.style.display = ""; graphEl.style.display = "";
  hintEl.style.display = ""; nameEl.textContent = s.name || "";
  const anims = s.animations || {};
  const local = TimelineMapper.playheadLocal(s);
  const selId = s.id || (Store.state.selectedKey || "");

  // 结构 key：段身份 + 每通道开/关状态（通道开关变化触发重建；播放头移动不重建）
  const stateBits = [];
  for (const g of KF_GROUPS) {
    for (const pair of g.pairs) for (const [path] of pair) stateBits.push(path + ":" + kfOnOff(anims, path));
    for (const [path] of g.singles) stateBits.push(path + ":" + kfOnOff(anims, path));
  }
  const stateKey = stateBits.join(",");

  if (_kfLastKey !== selId + "|" + stateKey) {
    buildKfSections(rowsEl, anims, local);
    _kfLastKey = selId + "|" + stateKey;
  } else {
    updateKfRowValues(rowsEl, anims, local);
  }

  // 曲线图 / 选中帧编辑（动态内容，独立管理）
  renderKfGraph(s);
  if (selectedKf.path && selectedKf.id && anims[selectedKf.path] && anims[selectedKf.path].keys
      && anims[selectedKf.path].keys.some(k => k.id === selectedKf.id)) {
    renderKfSel(s);
  } else { selEl.style.display = "none"; selectedKf = { path: null, id: null }; }
}

function kfOnOff(anims, path) {
  return (anims[path] && anims[path].keys && anims[path].keys.length) ? "1" : "0";
}

/* —— 整体重建 #kfRows（结构变化时才调用） —— */
function buildKfSections(rowsEl, anims, local) {
  rowsEl.innerHTML = "";
  for (let gi = 0; gi < KF_GROUPS.length; gi++) {
    const g = KF_GROUPS[gi];
    const collapsed = !!_kfSecCollapsed[gi];
    const sec = document.createElement("div");
    sec.className = "kf-section" + (collapsed ? " is-collapsed" : "");
    sec.dataset.gi = gi;
    const head = document.createElement("div");
    head.className = "kf-section-head";
    head.innerHTML = '<span class="kf-section-chevron">' + (collapsed ? "▶" : "▼") + '</span>' +
                     '<span class="kf-section-icon">' + g.icon + '</span>' +
                     '<span class="kf-section-title">' + g.title + '</span>';
    head.style.cursor = "pointer";
    head.addEventListener("click", () => {
      _kfSecCollapsed[gi] = !_kfSecCollapsed[gi];
      sec.classList.toggle("is-collapsed", _kfSecCollapsed[gi]);
      const chev = head.querySelector(".kf-section-chevron");
      if (chev) chev.textContent = _kfSecCollapsed[gi] ? "▶" : "▼";
    });
    sec.appendChild(head);
    const body = document.createElement("div");
    body.className = "kf-section-body";
    // 横向并排对（用 .kf-pair 包裹，左字段+右字段同行）
    for (const pair of g.pairs) {
      const pairEl = document.createElement("div");
      pairEl.className = "kf-pair";
      for (let i = 0; i < pair.length; i++) {
        const [path, lab, step, def] = pair[i];
        const row = buildKfRow(path, lab, step, def, anims, local);
        pairEl.appendChild(row);
        if (i === 0 && pair.length === 2) {
          // W↔H 中间的链接图标（OpenCut 截图位置）
          const link = document.createElement("span");
          link.className = "kf-pair-link";
          link.textContent = "🔗";
          pairEl.appendChild(link);
        }
      }
      body.appendChild(pairEl);
    }
    // 单行字段
    for (const [path, lab, step, def] of g.singles) {
      body.appendChild(buildKfRow(path, lab, step, def, anims, local));
    }
    sec.appendChild(body);
    rowsEl.appendChild(sec);
  }
}

function buildKfRow(path, lab, step, def, anims, local) {
  const s = selectedSeg();
  // B2.1（GPT 定案，kf-state-machine.md）：两概念拆开——
  //   channelOn = isAnimated（通道激活，决定输入框编辑语义：改 KF 还是静态值）
  //   hitOn     = hitAtPlayhead（播放头是否踩中 KF，决定 ◆ 外观：实心蓝/空心灰）
  const channelOn = KfChannel.isAnimated(s, path);
  const hitOn = KfChannel.hitAtPlayhead(s, path, local);
  const inRange = TimelineMapper.isPlayheadWithinRange(s);   // L0-06：播放头是否在元素范围内（范围门控第三态）
  // B2.1：显示值收口到 EffectivePropertyResolver（animation→transform→default，带 source）
  const cur = getEffectivePropertyValue(s, path, local).value;
  const shown = cur == null ? def : cur;
  const row = document.createElement("div");
  row.className = "kf-row";
  row.dataset.path = path;
  row.innerHTML =
    '<button class="kf-kf-toggle' + (hitOn ? ' is-active' : '') + '" data-act="tog" title="' +
      (hitOn ? '删除当前位置关键帧' : '在播放头处打关键帧') + '">' +
      '<span class="dia">◆</span>' +
    '</button>' +
    '<span class="lab">' + lab + '</span>' +
    '<input class="val" data-act="val" value="' + round2(shown) + '" step="' + step + '">' +
    '<button class="add" data-act="add" title="在播放头处打关键帧">＋</button>';
  // L0-06：播放头在元素范围外 → ◆ 与 ＋ 禁用（对齐 OpenCut：范围外只能改 base、不能打/删帧）
  const togBtn = row.querySelector('[data-act="tog"]');
  const addBtn = row.querySelector('[data-act="add"]');
  if (!inRange) {
    togBtn.disabled = true; togBtn.style.opacity = "0.5"; togBtn.style.pointerEvents = "none";
    togBtn.title = "播放头不在该元素时间范围内，无法打/删关键帧";
    addBtn.disabled = true; addBtn.style.opacity = "0.5"; addBtn.style.pointerEvents = "none";
  }
  // 事件（每个 row 独立绑一次）
  row.querySelector('[data-act="tog"]').addEventListener("click", () => {
    toggleKf(path);
  });
  const inp = row.querySelector('[data-act="val"]');
  // B1（GPT 定案，kf-complete-plan v2）：交互中只改本地临时态（KfChannel.upsertLocal / C1 setProperty），
  // blur/Enter 才一次 Command Transaction——绝不每次 keystroke 打后端（打穿 C3"一次动作=一条 undo"）。
  // 同时 input 聚焦期间置 _kfEditing=true → refresh() 暂停 draft 替换（防本地态被 500ms 轮询覆盖）。
  let _draft = null;   // 本地临时态 {v, hasKf, local}
  let _editCtx = null; // ★ KET（2026-08-22）：focus 锁定编辑时间（GPT §7：一次手势锁定 editTime，
                       //   不许 blur/input 时重读 playhead——输入期间播放头漂移会让打点时间错位）
  inp.addEventListener("focus", () => {
    _kfEditing = true;
    const s = selectedSeg();
    if (s && typeof createEditContext === "function" && Store.state.selectedKey) {
      _editCtx = createEditContext(Store.state.selectedKey);   // lockTime 默认 true
    }
  });
  inp.addEventListener("input", () => {
    const v = parseFloat(inp.value);
    if (isNaN(v)) return;
    const s = selectedSeg();   // 每次取最新段引用（Store 刷新替换 draft 后旧引用失效）
    if (!s) return;
    const hasKf = KfChannel.isAnimated(s, path) && inRange;   // L0-06：范围外即使有通道也走 base 分支
    // ★ KET：优先用 focus 锁定的 localUs（一次手势一个时间基准），fallback 实时换算
    const local = (_editCtx && _editCtx.editTime) ? _editCtx.editTime.localUs
                : TimelineMapper.playheadLocal(s);
    _draft = { v, hasKf, local };
    if (hasKf) {
      KfChannel.upsertLocal(s, path, local, v, "linear");   // 本地打点（预览插值用，不进后端/undo）
    } else {
      setProperty(s, path, v);   // C1 静态值本地态（params + legacy mirror）
    }
    renderPreview();   // 预览跟手
  });
  inp.addEventListener("blur", () => {
    _kfEditing = false;
    if (!_draft) return;
    const { v, hasKf, local } = _draft;
    _draft = null;
    _editCtx = null;   // 手势结束，释放时间锁（下次 focus 重新锁定）
    const s = selectedSeg();
    if (!s) return;
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (!k || k.length < 3) return;
    if (hasKf) {
      // 通道开 → 一次事务打点（add_keyframe，与面板 ＋ 同命令）
      CommandService.withTx("kf-edit", () =>
        CommandService.run("add_keyframe",
          { track_type: k[0], track_index: +k[1], index: +k[2], path, time_us: local, value: v, seg_mode: "linear" },
          { actor: "ui", paths: [path] })
      );
    } else {
      // 通道关 → 一次事务改静态值（update_segment_transform，transform 可只传改的字段）
      const tfKey = { "transform.positionX": "x", "transform.positionY": "y",
                      "transform.scaleX": "scaleX", "transform.scaleY": "scaleY",
                      "transform.rotate": "rotation", "transform.opacity": "opacity" }[path];
      if (!tfKey) return;
      CommandService.withTx("static-edit", () =>
        CommandService.run("update_segment_transform",
          { track_type: k[0], track_index: +k[1], index: +k[2], segid: s.id, transform: { [tfKey]: v } },
          { actor: "ui", paths: [path] })
      );
    }
  });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } });
  row.querySelector('[data-act="add"]').addEventListener("click", () => {
    addKfAtPlayhead(path, inp.value);
  });
  return row;
}

/* —— key 相同时只更新值（跳过正在编辑的输入框，避免吞输入） —— */
function updateKfRowValues(rowsEl, anims, local) {
  rowsEl.querySelectorAll(".kf-row").forEach(row => {
    const path = row.dataset.path;
    // B2.1：显示值收口到 EffectivePropertyResolver；source 驱动 ◆ 外观
    const s = selectedSeg();
    if (!s) return;
    const { value: cur, source } = getEffectivePropertyValue(s, path, local);
    if (cur == null) return;
    const inp = row.querySelector('[data-act="val"]');
    if (inp && document.activeElement !== inp) inp.value = round2(cur);
    // B2.1（GPT 定案）：◆ 外观 = 播放头是否踩中 KF（source==="keyframe"）——拖播放头实时亮灭
    const tog = row.querySelector('[data-act="tog"]');
    if (tog) {
      const hit = source === "keyframe";
      tog.classList.toggle("is-active", hit);
      tog.title = hit ? "删除当前位置关键帧" : "在播放头处打关键帧";
    }
  });
}

/* —— B2（GPT 定案）：播放头切片独立订阅者——拖播放头 → KF 面板值实时更新
 * 不挂 renderPlayheadUI（UI 层不互相调，防耦合）；播放头是 Store 的 playheadUs 切片，
 * 三个独立订阅者：renderPlayheadUI（播放头 DOM）/ updateKfPanelValues（KF 面板）/ 预览插值。 —— */
function updateKfPanelValues() {
  const rowsEl = $("kfRows");
  if (!rowsEl || rowsEl.style.display === "none") return;
  const s = selectedSeg();
  if (!s) return;
  // 编辑中（input 聚焦）→ 跳过（防吞输入；B1 _kfEditing 已暂停 refresh，此处只兜底）
  const activeIn = rowsEl.querySelector("[data-act='val']:focus");
  if (activeIn) return;
  const anims = s.animations || {};
  const local = TimelineMapper.playheadLocal(s);
  updateKfRowValues(rowsEl, anims, local);
}