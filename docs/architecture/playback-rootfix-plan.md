# 播放器/时间轴消费 · 根治实施方案（基于 OpenCut 底层全扒）

> 日期：2026-08-16
> 上游三份审计：
>  - `playback-rootcause-architectural.md`（播放底层根因：状态机 vs 调度）
>  - `timeline-to-playback-dataflow.md`（时间轴→播放：平铺 vs 逐帧）
>  - 本文：OpenCut 音量解析/视频节点化/调度机制 + 分阶段根治实施
> 核心思想：**建立"时间轴语义层"（Playback Graph），播放与导出都消费它**——预览=导出永远一致，换算逻辑只写一次。

---

## 0. 从 OpenCut 扒到的全部底层机制（本文依据）

| # | 机制 | 源码位置 | 内容 |
|---|------|---------|------|
| 1 | 时间轴→音频平铺 | `media/audio.ts` collectAudioClips | 整条时间轴 → AudioClipSource[]（每段自带 startTime/duration/trimStart/trimEnd/volume/muted/retime） |
| 2 | 时间轴→视频节点化 | `services/renderer/scene-builder.ts` buildTrackNodes | 每元素 → 独立节点（VideoNode 带 url/trim/retime/transform/opacity/blendMode/effects/masks） |
| 3 | 音量三层解析 | `timeline/audio-state.ts` resolveEffectiveAudioGain | 轨静音‖段静音→0；否则 resolveNumberAtTime（基础值+音量关键帧）→ dBToLinear |
| 4 | 音频调度 | `core/managers/audio-manager.ts` | AudioContext 墙钟 + 500ms lookahead 扫未来 2s → BufferSourceNode.start(ctxTime, offset) |
| 5 | 视频调度 | PlaybackManager（墙钟）+ canvas 渲染 | 播放头=纯墙钟；视频元素只解码 |
| 6 | 播放头 | `playback-manager.ts` | currentTime = start + wall 流逝（RAF 每帧）✅ 我们已对齐 |

## 1. 根治方案：时间轴语义层（Playback Graph）

```
draft（时间轴数据：segments）
   │  语义层平铺（一次构建，增量更新）
   ▼
Playback Graph：
  ├─ audioClips[]  （音频段：start/duration/trimStart/trimEnd/volume/muted/speed/changePitch）
  ├─ videoNodes[]  （视频段：path/trimStart/trimEnd/speed/transform/opacity/masks/volume）
  ├─ imageNodes[]  （图片段：path/transform/opacity）
  └─ textNodes[]   （文本段：content/style/start/duration）
   │
   ├─ 播放消费：AudioEngine（Web Audio 调度）+ VideoEngine（独立元素，墙钟驱动）
   └─ 导出消费：export_draft（同一语义层 → 剪映草稿）
```

**为什么这样设计**：
- OpenCut 的播放/渲染/导出**全部消费同一份"平铺后的节点/片段"**——换算只写一次
- 我们当前：播放（resolveHits+seek）、导出（读 seg 原始字段）**两套换算** → 预览≠导出的隐患
- 语义层 = 统一换算入口，天然保证一致

## 2. 分阶段实施

### Phase 1：音频 Web Audio 引擎（根治无声/跨段，1-2 天）

```
新增 AudioEngine（替代 <audio> 元素播放）：
  1. buildAudioClips(draft) → audioClips[]（平铺：每音频段/video 内嵌声 = 1 clip）
  2. 素材级解码缓存：loadAudio(path) → decodeAudioData → AudioBuffer
  3. startPlayback(time)：AudioContext.resume() + playbackSessionId++ + 启动 500ms 调度
  4. scheduleUpcomingClips()：墙钟当前 + 2s 窗口 → 命中 clip → BufferSourceNode.start(ctxTime, trimStart+offset)
  5. stopPlayback()：清所有 source
  保留：播放头墙钟（已对齐）、muted 跳过、音量（dBToLinear）、变速（playbackRate）
删除：audio 元素创建/seek/复用（media.js audioEls 路径退役）
验证：MP3 单段有声 ✅ → MP3 split 跨段有声 ✅ → 多轨混音 ✅
```

