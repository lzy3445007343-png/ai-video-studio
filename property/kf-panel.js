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
  {
    title: "文字",
    icon: "💬",
    pairs: [],
    singles: [
      ["text.color", "文字颜色", "color"],  // L2-07：kind="color" → buildColorRow（四分量合并成单 ColorRow + 成组 ◆）
      ["text.fontSize", "字号", 0.5, 10],     // L2-02：标量 KF（base 落 seg.sub_style.font_size）
      ["text.letterSpacing", "字距", 0.1, 0], // L2-02：标量 KF（base 落 seg.sub_style.letter_spacing）
    ],
  },
];

let _kfPropPanel = null;
let _kfLastKey = null;          // 上一次 build 的结构 key
let _kfBuildDirty = false;       // 标记整体重建
let _kfSecCollapsed = { 0: false, 1: false };  // section 折叠状态（按组下标）
// B1（GPT 定案）：KF 输入框聚焦时置 true → refresh() 暂停 draft 替换（防本地临时态被 500ms 轮询覆盖），blur 后恢复
let _kfEditing = false;
// L2-06：Scale 成组锁定开关（UI 偏好，不持久化，对齐 OpenCut isTransformScaleLocked）
let _scaleLocked = false;

function renderKfPanelPF() {
  const nameEl = $("kfSegName"), rowsEl = $("kfRows"), graphEl = $("kfGraph"),
        selEl = $("kfSel"), emptyEl = $("kfEmpty"), hintEl = $("kfHint");
  const s = selectedSeg();
  const KF_VISUAL = ["video", "image", "sticker", "text"];  // L2-07：文本段也进 KF 面板（渲染"文字"颜色组）
  if (!s || !KF_VISUAL.includes(s.type)) {
    if (_kfPropPanel) { _kfPropPanel.destroy(); _kfPropPanel = null; }
    _kfLastKey = null;
    selectedKf = { path: null, id: null };
    nameEl.textContent = "";
    selEl.style.display = "none"; hintEl.style.display = "none"; graphEl.style.display = "none";
    if (s && s.type === "audio") {
      emptyEl.style.display = "none"; rowsEl.style.display = "";
      rowsEl.innerHTML = '<div class="kf-empty-hint">音频段不支持位移/缩放/旋转关键帧（无画面）；调音量请切到 🔊 audio tab。</div>';
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
  const stateKey = stateBits.join(",") + "|scaleLock:" + (_scaleLocked ? "1" : "0");   // L2-06：锁状态变化触发重建

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
  const s = selectedSeg();
  for (let gi = 0; gi < KF_GROUPS.length; gi++) {
    const g = KF_GROUPS[gi];
    if (s && s.type === "text" && g.title !== "文字") continue;  // L2-07：文本段只渲染"文字"组（颜色），不显示变换/融合
    if (s && s.type !== "text" && g.title === "文字") continue;  // L2-07 fix：video/image/sticker 段不渲染文字组，避免 path 不在 KF_PATHS_BY_TYPE[video] 里
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
      const isScale = pair.length === 2 && pair[0][0] === "transform.scaleX" && pair[1][0] === "transform.scaleY";
      const pairEl = document.createElement("div");
      pairEl.className = "kf-pair";
      if (isScale && _scaleLocked) {
        // L2-06：锁定态 → 单 Scale 字段 + 成组菱形（替换两独立字段）
        pairEl.appendChild(buildScaleLockedRow(anims, local));
      } else {
        for (let i = 0; i < pair.length; i++) {
          const [path, lab, step, def] = pair[i];
          const row = buildKfRow(path, lab, step, def, anims, local);
          pairEl.appendChild(row);
          if (isScale && i === 0) {
            // W↔H 中间的锁按钮（替换原静态 🔗），点击进入等比锁定
            const lock = document.createElement("button");
            lock.className = "kf-pair-lock";
            lock.textContent = "🔓";
            lock.title = "锁定等比缩放（Scale 成组关键帧，L2-06）";
            lock.style.cursor = "pointer";
            lock.addEventListener("click", () => { _scaleLocked = true; _kfLastKey = null; renderKfPanelPF(); });
            pairEl.appendChild(lock);
          }
        }
      }
      body.appendChild(pairEl);
    }
    // 单行字段
    for (const item of g.singles) {
      if (item[2] === "color") body.appendChild(buildColorRow(item[0], item[1], anims, local));  // L2-07：颜色组 → ColorRow
      else body.appendChild(buildKfRow(item[0], item[1], item[2], item[3], anims, local));
    }
    sec.appendChild(body);
    rowsEl.appendChild(sec);
  }
}

/* —— L2-06：Scale 成组锁定（锁定态单 Scale 字段 + 成组菱形，走 toggleScaleKf 一次 upsert/remove 两条）—— */
function buildScaleLockedRow(anims, local) {
  const s = selectedSeg();
  const inRange = TimelineMapper.isPlayheadWithinRange(s);
  const hasX = KfChannel.isAnimated(s, "transform.scaleX");
  const hasY = KfChannel.isAnimated(s, "transform.scaleY");
  const hasScaleKf = hasX || hasY;
  const curX = getEffectivePropertyValue(s, "transform.scaleX", local).value;
  const shown = curX == null ? 1 : curX;
  const row = document.createElement("div");
  row.className = "kf-row kf-row-scale-locked";
  row.innerHTML =
    '<button class="kf-kf-toggle' + (hasScaleKf ? ' is-active' : '') + '" data-act="tog" title="成组打/删关键帧（scaleX+scaleY 同帧）">' +
      kfDiamondSVG("dia", "currentColor") + '</button>' +
    '<span class="lab">Scale</span>' +
    '<input class="val" data-act="val" value="' + round2(shown) + '" step="0.1">' +
    '<button class="kf-pair-lock" data-act="unlock" title="解锁等比（恢复 W/H 两字段）">🔒</button>';
  const togBtn = row.querySelector('[data-act="tog"]');
  if (!inRange) { togBtn.disabled = true; togBtn.style.opacity = "0.5"; togBtn.style.pointerEvents = "none"; togBtn.title = "播放头不在元素范围内，无法打/删关键帧"; }
  togBtn.addEventListener("click", () => toggleScaleKf());
  row.querySelector('[data-act="unlock"]').addEventListener("click", () => { _scaleLocked = false; _kfLastKey = null; renderKfPanelPF(); });
  const inp = row.querySelector('[data-act="val"]');
  inp.addEventListener("mousedown", e => { e.preventDefault(); inp.focus(); inp.select(); });
  let _editCtx = null;
  inp.addEventListener("focus", () => {
    _kfEditing = true;
    const seg = selectedSeg();
    if (seg && typeof createEditContext === "function" && Store.state.selectedKey) _editCtx = createEditContext(Store.state.selectedKey);
  });
  inp.addEventListener("input", () => {
    const v = (typeof ExprParse !== "undefined") ? ExprParse.parseNumeric(inp.value) : parseFloat(inp.value);
    if (isNaN(v)) return;
    const seg = selectedSeg(); if (!seg) return;
    if (typeof PreviewState !== "undefined") { PreviewState.set(seg.id, "transform.scaleX", v); PreviewState.set(seg.id, "transform.scaleY", v); PreviewState.notifyPreviewConsumers(seg.id); }
    renderPreview();
  });
  inp.addEventListener("blur", () => {
    _kfEditing = false;
    const sv = parseFloat(inp.value); if (isNaN(sv)) return;
    const seg = selectedSeg(); if (!seg) return;
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null; if (!k || k.length < 3) return;
    const hasKf = KfChannel.isAnimated(seg, "transform.scaleX") && TimelineMapper.isPlayheadWithinRange(seg);
    _editCtx = null;
    if (typeof PreviewState !== "undefined") PreviewState.discardPreview(seg.id);
    const tx = { scaleX: sv, scaleY: sv, rotation: (typeof getProperty === "function") ? getProperty(seg, "transform.rotate") : 0 };
    CommandService.withTx("scale-locked-edit", () =>
      CommandService.run("update_segment_transform", { track_type: k[0], track_index: +k[1], index: +k[2], segid: seg.id, transform: tx }, { actor: "ui", paths: ["transform.scaleX", "transform.scaleY"] }));
  });
  inp.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); inp.blur(); } });
  return row;
}

