# GPT 播放问题 v2 交接文档（截止 2026-08-15 17:10）

> **目的**：把整个播放器从 v1.0 到 v1.1 的迭代、每次改动、每次根因、当前实测结果、代码结构、已试/已否方案、需 GPT 评审问题，一次性打包给 GPT 评审。GPT 额度快没了，请一次给完整结论。
> **项目**：AI 剪辑工作台（桌面端，PyWebView + pyJianYingDraft）。本交接只涉播放路径（HTML 内），不涉后端 / MCP / 导出。
> **纪律**：不动渲染路径（renderPreview / _setVisualContent / _setTextContent / pool-create / release）；不动 MCP/pyJianYingDraft/list-of-list 模型；不改根目录 7 个违规诊断文件（用户禁止）。

---

## 1. 当前实测结果（v1.1，用户刚真机）

| 场景 | 操作 | 结果 |
|------|------|------|
| ① 首播纯 MP3 | 拖入 MP3 → 点 ▶ | ✅ **有声音**（v1.1 修复成功） |
| ② MP3 split 两段后从头播 | 切两段 → 播放头放回开头 → ▶ | ❌ **全部无声**（第一段有声，第二段无声；播完第一段后第二段没声） |
| ③ MP4 首播 | 拖入 MP4 → 点 ▶ | ❌ **卡住、无声**（画面在某一帧不动、没声音） |
| ④ MP4 换轨道播 | 主场景 MP4 → 换到音轨1 → ▶ | ❌ **同上，卡住** |

**v1.1 留住**：纯 MP3 首播已恢复。
**v1.1 没解决**：跨段第二段无声 / 从头重播无声 / MP4 卡住。

---

## 2. 迭代时间线（v1.0 → v1.1）

### v1.0（2026-08-13 之前）
- 散落模式：媒体元素被 ~11 处直接碰（play/pause/muted/currentTime/src/load），3 处状态源（isPlaying + 6 标志位）。
- 用户决定走架构收口路线：**PlayerManager facade-first 收口 + PlaySession 状态层 + 媒体激活门**。

### v1.1（2026-08-15 上午爆破，commit `bbb7979`）
- **改动**：Media Activation Contract v1.1
  - `_PLAY_REASON` 事务枚举（START/RECOVER/HANDOFF）替代 handoff 布尔
  - `_attemptPlay` 是唯一 `el.play()` 出口
  - `_setActivation` 分流 Session Gate（冷启动整批解 mute）vs Handoff Gate（单元素增量解 mute）
  - 跨段走 `_handoff` 复用 session，不 cancel+createSession、不重静音全体
- **效果**：跨段纯音频不再每段重建 session、每段 1s 静音。

### v1.3（2026-08-15 16:10，commit `2891596`）
- 用户真机测出残留：拖动/暂停恢复/跨段第二段仍有无声。
- v1.3 文档已发 GPT 一轮（无明确结论，因额度紧）。

### v1.4（2026-08-15 17:00，commit `5f1d79b` + `28346e4`）
- **B.5.4 Media Lifecycle Ownership 收口**：
  - `setMediaMute(el,value,reason,label)` 唯一 muted 写者（11 处裸写收口）
  - 删 `seekActiveMediaToPlayhead` / drift 的 active-restore 写 muted（保留 inactive-park 失活停车静音）
  - 新增 `primeMediaPlayback` 手势内预热
  - 新增 `MEDIA_TARGET_STATE` 显式化日志（不反向控制行为）
  - `PlayerManager.resume()` 复用 PAUSED session
- **v1.4 第一次真机（17:00）**：纯 MP3 / 纯 MP4 首播全部回归（比 v1.3 还糟）。
- **根因实锤**：`primeMediaPlayback` 对**真实元素**做 `play()+pause()` 且未 `await` → 与主流程 `_attemptPlay` 竞态 → 元素被 prime 的 pause 暂停 → 卡死/无声。
- **v1.4.1 修复（commit `5f1d79b`）**：
  1. `primeMediaPlayback` 改用**临时隐藏 `<audio>`**（动态生成 0.2s 静音 WAV Blob URL）拿文档级 autoplay 权限，绝不碰真实元素。
  2. `startPlay` 里 `await primeMediaPlayback(hits)`。
  3. `resume()` 里 `autoplayUnlockPending` 由 `false` 改回 `true`（恢复也走 Session 门），去掉提前 `_cleanupAllActivation`。
