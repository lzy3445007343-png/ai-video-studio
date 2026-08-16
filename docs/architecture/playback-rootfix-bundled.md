# 播放器根治 · 捆绑版实施方案（Playback Graph 原子切换包）

> 版本：v1.0（2026-08-16）
> 依据：OpenCut 三份源码全扒（audio-manager.ts / scene-builder.ts / audio-state.ts / media/audio.ts collectAudioClips）+ 我们现状三链代码级侦察
> 定位：**不是补丁，是把"同一份时间轴数据被多套逻辑各自算"收成"一套语义层 + 所有消费方同步切换"**。中途状态必然不一致，所以 6 件必须同批改完，统一验收。

---

## 0. 统一验收标准（整体完成后一次跑，不中途验收）

对测试项目（`粗剪_IMG_4379_v2.mp4` 3 段 + `王悦辰.mp3` 3 段，17s，上下对齐）：

| # | 验收项 | 通过标准 |
|---|--------|---------|
| V1 | 跨段播放 | 播放 17s 全程：有画面、不卡帧、**跨段有声**（原冻结项消失） |
| V2 | 变速+音量 | 段变速 2x / 音量 0.5：预览听感 = 导出到剪映后听感（比例一致） |
| V3 | 静音链 | 全局静音 / 轨静音 / 段静音 三档各自生效，且预览=导出 |
| V4 | AI 播放中修改 | 播放中 MCP 加/删/移段，播放器 1 秒内反映新时间轴（不中断播放头） |
| V5 | 老存档兼容 | 缺 src_start/speed/material_id 的旧段：正常播放、正常导出 |
| V6 | 缩略图 | 时间轴上视频段显示缩略图平铺 |

---

## 1. 现状画像（代码级事实，侦察于 2026-08-16）

### 1.1 播放链（player.js，546 行）
- `resolveHits(us)`（L40）：**每帧**遍历全部轨道找命中段 —— 大时间轴逐帧全扫
- `playTick()`（L500）：墙钟推进播放头 ✅（此层已对齐 OpenCut，不动）
- 跨段 = `keySig` 变化 → `PlayerManager.handleCrossSegment(us)` → 同元素 `setMediaSrc + seek + play`（**状态机竞态源**）
- `PlayerManager`（media.js L17）：媒体池 `pool: Map()` 但 **`destroy()` 是 TODO 空壳**（L67）—— 元素从不销毁，跨段全靠"复用+换内容"，状态残留无法清除
- 音频：`<audio>`/`<video>` 元素 play/pause/seek（WebView2 状态机 = 8 个补丁修不好的根源）

### 1.2 导出链（main.py export_draft，L3262）
- 视频段（L3390 附近）：`Timerange(start, duration)` + `source_timerange(src_start, src_end-src_start)` + `volume`（轨静音||段静音→0，否则 seg.volume）+ `speed/change_pitch` + 关键帧 + 遮罩 —— **字段映射已经完整**
- 音频段（L3410 附近）：同样完整
- **结论：导出层已经是"读字段"，不是"再算一遍"** —— 它缺的不是映射，而是与播放器**共用同一套换算公式的保证**

### 1.3 音量链（三层分散）
- 全局：`previewMuted`（player.js L19，写点 media.js L422 等 3+ 处）
- 轨级：`isTrackMuted(type, ti)`（player.js L291）
- 段级：`seg.muted` / `seg.volume`（renderer.js L92/L217/L226 应用）
- 分散在 player.js / media.js / renderer.js 的 **10+ 处**，各自判断逻辑不统一

### 1.4 缩略图
- 后端：素材有 `thumbnail` 字段（已生成）✅
- 前端：时间轴段渲染未用（显示层小 bug）

---

## 2. 核心决策：一份规范 + 两端实现 + 对拍保险丝

前端播放是 JS，导出是 Python，**跨语言无法共享同一份代码**。所以：

```
Playback Graph 规范文档（本文件 §3，字段表 + 换算公式，唯一权威）
        │
        ├── JS 实现（playback-graph.js）── 供播放器消费
        ├── Python 实现（main.py 内 _playback_graph()）── 供导出消费
        └── tools/graph_consistency.py（对拍脚本）── 同一 draft 跑两端，逐字段 diff
```

**对拍脚本是"防对不上"的保险丝**：每次改字段/公式，跑一遍，两端平铺结果必须逐字节一致。不一致 = 必然有"预览≠导出"的缝，当场暴露。

---

## 3. Playback Graph 语义层（Phase A，地基）