/* —— L2-06：成组菱形点击 → 一次 upsert/remove 两条（scaleX+scaleY 同 t 同值，后端帧吸附保证严格同帧）—— */
function toggleScaleKf() {
  const s = selectedSeg(); if (!s) return;
  if (!TimelineMapper.isPlayheadWithinRange(s)) return;   // L2-10 门控：范围外不响应
  const local = TimelineMapper.playheadLocal(s);
  const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
  if (!k || k.length < 3) return;
  const args = kfSegArgs();
  const segId = Store.state.selectedSegId;
  const hitX = KfChannel.hitAtPlayhead(s, "transform.scaleX", local);
  const hitY = KfChannel.hitAtPlayhead(s, "transform.scaleY", local);
  if (hitX || hitY) {
    const anims = s.animations || {};
    const rm = (path) => {
      const keys = (anims[path] && anims[path].keys) ? anims[path].keys : [];
      const hk = keys.find(kk => Math.abs((kk.t || 0) - local) <= KfChannel.KF_HIT_TOLERANCE_US);
      if (hk) call("remove_keyframe", ...args, path, hk.id, segId, Store.state.playheadUs);
    };
    rm("transform.scaleX"); rm("transform.scaleY");
    setTimeout(() => refresh(), 60);
  } else {
    const vx = getEffectivePropertyValue(s, "transform.scaleX", local).value;
    const vy = getEffectivePropertyValue(s, "transform.scaleY", local).value;
    const v = ((vx == null ? 1 : vx) + (vy == null ? 1 : vy)) / 2;   // 成组值取两轴平均
    call("add_keyframe", ...args, "transform.scaleX", local, v, "linear", segId).then(() =>
      call("add_keyframe", ...args, "transform.scaleY", local, v, "linear", segId).then(() => refresh()));
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
      kfDiamondSVG("dia", "currentColor") +
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
  inp.addEventListener("mousedown", e => { e.preventDefault(); inp.focus(); inp.select(); });  // L1-18 点击全选
  inp.addEventListener("input", () => {
    // L1-19：表达式求值（1920/2→960），否则 parseFloat
    const v = (typeof ExprParse !== "undefined") ? ExprParse.parseNumeric(inp.value) : parseFloat(inp.value);
    if (isNaN(v)) return;
    const s = selectedSeg();   // 每次取最新段引用（Store 刷新替换 draft 后旧引用失效）
    if (!s) return;
    const hasKf = KfChannel.isAnimated(s, path) && inRange;   // L0-06：范围外即使有通道也走 base 分支
    // ★ KET：优先用 focus 锁定的 localUs（一次手势一个时间基准），fallback 实时换算
    const local = (_editCtx && _editCtx.editTime) ? _editCtx.editTime.localUs
                : TimelineMapper.playheadLocal(s);
    _draft = { v, hasKf, local };
    if (hasKf) {
      KfChannel.upsertLocal(s, path, local, v, "linear");   // L0-03：本地打点写入 overlay（不污染 seg）
    } else {
      // L0-03：静态值也走 overlay（不污染 seg.params），Player 经 getPreviewSeg 实时显示
      if (typeof PreviewState !== "undefined") PreviewState.set(s.id, path, v);
      else setProperty(s, path, v);
    }
    if (typeof PreviewState !== "undefined") PreviewState.notifyPreviewConsumers(s.id);  // L1-10 三方联动
    renderPreview();   // 预览跟手
    if (typeof refreshSegKfMarkers === "function") refreshSegKfMarkers(s);   // L1-21 方向②：时间轴 marker 实时跟随
  });
  inp.addEventListener("blur", () => {
    _kfEditing = false;
    if (!_draft) return;
    const { v, hasKf, local } = _draft;
    _draft = null;
    _editCtx = null;   // 手势结束，释放时间锁（下次 focus 重新锁定）
    const s = selectedSeg();
    const segId = s ? s.id : null;
    if (typeof PreviewState !== "undefined" && segId) PreviewState.discardPreview(segId);  // L0-03：无论提交与否都清预览态（零残留）
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
  inp.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); inp.blur(); } });  // L1-18 分支 A：Escape=提交
  row.querySelector('[data-act="add"]').addEventListener("click", () => {
    // L1-19：＋ 打点前先求值表达式（否则后端收字符串）
    const ev = (typeof ExprParse !== "undefined") ? ExprParse.parseNumeric(inp.value) : inp.value;
    addKfAtPlayhead(path, ev);
  });
  return row;
}