- **v1.4.1 第二次真机（17:10）**：
  - ✅ 纯 MP3 首播有声
  - ❌ MP3 split 第二段无声；从头重播全部无声
  - ❌ MP4 还是卡住、无声

---

## 3. 当前 v1.4.1 残留问题（v1.4 没修干净）

### 问题 A：MP3 split 第二段无声
- **现象**：一轨 MP3 切成两段，从头播 → 第一段有声，第二段无。
- **可能根因**：
  - 跨段 `_handleCrossSegment` → `playAllMedia(HANDOFF)` → `_handoff` → `_attemptPlay`
  - 音频元素是同轨复用（`previewState.audioEls` 一轨一个 `<audio>`），split 后 src 变了（如果两段是同一文件则 src 不变 → 走 else 分支只 seek）
  - `_attemptPlay` 对 paused=true 元素走 `_playWhenReady` → 绑 playing/canplaythrough 等事件
  - 如果 WebView2 `<audio>` 在跨段 seek 后不 fire `playing`，只 fire `canplaythrough`/`loadeddata` → 应走 READY_FALLBACK 激活门 → 解 mute
  - 但用户报告没声，**可能**：激活门未触发 / `t.want` 错了 / `el.play()` 拒绝但没走 recover
- **关键代码点**：
  - `_handleCrossSegment` (2214)：crossSegmentPending + seeked + HANDOFF
  - `_attemptPlay` (1367)：`!el.paused` 早返守卫 + `_playWhenReady` (1406)
  - `_playWhenReady` 内部的 `el.play()` 与 `setMediaMute(el,true,"play-mute",t.key)`
  - `_setActivation` (1458)：autoplayUnlockPending 分流

### 问题 B：MP3 从头重播全部无声
- **现象**：播完或中断后，拖播放头到开头 → ▶ → 全部无声。
- **可能根因**：
  - `startPlay` 走 `playAllMedia(START)` → 冷启动 cancel 旧 session + createSession + start → `_attemptPlay`
  - 元素 paused=true（之前被 pause），走 `_playWhenReady`
  - 元素 src 不变（同 clip），但 `await _waitMediaReady` + `seekActiveMediaToPlayhead(0)` + `_waitSeekSettled` 后调 `play()`
  - 可能 WebView2 下 audio 元素在 repeated play/seek 后进入"被中断"或 stuck 状态
  - 也可能 `_setActivation` 解 mute 那一行 `setMediaMute(t.el, !(t.want && !previewMuted), "activation-restore", t.key)`（1515）走 Session Gate 解 mute，但因某原因 t.want=false
- **关键代码点**：
  - `startPlay` (2067)：`await primeMediaPlayback` → `_waitMediaReady` → `seekActiveMediaToPlayhead` → `_waitSeekSettled` → `playAllMedia`
  - `seekActiveMediaToPlayhead` (2158)：对每个命中元素调 `PlayerManager.seek`
  - 创建 session 时的 `want` 来自 `wantSound(type, ti)`（可能与轨道静音状态有关）

### 问题 C：MP4 卡住、无声
- **现象**：MP4 拖入 → 点 ▶ → 画面卡在某一帧不动、无声。
- **可能根因**：
  - **与 v1.4 同样的 audio 元素 race**：但截图全是单视频轨，无音频在轨？
  - 仔细看图3：似乎只有视频轨（主场景）+ 没音频轨。MP4 自身音频呢？
  - `_setVisualContent` 创建 `<video>` 元素，`autoplay` / 静音由 `muted` 参数控制
  - 视频元素被复用，同一时间只有一个 `<video>` 元素
  - 可能 `_attemptPlay` 的 `!el.paused` 早返：元素其实 paused=true，尝试 play() 但 WebView2 没响应
  - 视频元素 src 加载可能未完成 → `_waitMediaReady` 等 canplay → 5s 总超时 → 进入 `_playWhenReady` → play() → 激活门
  - 激活门 `_checkAllActivated` → `_restoreSession` → 解 mute
  - 但 `_playWhenReady` 内 `setMediaMute(el,true,"play-mute",t.key)` 先把视频 muted=true。如果激活门永远不触发，video 一直 muted。
- **关键代码点**：
  - `_setVisualContent` (1679)：创建 `<video>` 并设 `setMediaMute(v, !!muted || previewMuted, "render-visual", path)`
  - `_attemptPlay` → `_playWhenReady` (1406)：`setMediaMute(el,true,"play-mute",t.key)` + `el.play()`
  - 画面卡住 = `<video>` 元素被 `play()` 调用但 DOM 帧没推进，原因可能是 video 没真的 playing（playing 事件未 fire）

