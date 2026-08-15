# C.0 — AudioEngine 迁移设计（概念稿，待 C 阶段启动）

> 状态：**概念方向（v0.1），不锁字段/不落码**。C 阶段启动时细化。
> 日期：2026-08-15
> 依据：OpenCut 对比审计（`docs/audits/opencut-vs-ours-playback.md`）——OpenCut 音频用 Web Audio（decodeAudioData → BufferSourceNode.start(精确时间戳)）完全绕开 HTMLMediaElement 播放状态机。
> 拍板（用户，2026-08-15）：B.5 收尾后进入 C：**AudioEngine（Web Audio BufferSource）迁移**；视频暂时保持 element follower。

---

## 1. 为什么迁音频（痛点排序）

用户痛点：①MP3 首播无声 ②MP3 split 第二段无声 ③pause/resume 无声 ④MP4 卡住。
前三个**全部是 `<audio>` 元素病**（autoplay 策略 / playing 事件不 fire / 复用状态残留 / seek 竞态）。
AudioEngine 用 Web Audio 直接调度，**这类问题整类消灭**，且与视频路径完全解耦，可先行。

## 2. 目标结构（对齐 OpenCut 分层，不抄代码）

```
PlayerManager（现有，不动）
    ├─ 负责：session / timeline / playhead / 视频元素 follower
    └─ 音频职责移交 →

AudioEngine（新增 audio_engine.js）
    ├─ loadAudio(path) → 解码 AudioBuffer（缓存）
    ├─ scheduleClip(clip, startTime, offset) → BufferSourceNode.start(精确时间戳)
    ├─ stop() / suspend() / resume()
    └─ lookahead 调度（每 500ms 扫未来 2s 内 clips，到点自动起播 → 跨段天然无缝）
```

## 3. 核心 API（概念，不锁）

```js
class AudioEngine {
  constructor() { this.ctx = null; this.sessionId = 0; this.scheduled = new Set(); }
  ensureCtx()          // AudioContext 创建 + 首次 resume（一次手势解锁，之后无 autoplay 问题）
  async load(path)     // fetch → decodeAudioData → 缓存 Map<path, AudioBuffer>
  play(timelineStartUs, clips)   // 记录 playbackStartTime/StartCtxTime，开始 lookahead 调度
  scheduleUpcoming()   // 每 500ms：窗口内未激活 clip → createBufferSource → node.start(ts, offset)
  pause()              // ctx.suspend()（保留调度状态，resume 干净）
  resume()             // ctx.resume() + 继续调度
  seek(us)             // 重设 playbackStartTime，清已调度源，重新调度
  stop()               // stop 全部 node + sessionId++（旧异步天然作废 = OpenCut 的 MediaEpoch）
}
```

## 4. 迁移边界（明确不做）

- **不做**：重写 Timeline / 重写 Session / 动 MCP / 动数据模型 / 改视频路径。
- 视频（MP4）保持 element follower（`<video>` 元素 + 播放头墙钟），不迁 canvas（P2）。
- 播放头仍是 `playTick` 墙钟（master），AudioEngine 只订阅"当前时间"，不拥有时间轴。
- 音频与视频的 mute/音量：AudioEngine 用 GainNode（音量），`setMediaMute` 对 `<audio>` 的职责在音频迁移后消失（视频轨内嵌音频暂保留元素 mute）。

## 5. 与现有代码的衔接

- `PlayerManager` 的音频 target（`previewState.audioEls`）→ 迁移后不再创建 `<audio>` 元素，改由 AudioEngine 解码调度。
- `renderPreview` 音频段 → 改为通知 AudioEngine 当前 clips 集合（只读 draft，不重建元素）。
- `_handleCrossSegment` → 音频侧由 lookahead 调度替代，不再需要音频 handoff（视频仍走 handoff）。
- `primeMediaPlayback` / 激活门音频侧 → 迁移后不再需要（Web Audio 无 autoplay 策略）。

## 6. 验收目标（C 阶段）

1. MP3 首播有声（冷启动，无 prime/激活门）。
2. MP3 split 两段连续播，第二段有声（lookahead 天然无缝）。
3. 暂停 → 恢复，从原位置继续有声（ctx.suspend/resume）。
4. 拖播放头 → 从指定位置有声。
5. 音视频同播（视频元素 + AudioEngine）同步。

## 7. 风险

- `decodeAudioData` 大文件耗时 → 缓存 + 预解码（OpenCut decodedBuffers 同思路）。
- PyWebView 下 `fetch(file://)` 受限 → 音频文件经 `window.pywebview.api` 读 base64 或本地 HTTP（现有 fileURL 机制评估）。
- 多轨/变速/淡入淡出后续在 AudioEngine 内扩展（GainNode 自动化），不影响本次骨架。

## 8. 一句话

**C.0 = 把音频从"HTMLMediaElement 播放状态机"迁到"Web Audio 精确调度"（OpenCut 验证路径），PlayerManager/时间轴/播放头不变，视频暂不迁。B.5 收尾后启动。**
