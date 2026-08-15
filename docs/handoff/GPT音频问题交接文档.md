# AI 视频剪辑工作台 — 播放器音频问题排查 / B.5 重构总览（GPT 交接文档 v1.3）

> 这是一份**自包含**的交接文档。目标：让一个**没有上下文、可能只有一轮额度、可能英文回复**的 GPT 实例，读完即可接手分析「为什么纯音频（MP3）在 seek/drag/pause-resume 后仍频繁无声，以及音视频同播时状态错乱」这个问题，并给出**在 B.5 框架内**的修复建议（不要推倒重写播放器）。

---

## 0. English Executive Summary（英文执行摘要，给 GPT 看）

**Project**: A desktop AI video-editing workbench (PyWebView shell + single HTML timeline UI; pure Python + pyJianYingDraft for export). The core file is `工作台v0.8时间轴.html` (≈210 KB, all player logic in one inline `<script>`).

**The bug (latest round)**: After fixing cross-segment reboot, we still observe:
- A **split MP3** often becomes **silent** after the user **drags the playhead** to start/middle/cross-segment boundary and presses play.
- **Pause → resume** can drop audio or leave video frozen while audio keeps playing.
- Adding a **video (MP4)** sometimes makes audio work, but other times the video frame freezes while audio plays.
- First play of a fresh MP3 may still be silent; cutting/splitting sometimes (but not always) revives it.

**What we already verified by reading the code (do NOT re-litigate this)**:
- The player is **already Timeline-Clock-driven**, NOT video-driven. In `playTick`, the playhead is advanced by wall-clock elapsed time (`playStartUs + elapsed`); media elements are only *followers* (a drift corrector seeks media back when off by >100ms, but never writes the playhead).
- Video and audio go through the **same** code path: `resolveHits` → `PlayerManager.seek` → `seekActiveMediaToPlayhead` → `correctActiveMediaDrift`. There are **not** two separate play logics.
- There is **no** hidden `if(videoTargets.length)` or `activeMedia = videos` preference in the code (verified by grep = 0 hits).

**What we changed (chronological, all committed)**:
- **Step A (baseline)**: `PlaySession` state machine (8 states), gap/seek/pause partial fixes.
- **Step B (`9aac35a`)**: consolidated `AbortError` recovery into `continueStart` + `_scheduleRecover` with `recoverToken` race guard and windowed retry quota.
- **Step B.5 v1.0 (`7948d45`)**: removed the 120 ms bare unmute fallback; introduced a 3-signal "Activation Gate" (`playing` → `canplaythrough/readyState>=4` → `MEDIA_ACTIVATION_TIMEOUT=1000ms`) gated on **all targets activated** before unmuting.
- **Step B.5 v1.1 (`ed02a20`)**: added a **pre-ready gate** — wait for `canplay`/`canplaythrough`/`error` before calling `el.play()`. Fixed first-play frozen playhead.
- **Step B.5 v1.2 (`f6ce6ed`)**: added a global `AudioContext` and call `audioCtx.resume()` at the top of `startPlay()`; extended activation signals to `canplay`/`loadeddata`.
- **Step B.5 v1.3 (`bbb7979`)**: introduced `_PLAY_REASON` transaction enum (`START`/`RECOVER`/`HANDOFF`). Cross-segment now reuses the current `PlaySession` via `_handoff()` instead of cancel+createSession, avoiding a ~1s audio drop at segment boundaries.

**Our current hypothesis (needs GPT validation)**: The root cause is now less about "video unlocks audio" and more about:
1. **Mute-state ownership is scattered**: `seekActiveMediaToPlayhead()` explicitly unmutes active media (`v.muted = ... || previewMuted`, `a.muted = ... || previewMuted`), but `_playWhenReady()` then forces `el.muted = true` for every paused target, and unmute only happens through the Activation Gate. These multiple writers fight, especially after seek/drag.
2. **`startPlay()` loses the user gesture**: it calls `unlockAudio()` then does two `await`s (wait media ready + wait seek settled) before the real `playAllMedia()`/`el.play()`. By then the click gesture context is gone; WebView2 may silently reject `audio.play()`.
3. **Seek races**: `renderPreview()` sets `oncanplay` to seek, then `startPlay()` waits for ready, then `seekActiveMediaToPlayhead()` seeks again. Multiple overlapping seeks on the same `<audio>` element before/around `play()` create inconsistent `currentTime` and activation events.

