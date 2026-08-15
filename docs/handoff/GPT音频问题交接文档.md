# AI 视频剪辑工作台 — 播放器音频问题排查 / B.5 重构总览（GPT 交接文档）

> 这是一份**自包含**的交接文档。目标：让一个**没有上下文、可能只有一轮额度、可能英文回复**的 GPT 实例，读完即可接手分析「为什么纯音频（MP3）没声音 / 播放头不动，而加了视频（MP4）就正常」这个问题，并给出**在 B.5 框架内**的修复建议（不要推倒重写播放器）。

---

## 0. English Executive Summary（英文执行摘要，给 GPT 看）

**Project**: A desktop AI video-editing workbench (PyWebView shell + single HTML timeline UI; pure Python + pyJianYingDraft for export). The core file is `工作台v0.8时间轴.html` (≈210 KB, all player logic in one inline `<script>`).

**The bug**: When the timeline contains **only audio (MP3)**, pressing play often results in (a) the playhead not advancing / frozen at 0s, and/or (b) **no sound**. The moment you also add a **video (MP4)**, everything works — video plays AND audio plays. Cutting/splitting the audio clip, or dragging the playhead, sometimes makes sound appear. This is reproducible and consistent, not random.

**What we already verified by reading the code (do NOT re-litigate this)**:
- The player is **already Timeline-Clock-driven**, NOT video-driven. In `playTick`, the playhead is advanced by wall-clock elapsed time (`playStartUs + elapsed`); media elements are only *followers* (a drift corrector seeks media back when off by >100ms, but never writes the playhead). So the architecture GPT might suggest ("rewrite the player as Timeline Runtime") is **unnecessary** — the engine is already correct at that level.
- Video and audio go through the **same** code path: `resolveHits` → `PlayerManager.seek` → `seekActiveMediaToPlayhead` → `correctActiveMediaDrift`. There are **not** two separate play logics.
- `startPlay()` is an `async` function that does `await` on readiness/seek before calling `playAllMedia()`. This is suspicious for autoplay-policy reasons (see hypothesis).

