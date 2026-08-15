# OpenCut vs 我们：全面架构对比审计（2026-08-15 19:55）

> 目的：回答"为什么 OpenCut 能把功能做好、而我们一直在修 bug"。
> 方法：读 OpenCut classic 源码（reference/opencut-classic）+ 对照我们 3 个文件（工作台v0.8时间轴.html / main.py / mcp_server.py）。
> 结论先行：**不是我们能力差，是我们在"单文件平铺 + 无 Command 边界 + 播放器元素模式"的结构上做最复杂的部分，状态互相污染；OpenCut 用"分层单向依赖 + 一切修改走 Command + 播放与数据解耦"把同样复杂度拆开了。**

---

## 0. 规模对比（第一印象）

| 维度 | OpenCut（apps/web/src） | 我们 |
|------|------------------------|------|
| 代码组织 | **几十个 TS 文件**，12 个 Manager，按领域分目录 | **单 HTML 3988 行**（299 个函数平铺）+ main.py 3767 行 |
| 核心对象 | `EditorCore` 组装 12 个 Manager（单向依赖） | `PlayerManager` 一个对象承担播放/创建/seek/错误/reload |
| 修改通道 | 一切走 `CommandManager.execute(command)` | 每个操作直接改 `draft`（`_push_undo` 深拷贝压栈） |
| undo/redo | Command 栈（execute/undo/redo 各自实现） | 快照栈（每次深拷贝整个 draft） |
| 状态来源 | SceneTracks（纯数据），UI/播放/渲染都订阅它 | draft_state（数据），但 DOM/元素与它同步靠手工 |

---

## 1. 分层架构：OpenCut 拆开，我们平铺

### OpenCut（core/index.ts 实锤）
```
EditorCore
 ├─ CommandManager    一切修改的唯一入口（undo/redo/ripple/reactors）
 ├─ TimelineManager   时间轴数据 + 操作（全部转成 Command）
 ├─ PlaybackManager   纯墙钟时钟（不碰媒体）
 ├─ MediaManager      素材 Asset 管理（持久化 + 缓存）
 ├─ ScenesManager     场景/轨道容器
 ├─ ProjectManager    项目设置
 ├─ RendererManager   渲染/导出
 ├─ AudioManager      Web Audio 调度
 ├─ SelectionManager  UI 选择
 ├─ ClipboardManager  复制粘贴
 ├─ SaveManager       保存
 └─ DiagnosticsManager 诊断
```
**依赖方向**：UI → Command → Manager → 纯数据。Manager 之间单向，不互相乱碰。

### 我们
```
单 HTML：
  PlayerManager（播放/创建/seek/错误/reload/mute）
  playTick / renderPreview / seekActiveMediaToPlayhead / correctActiveMediaDrift / _handleCrossSegment ...
main.py：
  Api（300+ 方法，每个直接改 draft）
mcp_server.py：薄代理
```
**问题**：299 个函数平铺在一个文件，播放逻辑（playTick/drift/seek）、渲染（renderPreview）、数据修改（main.py）**没有清晰的层边界**，互相靠"记得别乱碰"维护。

---

## 2. 修改通道：OpenCut 用 Command，我们直接改状态（核心差距）

### OpenCut（commands.ts 实锤）
```ts
class SplitElementsCommand extends Command {
  execute() { /* 算左半+右半，改 SceneTracks */ }
  undo() { /* 还原 savedState */ }
}
// CommandManager.execute():
//   command.execute() → ripple → selection override → reactors → push history
```
**每个操作是独立 Command 对象**，可 undo/redo、可 ripple、执行后有统一的 reactor 通知订阅者。**修改和撤销是同一份代码的两个方法**——不可能"改了但撤销不了"。

### 我们（main.py 实锤）
```python
def _push_undo(self):
    Api.undo_stack.append(copy.deepcopy(self.draft))   # 操作前深拷贝整个 draft
```
**快照式 undo**：每个操作前深拷贝整个草稿压栈。缺点：
- 大草稿时内存/性能压力（每次操作全量深拷贝）
- **无 Command 边界** → 操作 A 改了 draft 但忘了压栈 → undo 不到；或操作 B 压栈了但改了别处 → undo 还原出意外状态
- 前端播放状态（isPlaying/mediaClockReady）**不进快照** → undo 后播放状态与数据不同步（这可能是我们"撤销后播放异常"的根源之一）

---

## 3. 播放架构：OpenCut 绕开元素模式，我们被困在元素模式

| | OpenCut | 我们 |
|--|---------|------|
| 时钟 | PlaybackManager 纯墙钟 RAF（**完全不碰媒体**） | playTick 墙钟 + correctActiveMediaDrift（drift 碰媒体 seek） |
| 音频 | Web Audio（decodeAudioData → BufferSourceNode.start(精确时间戳)） | `<audio>` 元素 play/pause/seek |
| 画面 | canvas 逐帧渲染（video 元素只解码） | `<video>` 元素内嵌播放 |
| 跨段 | lookahead 调度（每 500ms 扫未来 2s，到点自动起播） | `_handleCrossSegment`（seek → handoff） |
| 状态同步 | 订阅播放时钟，各自响应 | 手工 await/回调链 |

**为什么 OpenCut 稳**：它根本不和"浏览器媒体元素播放状态机"搏斗——音频用确定性调度（`start(when, offset)` 采样级精确），画面用 canvas 每帧画。**元素只当解码器，不是播放引擎**。