### 3.1 新文件 `playback-graph.js`（纯函数，无副作用，不碰 DOM）

```js
// 输入：draft（Store.state.draft）
// 输出：{ audioClips[], videoNodes[], version }
// 纯函数：同一 draft 永远产出同一 graph（可被对拍脚本复算）

function buildPlaybackGraph(draft) {
  const clips = [];   // audio 轨平铺结果
  const nodes = [];   // video 轨平铺结果
  // 每条轨、每段 → 平铺，内建兼容兜底（§3.3）+ 统一音量（§3.4）
  return { audioClips: clips, videoNodes: nodes, version: ++_graphVersion };
}
```

### 3.2 clip / node 结构（规范字段，两端一致）

```js
// 音频轨段 → AudioClip
{
  key: "audio:0:1",          // 轨:索引（与 resolveHits 同构）
  trackKey: "audio:0",
  startUs, durationUs,       // 时间轴位置
  srcStartUs, srcEndUs,      // 源窗口（兼容兜底后）
  speed,                     // 变速（default 1）
  gain,                      // 统一音量解析结果（0~2）
  path,                      // resolveSegPath 结果（失效返回 null → 跳过）
}

// 视频轨段 → VideoNode（含内嵌声）
{
  key: "video:0:0",
  trackKey: "video:0",
  startUs, durationUs,
  srcStartUs, srcEndUs,
  speed,
  gain,                      // 内嵌声音量（轨/段静音→0）
  muted,                     // 内嵌声是否静音（段级静音时 video 元素 muted）
  path,
  hidden,                    // 轨/段隐藏 → 播放跳过渲染
}
```

### 3.3 兼容兜底（内建进平铺，不散落）

| 字段 | 兜底规则 |
|------|---------|
| src_start | 缺 → 0 |
| src_end | 缺 → src_start + duration（speed=1 语义） |
| speed | 缺 → 1 |
| volume | 缺 → 1 |
| muted | 缺 → false |
| material_id | 缺 → 用 path 直接引用（resolveSegPath 已有 fallback） |

### 3.4 统一音量解析 resolveGain（三层收敛成一个函数）

```js
// 规范：全局静音 > 轨静音 > 段静音 > 段音量
function resolveGain(previewMuted, trackMuted, segMuted, segVolume) {
  if (previewMuted) return 0;
  if (trackMuted) return 0;
  if (segMuted) return 0;
  return segVolume == null ? 1 : segVolume;
}
```

> OpenCut 用 dB 制（audio-state.ts resolveEffectiveAudioGain）；我们保持线性（volume 0~2，剪映也是线性 volume）——**两端用同一公式即可，不必迁 dB**。

### 3.5 平铺换算（唯一换算点，替代散落逻辑）

```
每段：
  srcStartUs' = src_start（兜底 0）
  srcEndUs'   = src_end（兜底 src_start+duration）
  speed'      = speed（兜底 1）
  gain'       = resolveGain(...)
  path'       = 素材解析（失效 → 该段平铺为 null，播放跳过 + 控制台警告）
```

---

## 4. 音频 Web Audio 引擎（Phase B，新文件 `audio-engine.js`）

### 4.1 职责边界（关键分工，写死）

| 声音源 | 谁管 | 为什么 |
|--------|------|--------|
| **audio 轨**（独立音频段，如 MP3） | **Web Audio 引擎**（本 Phase） | decodeAudioData + lookahead 调度 = 跨段天然无缝 |
| **video 内嵌声**（MP4 自带音轨） | **视频元素重建**（Phase C） | 浏览器不提供"抽 MP4 内嵌音频"API，只能靠元素；元素重建解决状态残留 |

两者同时出声时由浏览器 mixer 混音（gain 乘积，可接受）。**禁止**给 video 元素 `muted=true` 强静音（会丢 MP4 内嵌声）。

### 4.2 引擎结构（对齐 OpenCut audio-manager.ts）