**What we need GPT to do (one round, please)**:
1. Validate the scattered-mute-state + lost-gesture + seek-race hypothesis.
2. Propose a **concrete, minimal in-B.5 fix** so that after seek/drag/pause-resume, audio (and video) reliably plays.
3. Specifically address whether `startPlay()` should call `playAllMedia()` **synchronously inside the click handler** (before the awaits), with elements muted, and let the Activation Gate unmute once ready/seeked.
4. Address whether `seekActiveMediaToPlayhead()` should stop touching `muted` at all.
5. Confirm we should **NOT** rewrite the player; keep fixing within B.5.

**Constraints**: Do not suggest touching `start()`'s orchestration red line, do not rewrite the architecture, do not add `AudioContext` audio-graph processing beyond an unlock key. The route is strictly serial: A → B → B.5 → C → D. We are in B.5 acceptance.

---

## 1. 项目是什么

- **形态**：桌面 AI 剪辑工作台。外壳用 PyWebView（Python 起本地 HTTP + WebView2 渲染），UI 是一个单文件 HTML 时间轴（`工作台v0.8时间轴.html`）。导出用 `pyJianYingDraft` 生成剪映草稿。
- **核心文件**：`工作台v0.8时间轴.html`（所有播放/时间轴/渲染逻辑都在一个内联 `<script>` 里，约 210KB）。
- **配套**：`main.py`（PyWebView 启动 + MCP 桥）、`mcp_server.py`（给外部 Agent 调用的剪辑能力）、`start.bat`（一键启动）。
- **目标定位**：不是做"剪辑软件"，是做"AI 视频操作系统"的执行层——未来外部 Agent 通过 MCP 发 Operation（如 `remove_segment`），系统改 Timeline、重同步播放器。详见 `docs/decisions/ADR-001-ai-video-os-route.md`。

---

## 2. 播放器架构核心事实（已读代码验证，GPT 不必再问）

| # | 问题 | 代码事实 | 结论 |
|---|---|---|---|
| 1 | 播放头（时钟）由谁维护？ | `playTick` 里 `us = playStartUs + 墙钟流逝`，写入 `Store.state.playheadUs`；媒体时钟只做 follower | **已是 Timeline Clock 驱动** |
| 2 | `currentTime` 来源？ | 墙钟推进；`correctActiveMediaDrift` 只在偏差 >100ms 时把媒体 seek 回正确位置，**绝不反写播放头** | 媒体是 follower，不是 master |
| 3 | MP4 是 video 驱动还是 Timeline 驱动？ | 同样走 `resolveHits` → `PlayerManager.seek` → 墙钟对齐 | Timeline 驱动 |
| 4 | MP3 是否另一套逻辑？ | video 和 audio **同一套** `resolveHits` / `seekActiveMediaToPlayhead` / `correctActiveMediaDrift` | **不是两套逻辑** |
| 5 | 有没有 `if(videoTargets.length)` 之类的 video-centric 硬编码？ | grep 结果 = 0 命中 | **没有** |
| 6 | PNG/文本/特效是否参与 PlaySession？ | `<img>`/文本/特效只按 `playheadUs` 控制 `display`/渲染，无 `play/pause/muted/readyState` | 正确（Timeline Render 层） |

> **关键结论**：播放器在 Timeline Clock 和视频/音频同路径这两件事上是对的，不需要重写 Runtime。问题在**媒体启动/解锁/静音状态**的协调层。

---

## 3. 我们做了什么 / 改了什么（按时间线，含 commit）

### Step A（本会话之前，基线）
- `PlaySession` 状态机化（8 态枚举）。
- gap 不卡 / seek 任意起播 / 暂停再播有声 —— 部分修复。
- 残留问题：首次播放没声（留给 B.5）。

### Step B（commit `9aac35a`）— 启动事务收口
- `RECOVER_CAP=2` / `RECOVER_WINDOW_MS=60000` 窗口化恢复配额。
- `createSession` 加 `recoverToken`/`recoverCount`/`lastRecoverAt`。
- `start()` 删掉内联 `AbortError→setTimeout(60ms){el.play()}` 第二套裸播放逻辑。
- 新增 `_attemptPlay`（唯一 `el.play()` 出口）、`_onMediaPlaying`（钉子4 seam）、`_onStartError`（错误分类）、`_scheduleRecover`（token 竞态防护）、`continueStart`（复用启动序列）。

### Step B.5 v1.0（commit `7948d45`）— 媒体激活门
- 移除 120ms 裸兜底。
- 新增 `MEDIA_ACTIVATION_STATE` + `MEDIA_ACTIVATION_TIMEOUT=1000ms`。
- `playing` → `canplaythrough`/`readyState>=4` → `timeout` 三层激活信号，等全部 target 激活才整批解 mute。
- 退化：首次播放 `readyState<2` 时 `play()` pending → 播放头不动。

