# 播放器底层根因对比：OpenCut 为什么天然没这个问题（底层架构，非补丁）

> 日期：2026-08-16
> 背景：8 个补丁（B.5 系列）修不好"跨段无声/卡顿"。用户正确指出：这不是单个 bug，是**底层架构差异**。
> 本文从 OpenCut 播放架构逐层对比，揪出根因 + 根治路线。

---

## 1. 播放架构逐层对比

| 层 | OpenCut | 我们 | 结论 |
|----|---------|------|------|
| **播放头（时间源）** | PlaybackManager：`currentTime = playbackStartTime + (performance.now() - startWall)/1000`，纯墙钟 RAF | playTick：`playStartUs + (now - playStartWall)*1000`，纯墙钟 RAF | ✅ **已对齐**（我们这层是对的） |
| **音频** | **Web Audio**：AudioContext 墙钟 + lookahead 调度，`BufferSourceNode.start(ctxTime, offset)` 到点出声 | `<audio>` 元素 `play()/pause()/seek()` 状态机 | ❌ **状态机 = 竞态源** |
| **视频** | **canvas 渲染**：video 元素**只解码不控制播放**，canvas 每帧抽帧画 | `<video>` 元素 `play()/pause()/seek()` 状态机 | ❌ **状态机 = 卡顿源** |
| **跨段** | 调度器看墙钟 → 到点自然衔接（**没有"切换"动作**） | 同元素 `setMediaSrc` + seek + play | ❌ **复用 = 竞态** |

## 2. 根因（一句话）

**OpenCut 的媒体"只听墙钟，自己调度自己"；我们"媒体元素自己 play/pause/seek"，跨段要切换元素内容——元素状态机（playing/paused/seeked）和墙钟打架 → 竞态 → 卡/无声。**

播放头那层我们早对齐了（墙钟 master），但**音频/视频的"出声/出画"仍依赖元素状态机**——元素状态（play 有没有成功、seek 有没有到位、切源后 readyState）参与驱动判断，就是竞态温床。

## 3. 为什么 8 个补丁修不好

补丁都是"在元素状态机上**加防御**"（激活门 / seekBarrier / prime / recoverToken / 跨段 handoff）：
- 激活门：等元素 playing 事件才解静音 → 元素事件不触发就卡
- seekBarrier：seek 用 pause→seek→resume → 每帧 pause/play 重启播放（咚咚声）
- 跨段 handoff：play(HANDOFF) 复用 session → 边界仍掉声

**状态机的竞态本质没消除**，防御只是延迟/掩盖——修一个竞态冒出新竞态。这就是"一直打补丁一直坏"的机制。

## 4. 根治路线（对齐 OpenCut 底层，~2 天）

### 4.1 音频迁 Web Audio（1-2 天）——根治无声/跨段
```
loadAudio(path) → decodeAudioData → AudioBuffer（素材级缓存）
scheduleClip(clip, ctxTime) → BufferSourceNode.start(ctxTime, offset)
lookahead 调度：500ms 扫未来 2s 的段（跨段天然无缝）
保留：播放头墙钟（已对齐）、muted 跳过、sessionId 防竞态
```
参考：OpenCut `audio-manager.ts`（700 行），我们只需要其核心调度（~150 行），
不做它的完整解码链（AudioBufferSink/Input/prepared-buffer 优化）。

### 4.2 视频保持元素模式但重构"播放驱动"（0.5-1 天）——根治卡顿
方案 B（元素模式正解）：
```
每段独立 <video> 元素（不复用）
播放位置由墙钟（playheadUs）驱动 seek
跨段 = 销毁旧元素 + 创建新元素（无复用 = 无状态机残留）
```
不做 OpenCut 的 canvas 渲染（工程大 + 我们导出走剪映草稿，不需要 render tree）。

## 5. 为什么这次能成（和补丁的区别）

| 补丁 | 根治 |
|------|------|
| 在状态机上加防御 | **消灭状态机依赖**（音频 Web Audio 无状态机，视频元素不复用） |
| 修一个竞态冒一个 | 竞态源（复用+seek/play）被架构消除 |
| 越修越复杂 | 架构向 OpenCut 看齐后，播放器回到"墙钟驱动+简单调度" |

## 6. 优先级

1. **音频 Web Audio**（根治无声+跨段，1-2 天）
2. **视频重建元素**（根治卡顿，0.5-1 天）
3. 时间轴缩略图前端显示修复（0.5h，后端缩略图已生成，只是前端没画）

## 7. 用户预期对齐

- Agent skill 已做好，差工作台播放器
- 播放+导出跑通 = 工具初步成功
- 特效轨（原语引擎）在播放器稳定后做
