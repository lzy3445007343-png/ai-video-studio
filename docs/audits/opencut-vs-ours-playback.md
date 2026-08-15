# OpenCut vs 我们：播放路径对比审计（只读，2026-08-15 17:40）

> 目的：用户要求"看 OpenCut 源码，对比问题到底出在哪里"。本文是**只读审计**，未改任何代码。
> OpenCut 源码：`reference/opencut-classic`（apps/web/src/core/managers/）。
> 结论先行：**我们的所有播放问题（首播无声/跨段无声/重播无声/MP4 卡住）根因 = 播放路径建立在 HTMLMediaElement（`<audio>`/`<video>` 元素）的 `play()/pause()/seek()` 之上——这是 WebView2 下最不可靠的一条路径；OpenCut 完全绕开了它。**

---

## 1. OpenCut 播放架构（三个 manager，全看完）

### 1.1 PlaybackManager（playback-manager.ts，257 行）
- **播放头 = 纯墙钟 RAF**。`play()` 只做：`isPlaying=true → startTimer()`；`updateTime()` 每帧算 `playbackStartWallTime + elapsed` → `notifyUpdate(newTime)`。
- **完全不碰媒体元素**。媒体同步靠事件：`notifyUpdate` / `notifySeek` → AudioManager 等订阅者响应。
- `seek()` 只改 `currentTime` + 重置墙钟锚点（`playbackStartWallTime`），**不碰任何媒体**。
- 注意：**没有 `primeMediaPlayback`、没有 autoplay 解锁、没有激活门**——因为媒体不在它的路径里。

### 1.2 AudioManager（audio-manager.ts，701 行）—— 关键
- **音频根本不用 `<audio>` 元素**。用 Web Audio API：
  1. `decodeClipBuffer()`：mediabunny `Input`/`AudioBufferSink` 把文件**解码为 AudioBuffer**（预先缓存 decodedBuffers）；
  2. `startPlayback()`：`audioContext.resume()` → 记录 `playbackStartTime`（时间轴秒）与 `playbackStartContextTime`（audioCtx 秒）；
  3. `scheduleUpcomingClips()`：**lookahead 调度**——每 500ms 扫未来 2 秒内的 clips，对每个未激活 clip 创建 `BufferSourceNode`，`node.start(startTimestamp, clipOffset)` **在精确音频时间戳启动**；
  4. `stopPlayback()`：stop 所有 queuedSources + 递增 `playbackSessionId`。
- **为什么这样没有我们那些问题**：
  - `BufferSourceNode.start(when, offset)` 是**确定性调度**，交给音频线程精确执行，**不依赖 `play()` promise、不依赖 playing 事件、不依赖元素状态**；
  - 跨段天然无缝：lookahead 窗口到了下一个 clip 的 startTime 就自动起播，**不需要跨段交接逻辑**；
  - `playbackSessionId` 每次 startPlayback 递增，**旧 session 的异步回调天然作废**——这就是 GPT 说的 MediaEpoch，OpenCut 原生就有；
  - **没有 muted/autoplay/激活门概念**——Web Audio 的 GainNode 管音量，没有浏览器自动播放策略问题。

### 1.3 RendererManager（renderer-manager.ts，253 行）
- 主要是导出/快照（canvas 渲染）。实时预览画面走 **canvas 逐帧渲染**（CanvasRenderer + wasm compositor），`video` 元素**只用于解码取帧**，不做播放控制。
- 所以 OpenCut **不存在 `<video>.play()` 的画面推进问题**——画面是 canvas 每帧画的，时钟是墙钟。

### 1.4 结论：OpenCut 的播放路径分层
```
PlaybackManager（纯墙钟 RAF，时间轴唯一 master）
    ├─→ AudioManager（Web Audio 精确调度，采样级）
    └─→ CanvasRenderer（canvas 逐帧画，视频元素只解码）
```
**没有任何一层依赖 HTMLMediaElement 的播放状态机。**

---

## 2. 我们的播放路径（工作台v0.8时间轴.html）

```
playTick（墙钟 RAF，时间轴 master）—— 思路和 OpenCut 一致 ✅
    ├─→ <audio> 元素：el.play()/pause()/currentTime=… —— ❌ WebView2 不可靠路径
    ├─→ <video> 元素：el.play()/pause()/currentTime=… —— ❌ 同
    ├─→ primeMediaPlayback（autoplay 解锁，v1.4.1 改临时元素）
    ├─→ PlaySession + 激活门（Session Gate / Handoff Gate）
    ├─→ _handleCrossSegment（跨段 handoff）
    └─→ _seekTarget / _attemptPlay 早返守卫（B.5.5-1）
```

