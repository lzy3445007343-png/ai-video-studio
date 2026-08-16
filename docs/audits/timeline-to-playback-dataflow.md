# 时间轴 → 播放器：素材怎么被播（OpenCut vs 我们 全链路对比）

> 日期：2026-08-16
> 关联：`playback-rootcause-architectural.md`（播放底层根因）。本文补全"时间轴素材摆放→播放消费"这条链。
> 核心机制：OpenCut **先平铺（时间轴→clip 列表），后调度（墙钟→到点 start）**；我们**边播边查（每帧 resolveHits + seek）**。

---

## 1. OpenCut：时间轴 → 播放（collectAudioClips 全链路）

### 1.1 平铺（一次性，播放前）
```
collectAudioClips({tracks, mediaAssets})：
  1. orderedTracks = [overlay, main, ...audio]（轨道顺序，主轨居中）
  2. mediaMap = mediaAssets.id → asset
  3. 遍历每条轨的每个 element：
     - canElementHaveAudio?（video/audio 才有音频）
     - muted = 轨级 || 段级
     - volume = resolveEffectiveAudioGain（轨/段/时间）
     - audio element → collectMediaAudioClip
     - video element（内嵌音频）→ 同样收集
  4. 输出 AudioClipSource[]（每个段一个独立 clip）
```

### 1.2 AudioClipSource 结构（每段 = 独立播放单元）
```ts
{
  id, sourceKey(mediaAsset.id), file,
  startTime,   // 时间轴位置（秒）
  duration,    // 时间轴时长
  trimStart,   // 源窗口入点（秒）
  trimEnd,     // 源窗口出点
  volume, muted, retime,
}
```
**每个段自带"时间轴位置 + 源窗口 + 音量"**——播放器不关心时间轴结构，只消费这个列表。

### 1.3 调度（播放中，墙钟驱动）
```
AudioManager.scheduleUpcomingClips()（每 500ms）：
  currentTime = getPlaybackTime()（AudioContext 墙钟）
  windowEnd = currentTime + 2s（lookahead）
  遍历 clips：muted 跳过 / 已 active 跳过 / 已结束跳过 / 未到 window 跳过
  命中 → BufferSourceNode.start(ctxTime, trimStart 偏移)   ← 到点出声
```
**跨段 = 两个独立 clip 的天然衔接**——没有"切换"动作，没有元素复用。

## 2. 我们：时间轴 → 播放（resolveHits 全链路）

### 2.1 边播边查（每帧）
```
playTick（RAF 每帧）：
  1. playheadUs = playStartUs + wall 流逝（墙钟 ✅ 对齐）
  2. resolveHits(playheadUs)：
     - 遍历 draft 全部轨/段
     - us ∈ [seg.start, seg.start+seg.duration) → 命中
     - 输出 [{seg, type, ti, idx, key}]
  3. keySig 变化（跨段）→ PlayerManager.handleCrossSegment：
     - 同元素 setMediaSrc(新段 path) + seek(新源位置) + play
  4. drift 校正：媒体偏离 >100ms → 元素 seek 回墙钟位置
```

### 2.2 段→源换算（每帧 seek 时）
```
PlayerManager.seek(el, seg, playheadUs)：
  源内位置 = src_start + (playheadUs - seg.start) * speed
```

## 3. 对比：差异在"平铺 vs 逐帧"

| 环节 | OpenCut | 我们 | 差异后果 |
|------|---------|------|---------|
| 时间轴→播放映射 | **一次性平铺**成独立 clip 列表 | **每帧 resolveHits** 现查 | 我们每帧都在"找段+换算+seek" |
| 段=播放单元 | 是（独立 source，自带全部参数） | 否（元素复用 + 每次重新 setMediaSrc/seek） | 我们跨段要"切换"，有竞态 |
| 跨段 | 两个独立 clip 自然衔接 | 同元素换内容重播 | 元素状态机参与 = 卡/无声 |
| 音量/静音 | 平铺时算好（每 clip 自带） | 播放时查轨/段级再设 | 我们漏设就静音 |
| 时间源 | 单一墙钟（AudioContext/RAF） | 墙钟（playTick）✅ | 已对齐 |

## 4. 根治方案（对齐"平铺后调度"）

### 4.1 音频（1-2 天）
```
1. collectAudioClips 平铺：把 draft 转成 clip 列表（每段含 start/duration/trimStart/trimEnd/volume/muted/speed）
2. decodeAudioData 预解码（素材级缓存）
3. lookahead 调度：500ms 扫未来 2s，BufferSourceNode.start(ctxTime, trimStart+offset)
4. 播放头墙钟保留（已对齐）
```

### 4.2 视频（0.5-1 天，元素模式）
```
方案 B：每段独立 <video> 元素（不复用）
  - 平铺：每段一个 video（含 src/trim 换算）
  - 墙钟驱动：playheadUs → 对应段 video.seek
  - 跨段：显示新元素（旧的销毁或隐藏）——无复用竞态
```

## 5. 结论

**"时间轴素材怎么被播"的底层 = 平铺 vs 逐帧**：
- OpenCut：先一次平铺（时间轴→clip 列表），播放器只消费列表 + 墙钟调度——**数据和播放解耦**
- 我们：边播边查（每帧 resolveHits + 元素 seek）——**数据和播放耦合在每帧操作里** → 每帧的 seek/切换就是竞态源

根治 = 对齐"平铺后调度"：音频平铺成 clip 列表（Web Audio 调度），视频平铺成独立元素（墙钟驱动）。这与上轮结论一致，且补齐了"时间轴素材摆放→播放"这条链。

## 6. 涉及的所有时间轴元素

| 类型 | 平铺产物 | 播放方式 |
|------|---------|---------|
| video（含内嵌音频） | 视频元素（画面）+ AudioClipSource（内嵌声） | 墙钟驱动 seek + Web Audio 内嵌声 |
| audio | AudioClipSource | Web Audio 调度 |
| text | 无音频（只渲染） | 关键帧动画每帧应用 |
| image | 无音频（只渲染） | 关键帧动画每帧应用 |
| sticker | 无音频（只渲染） | transform 每帧应用 |
| effect | 原语参数（后置） | 特效引擎（后续） |