**为什么我们修不完**：`<audio>/<video>` 的 `play()/pause()/seek()/playing 事件` 在 WebView2 下本身就不稳定（autoplay 策略、playing 不 fire、playing 态设 currentTime 无效、复用元素状态残留）。**B.5~B.5.5 全程在给这条不稳定的路打补丁**——而 OpenCut 根本不走这条路。

**我们已验证的元素模式事实**（这两天日志实锤）：
- ✅ 播放头墙钟 master（OpenCut 同思路）——对
- ✅ 首播 MP3 能出声（paused→seek→play 顺序对时）
- ❌ 跨段无声（playing 态设 currentTime 被 WebView2 吞）
- ❌ MP4 跨段卡住（同因）
- ❌ "咚咚咚"（我们自己的 seekBarrier pause/play 每帧重启）

---

## 4. 素材模型：OpenCut 严格分离，我们方向对但未收口

### OpenCut（media-manager + split-elements 实锤）
```
MediaAsset（素材库：id/url/thumbnail，独立持久化）
     ↑ 引用
TimelineElement（时间轴：startTime + duration = 时间轴窗口；
                            trimStart + trimEnd = 源素材窗口；
                            material_id 引用 Asset）
```
**split 是纯数据操作**（split-elements.ts 实锤）：
- `leftVisibleDuration = splitTime - startTime`
- **snap-once**：`leftSourceSpan` 只算一次，`rightSourceSpan = totalSourceSpan - leftSourceSpan`，保证 `左源窗口 + 右源窗口 == 总源窗口` 不变量
- `leftTrimEnd = trimEnd + rightSourceSpan`；`rightTrimStart = trimStart + leftSourceSpan`
- **不碰任何媒体元素**，只改数据

### 我们（SCHEMA.md 实锤）
```
segment = { start, duration, src_start, src_end, material_id, path, ... }
```
**好消息**：方向对——`src_start/src_end`（源窗口）+ `start/duration`（时间轴窗口）+ `material_id`（素材引用）都有。
**差距**：
- segment 直接带 `path`（素材库与时间轴耦合，改素材路径要同步全量 segment）
- **split 时 src_start/src_end 是否遵守 snap-once 不变量未验证**（用户提过"拉长切开片段声音异常"——可能正是 `leftSourceSpan + rightSourceSpan != totalSourceSpan`）
- 媒体元素与 segment 的同步靠手工（renderPreview/seekActiveMediaToPlayhead 每个调用点各自算，我们这 2 天就在补这个）

---

## 5. 我们到底缺什么（按 OpenCut 对齐，分级）

### 必须有（否则"一直修 bug"）
1. **Command 层**：每个操作（split/trim/move/delete）封装成 {apply, undo}，前端和后端同走；undo/redo 由 CommandManager 统一管。**这是 OpenCut 最核心的稳定器**——所有修改可回滚、可审计、边界清晰。
2. **播放与数据解耦**：playTick 纯墙钟（已有）+ **媒体 seek 走单一换算函数**（timelineToSource/sourceToTimeline，禁止各调用点自算）——我们 8-13 就立了这条铁律，但这两天又滑回散落。
3. **Asset 与 Element 分离**：materials 独立维护（路径/时长/缩略图），segment 只存 material_id 引用，不直接带 path。

### 建议有（影响稳定性）
4. **单文件拆分**：HTML 3988 行拆成 player.js / timeline.js / renderer.js / store.js（同一 runtime 的多个 JS，不必 React）。上下文爆炸是"改 A 坏 B"的温床。
5. **项目保存/打开**：OpenCut 有 ProjectManager + SaveManager；我们 draft_state.json 单文件，无项目级组织。

### 以后再做（OpenCut 也有的，但我们不急）
6. canvas 渲染、Web Audio 调度（**播放器跨段问题的最终解，但非现在**）、Rust wasm

---

## 6. 为什么"OpenCut 能做那么好"而我们修不完（一句话答案）

**OpenCut 把"改数据"和"播放/渲染"拆成两个世界，中间用 Command + 订阅隔离；我们把它们塞进一个文件、一个 PlayerManager、一套手工同步——于是每个 bug 都牵一发动全身，修 A 坏 B。**

我们的数据模型（SCHEMA）方向没错、MCP 层也在、墙钟思想也对——**缺的是"分层纪律"本身**，不是任何单个功能。

---

## 7. 立即止损建议（不等 GPT 施工图也能做）

1. **冻结播放器**（Phase 0 已经该生效）——跨段无声丢后置
2. **优先做 Command 层**（最小：给 main.py 的写操作统一套 {apply, undo}，前端调用不变）
3. **Asset 分离**（materials 抽出来，segment 去 path 化）
4. 之后才回播放器（或直接 AudioEngine 迁 Web Audio，一劳永逸）

---

## 8. 参考：OpenCut 关键文件速查

```
apps/web/src/core/index.ts                  EditorCore 组装（12 Manager）
apps/web/src/core/managers/commands.ts      CommandManager（execute/undo/redo/ripple）
apps/web/src/core/managers/timeline-manager.ts  时间轴（所有操作转 Command）
apps/web/src/core/managers/media-manager.ts      素材 Asset（storageService + 缓存）
apps/web/src/core/managers/playback-manager.ts   纯墙钟（不碰媒体）
apps/web/src/core/managers/audio-manager.ts      Web Audio 调度（lookahead + sessionId）
apps/web/src/commands/timeline/element/split-elements.ts  split 纯数据（snap-once）
apps/web/src/timeline/types.ts               SceneTracks/TimelineElement 类型
```