/* —— L2-07：颜色关键帧（分支 A-1 四分量独立 scalar path text.color.r/g/b/a）
 *   ColorRow = 触发色块(ColorPicker) + 成组 ◆（四分量同 t 一起打/删）
 *   base 颜色(sub_style.color)写回衔接 L2-02（本卡不新增后端 Api，仅做 KF 通道机制 + 预览）
 */
function resolveColorAtTime(s, local) {
  const a = s.animations || {};
  const rv = kfVal(a, "text.color.r", local), gv = kfVal(a, "text.color.g", local),
        bv = kfVal(a, "text.color.b", local), av = kfVal(a, "text.color.a", local);
  const r = rv == null ? 1 : rv, g = gv == null ? 1 : gv, b = bv == null ? 1 : bv, al = av == null ? 1 : av;
  return ColorPickerUtils.rgbaToHex(r, g, b, al);
}
function buildColorRow(pathBase, lab, anims, local) {
  const s = selectedSeg();
  const inRange = TimelineMapper.isPlayheadWithinRange(s);
  const hasKf = ["text.color.r", "text.color.g", "text.color.b", "text.color.a"].some(p => KfChannel.isAnimated(s, p));
  const cur = resolveColorAtTime(s, local);
  const row = document.createElement("div");
  row.className = "kf-row kf-row-color";
  row.dataset.kind = "color";
  row.dataset.pathBase = pathBase;
  row.innerHTML =
    '<button class="kf-kf-toggle' + (hasKf ? ' is-active' : '') + '" data-act="tog" title="成组打/删颜色关键帧（r/g/b/a 同帧）">' +
      kfDiamondSVG("dia", "currentColor") + '</button>' +
    '<span class="lab">' + lab + '</span>' +
    '<span class="kf-color-wrap"></span>';
  const togBtn = row.querySelector('[data-act="tog"]');
  if (!inRange) { togBtn.disabled = true; togBtn.style.opacity = "0.5"; togBtn.style.pointerEvents = "none"; togBtn.title = "播放头不在元素范围内，无法打/删关键帧"; }
  togBtn.addEventListener("click", () => toggleColorKf(pathBase));
  const wrap = row.querySelector(".kf-color-wrap");
  const cp = new ColorPickerField({ value: cur, onPreview: previewColor, onCommit: commitColor });
  cp.mount(wrap);
  row._cp = cp;
  return row;
}
function previewColor(hex) {
  const s = selectedSeg(); if (!s) return;
  const { r, g, b, a } = ColorPickerUtils.hexToRgba(hex);
  ["text.color.r", "text.color.g", "text.color.b", "text.color.a"].forEach((p, i) => {
    const v = [r, g, b, a][i];
    if (typeof PreviewState !== "undefined") PreviewState.set(s.id, p, v);
  });
  if (typeof PreviewState !== "undefined") PreviewState.notifyPreviewConsumers(s.id);
  renderPreview();
}
function commitColor(hex) {
  const s = selectedSeg(); if (!s) return;
  const { r, g, b, a } = ColorPickerUtils.hexToRgba(hex);
  const inRange = TimelineMapper.isPlayheadWithinRange(s);
  const hasKf = ["text.color.r", "text.color.g", "text.color.b", "text.color.a"].some(p => KfChannel.isAnimated(s, p));
  const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
  if (!k || k.length < 3) return;
  const args = kfSegArgs();
  const segId = Store.state.selectedSegId;
  const local = TimelineMapper.playheadLocal(s);
  if (typeof PreviewState !== "undefined") PreviewState.discardPreview(s.id);
  if (hasKf && inRange) {
    // 写四分量当前帧（一次事务 ×4 同 t）
    const paths = ["text.color.r", "text.color.g", "text.color.b", "text.color.a"];
    const vals = [r, g, b, a];
    const run = i => {
      if (i >= 4) { setTimeout(() => refresh(), 60); return; }
      call("add_keyframe", ...args, paths[i], local, vals[i], "linear", segId).then(() => run(i + 1));
    };
    CommandService.withTx("color-kf-edit", () => run(0));
  } else {
    // L2-02：无帧 → base 写回 sub_style.color（set_segments_props 已扩展 sub_style，不新增 Api）
    const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
    if (k && k.length >= 3) {
      CommandService.withTx("text-color-base", () =>
        CommandService.run("set_segments_props",
          [{ track_type: k[0], track_index: +k[1], index: +k[2], segid: s.id, sub_style: { color: hex } }],
          { actor: "ui", paths: ["text.color"] }));
    }
  }
}
function toggleColorKf(pathBase) {
  const s = selectedSeg(); if (!s) return;
  if (!TimelineMapper.isPlayheadWithinRange(s)) return;  // L2-10 门控：范围外不响应
  const local = TimelineMapper.playheadLocal(s);
  const k = Store.state.selectedKey ? Store.state.selectedKey.split(":") : null;
  if (!k || k.length < 3) return;
  const args = kfSegArgs();
  const segId = Store.state.selectedSegId;
  const anims = s.animations || {};
  const paths = ["text.color.r", "text.color.g", "text.color.b", "text.color.a"];
  const hit = paths.some(p => KfChannel.hitAtPlayhead(s, p, local));
  if (hit) {
    paths.forEach(p => {
      const keys = (anims[p] && anims[p].keys) ? anims[p].keys : [];
      const hk = keys.find(kk => Math.abs((kk.t || 0) - local) <= KfChannel.KF_HIT_TOLERANCE_US);
      if (hk) call("remove_keyframe", ...args, p, hk.id, segId, Store.state.playheadUs);
    });
    setTimeout(() => refresh(), 60);
  } else {
    const cur = resolveColorAtTime(s, local);
    const { r, g, b, a } = ColorPickerUtils.hexToRgba(cur);
    const vals = [r, g, b, a];
    const run = i => {
      if (i >= 4) { setTimeout(() => refresh(), 60); return; }
      call("add_keyframe", ...args, paths[i], local, vals[i], "linear", segId).then(() => run(i + 1));
    };
    CommandService.withTx("color-kf", () => run(0));
  }
}

