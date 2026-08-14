# AI 剪辑工作台 — 项目交接状态（2026-08-14 凌晨，给新 GPT）

> 你（AI）没有前面几十轮的上下文。先读这份，别重新读码猜方向。前面已经踩过"改了出新 bug"的坑，纪律是第一位的。本文件是当前权威状态，计划文档 `P0重构实施计划v2.md` 的 Round 命名已演进，以本文件为准。

## 〇、3 句话定位
- 项目：PyWebView 桌面 **NLE（非线性编辑器）**，定位"给 Agent 操作的剪辑内核"，不是普通网页播放器。路径 `C:\Users\34450\Desktop\ai-video-studio\`
- 唯一改动文件：`工作台v0.8时间轴.html`（~3000 行单文件，UI+播放+渲染全在内）。后端 `main.py` 本轮不动。
- **铁律**：PyWebView 不热更新 → 任何改动必须重启 `start.bat` 真机验，不能靠刷新页面。

## 一、执行纪律（最重要，照做）
1. 外科手术式小改，按 Round 拆轮，**每轮独立可回退**。
2. 每轮顺序：先备份 → 只读定位/出方案 → **等用户回"改"**才动手 → 改码 → 抽内联 JS 跑 `node --check`（用 `C:/...` 绝对路径，别 `/c/...`，Git Bash 会把 `/c/...` 传给原生 node 转成 `c:\c\...` 报 MODULE_NOT_FOUND）→ 提醒用户重启 `start.bat` 验。
3. 禁止：大重构 / 新建第二套播放 / 重构 `renderPreview` / 改数据结构 / 改 `main.py` / 改 UI / 碰 Step2/Step3。
4. 任何 seek 只能经 `_seekMedia`，不准散写 `el.currentTime=xxx`。
5. 用户已具备架构评审能力，会反问"这个设计是不是合理/是不是在掩盖 bug"——不要擅自连改多轮，严格逐轮等验收。

## 二、当前代码状态（真实，精确到标记/行号，可 grep 验证）
已落地（代码在文件中，标记可搜）：
- **Round A ✅ 已验收**：删 `canplay` 主动 `t.play()`，`play()` 收归 `playAllMedia()` 唯一入口。双声/抢播/AbortError 该源已消失。
- **Round B0 ✅ 已验收**：`setZoom` 补内容区/标尺宽度重排，修"播放期放大比例播放头消失"。
- **Round B**：跨段 `renderPreview()`→`seekActiveMediaToPlayhead()`（L1527 新函数）。代码已落，待干净验收。
- **Round B1**：跨段补非活动媒体 `pause()+muted=true`。代码已落，待干净验收。
- **B2-A ✅ 用户验收"过"**：`_seekMedia`（L1135）钳制上界由 `(srcEndUs-srcStartUs)` 改为 `srcEndUs`。修 split 右段从切点续播（不再反复播开头）。
- **B2-B**：代码已落（L1532 命中循环，标记 `B2-B`）：`if (rec && (rec.seg !== h.seg || rec.key !== h.key)) { rec.seg = h.seg; rec.key = h.key; }` 跨段刷新 rec 元数据。**待干净验收**（曾被上游 bug 污染，见三）。
- **B2-Foundation（F1/F2/F3）**：代码已落（标记 `F1：`/`F2：`/`F3：`）：
  - F1（`startPlay` ~L1375）：`playAllMedia()` 前插 `seekActiveMediaToPlayhead(Store.state.playheadUs)`，修"首次播放永远从源素材 0 秒起"。
  - F2（`_dominantMediaUs` L1498）：源时间→时间轴减 `src_start` 偏移 + 钳到段时长，修跨段播放头算错→闪/卡/反复 seek。
  - F3（`playAllMedia` catch）：仅 `NotAllowedError` 走静音兜底；`AbortError` 记日志+轻量重试；其它错误 `console.warn`+红条暴露真名，禁 blanket 静音。**待用户验**。

**未做**：Round C（下一步，见四）。

## 三、当前两个未解 bug（用户最新报，截图 AI 读不到，文字描述）
- **Bug A（音频跨段跳/断）**：音频-only 项目，cut 成多段后播放，播放头自己跳到下一段继续播、中间每断（有缝隙/跳变）；但只要叠一条视频轨（整段视频）就正常。
- **Bug B（拖播放头回弹）**：把播放头拖到某位置点播放，它会回到"之前播放的位置"继续播，不服从新拖的位置。
- **根因（同一处，媒体时钟信任竞态）**：
  - `onplaying`（L1120 video / L1319 audio）一 `play()` 立刻 `mediaClockReady = true`，但此刻 `currentTime` 可能还在 seek 到新位置的过程中（seek 是异步的）。
  - `_dominantMediaUs`（L1498）在 `mediaClockReady===true` 时直接读元素 `currentTime` 算播放头 → 读到 seek 前的旧位置 → 播放头显示回旧位置 / 跨段误判 → 反复 seek。
  - 加视频就正常的原因：视频是整段长素材，跨音频段时不 seek，`_dominantMediaUs` 始终读视频时钟（无段边界切换），所以"正常"。
- **归属**：Round C（见四），不是 B2 系列。B2-Foundation 落地后这两个 bug 仍未消，是因为根因在"onplaying 抢先信任时钟"，Foundation 没动这里。

## 四、下一步 Round C 精确方案（4 处，纯前端、不重建元素、不碰 Step2/3）
目标：让 `mediaClockReady` 只在元素**真正 settle（非 seek 中）**才为真 → 播放头既不回弹、跨段也不跳。
1. **L1120 video**：`v.onplaying = () => { if (!v.seeking) mediaClockReady = true; };`（seek 中不置 true）
2. **L1319 audio**：`a.onplaying = () => { if (!a.seeking) mediaClockReady = true; };`（同上）
3. **`_dominantMediaUs` L1500 video 分支**：`if (v && !v.paused && !v.seeking)`（seek 中该元素不算 dominant，回落墙钟）
4. **`_dominantMediaUs` L1506 audio 分支**：`if (a && !a.paused && !a.seeking)`（同上）
- 配套已有机制：`onseeked`（L1564）在跨段 seek 完成后正确置 `mediaClockReady=true`；`startPlay` 起播时置 `false`（F1 已先 seek 到播放头）。三处协同 → 播放头稳定、跨段不跳。
- 验证三项：①拖播放头到任意位置点播放，从新位置开始、不回弹 ②音频-only 跨段无跳无断 ③开发者工具 Console 无异常报错（F3 已让真实错误名暴露）。

## 五、关键函数地图（行号，快速定位）
| 函数 | 行 | 职责 |
|---|---|---|
| `_seekMedia(el, seg, us)` | 1135 | 唯一 seek 入口：timeline→source 换算（含 src_start 钳制到 srcEndUs），禁第二套 |
| `_dominantMediaUs()` | 1498 | 播放头跟随媒体时钟：源时间→时间轴（F2 已修减 src_start） |
| `playAllMedia()` | 1448 | play 唯一入口；catch 按错误类型分流（F3） |
| `seekActiveMediaToPlayhead(us)` | 1527 | 跨段只 seek 已存在元素；刷新 rec.seg/key（B2-B） |
| `renderPreview(s)` | 1160 | 媒体创建/复用唯一函数（按轨道 ti 复用元素），本轮禁重构 |
| `startPlay()` | 1363 | 起播：renderPreview→F1 seek→playAllMedia |
| `playTick` | ~1560 | RAF 播放循环：跨段检测→切源→续播 |

## 六、文件清单
- `P0重构实施计划v2.md` — 计划 v2.2（权威背景，但 Round 命名已演进，以本文件为准）
- `架构地图_当前与OpenCut对应.html` — 五层架构 + OpenCut 对应图
- `项目交接状态_给新GPT.md` — 本文件
- `工作台v0.8时间轴.html` — 唯一改动文件，当前 = Foundation 后状态
- 回退链（均已验证干净）：`Step1_A_backup.html`(post-A) / `Step1_B0_backup.html` / `Step1_B_backup.html` / `Step1_B1_backup.html` / `Step1_B2_backup.html`(pre-B2-A) / `Step1_B2B_backup.html`(post-B2-A/pre-B2-B) / `Step1_Foundation_backup.html`(post-B2-B/pre-Foundation)

## 七、给新 GPT 的硬约束（照抄执行）
1. 只许按 Round 改；禁止大重构 / 第二套播放 / 重构 renderPreview / 改数据结构 / 改 main.py / 改 UI。
2. 任何 seek 只经 `_seekMedia`。
3. 每轮：备份 + node --check（`C:/` 路径）+ 重启 start.bat 验。
4. Step2（集中 timelineToSource）/ Step3（Command）/ MCP，本轮不碰。
5. **等用户回"改"再动手**，绝不一次连改多轮。
