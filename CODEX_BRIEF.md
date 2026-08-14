# CODEX_BRIEF —— 项目总览与播放链路修复全记录

> **给 Codex 的阅读指引**：本文件是接手本项目的最全单文档。请先通读本文，再按需 grep 主文件 `工作台v0.8时间轴.html` 里的具体函数。所有行号均为**近似**（文件历经多轮编辑），请以**函数名 + grep** 为准。本项目纪律是"外科手术式小改、分轮验收"，改任何东西前务必先读码定位、备份、跑 `node --check`、真机验证，不要连续打补丁。

---

## 0. 项目是什么（从头到尾的背景）

**产品定位**：`ai-video-studio` 是一个**本地桌面 AI 剪辑工作站**（剪辑型为主、数字人为辅）。卖给本地中小企业老板（有剪辑岗），卖点 = 用 `pyJianYingDraft` 原生对象生成剪映可编辑草稿 + 文字/响度情绪处理（可独立成 Skill）。整体属于"系统型产品"，不是一次性脚本。

**技术栈**：
- 后端：`main.py`（PyWebView 启动）+ `mcp_server.py`（MCP stdio 服务，暴露剪辑能力给 Agent）
- 前端：`工作台v0.8时间轴.html` —— **单文件、约 186KB、3000+ 行原生 JS**（无框架，自己手搓时间轴/播放器/渲染）
- 运行：`start.bat` 启动 PyWebView（WebView2/Chromium）；后端未连时前端用 `file://` 兜底（**注意：WebView2 禁止 file:// 加载媒体**，这是 later bug 的诱因）
- 草稿落盘 `draft_state.json`，前端 0.5s 轮询刷新
- 导出：调 `pyJianYingDraft` 生成剪映 `draft_content.json`（微秒单位）

**与 OpenCut 的关系（钉死）**：整套**抄 UI 四区布局 / 工具集 / 行为逻辑 / 交互手势 / 选中态 / 视觉**，但**用自己原生 JS 重实现**，不抄 React/TS 组件代码。唯一改动 = 它右上 PropertiesPanel 换成我们的「Skill 区」（预留坑位，B 线填）。可真引的纯 JS 组件只有 `wavesurfer.js`（波形）/ `Video.js`（播放器）。

**当前阶段判定**：Demo 阶段已完成，进入**「架构阶段」**。用户已叫停所有具体 bug 的单点硬修——因为单个 bug 互相关联，根因是**架构缺基线**（媒体生命周期被渲染管线拥有 + 时间换算散落），不是某函数写错。继续打补丁会越陷越深。

**架构目标（三层分离，对齐 OpenCut 骨架，不抄代码）**：
- **Editor**：拥有 timeline DOM，播放时冻结，只发 Command
- **Player**：独占 media 元素，RAF 只接受 `seekTo / setActive / play / pause`，**永不主动重建**媒体元素
- **Renderer**：画面合成
- **内部 Command API**（Agent 未来唯一入口）：`splitClip / trimClip / moveClip / deleteClip` 封装不变量；UI 与 Agent 同走；MCP 暴露 Command，**绝不暴露 `renderAll`**。Agent 只说"要做什么"，不碰 `draft_state.json` 底层字段。

**已确立的架构铁律（P0 重构前不再打补丁）**：
1. 数据模型 → 内部 Command → UI → MCP → Skill，顺序不可跳步。
2. 底层未稳前**禁止加新功能**（字幕/特效/MG/情绪识别/MCP/Skill 一律后置）。
3. **时间权威铁律（用户拍板，核心）**：媒体元素**只能执行播放，不能决定时间轴位置**。播放头是 master → 反推媒体该在哪 → seek 媒体；媒体时钟仅辅助校准。
4. 验收基线：修改任意 clip（split/trim/move）**绝不触发媒体元素重建**；Agent 改时间轴时正在播放的预览**不被打断**。

---

## 1. 数据模型