### Step B.5 v1.1（commit `ed02a20`）— 预 ready gate
- `readyState<2` 时先等 `canplay`/`canplaythrough`/`error` 再 `play()`。
- 修复"首次播放画面不动"。

### Step B.5 v1.2（commit `f6ce6ed`）— 音频解锁
- 全局 `AudioContext`，`startPlay()` 首行同步 `audioCtx.resume()`。
- 扩展激活信号：`canplay`/`loadeddata`。
- 纯 MP3 仍有概率无声；切开/拖动后有时恢复。

### Step B.5 v1.3（commit `bbb7979`）— 跨段 handoff 非 reboot
- 新增 `_PLAY_REASON` 事务枚举（START/RECOVER/HANDOFF）。
- `play()` 分流：HANDOFF 复用当前 `PlaySession`，调用 `_handoff()` 增量处理，不 cancel+createSession，不重静音全体。
- `_setActivation` 聚合门分流：冷启动走 `_checkAllActivated`（全体激活整批解 mute），已解锁 session 走 Handoff Gate（单 target 激活即解 mute）。
- 修复跨段边界约 1s 掉声。
- **仍残留**：seek/drag/pause-resume 后仍频繁无声；音视频同播偶发视频卡住但音频继续。

---

## 4. 当前剩余问题（用户最新一轮真机验收）

1. **纯 MP3 切开后，拖动播放头到开头/中间/跨段边界，再点播放 → 经常无声**。
2. **暂停 → 再开始**：有时掉声；有时视频卡住但音频有声；有时音频有声但视频不动。
3. **音视频同播**：有时正常，有时 MP4 画面卡住但 MP3 继续有声。
4. **纯 MP3 首次播放**：仍可能无声（比 v1.2 前略有改善，但不稳定）。
5. **拉长 split 片段声音异常**（此为数据模型层 bug，归未来 C/D，本次不解决但需记住）。

---

## 5. 根因假设（v1.3 后，待 GPT 验证）

我们判断问题已从"音视频两套逻辑"收敛为以下三点，全部在 B.5 范围内可修：

### 假设 1：静音状态所有权分散，多个地方在写 `muted`

当前至少 5 处会修改 `el.muted`：
- `seekActiveMediaToPlayhead()` line ~2072（活动视频恢复 muted）
- `seekActiveMediaToPlayhead()` line ~2080（活动音频恢复 muted）
- `_playWhenReady()` line ~1391（强制 `el.muted = true`）
- `_restoreSession()` line ~1492（整批解 mute）
- `_setActivation()` Handoff Gate line ~1460（单 target 解 mute）
- `pause()` 中不直接设 muted，但 `seekActiveMediaToPlayhead` 对非命中元素 `a.muted=true`
- `setGlobalMute()` / 轨道静音切换

这导致 seek 后、play 前、play 中，mute 状态反复横跳。如果 activation 信号稍有延迟，元素可能卡在 `_playWhenReady` 设置的 `muted=true` 状态，等 1000ms timeout 才解（或一直卡）。

### 假设 2：`startPlay()` 在用户手势内调 `unlockAudio()`，但真正的 `play()` 被两个 `await` 甩到手势之外

`startPlay()` 流程：
```
unlockAudio()           // 手势内
await 等媒体 ready
await 等 seek 落位
playAllMedia()          // 实际 el.play() —— 此时手势可能已过期
```

WebView2/CEF 的自动播放策略要求 `play()` 调用必须发生在用户手势处理栈内。两个 `await` 后，手势上下文通常已经消失，`<audio>.play()` 被静默拒绝。`video.play()` 因为浏览器优化/策略差异，有时仍能过。

### 假设 3：seek 被调了多次，和 play 竞态

`renderPreview()` 音频区会设 `oncanplay → PlayerManager.seek`（异步 seek 一次）。
`startPlay()` 又调用 `seekActiveMediaToPlayhead()`（再 seek 一次）。
如果用户在播放中拖动播放头，`seekActiveMediaToPlayhead()` 先 seek，然后 `playAllMedia()` 再 play。
多次 seek + play 重叠，导致 `currentTime` 不一致、`seeked` 事件乱序、activation 信号不来。

### 为什么偏偏音频更惨

- `video` 有画面作为"已激活"的强反馈，且浏览器对 video 的 autoplay 解锁更宽松。
- `audio` 没有画面，无法直观判断，且 WebView2 对 `<audio>` 的自动播放策略更严。
- 音频跨段时元素被复用（同一条音轨一个 `<audio>`），src 不变但 seek 位置变，容易在"还没 seek 好就 play"时出错。

---

## 6. 需要 GPT 分析 / 回答的问题（请一轮内给结论 + 代码位置）