/* —— key 相同时只更新值 + L2-10 实时刷新范围门控禁用态（跳过正在编辑的输入框，避免吞输入） —— */
function updateKfRowValues(rowsEl, anims, local) {
  const s = selectedSeg();
  if (!s) return;
  const inRange = TimelineMapper.isPlayheadWithinRange(s);   // L2-10：播放头实时门控（拖播放头进出范围时刷新 ◆/＋ 禁用态）
  rowsEl.querySelectorAll(".kf-row").forEach(row => {
    const path = row.dataset.path;
    // L2-07：颜色行（kind=color）单独处理——合成当前色 + 刷新 ◆ 门控（不进通用值更新，避免 getEffectivePropertyValue 对 base path 失败）
    if (row.dataset.kind === "color") {
      const ctog = row.querySelector('[data-act="tog"]');
      if (ctog) { ctog.disabled = !inRange; ctog.style.opacity = inRange ? "" : "0.5"; ctog.style.pointerEvents = inRange ? "" : "none"; }
      const cur = resolveColorAtTime(s, local);
      if (row._cp && document.activeElement !== row._cp.el) row._cp.setColor(cur, null);
      return;
    }
    const tog = row.querySelector('[data-act="tog"]');
    const add = row.querySelector('[data-act="add"]');
    // L2-10/L2-06：范围门控每帧刷新（即便无 dataset.path 的锁定行也生效）
    if (tog) { tog.disabled = !inRange; tog.style.opacity = inRange ? "" : "0.5"; tog.style.pointerEvents = inRange ? "" : "none"; }
    if (add) { add.disabled = !inRange; add.style.opacity = inRange ? "" : "0.5"; add.style.pointerEvents = inRange ? "" : "none"; }
    if (!path) return;   // L2-06 锁定行无 path，gate 已处理，跳过值更新
    // B2.1：显示值收口到 EffectivePropertyResolver；source 驱动 ◆ 外观
    const { value: cur, source } = getEffectivePropertyValue(s, path, local);
    if (cur == null) return;
    const inp = row.querySelector('[data-act="val"]');
    if (inp && document.activeElement !== inp) inp.value = round2(cur);
    // B2.1（GPT 定案）：◆ 外观 = 播放头是否踩中 KF（source==="keyframe"）——拖播放头实时亮灭
    if (tog) {
      const hit = source === "keyframe";
      tog.classList.toggle("is-active", hit && inRange);
      tog.title = !inRange ? "播放头不在该元素时间范围内，无法打/删关键帧"
                           : (hit ? "删除当前位置关键帧" : "在播放头处打关键帧");
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