- 共享状态：`draft_state.json`，前端 0.5s 轮询（`refresh` → `renderAll`）。
- Clip 字段（**全微秒**）：`start / duration / src_start / src_end / material_id`。后端 `_split_segment_core` 正确重算两半。
- 数据模型本身**骨架没烂**（Clip 已含这些字段，split 重算正确），缺的是"纪律"——无需推倒重来。
- 轨道键：`video:ti` / `image:ti` / `audio:ti`；媒体按轨道复用：`visualEls`（video:ti + image:ti）、`audioEls`（audio:ti）。
- **时间换算纪律（尚未落实）**：所有消费者禁止自写 `us - seg.start`，统一走 `timelineToSource()` / `sourceToTimeline()`。目前 `_dominantMediaUs` 仍在各自算。

---

## 2. 播放架构现状（目标 vs 当前）

- **目标**：Editor/Player/Renderer 三层分离，Player 独占媒体、永不重建。
- **当前**：3000+ 行单 HTML，UI/状态/播放/渲染/同步混在一起；播放期 `renderTimeline` 被 `if(!isPlaying)` 冻结（L1850 附近）。
- **播放器状态机纪律**：本地剪辑软件点击播放 = 用户手势，浏览器不该用 `NotAllowedError` 拦；`play().catch` 里 blanket `el.muted=true` 兜底会**掩盖播放器自身状态 bug**（开发期危险）。改为**按错误类型分流**：仅 `NotAllowedError` 才静音兜底 + 红条；`AbortError`/状态错/seek 错一律 `console.warn` 暴露 + 红条、不静音。全局静音按钮（🔊/🔇）保留。
- **`isPlaying` 全文件单一定义**（约 L1024），无多播放状态源。

---

## 3. Bug 修复史（按轮次：现象 / 根因 / 修法 / 状态）

> 纪律：每轮独立备份可回退；改前只读定位；改后 `node --check`（用内存 `vm.Script` 校验抽出的 `<script>` 块，因 `node --check xxx.html` 会报 `ERR_UNKNOWN_FILE_EXTENSION`）；重启 `start.bat` 真机验。

### Round A —— 双声/抢播/AbortError
- **现象**：多轨音频互相抢播、报 AbortError。
- **根因**：多处 `canplay` 事件里主动调 `play()`，play 入口不统一。
- **修法**：删 canplay 主动 play，`play()` 收归 `playAllMedia` **唯一入口**。
- **状态**：✅ 已验收（用户确认"a 没问题了"）。

### Round B0 —— 播放时放大比例播放头消失
- **现象**：播放中 `setZoom` 放大，播放头 `#playhead` 看不见。
- **根因**：`setZoom` 改 `pps()` + 重定位播放头 + 重绘波形，但**没重排 `tlContent`/`ruler` 宽度**；播放期 `renderTimeline` 冻结，容器宽度停在旧比例，播放头按新 pps 算 `left` 远超旧尺寸被 `overflow:hidden` 裁掉。
- **修法**：`setZoom` 的 rAF 里补 `tlContent.style.width = contentWidth()` + `ruler.style.width`（复用 `contentWidth()`），**绝不调 `renderTimeline`/`renderPreview`/`playAllMedia`**。
- **状态**：✅ 已验收。副作用（播放期 clip/刻度保持旧像素宽度）停止后自愈，可接受。

### Round B + B1 —— 跨段闪/卡/反复播 + `v.pause is not a function`
- **现象**：跨段闪、卡、反复播；hotfix 后报 `TypeError: v.pause is not a function`。
- **根因 B**：跨段时 `renderPreview()` 全量重建媒体 → 正在播的 `play()` promise 被 abort。
- **修法 B**：跨段分支改调 `seekActiveMediaToPlayhead(us)`（只 `_seekMedia` 唯一 seek，无第二套换算），命中元素缺失才 `renderPreview()` 一次降级 + `isRepairing` 防循环。
- **根因 B1**：`visualEls` 除 VIDEO 还存 IMG（图片轨道 `firstElementChild` 是 `<img>`，无 `pause()`），Round B 的非活动停车逻辑未区分 → 崩溃。
- **修法 B1**：非活动循环加 `const isVideo = v.tagName === "VIDEO"`，仅 VIDEO 调 `pause()/muted`，IMG 跳过。
- **状态**：✅ 落地（教训：对 `visualEls` 元素的媒体操作必须先按 `tagName` 区分）。