### Phase 2：视频独立元素（根治卡顿，0.5-1 天）

```
VideoEngine（每段独立 <video>，不复用）：
  1. buildVideoNodes(draft) → videoNodes[]（每段：path/trim/speed/transform/masks）
  2. 播放：playheadUs → 命中 node → 显示该 node 的 video 元素 + seek(trim 偏移)
  3. 跨段：切显示目标元素（旧的隐藏/销毁）——无复用无竞态
  保留：transform 动画（applyKfTransform 每帧）、遮罩、音量（video.volume）
不做：canvas 渲染（工程大，导出走剪映草稿不需要 render tree）
验证：MP4 单段 ✅ → split 跨段不卡 ✅ → 多轨叠加 z 序 ✅
```

### Phase 3：导出共享语义层（预览=导出一致，0.5 天）

```
export_draft 改消费 Playback Graph（不再直接读 seg 字段）：
  - audioClips/videoNodes 的 trim/speed/volume/muted → 剪映草稿素材/轨道
  - 保证：预览看到的 = 导出的
验证：改音量/变速/静音后，预览与导出剪映草稿参数一致
```

### Phase 4：统一音量解析（0.5 天）

```
resolveGain(seg, trackMuted, localTime)：
  轨静音 || 段静音 → 0
  else → 段 volume（线性 0-2，我们非 dB）* 音量关键帧（若有）
播放 + 导出共用
验证：全局静音/轨静音/段静音/音量关键帧 四层叠加正确
```

### Phase 5：边缘收口（后置）

- 数据兼容：旧段缺 src_start/src_end/speed/material_id → 语义层构建时兜底
- 播放中外部修改：MCP 改 draft → 语义层增量重建（不重启播放）
- 性能：audioClips 按 start 排序 + 二分查找，替代逐帧全扫
- 素材失效：播放前 resolveSegPath 检查文件存在

## 3. 验收标准（每阶段）

| Phase | 验收 |
|-------|------|
| 1 | MP3 split 3 段跨段播放**有声**；多轨音频同时出声；暂停恢复有声 |
| 2 | MP4 split 3 段跨段**不卡**；多视频轨叠加 z 序正确；变速播放正常 |
| 3 | 改音量/变速/静音 → 导出剪映草稿参数与预览一致 |
| 4 | 四层音量叠加（全局/轨/段/关键帧）正确 |
| 5 | 旧存档项目能播；AI 播放中改 draft 不崩；50+ 段时间轴流畅 |

## 4. 资源

- 参考：OpenCut audio-manager.ts（700 行，我们只需核心调度 ~150 行）
- 我们已对齐：播放头墙钟、Command 审计、resolveSegPath
- 需新建：AudioEngine（player 层）、VideoEngine 重构（media.js）、PlaybackGraph 构建器（可放 timeline.js 或新文件）

## 5. 风险

| 风险 | 缓解 |
|------|------|
| Web Audio 解码内存（大素材） | 素材级缓存 + LRU 上限；超大素材降级元素播放 |
| 变速音频音质 | playbackRate + preservePitch 处理 |
| 现有 audioEls/visualEls 依赖多 | 分阶段迁移：Phase1 只替换音频，Phase2 替换视频，每步回归 |
| 导出格式差异 | Phase3 单独验证剪映草稿字段 |

## 6. 一句话

**建一个 Playback Graph（时间轴语义层）：draft → 平铺成 audioClips/videoNodes，播放（Web Audio + 独立视频元素）和导出（剪映草稿）都消费它——根治"跨段无声/卡顿" + 消灭"预览≠导出"隐患，换算逻辑只写一次。**