**What we changed (chronological, all committed)**:
- **Step A (baseline, before this session)**: `PlaySession` state machine (8 states), gap/seek/pause partial fixes.
- **Step B (`9aac35a`)**: consolidated `AbortError` recovery into `continueStart` + `_scheduleRecover` with a `recoverToken` race guard and a windowed retry quota (`RECOVER_CAP=2`, `RECOVER_WINDOW_MS=60000`). Removed the inline bare `setTimeout(60ms){el.play()}` second play path.
- **Step B.5 v1.0 (`7948d45`)**: removed the 120 ms bare unmute fallback; introduced a 3-signal "Activation Gate" (`playing` → `canplaythrough/readyState>=4` → `MEDIA_ACTIVATION_TIMEOUT=1000ms`) gated on **all targets activated** before unmuting. **Regression introduced**: first play froze (playhead didn't move) because `el.play()` was called at `readyState<2` and stayed pending.
- **Step B.5 v1.1 (`ed02a20`)**: added a **pre-ready gate** — wait for `canplay`/`canplaythrough`/`error` (with timeout) before calling `el.play()`. Fixed the frozen-playhead regression.
- **Step B.5 v1.2 (`f6ce6ed`)**: added a global `AudioContext` and call `audioCtx.resume()` synchronously at the top of `startPlay()` to unlock page audio output; extended activation signals to include `canplay`/`loadeddata`. **Current state**: pure MP3 *still* sometimes has no sound on first play; cutting/dragging sometimes fixes it.

**Our current hypothesis (needs GPT validation)**: The root cause is **WebView2 / CEF autoplay policy**, not a logic bug. A successful first `video.play()` unlocks page-wide audio; a bare `audio.play()` (especially after `await`s that consume the user-gesture context, and on cross-segment resume) is silently rejected by WebView2. "Cutting makes it work" = the cut triggers element recreation/reload, which re-initializes media in a ready state within a fresh gesture, bypassing the lock. The "stretch a split clip → garbled sound" issue is a **separate data-model bug** (Command layer, belongs to future step C/D): stretching a split clip changes `duration` but does not re-sync `src_start`/`src_end`.

**What we need GPT to do (one round, please)**:
1. Validate or refute the WebView2 autoplay-policy hypothesis for `<audio>` specifically.
2. Propose a **concrete, minimal in-B.5 fix** so pure audio reliably produces sound *without* a video present — ideally guaranteeing the first `audio.play()` happens inside the user gesture, or routing audio through the `AudioContext` graph. Show the exact code change location in `工作台v0.8时间轴.html` (`startPlay`, `_attemptPlay`/`_playWhenReady`, `unlockAudio`).
3. Address the **cross-segment audio handoff** (first segment ending → second segment starting) so it doesn't drop sound.
4. Confirm we should **NOT** rewrite the player; keep fixing within B.5.

**Constraints**: Do not suggest touching `start()`'s orchestration red line, do not rewrite the architecture, do not add `AudioContext` audio-graph processing beyond an unlock key. The route is strictly serial: A → B → B.5 → C → D. We are in B.5 acceptance.

---

## 1. 项目是什么

- **形态**：桌面 AI 剪辑工作台。外壳用 PyWebView（Python 起本地 HTTP + WebView2 渲染），UI 是一个单文件 HTML 时间轴（`工作台v0.8时间轴.html`）。导出用 `pyJianYingDraft` 生成剪映草稿。
- **核心文件**：`工作台v0.8时间轴.html`（所有播放/时间轴/渲染逻辑都在一个内联 `<script>` 里，约 210KB）。
- **配套**：`main.py`（PyWebView 启动 + MCP 桥）、`mcp_server.py`（给外部 Agent 调用的剪辑能力）、`start.bat`（一键启动）。
- **目标定位**：不是做"剪辑软件"，是做"AI 视频操作系统"的执行层——未来外部 Agent 通过 MCP 发 Operation（如 `remove_segment`），系统改 Timeline、重同步播放器。详见 `docs/decisions/ADR-001-ai-video-os-route.md`。

## 2. 播放器架构核心事实（已读代码验证，GPT 不必再问）

| # | 问题 | 代码事实 | 结论 |
|---|---|---|---|
| 1 | 播放头（时钟）由谁维护？ | `playTick` 里 `us = playStartUs + 墙钟流逝`，写入 `Store.state.playheadUs`；媒体时钟只做 follower | **已是 Timeline Clock 驱动** |
| 2 | `currentTime` 来源？ | 墙钟推进；`correctActiveMediaDrift` 只在偏差 >100ms 时把媒体 seek 回正确位置，**绝不反写播放头** | 媒体是 follower，不是 master |
| 3 | MP4 是 video 驱动还是 Timeline 驱动？ | 同样走 `resolveHits` → `PlayerManager.seek` → 墙钟对齐 | Timeline 驱动 |
| 4 | MP3 是否另一套逻辑？ | video 和 audio **同一套** `resolveHits` / `seekActiveMediaToPlayhead` / `correctActiveMediaDrift` | **不是两套逻辑** |
| 5 | PNG 是否参与 PlaySession？ | `<img>` 不参与 play/pause 控制（无 `pause()`/`muted`），由 `renderPreview` 控显示 | 正确（图片只需"显示"） |
| 6 | 文本/特效是否统一时间范围？ | 都基于 `playheadUs` 判定可见/应用 | 统一 |

> **关键结论**：GPT 在对话中曾建议"暂停 B.5、重写 Player Runtime Architecture v1，因为播放器围绕视频设计"——**这个假设被代码事实推翻**。引擎已经是 Timeline 驱动的，video/audio 同级同逻辑。所以正确做法是在 B.5 框架内修，不是推倒重写。

## 3. 我们做了什么 / 改了什么（按时间线，含 commit）

### Step A（本会话之前，基线）
- `PlaySession` 状态机化（8 态枚举 `PLAY_SESSION_STATE`：CREATED/STARTING/MUTED_PLAYING/PLAYING/RECOVERING/PAUSED/ENDED/CANCELLED）。
- gap 不卡 / seek 任意起播 / 暂停再播有声 —— 部分修复。
- 残留问题：首次播放没声（留给 B.5）。

### Step B（commit `9aac35a`）— 启动事务收口
- 新增常量 `RECOVER_CAP=2`、`RECOVER_WINDOW_MS=60000`（窗口化恢复配额）。
- `createSession` 加 `recoverToken:0` / `recoverCount:0` / `lastRecoverAt:0` + `canContinue()` 方法（配额判定）。
- `start()` 瘦身为纯编排，**删掉内联的 `AbortError→setTimeout(60ms){el.play()}` 第二套裸播放逻辑**。
- 新增 5 个方法：
  - `_attemptPlay(session,t)`：**唯一 `el.play()` 出口**，纯媒体动作，不碰 state / 不写 restore / 不分类错误。
  - `_onMediaPlaying(session,t)`：钉子4 seam（B 阶段等同原 onPlaying 解锁；B.5 升级为聚合门）。
  - `_onStartError(session,t,err)`：错误集中分类（AbortError→`_scheduleRecover`；NotSupportedError→`_tryReloadMedia` 原样移交；其他→`showFatal`）。
  - `_scheduleRecover(session)`：`recoverToken` 竞态防护（旧恢复回调首行校验 token，防污染新状态）。
  - `continueStart(session,reason)`：`canContinue` 校验 → 置 STARTING → **复用启动序列**调 `_attemptPlay`（禁复制 start 内部逻辑）。
- 日志统一 `[PlaySession]` 格式，含 `token=` / `reason=`。

### Step B.5 v1.0（commit `7948d45`）— 媒体激活门
- **移除 B 红线保留的 120ms 裸兜底**（这是"画面跑了但声音没出来"的真凶：冷启动/seek 重定位时音频管线未稳定就解了 mute）。
- 新增 `MEDIA_ACTIVATION_STATE` 枚举（`WAITING`/`PLAYING_CONFIRMED`/`READY_FALLBACK`/`TIMEOUT_DEGRADED`）+ `MEDIA_ACTIVATION_TIMEOUT=1000ms`。
- `_attemptPlay` 改造：`playing`（最高）→ `canplaythrough`/`readyState>=4`（中）→ `timeout`（兜底）三层激活信号。
- `_onMediaPlaying` 升级为聚合门；新增 Activation Tracker 全套方法：`_initActivation` / `_setActivation` / `_onMediaReady` / `_onActivationTimeout` / `_checkAllActivated` / `_restoreSession` / `_cleanupAllActivation`。
- 逻辑：**等全部 target 都脱离 WAITING 才整批解 mute**；单坏轨走 timeout 降级，不拖死整体（比 `Promise.all` 成熟）。
- `pause()` 清理激活监听/timer，防暂停后旧回调误触发。
- **引入退化**：首次播放时 `el.play()` 在 `readyState<2` 被调用，WebView2 下 `play()` 长期 pending → 播放头不动。

### Step B.5 v1.1（commit `ed02a20`）— 预 ready gate
- 把 `_attemptPlay` 拆成两步：
  1. **预 ready gate**：`readyState<2` 且无 error 时，先等 `canplay`/`canplaythrough`/`error`，超时才尝试 play。
  2. `_playWhenReady`：媒体 ready 后再走原 B.5 三层激活信号。
- 修复"首次播放画面不动"。

### Step B.5 v1.2（commit `f6ce6ed`）— 音频解锁
- 全局创建 `AudioContext`（**只当解锁钥匙，不处理音频流**）。
- `startPlay()` 首行同步调用 `audioCtx.resume()`，趁点击手势还在时解锁页面音频输出。
- `_playWhenReady` 扩展激活信号：`playing`（最高）+ `canplaythrough`/`canplay`/`loadeddata`（READY_FALLBACK）+ `timeout` 兜底。
- **当前状态**：纯 MP3 首次仍可能无声；切开/拖动后有时有声。

## 4. 当前剩余问题 + 根因假设

### 现象（用户真机验收，最新一轮）
1. 纯 MP3，刚打开点播放 → 播放头在 0 秒不动，截了张图后突然动了，但**没声音**。
2. 放 MP4，中间切一下 → MP4 有声音，但同时间轴里的 MP3 仍可能没声。
3. 删掉所有素材，只放 MP3 → **没声音**。
4. 把 MP3 **切开**（split）→ **有声音**。
5. 把切开的 MP3 片段**拉长** → 播放出异常/听不清的声音（疑似速度或映射错乱）。

### 根因假设（待 GPT 验证）
- **不是两套代码逻辑**（已证伪）。
- **是 WebView2 / CEF 的自动播放策略（autoplay policy）**：
  - 浏览器以"首次成功 `play()` 的媒体"作为页面音频解锁钥匙。放 MP4 → `video.play()` 成功 → 浏览器授予页面媒体权限 → 之后 `<audio>` 也能播 → 看起来"放 MP4 就正常"。
  - 纯 `<audio>`：我们的 `unlockAudio()`（`AudioContext.resume()`）在 `startPlay()` 里跑了，但 `startPlay()` 是 `async`，在真正调 `playAllMedia()`/`el.play()` 之前有 `await`（等 ready / 等 seek），**用户手势上下文被消耗**，导致 `<audio>.play()` 在 WebView2 下被静默拒绝。
  - **跨段续播**时再次 `play()` 已无新鲜手势 → 同样被拒 → 你看到的"从第一段尾直接跳第二段头 / 衔接掉声"。
- **"切开 MP3 突然有声"** = 切开触发了片段重创建 / 重绑定 / 重加载，媒体被预热且在一次新鲜手势内 → 绕过锁定。这**证明是初始化/手势问题，不是逻辑路径差异**。
- **"拉长切开的片段声音异常"** = **另一个 bug（数据模型层，归 C/D）**：拉长 split 片段只改了 `duration`，没同步重算 `src_start`/`src_end`，媒体元素把时间轴时间映射到错误的素材源时间 → 播放错乱。

## 5. 为什么偏偏音频出问题（直接回答）

一句话：**音频不是走了另一套代码，而是播放器的"可靠启动 + 解锁"在『没有视频铺路 + WebView2 自动播放策略 + 跨段续播失去手势』三重叠加下暴露了脆弱性。**

拆解：
1. 引擎本身是对的（Timeline 驱动、音视频同逻辑）。
2. 视频元素天然被浏览器"厚待"——`video.play()` 成功即解锁整页音频，所以"加个 MP4 就全好"。
3. 纯 `<audio>` 在没有视频基准时，首播 `play()` 容易因手势上下文丢失被静默拒绝；跨段续播再次 `play()` 同样脆弱。
4. 拖动/切开之所以"恰好好"，是因为它们顺手把媒体元素重建 + 重载，等于强制重新初始化，绕过了竞态——这是巧合性规避，不是真修。

所以我们的方向不是"再写个音频专属逻辑"，而是**让纯音频的启动像视频一样稳**：保证首次 `audio.play()` 在手势内、保证激活信号在无视频参考时钟时也能可靠 resolve、保证跨段衔接不掉声。全部在 B.5 框架内做，不新建架构。

## 6. 需要 GPT 分析 / 回答的问题（请一轮内给结论 + 代码位置）

1. **验证假设**：WebView2/CEF 对 `<audio>` 的自动播放策略是否确实比 `<video>` 更严？纯音频首播被静默拒绝是否符合该假设？
2. **最小修复**：给出一个**具体、最小、在 B.5 框架内**的改法，让纯音频（无视频）可靠出声。重点：
   - 能否把"首次 `audio.play()`"提前到点击手势内（在 `startPlay` 的 `await` 之前同步触发一次 `el.play()` 或 `audioCtx.resume()` + 同步 play）？
   - 是否应该把音频真正接到 `AudioContext` 的 graph 上（`MediaElementSource` → `destination`）来保证解锁？如果只是 `resume()` 不够，给出准确接线代码。
   - 改动的**精确位置**：`startPlay()`（约 1880 行附近）、`unlockAudio()`（新增）、`_attemptPlay` / `_playWhenReady`（约 1300–1400 行）。
3. **跨段衔接**：多段 MP3 拼接时，第一段结束→第二段开始，如何保证不掉声、不跳变？现有 `_handleCrossSegment` / `seekActiveMediaToPlayhead` 在这块有什么具体缺陷？
4. **路线确认**：是否同意"**不重写播放器，继续在 B.5 内修**"？请提供理由。
5. **边界**：明确告知"拉长 split 片段声音异常"属于数据模型层（C/D 的 Command 收口），不属于本次播放器修复范围——确认这个判断。

## 7. 约束与纪律（防止 GPT 跑偏）

- **不要推倒重写播放器**。代码已是 Timeline-Clock 驱动，重写会丢进度。
- **严格串行路线**：A → B → B.5 → C → D。当前在 B.5 验收阶段，不要跳去 C/D。
- **B 红线**：`start()` 内不得再出现裸 `play()` 补丁；恢复逻辑统一走 `_scheduleRecover`/`continueStart`。
- **AudioContext 只做解锁钥匙**，不要接管音频流处理（超出范围）。
- **不碰根目录那 7 个违规文件**（CODEX_BRIEF / HANDOFF_CODEBUDDY / P0重构实施计划v2 / 剪辑工具_开发待办 / 项目交接状态_给新GPT / 架构地图_当前与OpenCut对应.html / ai-video-studio_public.zip），它们不进 git，是历史遗留，不要基于它们分析。
- 改完代码后必须 `node --check` 语法校验（抽内联 `<script>` 到临时 js 再校验）。

## 8. 如何复现 / 验收

**复现（必做）**：
1. 启动 `start.bat`，导入一个 MP3，点播放 → 预期应：播放头走动 + 有声。当前：可能不动 / 无声。
2. 同一个 MP3，拖动播放头到中间再播 → 预期有声。
3. 暂停后再播 → 预期有声。
4. 把 MP3 split 成两段，从头播 → 预期两段衔接都有声。
5. 加一个 MP4 同播 → 预期音视频都有声（这是"正常基线"，用来对比）。

**验收通过标准**：以上 5 条全过，且控制台能看到 `ACTIVATION` 行与最终 `[PlaySession] ... PLAYING ... reason=activationGate`；若媒体损坏/极慢，1000ms 后降级为 `state=TIMEOUT_DEGRADED` 但不卡死。

**关键源码锚点（行号可能漂移，用 grep 定位）**：
- `function startPlay` —— 播放入口（含 `unlockAudio` / `audioCtx`）。
- `_attemptPlay` / `_playWhenReady` —— 媒体起播 + 激活信号。
- `_onMediaPlaying` / `_setActivation` / `_checkAllActivated` / `_restoreSession` —— Activation Gate。
- `playTick` —— 播放头推进（墙钟）。
- `resolveHits` / `seekActiveMediaToPlayhead` / `correctActiveMediaDrift` —— 时间轴↔媒体映射。
- `MEDIA_ACTIVATION_STATE` / `MEDIA_ACTIVATION_TIMEOUT` / `RECOVER_CAP` / `RECOVER_WINDOW_MS` —— 常量。

---

*本文件是 B.5 音频排查的调试回溯，供外部 GPT 接手分析用。配套干净源码已用 `git archive` 打包为 ZIP。*