### Round B2-A —— split 右段反复播开头
- **现象**：split 后右段反复从开头播。
- **根因**：`_seekMedia` 钳制上界用 `(srcEndUs - srcStartUs)/1e6`（段时长），对 `src_start>0` 的右段会把段内偏移超段时长的值钳回 `src_start` → 反复从切点重播。
- **修法**：上界改为 `srcEndUs/1e6`。
- **状态**：✅ 已验收。

### Round B2-B —— 跨段 rec.seg/key 过期
- **现象**：跨段闪/卡/反复播（去 renderPreview 后暴露）。
- **根因**：`_dominantMediaUs`/`playAllMedia` 兜底用旧 `rec.seg` 元数据算位置。
- **修法**：`seekActiveMediaToPlayhead` 命中循环捕获 `rec` + 条件刷新 `rec.seg/key`（仅跨段才写）。
- **状态**：✅ 落地，待干净验收。

### Foundation F1/F2/F3 —— 首次从源0播 / 跨段播放头算错 / play catch blanket 静音
- **F1 现象**：任意播放头启动都从源素材 0 秒开始（三段从头开始）。**修法**：`startPlay` 在 `playAllMedia()` 前插 `seekActiveMediaToPlayhead(playheadUs)`。
- **F2 现象**：跨段播放头算错 → 闪/卡/反复 seek。**修法**：`_dominantMediaUs` 源时间→时间轴反向映射，减 `src_start` 偏移 + 钳到段时长（公式：`seg.start + min(duration, max(0, currentTime*1e6 - src_start))`）。
- **F3 现象**：`playAllMedia` catch blanket 静音掩盖真错误。**修法**：按错误类型分流（仅 `NotAllowedError` 静音兜底；`AbortError` 记日志 + 轻量重试；其它 `console.warn` + 红条暴露真名，禁 blanket 静音）。
- **状态**：✅ 落地，待干净验收（曾被时钟竞态污染）。

### Round C —— 媒体时钟信任竞态（播放头回弹 / 跨段闪）
- **现象**：拖播放头回弹、跨段闪。
- **根因**：`onplaying` 过早置 `mediaClockReady=true`（两处），抢在 seek 完成前读脏 `currentTime` → 播放头回弹/跨段闪。`_dominantMediaUs` 也没跳过 seeking 元素。
- **修法**：① `onplaying` 加 `!el.seeking` 守卫（两处）；② `_dominantMediaUs` 跳过 `seeking` 状态的元素。
- **实证**：grep 确认 `mediaClockReady` 全文件 9 处命中，置 true 仅 5 处（两处 onplaying + 三处 onseeked 正确入口），置 false 仅 `startPlay` + 跨段切源；`playStartUs` 跨段分支不写（墙钟连续单调）。精准无遗漏。
- **状态**：✅ 落地，待真机验收。

### Round D（Seek Barrier）—— seek 未完就 play 竞态
- **现象**：音频-only 跨段自己跳、加视频才正常、拖播放头播放卡死闪。
- **根因**：`_seekMedia` 是同步函数（无 Promise/onseeked/回调），调用方无"seek 完成"信号；`startPlay` 先 `seekActiveMediaToPlayhead`（设 currentTime 触发异步 seek）立即 `playAllMedia` → `play()` 在 seeking 中调，高概率 AbortError。这是 B(seek 未完就 play) 的底层 + A(时钟丢失→墙钟接管→跨段跳) 的放大。
- **否决方案**：`_seekMedia` Promise 化——因为文件里 4 处有覆盖式 `el.onseeked = ()=>{mediaClockReady=true}`，Promise 内部设 `onseeked` 会被覆盖 → 死锁。
- **最终方案**：收敛为 `_waitSeekSettled` 屏障 + 跨段锁（外科手术，未碰 `_seekMedia`/`renderPreview`/`onseeked`/数据结构）：
  1. `_waitSeekSettled(el)`：用 `addEventListener("seeked"/"error",{once:true})`，**绝不写 `el.onseeked`**（绕开 4 处 onseeked 所有权冲突）。
  2. 放行条件加 `el.readyState >= 2`（不止 `!el.seeking`），防换 src 加载阶段 `seeking=false` 误放行。
  3. 跨段抽 `_handleCrossSegment(us)` async fire-and-forget，加 `crossSegmentPending` 锁 + `crossSegmentQueuedUs` 队列（处理中又跨段只记最新目标、处理完补一轮，绝不丢 clip），防 RAF 多帧重复进入导致双播。
  4. `startPlay` 改 async，`await Promise.all(seeked.map(_waitSeekSettled))` 再 `playAllMedia()`。