---

## 4. 当前代码架构关键点（v1.4.1）

### 4.1 媒体生命周期所有权
- **Mute 所有权**：`setMediaMute(el, value, reason, label)`（1213）唯一写者，reason 标注来源。
- **媒体创建**：`PlayerManager._createElement`（1269）唯一 `createElement('video'/'audio')` 入口。
- **媒体激活门**：`MEDIA_ACTIVATION_STATE`（1185）枚举 + `_attemptPlay`/`_playWhenReady`/`_setActivation`（1367/1406/1458）。
- **Session 状态机**：`PLAY_SESSION_STATE` 8 态 + `_PLAY_REASON` 事务枚举（START/RECOVER/HANDOFF/RESUME）。

### 4.2 播放路径关键函数
| 函数 | 行号 | 作用 |
|------|------|------|
| `togglePlay` | 2043 | 入口：PAUSED→resume；否则→startPlay |
| `startPlay` | 2067 | 冷启动：unlockAudio → renderPreview → await primeMediaPlayback → waitReady → seek → playAllMedia → playTick |
| `primeMediaPlayback` | 2071 | **临时隐藏 `<audio>` 拿文档级 autoplay 权限**（v1.4.1 修正） |
| `pausePlay` | 2098 | `PlayerManager.pause` 包装 |
| `PlayerManager.play` | 1285 | 选 targets → 冷启动/跨段分发 |
| `PlayerManager.start` | 1331 | 编排 `_attemptPlay` 串 |
| `PlayerManager._handoff` | 1353 | **跨段交接**（不重建 session，增量 `_attemptPlay` + target diff 日志） |
| `PlayerManager._attemptPlay` | 1367 | 唯一 `el.play()` 入口；`!el.paused` 早返守卫 |
| `PlayerManager._playWhenReady` | 1406 | pre-ready gate + mute + play + 绑事件 + timer |
| `PlayerManager._setActivation` | 1458 | Session Gate / Handoff Gate 分流 |
| `PlayerManager._restoreSession` | 1510 | 整批解 mute |
| `PlayerManager.resume` | 1583 | 复用 PAUSED session（v1.4.1 修正 autoplayUnlockPending=true） |
| `playTick` | 2239 | 墙钟 master + 跨段 `handleCrossSegment` + drift 纠偏 |
| `_handleCrossSegment` | 2214 | 跨段：seek → wait → `playAllMedia(HANDOFF)` |
| `_waitMediaReady` | 1753 | 等 canplay/canplaythrough/error，3s 超时放行 |
| `seekActiveMediaToPlayhead` | 2158 | 对活跃 element 调 `PlayerManager.seek`；非活跃 `pause + setMediaMute(true,"inactive-park")` |
| `PlayerManager.seek` | 1647 | timeline→source 换算 + `el.currentTime = t` |
| `unlockAudio` | 1101 | `audioCtx.resume()`（仅 Web Audio 解锁，不解 `<video>`/`<audio>` autoplay） |

### 4.3 渲染路径（v1.4.1 不碰）
- `renderPreview` (1844)：重建元素 + 维护 `previewState.visualEls/audioEls`
- `_setVisualContent` (1679)：`<video>` 元素管理（dataset.muted 缓存）
- `_setAudioContent` (1998-2023 等价)：`<audio>` 元素管理（src 变化时走 oncanplay 异步 seek）
- `pool-create` / `release` / `reload` 路径

### 4.4 关键去抖/防扰
- `playAllMedia` 250ms 防抖（1287）
- `_playWhenReady` 1s 激活超时（MEDIA_ACTIVATION_TIMEOUT）
- crossSegmentPending 抑制 drift（修 Bug A）

---

## 5. 已试 / 已否方案

| 方案 | 结果 | 备注 |
|------|------|------|
| `primeMediaPlayback` 用真实元素 + 未 await | ❌ v1.4 回归 | 现已改临时元素 |
| `primeMediaPlayback` 用真实元素 + await 在主流程前 | ⚠️ 未实测 | 担心 play+pause 仍污染元素 |
| `primeMediaPlayback` 用临时隐藏 `<audio>` + 0.2s 静音 WAV Blob | ✅ v1.4.1 通过（首播 MP3） | 但未解决跨段/重播/MP4 |
| `resume` 复用 PAUSED session + autoplayUnlockPending=false | ❌ 跳过 Session 门、元素卡 WAITING | v1.4.1 改回 true |
| `resume` 提前 `_cleanupAllActivation` | ❌ 移除激活监听 | v1.4.1 去掉 |
| 删 seek active-restore 写 muted（保留 inactive-park） | ✅ 解决双写 | v1.4 保留 |
| `setMediaMute` 统一包装 | ✅ 解决 muted 所有权分散 | v1.4 保留 |
| **跨段第二段有声** | ❌ 未解决 | 见问题 A |
| **从头重播有声** | ❌ 未解决 | 见问题 B |
| **MP4 不卡** | ❌ 未解决 | 见问题 C |