```js
const AudioEngine = {
  ctx,                       // 复用现有 audioCtx（player.js L25 已有 + unlockAudio 手势解锁 ✅）
  bufferCache: new Map(),    // path → AudioBuffer（LRU，上限 8 个素材，超限逐出最久未用）
  scheduled: new Set(),      // 已调度 BufferSourceNode
  clips: [],                 // 当前 graph.audioClips 快照

  async setClips(clips) {          // 平铺结果喂进来（播放前 / 播放中重平铺 / seek 后）
    this.stopAll();                // 清掉已调度 source
    this.clips = clips;
    this.tick();                   // 立即扫一次
  },
  async tick() {                   // 每 500ms 扫未来 2s（setInterval 驱动）
    const now = ctx.currentTime;   // 墙钟（音频时钟，与播放头墙钟独立）
    const horizon = now + 2.0;
    for (const c of this.clips) {
      if (c.scheduled) continue;
      const clipStartCtx = c.startUs / 1e6;      // 时间轴秒 → ctx 秒
      if (clipStartCtx >= now && clipStartCtx < horizon && c.gain > 0) {
        this.schedule(c);
      }
    }
  },
  schedule(c) {
    const buf = await this._decode(c.path);       // decodeAudioData，带缓存
    if (!buf) return;                             // 解码失败：跳过该段，控制台警告
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;             // 变速（音调随变；change_pitch 后置）
    const g = ctx.createGain();
    g.gain.value = c.gain;
    src.connect(g).connect(ctx.destination);
    const offset = c.srcStartUs / 1e6;            // 源窗口起点
    const startCtx = c.startUs / 1e6;             // 到点出声
    src.start(startCtx, offset, (c.srcEndUs - c.srcStartUs) / 1e6 / c.speed);
    this.scheduled.add(src);
    src.onended = () => this.scheduled.delete(src);
  },
  stopAll() {                                      // 拖动/暂停/重平铺时清场重建
    for (const s of this.scheduled) { try { s.stop(); } catch (e) {} }
    this.scheduled.clear();
  },
};
```

### 4.3 播放器接线（player.js 改动点）

| 位置 | 改法 |
|------|------|
| `startPlay()`（L347） | 播放前：`AudioEngine.setClips(graph.audioClips)` |
| `pausePlay()` | `AudioEngine.stopAll()` |
| `seekActiveMediaToPlayhead`（L419） | seek 后：`AudioEngine.setClips(graph.audioClips)`（重排调度） |
| `playTick` 跨段分支（L541） | 不再操作 audio 元素；`keySig` 变化仅重排 video 元素（Phase C） |

### 4.4 解决什么问题

- **MP3 跨段无声**（冻结项核心）：每段独立 BufferSource 到点出声，无"交接"动作
- **audio 元素状态残留**：不再有 `<audio>` 元素的 play/pause/seek 竞态
- **变速**：playbackRate 直接生效（预览与导出一致：导出 speed 也是 playbackRate 语义）

---

## 5. 视频独立元素（Phase C，改 media.js / renderer.js）

### 5.1 原则：**跨段不复用，销毁重建**

现状：`PlayerManager.destroy()` 是 TODO 空壳（media.js L67）——补实现：

```js
destroy(key) {
  const el = this.pool.get(key);
  if (!el) return;
  el.pause();
  el.removeAttribute("src");   // 关键：清 src 触发元素彻底复位
  el.load();                   // 复位解码状态（消灭 WebView2 状态残留）
  el.remove();                 // 从 DOM 移除
  this.pool.delete(key);
}
```

跨段时（`handleCrossSegment`）：
```
旧 video 元素：保留显示最后一帧（CSS opacity 过渡遮闪）→ 新元素 ready 后移除
新 video 元素：PlayerManager.create → setMediaSrc(新段源窗口) → seek 到源偏移 → play
```

### 5.2 解决什么问题

- **MP4 跨段卡帧**：不再同元素换内容（状态机竞态消失）
- **MP4 内嵌声跨段**：内嵌声跟着新元素走，无残留
- **播放头 / 画面脱节**：新元素从源偏移起播，墙钟驱动 seek 校准保留

### 5.3 视频内嵌声的音量

新元素创建时：`v.muted = !(gain > 0)`（轨/段静音时静音元素本身），`v.volume = gain`。

---

## 6. 导出共享语义（Phase D，改 main.py）

### 6.1 抽统一换算函数

```python
def _playback_graph(draft):
    """Python 版语义层：与 playback-graph.js 逐字段对拍（tools/graph_consistency.py）。"""
    # 输出 audioClips / videoNodes，字段与 §3.2 完全一致
    # 内建：兼容兜底（§3.3）+ resolveGain（§3.4）+ 素材解析（resolveSegPath 的 Python 对应）
```

### 6.2 export_draft 改吃它

