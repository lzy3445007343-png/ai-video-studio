# 播放器冻结项 vs OpenCut 深度对比（能借鉴/不能借鉴全清单）

> 日期：2026-08-15 深夜
> 方法：精读 OpenCut `audio-manager.ts`(700行) + `renderer-manager.ts` + `playback-manager.ts`，逐机制对照我们 player.js 的冻结项。

---

## 1. 冻结项 → OpenCut 机制对照

| 我们的冻结项 | OpenCut 对应机制 | 根因差异 |
|------------|-----------------|---------|
| MP3 split 第二段无声（跨段） | AudioManager **lookahead 调度**（每 500ms 扫未来 2s 的 clip，`BufferSourceNode.start(ctxTime, offset)` 到点出声） | 他们**没有跨段交接**——每个 clip 独立调度、到点自然衔接；我们同元素复用 + seek/play 竞态 |
| MP4 split 跨段卡 | RendererManager 走 **canvas 逐帧**（video 元素只解码取帧，不控制播放） | 他们画面推进不依赖 video.play() 状态机；我们依赖元素播放态 |
| 从头重播不稳定 | startPlayback 每次**重建调度**（stopPlayback 清空所有 source + sessionId++ 丢弃旧异步） | 他们元素=解码器，无状态残留；我们元素被 play/pause/seek 弄脏 |
| 播放头不动（已修） | PlaybackManager 纯墙钟 RAF（已对齐 ✅） | — |

## 2. OpenCut 音频调度机制（audio-manager.ts 精读）

```
核心状态：
  audioContext（AudioContext）+ masterGain（主音量 GainNode）
  playbackStartTime（时间轴位置）+ playbackStartContextTime（ctx 时刻）
  lookaheadSeconds=2 / scheduleIntervalMs=500
  activeClipIds / queuedSources / sessionId（防竞态）

getPlaybackTime() = playbackStartTime + (ctx.currentTime - playbackStartContextTime)
  —— 音频时钟 = AudioContext 墙钟（采样级精确）

startPlayback(time)：
  stopPlayback()（清场）
  playbackSessionId++（旧异步全作废）
  await ctx.resume()（手势内解锁——和我们 unlockAudio 同理）
  collectAudioClips（收集时间轴上的音频片段）
  启动 500ms interval → scheduleUpcomingClips

scheduleUpcomingClips()：
  currentTime = getPlaybackTime()
  windowEnd = currentTime + 2s（lookahead）
  遍历 clips：muted 跳过 / 已 active 跳过 / 已结束跳过 / 未到 windowEnd 跳过
  命中 → activeClipIds.add + schedulePreparedClip 或 runClipIterator

schedulePreparedClip：
  AudioBufferSourceNode.start(启动时刻, 源偏移) —— 一次调用，精确到采样

stopPlayback()：
  clearInterval + 全部 queuedSources.stop() + activeClipIds.clear()
```

**关键洞察**：
- **没有 seek/play/pause 竞态**——BufferSourceNode 一次 start 就播完，不重新 play
- **没有 playing 事件依赖**——Web Audio 无事件，声音由 ctx 墙钟保证
- **没有 autoplay 拦截**——只有一次 ctx.resume() 手势解锁
- **没有元素复用**——每个 clip 独立 source，播完自然停
- **sessionId 防竞态**——异步回调检查 sessionId，旧 session 的异步结果全丢弃

## 3. 能借鉴（按价值排序）✅

| # | 借鉴点 | 对应我们 | 价值 |
|---|--------|---------|------|
| 1 | **Web Audio lookahead 调度**（音频全迁） | 我们元素模式（冻结项根因） | **根治跨段无声/重播不稳** |
| 2 | **sessionId 防竞态** | 我们有 recoverToken（类似，可强化） | 异步回调竞态防护 |
| 3 | **getPlaybackTime 单一时间源**（ctx 墙钟） | 我们有 playStartWall/playStartUs | 对齐时间基准 |
| 4 | **muted clip 跳过** | 我们有 isTrackMuted | 已对齐 |
| 5 | **500ms lookahead 窗口** | 无 | 简单可抄（跨段调度） |
| 6 | **stopPlayback 清场 + 重建** | 我们有 pausePlay（保留） | 重播时先清场再建 |
| 7 | **ctx.resume() 手势解锁** | 我们有 unlockAudio | 已对齐 |

**核心结论**：**音频冻结项（跨段无声/重播）的真正解药 = 音频迁 Web Audio lookahead 调度**。这不需要重写时间轴/播放头——只替换"音频出声道"（AudioEngine 概念稿就是这个方向）。视频仍可保持元素模式。

## 4. 不能借鉴（或有条件）❌

| # | OpenCut 机制 | 为什么不能/不必要 |
|---|-------------|-------------------|
| 1 | **canvas 逐帧渲染**（RenderTree/CanvasRenderer/SceneExporter） | 工程量大（渲染树+合成器），我们 DOM 叠加预览已够用；且我们导出走**剪映草稿**（pyJianYingDraft），不是 OpenCut 的 render tree |
| 2 | **Rust/wasm 核心**（opencut-wasm：MediaTime 类型/帧级计算） | 我们纯 Python + JS，引入 wasm 模块不现实 |
| 3 | **React 组件架构** | 我们原生 JS（已拆 5 文件），不迁移 |
| 4 | **多场景 scenes 模型** | 我们单项目够用 |
| 5 | **AudioBufferSink/Input 复杂解码链** | 简化版（decodeAudioData 直调）够用 |
| 6 | **prepared-clip-buffer 预解码优化** | 性能优化项，非功能必需，后置 |

## 5. 借鉴落地方案（C.0 AudioEngine 方向细化）

```
音频迁 Web Audio（1-2 天）：
  loadAudio(path) → decodeAudioData → AudioBuffer（material 级缓存）
  scheduleClip(clip, ctxTime) → BufferSourceNode.start(ctxTime, offset)
  lookahead 调度：500ms interval 扫未来 2s 片段（跨段天然无缝）
  保留：播放头墙钟 master（已对齐）、muted 跳过、sessionId 防竞态
  video 不动（元素模式，MP4 单段已能播）

视频跨段卡（P2）：
  可选 A：跨段时重建 video 元素（非复用）——元素级解决状态残留
  可选 B：保持现状（canvas 迁移不做）
```

## 6. 一句话结论

**音频 = OpenCut 的 Web Audio 调度是唯一根治路径（能借鉴，值得做）；视频 = 元素模式够用，canvas 渲染不能抄（工程大且我们导出路径不同）。播放头墙钟我们已经和 OpenCut 对齐了。**