---

## 6. 给 GPT 的评审问题（收敛核心）

请按优先级回答，**不要扩展路线**。

### Q1（核心，v1.4.1 三个残留问题根因）
请从源码（HTML 内所有函数，行号见 §4.2）定位：
- **问题 A**（MP3 split 第二段无声）：跨段 `_handleCrossSegment` → `_handoff` → `_attemptPlay` → `_playWhenReady` 路径上，**为什么第二段无声**？是 playing 事件未 fire？激活门未触发？`t.want` 错？`el.play()` 拒绝但未走 recover？
- **问题 B**（MP3 从头重播全部无声）：`startPlay` 冷启动路径上，**为什么重播无声**？是 `_waitMediaReady` 提前放行导致 seek 静默失败？还是 `_playWhenReady` 内 `el.play()` 拒绝？还是激活门解 mute 失败？
- **问题 C**（MP4 卡住、无声）：视频元素`<video>`路径上，**为什么 play 没真正让画面推进**？是 `<video>` 元素在 PyWebView/WebView2 下的特殊行为？`_attemptPlay` 早返守卫误判？还是激活门永远不触发？

### Q2（结构）
- 三个问题的根因是同一类（同源）还是三类（不同）？如果是三类，能否收敛成 1-2 个修复？
- 修复的最小改动是什么？是否仍在「播放路径」内（不碰渲染路径）？

### Q3（参考）
- WebView2 / `<video>`/`<audio>` 在 PyWebView 下的 autoplay / play 行为有什么已知坑？尤其 `play()` 被 `seek()` 中断、replay 同元素等场景。
- OpenCut 或其他 PyWebView 内嵌视频编辑器的播放路径实现，可参考什么？

### Q4（架构）
- 是否应该把"audio 元素复用 vs 重建"作为单独决策点？目前一轨一元素的复用策略在跨段和重播时是否已到极限？
- `_attemptPlay` 的 `!el.paused` 早返守卫，在 WebView2 下是否容易误判（audio 元素 paused 状态不稳定）？

### Q5（验证）
- 给出 3 个真机验收用例（控制台日志关键 grep），能区分这三个问题是否同源、是否都修复。

---

## 7. 约束纪律（不可破坏）

1. **不重写播放器**：不允许提议把 PlayerManager 整个推翻，从零写。
2. **不碰渲染路径**：`renderPreview` / `_setVisualContent` / `_setAudioContent` / pool-create / release 一律不碰。
3. **不碰 MCP/pyJianYingDraft/list-of-list 数据模型**。
4. **不动根目录 7 个违规诊断文件**（CODEX_BRIEF.md / HANDOFF_CODEBUDDY.md / P0重构实施计划v2.md / 剪辑工具_开发待办.md / 项目交接状态_给新GPT.md / ai-video-studio_public.zip / 架构地图_当前与OpenCut对应.html）。
5. **修复的最小改动原则**：v1.4.1 已稳定部分（首播 MP3）不可回归。
6. **B.5.4 收口三原则保留**：Session owns transaction / Segment switching=handoff / Activation belongs to MediaTarget。

---

## 8. 真机复现 / 验收清单

**前提**：用 `start.bat` 重开 PyWebView → 等待 v1.4.1 加载（仓库 HEAD = `5f1d79b` + `28346e4`）。

| 场景 | 操作 | 期望 | 现状 |
|------|------|------|------|
| ① 首播纯 MP3 | 拖入 MP3 → ▶ | 有声 | ✅ |
| ② MP3 split 两段从头播 | 切两段 → 头 → ▶ | 两段都声 | ❌ 第二段无 |
| ③ MP3 从头重播 | 播完/中断 → 头 → ▶ | 有声 | ❌ 全无 |
| ④ MP4 首播 | 拖入 MP4 → ▶ | 画面动+有声 | ❌ 卡住+无 |
| ⑤ MP4 换轨道 | 主场景 → 音轨1 → ▶ | 画面动+有声 | ❌ 卡住 |
| ⑥ 跨段音视频 | video+audio 跨段 | 段切换无缝 | ⚠️ 未测 |
| ⑦ 拖动播放头 | 拖头 → ▶ | 指定位置播 | ⚠️ 未测 |
| ⑧ 暂停恢复 | 暂停 → ▶ | 原位置继续 | ⚠️ v1.4.1 改动未测 |