- `export_draft`（L3262）里视频/音频段映射（L3390/L3410）**不再自己拼换算**，改为遍历 `_playback_graph(self.draft)` 的平铺结果：
  - `start/duration` → `Timerange(clip.startUs, clip.durationUs)`
  - `source_timerange` → `Timerange(clip.srcStartUs, clip.srcEndUs - clip.srcStartUs)`
  - `volume` → `clip.gain`；`speed` → `clip.speed`
  - 关键帧/遮罩仍走原有 `_seg_anims/_seg_masks`（这些不动，只换时间/音量/变速来源）
- 保留现有 skipped 容错逻辑（重叠跳过等）

### 6.3 解决什么问题

- **预览 ≠ 导出的缝**：两端读同一平铺结果（公式一致 + 对拍保证）
- 以后加字段（如新特效参数）：只改规范 + 两端实现 + 对拍一次

---

## 7. 播放中外部修改（Phase E，改轮询链路）

### 7.1 现状问题

播放时 `renderTimeline` 冻结 + `renderPreviewMaybe` 播放期 return（防撕裂），但 **AI 在播放中改 draft → 轮询刷新被冻结 → 播的还是旧时间轴**（"AI 放的对，我看的错"的机制之一）。

### 7.2 改法

```
refresh()（HTML L2316 附近）：
  拿到新 draft 后，先比较版本指纹（JSON 结构 hash，轻量）
  若变化 且 isPlaying：
    graph = buildPlaybackGraph(newDraft)     // 重平铺（纯函数）
    AudioEngine.setClips(graph.audioClips)   // 增量：新 clip 进调度，删的 stop
    视频节点 diff → 增删重建对应元素         // 不中断播放头墙钟
  若变化 且 !isPlaying：走现有 renderAll（时间轴+预览刷新）
```

- 时间轴 DOM 仍冻结（防撕裂）——但**播放内容**实时反映 AI 修改
- 播放头墙钟不动（master 纪律不变）

### 7.3 解决什么问题

- AI 播放中改时间轴，你看到的和 AI 放的立即一致
- 不引入"播放中重绘时间轴"的撕裂风险

---

## 8. 缩略图显示（Phase F，独立小项，同批顺手）

- 后端 `thumbnail` 已有 → 前端时间轴段渲染（renderer.js / timeline.js）加缩略图 `<img>`（宽 ~64px，video 段用，失败回落纯色）
- 0.5h，不阻塞其它 Phase，但它是 V6 验收项，建议同批

---

## 9. 切换纪律与风险

### 9.1 原子切换（用户已拍板）

```
落地顺序（每步独立 commit，可回退）：
  A. playback-graph.js + main.py _playback_graph() + tools/graph_consistency.py（对拍跑通）
  B. audio-engine.js（独立文件，先不接线，单元验证解码/调度）
  C. media.js destroy() 实现 + 跨段重建（video 路径切换）
  D. export_draft 切语义层（对拍 + 导出真机验证）
  E. 轮询重平铺（播放中修改）
  F. 缩略图
验收：V1~V6 统一跑（不中途验收 —— 中途状态必然不一致，会误导）
```

### 9.2 风险与缓解

| 风险 | 缓解 |
|------|------|
| decodeAudioData 大文件内存 | LRU 缓存上限 8 个素材 + 按需解码 |
| WebView2 AudioContext 限制 | 现有 unlockAudio 手势解锁复用 ✅ |
| 拖动/seek 后调度错乱 | stopAll + setClips 重排（seek 路径已接） |
| 视频重建瞬间闪 | 旧元素最后一帧 + opacity 过渡遮闪（0.15s） |
| 两端平铺不一致 | 对拍脚本进 tools/，每次改字段必跑 |
| 音频变速音调 | change_pitch（保调）后置：先保证变速时长/节奏对 |

### 9.3 工期（诚实估计）

| Phase | 工期 |
|-------|------|
| A 语义层（两端+对拍） | 0.5-1 天 |
| B 音频引擎 | 1 天 |
| C 视频重建 | 0.5 天 |
| D 导出切换 | 0.5 天 |
| E 播放中修改 | 0.5 天 |
| F 缩略图 | 0.5h |
| **合计** | **2-3 天** |

---

## 10. 完成后的形态

```
draft
  → buildPlaybackGraph（唯一换算点：源窗口/变速/音量/兼容）
      ├── 播放：AudioEngine（audio 轨 Web Audio）+ 视频独立元素（video 内嵌声）
      ├── 导出：export_draft 消费同一平铺结果
      └── 对拍：tools/graph_consistency.py 保证两端恒等
→ 预览 = 导出（同一语义）
→ 跨段无声/卡帧（状态机竞态）→ 架构消除
→ AI 播放中修改 → 实时反映
```