1. **验证假设**：上述"mute 所有权分散 + startPlay 丢失手势 + seek/play 竞态"三元假设是否成立？有没有遗漏？

2. **最小修复方案（核心）**：
   - 是否应该让 `startPlay()` **在 click 手势内同步调用 `playAllMedia()`**（在 `await` 之前），让 `el.play()` 发生在手势栈里？元素可先 muted，等 Activation Gate 就绪/seek 完成后再解 mute。
   - 如果是，具体怎么写？需要保证：不会在 seek 完成前漏出可听声音、不会 AbortError 泛滥、不会破坏现有 `_attemptPlay` 的预 ready gate。
   - 如果不是，给出替代方案。

3. **静音状态统一**：
   - 是否应该禁止 `seekActiveMediaToPlayhead()` 恢复 `muted`（删除 line ~2072 和 ~2080 的 `v.muted=...`、`a.muted=...`）？让 mute 决策完全归 `PlayerManager`（`_restoreSession` / `_setActivation` Handoff Gate）。
   - 这样改动后，对轨道静音/全局静音切换有无副作用？

4. **AudioContext 方案**：
   - 当前只 `audioCtx.resume()`。如果仍不够，是否应该将 `<audio>` 接到 `AudioContext` graph（`MediaElementSourceNode → destination`）？这在 WebView2 下是否能绕过自动播放限制？给出接线代码和放置位置。
   - 注意：我们只接受"解锁钥匙"级别的改动，不要引入 gain/latency/混音。

5. **跨段/暂停恢复**：
   - 用户 pause → resume 时，`startPlay()` 会重新走 await 流程。是否应该识别"同一 session 恢复"，走类似 HANDOFF 的路径（复用 session、不重建），避免重新过一遍手势/激活门？

6. **路线确认**：是否同意**不重写播放器、继续在 B.5 内修**？

---

## 7. 约束与纪律（防止 GPT 跑偏）

- **不要推倒重写播放器**。代码已是 Timeline-Clock 驱动，重写会丢进度。
- **严格串行路线**：A → B → B.5 → C → D。当前在 B.5 验收阶段，不要跳去 C/D。
- **B 红线**：`start()` 内不得再出现裸 `play()` 补丁；恢复逻辑统一走 `_scheduleRecover`/`continueStart`。
- **AudioContext 只做解锁钥匙**，不要接管音频流处理（超出范围）。
- **不碰根目录那 7 个违规文件**（CODEX_BRIEF / HANDOFF_CODEBUDDY / P0重构实施计划v2 / 剪辑工具_开发待办 / 项目交接状态_给新GPT / 架构地图_当前与OpenCut对应.html / ai-video-studio_public.zip），它们不进 git，是历史遗留，不要基于它们分析。
- 改完代码后必须 `node --check` 语法校验（抽内联 `<script>` 到临时 js 再校验）。

---

## 8. 如何复现 / 验收

**复现（必做）**：
1. 启动 `start.bat`，导入一个 MP3，点播放 → 应播放头走动 + 有声。
2. 把 MP3 split 成两段，拖动播放头到：段首 / 段中 / 跨段边界，再点播放 → 均应出声。
3. 播放中暂停，再点播放 → 均应出声，画面不卡。
4. 加一个 MP4 同播 → 音视频同步出声，画面不卡。
5. 在音视频同播时暂停 → 再播放 → 均正常。

**验收通过标准**：以上 5 条全过，且控制台跨段日志体现 `reason=handoff`；无大量 `TIMEOUT_DEGRADED`；seek/drag/pause-resume 后稳定有声。

**关键源码锚点（行号会漂移，用 grep 定位）**：
- `function startPlay` —— 播放入口（含 `unlockAudio` / awaits / `playAllMedia`）。
- `PlayerManager.play` / `PlayerManager._handoff` —— session 生命周期与跨段交接。
- `PlayerManager._attemptPlay` / `PlayerManager._playWhenReady` —— 媒体起播 + 激活信号 + `el.muted=true`。
- `PlayerManager._setActivation` / `_checkAllActivated` / `_restoreSession` —— Activation Gate / Handoff Gate。
- `seekActiveMediaToPlayhead` —— 其中有 `v.muted = ...` 和 `a.muted = ...` 两处恢复 muted 的逻辑。
- `playTick` / `PlayerManager.handleCrossSegment` / `_handleCrossSegment` —— 播放头推进与跨段调度。
- `MEDIA_ACTIVATION_STATE` / `MEDIA_ACTIVATION_TIMEOUT` / `_PLAY_REASON` —— 相关常量。

---

*本文件是 B.5 音频排查的调试回溯，供外部 GPT 接手分析用。配套干净源码已用 `git archive` 打包为 ZIP。*