**控制台关键 grep**：
- `[MUTE]` 每个 muted 变化都有 reason
- `[PlaySession]` session 状态机
- `[target diff]` 跨段 target 变化
- `[activation] state=` 激活门状态
- `NotAllowedError` / `AbortError` play 拒绝

---

## 9. 源码打包

- 本次提交：`5f1d79b`（代码修复）+ `28346e4`（设计稿更新）
- 源码 ZIP：`git archive HEAD` → `C:\Users\34450\Desktop\ai-video-studio源码_20260815_v1.4.zip`
- 仅含 git 跟踪文件（自动排除 .venv / assets / 违规文件 / .git）

---

## 10. 关键源码锚点（行号速查）

```
1101  unlockAudio()                              仅 Web Audio 解锁
1185  MEDIA_ACTIVATION_STATE                    激活门状态枚举
1195  _PLAY_REASON                              事务枚举 (START/RECOVER/HANDOFF/RESUME)
1203  MEDIA_TARGET_STATE                        target 生命周期枚举（仅日志）
1213  setMediaMute()                             唯一 muted 写者
1269  PlayerManager._createElement()            唯一 media 元素创建入口
1285  PlayerManager.play(reason)                 播放入口（START/RECOVER/HANDOFF）
1331  PlayerManager.start(session)              编排 _attemptPlay
1339  PlayerManager.continueStart(session)      复用启动序列（不重写）
1353  PlayerManager._handoff(session, targets)  跨段交接（不重建 session）
1367  PlayerManager._attemptPlay(session, t)    唯一 el.play() 入口
1406  PlayerManager._playWhenReady(session, t)  pre-ready gate + mute + play
1458  PlayerManager._setActivation(...)         Session Gate / Handoff Gate 分流
1510  PlayerManager._restoreSession(session)    整批解 mute
1563  PlayerManager.pause()                     暂停（state=PAUSED，不 CANCELLED）
1583  PlayerManager.resume(reason)              v1.4.1 修正：复用 PAUSED session + autoplayUnlockPending=true
1647  PlayerManager.seek(el, seg, us)           timeline→source 换算
1679  _setVisualContent()                       <video> 元素管理（渲染路径，不动）
1753  _waitMediaReady(el)                       等 canplay 3s 超时
1776  _tryReloadMedia()                         error 恢复
2055  _silentPrimeUrl / _getSilentPrimeUrl()    v1.4.1 临时静音 WAV 生成
2071  primeMediaPlayback(hits)                  v1.4.1 临时 <audio> 拿权限
2067  startPlay()                               冷启动
2107  playAllMedia(reason)                      PlayerManager.play 包装
2239  playTick()                                墙钟 master + 跨段入口
2214  _handleCrossSegment(us)                   跨段：seek→wait→playAllMedia(HANDOFF)
2158  seekActiveMediaToPlayhead(us)             活跃 seek + 非活跃 inactive-park
2043  togglePlay()                              入口：PAUSED→resume / 否则→startPlay
```

---

## 11. 提交记录

```
e62c6af  Step B.5.4 Media Lifecycle Ownership 收口（v1.4 原版，有 bug）
28346e4  docs(B.5.4): 设计稿补 v1.1 真机回归修正章节
5f1d79b  fix(B.5.4): primeMediaPlayback 临时元素 + resume Session 门（v1.4.1，本次状态）
2891596  docs/handoff: 更新 GPT 音频问题交接文档至 v1.3
bbb7979  Step B.5 Media Activation Contract v1.1
bb9a764  docs/handoff: 新增 GPT 音频问题交接文档
f6ce6ed  Step B.5 v1.2 音频专项：解锁 WebView2 <audio>
ed02a20  Step B.5 v1.1 热修：预 ready gate
```

---

## 12. 一句话请求 GPT

**v1.4.1 守住"首播 MP3"，但 split 第二段 / 从头重播 / MP4 全坏。请从源码定位这三个问题的根因（可同源可不同），给出最小改动修复方案（仍在播放路径内），并给出 3 个控制台 grep 验收用例。**

谢谢。