- **状态**：✅ 落地。已知残留：①首播弱竞态（800ms `mediaClockReady` 看门狗兜底）；②A2 固有声音缝 barrier 治不了；③Round C 的 60ms AbortError 重试保留双保险。

### Round D.1 —— gap-skip 主动瞬移（"直接跳"）
- **现象**：播放头"直接跳"到空隙后段。
- **根因（探针实锤）**：`playTick` 运行期 gap-skip 分支**主动瞬移**播放头到段边界 + 重置墙钟锚点；与 Round D barrier 修好的"卡"是两个独立现象。
- **修法**：删运行期 gap 瞬移，只留"空隙后无任何可播段才收尾暂停"。跨段检测不依赖 gap-skip（基于 `resolveHits(us)` 的 `keySig` 变化，us 穿过空白自然触发）。
- **状态**：✅ 落地。

### Round D.2 —— 删 gap-skip 后 mediaUs 锁死
- **现象**：播放头卡在 clip1 末尾（`mediaUs=3.367` 锁死，`clock=MEDIA`，`wallUs` 涨但系统信任 `mediaUs`，`seg=null gap=true`，音频照播）。
- **根因**：媒体时钟本身没错，错在它绑定的**时间轴段已过期**——`_dominantMediaUs` 用旧 `rec.seg` 把 `currentTime` 映射回 clip1 末尾，`mediaClockReady=true` 锁死 `us` → `resolveHits` keySig 不变 → cross 永触发 → `rec.seg` 不刷新 → 死锁。之前 gap-skip 掩盖了它。
- **修法**：Media Clock Validity Guard（**局部 fallback，不改全局状态**）：`let mediaUs=_dominantMediaUs(); if(mediaUs!=null && !hasPlayableAt(mediaUs)) mediaUs=null;`，仅 seg 过期帧降级墙钟，使播放头穿过空白自然触发 cross。
- **状态**：✅ 落地。

### Round D.2b —— D.2 guard 不够（段内但过期）
- **现象**：`mediaUs=2.842` 落在 clip1 内（`gap=false`），guard 不降级，仍冻在 clip1 尾端。
- **根因**：`hasPlayableAt` 只问"时间轴位置有没有素材"，不问"当前媒体绑定的段是否已过期"。单位核实：`src_start/src_end/duration` **全微秒**，无第二单位 bug。
- **修法**：`_dominantMediaUs` 改算 `srcStartUs/srcEndUs/localRaw`，`localRaw` 越界则 video 分支落入 audio 兜底、audio 分支 `continue`；过期媒体不再返回冻结值。加 `src_end||(src_start+duration)` 兜底防缺字段。
- **状态**：✅ 用户验收"不卡了"。

### Round D.4 —— 后端未连导致完全播不了
- **现象**：重启 `start.bat` 后完全无播放（`STARTPLAY`+`SEEK` 反复但 `PLAY` 一次无）。
- **根因**：后端未连 → `window.MEDIA_BASE` 未设置 → `fileURL` 兜底 `file://` → WebView2 禁 file:// 媒体 → `readyState=0` → `_waitSeekSettled` 死等 seeked/error → 静默死锁。
- **修法**：屏障加 **700ms 超时安全网** + 上报 src（确认 file:// 即后端问题）；超时后报错红条而非静默死。
- **真修复**：后端连上（`MEDIA_BASE` 设置）；否则即使超时放行，`el.play()` 仍因 file:// 失败。
- **状态**：✅ 已加兜底。用户需确认 `start.bat` 的 Python 窗口真在跑、无报错。