**差异本质**：我们为了解决"元素模式"的坑（autoplay、playing 事件、复用状态、竞态），造了一整套补偿机制（prime/激活门/handoff/确认门）。而 OpenCut **根本不在元素模式里**——它把播放拆成"墙钟定时间、Web Audio 精确出声、canvas 精确出画"，元素只做解码。

---

## 3. 我们每个历史问题的 OpenCut 视角解释

| 我们的问题 | 元素模式根因 | OpenCut 为何没有 |
|-----------|-------------|-----------------|
| 首播纯 MP3 无声 | `<audio>.play()` 被 WebView2 autoplay 策略拦截 / playing 不 fire → 激活门等不到 → muted 不解 | Web Audio 无 autoplay 策略，`node.start()` 直接出声 |
| split 第二段无声 | 同一 `<audio>` 元素复用，seek 后 decoder 状态残留、playing 不再 fire | 每 clip 独立 BufferSourceNode，`start(时间戳, 偏移)` 确定性 |
| 从头重播无声 | 元素被 play+pause+play 污染，decoder 未重入 | `startPlayback()` 每次新建调度，`playbackSessionId` 隔离旧状态 |
| MP4 卡住 | `<video>.play()` 成功但 GPU 无帧 / playing 事件缺失 → 画面卡 | 画面是 canvas 逐帧画，与元素播放状态无关 |
| 播放头不能动（最新） | `startPlay` 的 async 链（renderPreview/await）某处抛错或卡住 → playTick 未启动 | PlaybackManager 的 clock 与媒体完全解耦，媒体挂掉不影响播放头 |

---

## 4. 给我们的方向（两个选项，用户拍板）

### 选项 A：音频迁移 Web Audio API（OpenCut 验证的根治路径，大改）
- MP3/音频轨：`fetch(file) → audioContext.decodeAudioData → 播放时建 BufferSourceNode → node.start(精确时间戳, 源偏移)`，lookahead 调度。
- 优点：**彻底消灭 autoplay/playing/复用/竞态/跨段全部音频问题**；跨段天然无缝；无 muted 所有权问题（GainNode 管音量）。
- 代价：音频解码要重写音频播放层（工作量 1-2 天）；需要处理文件读取（PyWebView 下 file:// 或 base64）。
- 用户此前说"AudioContext MediaElementSource 不要接"——那是指**不要把 `<audio>` 元素接进 AudioContext graph**；选项 A 是**直接用 Web Audio 播放解码 buffer**，是另一条路，不冲突。

### 选项 B：继续元素模式（当前 B.5.5 路线）
- 接受"元素模式在 WebView2 永远有边缘坑"，用确认门/epoch 兜底。
- 优点：改动小，视频画面仍走元素（无需 canvas 重构）。
- 代价：每个坑都是"堵"，永远有下一个；视频 MP4 卡住的根治（canvas 渲染）不在这个选项内。

### 建议
- **纯音频（MP3）**：强烈建议选项 A——这是 OpenCut 验证过的方案，能把我们最痛的一整类问题（音频无声/跨段/重播）一次性根除，且**与视频路径完全解耦**，可以先做音频再做视频。
- **视频（MP4）**：短期先回退到"能播"（元素模式 + 确认门），canvas 逐帧渲染是中长期方向（P2），不阻塞当前。
- 两条线不冲突：**音频先迁 Web Audio，视频保持元素模式**，播放头墙钟不变。

---

## 5. 立即可做的止血（不改播放架构）

- **播放头不能动**（最新症状）：`startPlay` 是 async，若 `renderPreview()` 或任何 await 链抛异常，`playAllMedia()`/`playTick()` 不会执行 → 播放头不动。建议在 `startPlay` 加 `try/catch` + 日志（这是诊断，不是架构改动）。确认方法：开 debug（main.py `debug=True`）看 Console 有没有红色异常。

---

## 6. 结论一句话

**我们花了 B.5~B.5.5 五轮修的元素播放补偿机制，OpenCut 用"Web Audio 调度 + canvas 渲染"直接绕过了。方向性选择：音频走 Web Audio API 根治，视频保持元素模式兜底，播放头墙钟两边通用。**