### 探针（D.3 等，待清理）
- 为定位"从头播放 + 第二段播两次"，在 `STARTPLAY`/`PLAY`/`CROSS_ENTER`/`SEEK`/`TICK`/`CROSS` 插 console.log；因 DevTools 打不开，额外在页面右上角劫持 `console.log/warn/error` 显示半透明绿字面板（最近 50 条）。
- **状态**：仍在主文件，**待验完清理**（不属于生产代码）。

---

## 4. 当前未根治的核心根因（重点！这是接手后该做的方向）

**时钟仲裁未解耦**（用户已立为架构基线，不是再打一个补丁能解决的）：

- **机制**：播放头位置由"当前正在播的媒体"反推（`_dominantMediaUs`），而**下一段在 gap 入口已被提前 `seek+play`**，两者耦合 → gap 期间媒体时钟越权。
- **现象链**：跨段检测 `keySig !== lastHitSig` 在 `us` 一到 gap 入口（=clip1.end）就触发 `_handleCrossSegment(us)`，该函数**立刻** `seekActiveMediaToPlayhead` + `playAllMedia` 把**下一段（clip2）媒体 seek 到 `src_start` 并 play** → gap 期间 clip2 已在播（`currentTime≈0`），`_dominantMediaUs` 把它映射回 clip2 时间轴起点（如 20s）→ `mediaUs=20s` → `playTick` `us=mediaUs` → 播放头在 gap 入口瞬间跳到 20s，**10~20s gap 被视觉跳过**；同时 clip2 在 gap 里被提前播 → 也解释"第二段播两次/提前播"。
- **D.2b 的 guard 为什么拦不住**：`hasPlayableAt(mediaUs)` 只拦"mediaUs 落在 gap"，拦不住"mediaUs 落在下一段起点而 us 还在 gap"。
- **真正的底层修复 = 时钟仲裁收口**：
  1. `_dominantMediaUs` **只信任"其 seg 时间轴区间包含当前 `us`"的媒体**（gap 期间无媒体被信任 → 走墙钟平滑穿过）。
  2. 跨段处理**推迟到 `us` 真正到达下一段起点**才 `seek+play`，不在 gap 入口提前播。
  3. 未来 `ClockManager` 不能"谁在播谁是老大"，要先选**权威轨**（用户操作轨 / 主视频轨 / 音频轨 / wall fallback），只信任该轨 seg 区间含 `us` 的媒体（防 bgm 0-60 跨空白篡夺视频轨时钟）。

**A2 固有声音缝**：音频切换解码空档，barrier 治不了，留一轮 `audio transition / pre-seek / overlap`。

---

## 5. 当前仍存在的问题（已知，未改）

1. **中间"跳过"空隙**：gap 区被视觉跳过（因跨段提前播）—— 结构性，需时钟仲裁（见 §4）。
2. **第二段播两次 / 提前播**：同上根因。
3. **"从头播放"疑似**：`startPlay` 有 `if(playheadUs >= maxUs-1000) set(playheadUs:0)` 的"播完重播"逻辑；之前因卡死从没跑到末尾，现在能播完才暴露。**需确认是"播完重播"还是"中途播放也跳回 0"**（后者才是真回归）。
4. **完全播不了**：仅当后端未连（已加 700ms 超时兜底，但真修复 = 后端连上）。
5. **探针 + 页面日志面板残留**：D.3 的 `STARTPLAY/PLAY/SEEK/CROSS_ENTER/TICK/CROSS` 探针 + 右上角绿字面板仍在主文件，验完应清掉（非生产代码）。

---

## 6. 故意推迟 / 未动的区域（架构基线，禁止加新功能直到底层稳）

- **Step2 时间换算统一**：`timelineToSource()` / `sourceToTimeline()` 尚未落地，当前各消费者自写。
- **Step3 Command 层**：`splitClip/trimClip/moveClip/deleteClip` 封装不变量尚未做，当前 UI 直接改 `draft_state`。
- **MCP 暴露 Command**：当前 MCP 已接 `get_state / import_media_by_paths / add_clip / add_to_timeline / export_draft / split_segment / trim_segment / move_segment / remove_segment / undo / redo` 等；未来应暴露 Command 而非 `renderAll`。
- **Skill 区**：OpenCut PropertiesPanel 替换位（B 线填）。
- **字幕 / 特效 / MG / 情绪识别 / 基础特效原语引擎**：一律后置。
- **基础特效原语引擎**（下一阶段，非明天）：10~20 个 Agent 可调用原语（fade/scale/move/rotate/shake/zoom/blur/mask/crop/slide/typewriter/popText/highlight/counter/progress/wipe/glitch/flash/bounce），Skill 组合它们。参考 Remotion/Motion Canvas/motion-editor（引用前必做 LICENSE 审查；Remotion 特殊许可证商业闭源需商业许可）。

---

## 7. 工程纪律（必须遵守，否则越改越乱）

1. **外科手术式小改**，分轮（A→B→C→D…），每轮**独立可回退**（先存 `xxx_backup.html`）。
2. 流程：**备份 → 只读定位（grep/读码）→ 等"改" → 改码 → `node --check` → 重启 `start.bat` 真机验**。进入播放器状态机边界宁可多读一次，不连续打补丁。
3. **改完必须 Python 读真实函数体 + assert 标记存在 + `node --check` 实证**（不可信脚本回执）。本会话曾因脚本回执断言成功但文件未改而踩坑。
4. **不碰媒体生命周期**：不碰 `renderPreview`/`renderTimeline`/`playAllMedia` 无关改动；任何对 `visualEls`/`audioEls` 元素的媒体操作必须先按 `tagName` 区分 VIDEO/IMG/AUDIO。
5. **`node --check` 坑**：直接 `node --check xxx.html` 报 `ERR_UNKNOWN_FILE_EXTENSION`；须抽 `<script>` 块写临时 `.js` 再 `node --check`，或 `node -e` 直读 html + 内存 `vm.Script` 校验。

---

## 8. 关键文件与函数（给 Codex 直接定位）

- **主文件**：`工作台v0.8时间轴.html`（~186KB，所有前端逻辑；探针与日志面板也在内，待清）
- **后端**：`main.py`（PyWebView 启动 + 本地 HTTP 代理 `window.MEDIA_BASE`）、`mcp_server.py`（MCP stdio）
- **关键函数（grep 这些名字）**：
  - `startPlay` —— 播放启动入口（async，先 seek 屏障再 playAllMedia）
  - `playTick` —— RAF 每帧驱动器（`us = mediaUs!=null ? mediaUs : wallUs`）
  - `_dominantMediaUs` —— 媒体时钟→时间轴反向映射（**当前核心争议函数**）
  - `_handleCrossSegment(us)` —— 跨段处理（**当前提前播根因**）
  - `seekActiveMediaToPlayhead(us)` —— 唯一 seek 入口（含非活动媒体停车 + rec.seg 刷新）
  - `_waitSeekSettled(el)` —— seek 屏障（Round D）
  - `_seekMedia(el, seg, us)` —— 底层 seek（同步，无回调）
  - `playAllMedia` —— play 唯一入口（错误类型分流 F3）
  - `setZoom` —— 缩放（B0 补 tlContent/ruler 宽度）
- **其它说明文档**（本文件为 master，以下为补充）：
  - `README.md` —— 项目总览
  - `项目交接状态_给新GPT.md` / `HANDOFF_CODEBUDDY.md` —— 零上下文接交
  - `P0重构实施计划v2.md` —— 架构重构计划
  - `OpenCut对照诊断报告.md` —— 播放链路根因分析
  - `SCHEMA.md` + `架构地图_当前与OpenCut对应.html` —— 数据模型与架构对照

---

## 9. 接手建议（给 Codex 的最短路径）

1. 先读 §4（时钟仲裁未解耦）—— 这是所有"跳/双播/跳过"症状的**共同根因**，不要再去逐个修 D 系列的症状。
2. 设计 `ClockManager`：选权威轨 → 只信任 seg 区间含 `us` 的媒体 → gap 期间走墙钟平滑穿过 → 跨段推迟到 `us` 真正到达下一段起点才 seek+play。
3. 落实 §6 的 Step2（统一时间换算函数）和 Step3（Command 层）作为地基。
4. 修完 §5 的残留后，**清掉 §3 最后的探针与日志面板**。
5. 严守 §7 纪律：每轮独立备份、node --check、重启真机验。
