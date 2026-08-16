# 播放器根治 · 捆绑版实施方案（Playback Graph 原子切换包）

> 版本：**v1.3 三审修正版**（2026-08-16，经三轮独立 Agent 代码级审查）
> 依据：OpenCut 三份源码全扒 + 我们现状三链代码级侦察 + 独立审查报告（一审 agent-c32a318f / 二审 agent-c9f38739 / 三审"小扭扭"）
> 定位：**不是补丁，是把"同一份时间轴数据被多套逻辑各自算"收成"一套语义层 + 所有消费方同步切换"**。中途状态必然不一致，所以 6 件必须同批改完，统一验收。
>
> **v1.1 修正记录**（一审打脸 → 已修）：
> 1. ❌→✅ §1.1：跨段**不是** setMediaSrc+seek+play，是**同元素只 seek+play、src 恒定**（player.js:416-417 明令"绝不复建/改 src"）——"不换 src"是现有纪律，Phase C 将其翻转，两套纪律必须一次收敛（§5.1）
> 2. ❌→✅ §1.2：导出**就是在自己算第二套换算**（不是"读字段"）——对拍 diff 面比 v1.0 预估大
> 3. 🆕 §1.1：**预览播放从不变速**（全项目无 playbackRate）——speed 只影响 UI 面板+导出；V2 验收实质依赖 B 落地
> 4. ❌→✅ §1.4：缩略图**前端已实现**（timeline.js:130-139 background-image 瓦片）——Phase F 改为只修 material_id 缺口，不重复实现
> 5. 🆕 §4.2：Phase B 前置 **CORS 坑**——本地服务器 main.py:69-93 无 ACAO 头，fetch decodeAudioData 会被拦截，先加头
> 6. ✅ 修正：destroy() 实际在 media.js:38-41（非 L67），且 pool 是死代码（grep 无任何调用）
>
> **v1.2 修正记录**（二审打脸 → 已修）：
> 7. ❌→✅ **R5 CORS 是误诊（二审推翻）**：页面本身走本地 HTTP 加载（main.py:3908 url=HTTP_URL，origin=http://127.0.0.1:PORT），与媒体服务器**同源**，fetch 不会被 CORS 拦截。v1.1 的 §4.2 CORS 前置**撤销**——无需 ACAO 头；仅当未来改用 file:// 打开页面时才需要
> 8. 🆕 **S2-1 §4.2 伪代码 bug**：`schedule()` 内 `await` 但函数非 async → SyntaxError，照抄即崩；已改 `async schedule(c)`
> 9. 🆕 **S2-2 §4.2 时钟基准缺陷（二审最实质发现）**：tick 用 `ctx.currentTime`（AudioContext 创建以来的绝对秒）与时间轴秒（startUs/1e6）直接比较，基准不一致——seek 后 MP3 会不响/错位响。已设计 anchor 偏移换算（§4.2）
> 10. 🆕 **S1 §5.1 收敛边界补全**：startPlay 起播（player.js:342）是第三条建元素触发点；previewState key 是轨级（"video:0"）非段级——destroy 按轨 key 删元素后跨段重建，与 mediaClockReady/crossSegmentPending 状态机衔接需显式处理
>
> **v1.3 修正记录**（三审"小扭扭"打脸 → 已修）：
> 11. 🔴 **§3.4 resolveGain 拆两层（三审问题 2，唯一会直接导致导出声错的逻辑 bug）**：`resolveGain` 原签名把 `previewMuted` 塞进统一公式——但导出端（Phase D）根本没有 previewMuted 概念（export_draft main.py:3382 只判 `track_muted or seg.muted`，导出正确不受预览静音影响）。若导出吃"含 previewMuted 的 gain"→ 预览静音时导出也静音（错）。**已拆**：`resolveGain(trackMuted, segMuted, segVolume)` 为两端共享（不含 previewMuted）；previewMuted 只在 JS 播放端叠加（`finalGain = previewMuted ? 0 : resolveGain(...)`）
> 12. 🟠 **§6 Phase D 工期与对象链（三审问题 3）**：关键帧/遮罩绑定在同一 vseg 对象（main.py:3388-3398 VideoSegment 一体建）——改吃平铺后对象构建链要整体重排，非"只换参数来源"。工期 0.5 天 → **1 天**
> 13. 🟠 **§7 Phase E 与 Phase C 衔接（三审问题 4）**：播放中视频重建走 Phase C 的 destroy 路径 + 复用"重建中禁止再次触发跨段"锁（§5.1），方案原未写清
> 14. ⚠️ **行号核对（三审问题 1，部分成立）**：现查 v0.9 源码——大部分引用行号准确（audioCtx 25 / resolveHits 40 / _handleCrossSegment 475 / playTick 500 / seekActiveMediaToPlayhead 419 / destroy 39 / handleCrossSegment 494 / renderer setMediaSrc 46+232 / export_draft 3377-3387 / renderPreviewMaybe 837 / renderAll 866 / refresh 2316），**仅 startPlay 漂移：实际 342（方案曾写 347）**。已修正为 342。结论：文档行号基本可信，但落地时仍以 grep 现查为准

---

## 0. 统一验收标准（整体完成后一次跑，不中途验收）

对测试项目（`粗剪_IMG_4379_v2.mp4` 3 段 + `王悦辰.mp3` 3 段，17s，上下对齐）：

| # | 验收项 | 通过标准 | 依赖 |
|---|--------|---------|------|
| V1 | 跨段播放 | 播放 17s 全程：有画面、不卡帧、**跨段有声**（原冻结项消失） | B+C |
| V2 | 变速+音量 | 段变速 2x / 音量 0.5：预览听感 = 导出到剪映后听感（比例一致） | **B 落地后才可验收**（预览不变速是现状缺口，v1.1 已记录） |
| V3 | 静音链 | 全局静音 / 轨静音 / 段静音 三档各自生效，且预览=导出 | B+D |
| V4 | AI 播放中修改 | 播放中 MCP 加/删/移段，播放器 1 秒内反映新时间轴（不中断播放头） | E |
| V5 | 老存档兼容 | 缺 src_start/speed/material_id 的旧段：正常播放、正常导出 | A 兜底 |
| V6 | 缩略图 | material_id 场景下时间轴视频段显示缩略图（常规场景已实现，v1.1 修正） | F |

---

## 1. 现状画像（代码级事实，侦察于 2026-08-16）

### 1.1 播放链（player.js，546 行）
- `resolveHits(us)`（L40）：**每帧**遍历全部轨道找命中段（playTick L539 每帧调）—— 大时间轴逐帧全扫
- `playTick()`（L500）：墙钟推进播放头 ✅（此层已对齐 OpenCut，不动）
- **跨段现状（审查实锤，v1.0 描述有误）**：`keySig` 变化 → `PlayerManager.handleCrossSegment`（media.js:494）→ `_handleCrossSegment`（player.js:475）→ `seekActiveMediaToPlayhead` + `playAllMedia(HANDOFF)`——**同元素只 seek+play，src 恒定**（player.js:416-417 明令"绝不复建/改 src/重跑 render"）。`setMediaSrc` 只发生在 renderPreview，而播放期 renderPreview 冻结 → **播放中跨段从不换内容**
  - ⚠️ 推论：**同轨相邻段若来自不同素材文件，播放器会播错内容**（旧 src 的偏移画面）——现有"不换 src"纪律的固有缺陷，Phase C 必须同时修
- `PlayerManager`（media.js L17）：`destroy()` 是 **TODO 空壳**（media.js:38-41），`pool: Map()` 是**死代码**（grep 无任何 pool.set/get/delete/clear 调用）——元素永不销毁，元素生命周期实际挂在 previewState.visualEls/audioEls
- 音频：`<audio>`/`<video>` 元素 play/pause/seek（WebView2 状态机 = 8 个补丁修不好的根源）
- 🆕 **预览不变速（审查发现）**：全项目 JS **无 playbackRate**（grep 零命中）——speed 只在 UI 面板（HTML:1024 set_segment_speed 提交）和导出生效，**预览播放从不应用变速**。V2 验收（变速预览=导出）实质依赖 Phase B 落地

### 1.2 导出链（main.py export_draft，L3262）
- 视频段（L3377-3387）：`ss = seg.get("src_start", 0)` + `se_ = seg.get("src_end", ss+duration)` + `Timerange(ss, se_-ss)` + `vol = 0.0 if (track_muted or seg.muted) else seg.volume` + `_seg_speed(seg)` + `change_pitch` + 关键帧 + 遮罩
- 音频段（L3413-3421）：同构
- **结论（审查实锤，v1.0 自相矛盾已修）**：导出层**就是在自己拼第二套换算**（default 兜底、se_-ss 差、_seg_speed clamp、轨/段静音判断）——不是"读字段"。它和播放器侧（media.js:445-457 PlayerManager.seek 的 src 偏移换算）是**两套独立实现的换算**，这正是"预览≠导出"的缝

### 1.3 音量链（三层分散）
- 全局：`previewMuted`（player.js L19，**唯一写点** media.js:422 setGlobalMute 内，其余全为读取——审查修正"写点 3+ 处"）
- 轨级：`isTrackMuted(type, ti)`（player.js L291）
- 段级：`seg.muted` / `seg.volume`（renderer.js L92/L217/L226 应用）
- **判定逻辑不统一**（审查实锤）：`shouldMediaBeMuted`（previewMuted || autoplayUnlockPending || mediaMuteReasons）与 `wantSound`（!previewMuted && !isTrackMuted）两套判定并存；audio 轨静音段在 renderer.js:217 被 filter 掉**不建元素**，而 video 静音段建元素置 muted——行为模式不一致真实存在

### 1.4 缩略图
- 后端：素材有 `thumbnail` 字段（已生成：main.py:1499 `_make_thumbnail` + import_media_by_paths 抽帧 + L3870 `_ensure_video_thumbnails`）✅
- 前端：**已实现**（审查实锤）——timeline.js:130-139 makeSeg 用 `background-image:url(...)` 瓦片平铺 + 素材面板 HTML:788 也已用。**唯一真缺口**：makeSeg 用 `s.path` 而非 `resolveSegPath`，段仅含 material_id 无 path 时缩略图缺失（Phase F 只修这个）

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
  speed,                     // 变速（default 1）；⚠️ v1.1：预览端目前不变速（无 playbackRate），B 落地后本字段才在预览生效；导出端立即生效
  gain,                      // 统一音量解析结果（0~2）；⚠️ v1.3：= resolveGain(...) **不含 previewMuted**（预览静音在播放端叠加，导出端不受影响）
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

### 3.4 统一音量解析 resolveGain（三层收敛成一个函数）—— ⚠️ v1.3：拆两层，previewMuted 只在播放端叠加

**v1.3 关键修正（三审问题 2）**：previewMuted（全局预览静音）是**预览专用**概念，导出端（export_draft main.py:3382）正确只判 `track_muted or seg.muted`——导出不该受预览静音影响。因此 resolveGain **不能**把 previewMuted 塞进两端共享公式，拆两层：

```js
// 第一层：两端共享（播放 + 导出都用）——不含 previewMuted
function resolveGain(trackMuted, segMuted, segVolume) {
  if (trackMuted) return 0;
  if (segMuted) return 0;
  return segVolume == null ? 1 : segVolume;
}
// 第二层：仅 JS 播放端叠加全局预览静音
function finalPlaybackGain(previewMuted, trackMuted, segMuted, segVolume) {
  if (previewMuted) return 0;
  return resolveGain(trackMuted, segMuted, segVolume);
}
```

> 用法：`clip.gain` = `resolveGain(...)`（两端一致，导出直接吃）；播放端消费时再乘 previewMuted（`AudioEngine.schedule` 里 `g.gain.value = previewMuted ? 0 : clip.gain`）。
> OpenCut 用 dB 制（audio-state.ts resolveEffectiveAudioGain）；我们保持线性（volume 0~2，剪映也是线性 volume）——**两端用同一公式即可，不必迁 dB**。

### 3.5 平铺换算（唯一换算点，替代散落逻辑）

```
每段：
  srcStartUs' = src_start（兜底 0）
  srcEndUs'   = src_end（兜底 src_start+duration）
  speed'      = speed（兜底 1）
  gain'       = resolveGain(trackMuted, segMuted, segVolume)   // v1.3：不含 previewMuted（播放端另叠）
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

> ✅ **v1.2 修正（二审推翻 v1.1 的 CORS 误诊）**：页面经本地 HTTP 加载（main.py:3908 url=HTTP_URL，origin=http://127.0.0.1:PORT），与媒体服务器**同源**——fetch decodeAudioData **不会被 CORS 拦截，无需 ACAO 头**。仅当未来改用 file:// 打开页面时才需要加 `Access-Control-Allow-Origin`。此条从 v1.1 的"前置条件"降级为"备忘"。

> ⚠️ **v1.2 时钟基准设计（二审 S2-2，B 落地必读）**：`ctx.currentTime` 是 AudioContext 创建以来的绝对秒（player.js:25 页面加载即建），与时间轴坐标秒（startUs/1e6）**基准不一致**——直接比较会导致 seek 后 MP3 不响/错位响。必须在 `setClips` 时锚定偏移：

```js
const AudioEngine = {
  ctx,                       // 复用现有 audioCtx（player.js L25 已有 + unlockAudio 手势解锁 ✅）
  bufferCache: new Map(),    // path → AudioBuffer（LRU，上限 8 个素材，超限逐出最久未用）
  scheduled: new Set(),      // 已调度 BufferSourceNode
  clips: [],                 // 当前 graph.audioClips 快照
  anchorOffset: 0,           // v1.2：ctx 秒 ↔ 时间轴秒 的偏移换算锚点

  // v1.2：锚定。playheadUs 为当前播放头（时间轴坐标）。
  // 原则：时间轴秒 T 对应的 ctx 时刻 = T + anchorOffset（由本次 setClips 时的播放头位置决定）
  setAnchor(playheadUs) {
    this.anchorOffset = this.ctx.currentTime - playheadUs / 1e6;
  },
  timelineToCtx(us) { return us / 1e6 + this.anchorOffset; },

  async setClips(clips, playheadUs) {      // 平铺结果喂进来（播放前 / 播放中重平铺 / seek 后）
    this.stopAll();                        // 清掉已调度 source
    this.setAnchor(playheadUs);            // v1.2：每次重排都重新锚定（seek 后基准才正确）
    this.clips = clips;
    this.tick();                           // 立即扫一次
  },
  async tick() {                           // 每 500ms 扫未来 2s（setInterval 驱动）
    const now = ctx.currentTime;           // ctx 绝对时钟
    const horizon = now + 2.0;
    for (const c of this.clips) {
      if (c.scheduled) continue;
      const clipStartCtx = this.timelineToCtx(c.startUs);   // v1.2：时间轴秒 → ctx 秒（含偏移）
      if (clipStartCtx >= now && clipStartCtx < horizon && c.gain > 0) {
        this.schedule(c);
      }
    }
  },
  async schedule(c) {                      // v1.2：补 async（原伪代码漏了，SyntaxError）
    const buf = await this._decode(c.path);       // decodeAudioData，带缓存
    if (!buf) return;                             // 解码失败：跳过该段，控制台警告
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed;             // 变速（音调随变；change_pitch 后置）
    const g = ctx.createGain();
    g.gain.value = previewMuted ? 0 : c.gain;   // v1.3：previewMuted 只在播放端叠加（clip.gain 不含它）
    src.connect(g).connect(ctx.destination);
    const offset = c.srcStartUs / 1e6;            // 源窗口起点（buffer 内偏移，与 ctx 无关）
    const startCtx = this.timelineToCtx(c.startUs); // v1.2：到点出声（含 anchor 偏移）
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
| `startPlay()`（L347） | 播放前：`AudioEngine.setClips(graph.audioClips, Store.state.playheadUs)`（v1.2：带播放头锚定偏移） |
| `pausePlay()` | `AudioEngine.stopAll()` |
| `seekActiveMediaToPlayhead`（L419） | seek 后：`AudioEngine.setClips(graph.audioClips, 新播放头)`（重排调度 + 重新锚定） |
| `playTick` 跨段分支（L541） | 不再操作 audio 元素；`keySig` 变化仅重排 video 元素（Phase C） |

### 4.4 解决什么问题

- **MP3 跨段无声**（冻结项核心）：每段独立 BufferSource 到点出声，无"交接"动作
- **audio 元素状态残留**：不再有 `<audio>` 元素的 play/pause/seek 竞态
- **变速**：playbackRate 直接生效（预览与导出一致：导出 speed 也是 playbackRate 语义）

---

## 5. 视频独立元素（Phase C，改 media.js / renderer.js）

### 5.1 原则：**跨段不复用，销毁重建** —— ⚠️ v1.1：这是对现有"不换 src"纪律的**翻转**，必须一次收敛

**审查实锤的纪律冲突**：现有跨段路径（player.js:416-417）明令"绝不复建/改 src"；setMediaSrc 只发生在 renderPreview（renderer.js:46/232），而播放期 renderPreview 冻结 → 播放中跨段**从不换内容**（同轨不同素材相邻会播错内容）。Phase C 改为"销毁重建 + 新元素 setMediaSrc"，行为翻转。

**收敛要求（避免比现状更糟）**：
```
Phase C 落地时，把三条路径合并成单一策略：
  ① renderPreview（renderer.js:46/232 的 setMediaSrc 点）—— 非播放期建元素
  ② seekActiveMediaToPlayhead（player.js 复用纪律）—— 播放期跨段
  ③ startPlay 起播（player.js:342 调 renderPreview）—— 起播建元素（v1.2 补：一审只列了 ① ②，第三条触发点漏了；v1.3 行号核实：342 非 356）
→ 统一为：元素只属于"一个段"，段变化 = 销毁旧 + 建新（含 setMediaSrc）
→ 绝不存在"换 src 路径"与"不换 src 路径"并存
```

> ⚠️ **v1.2 收敛边界补全（二审 S1）**：
> - **key 是轨级不是段级**：previewState.visualEls/audioEls 的 key 形如 `"video:0"`（轨级），不是 `"video:0:0"`（段级）。destroy 按轨 key 删元素后，同轨下一段跨段需重建——**"轨级 key ↔ 段级元素"的映射必须在 C 落地时显式定义**（方案：destroy 后由跨段路径立即建新元素，key 保持轨级，元素引用刷新）
> - **重建与状态机衔接**：`_handleCrossSegment` 依赖 `mediaClockReady`/`crossSegmentPending`（player.js:481-497）。销毁重建会让新元素经过 loading→canplay→playing，800ms mediaClockReady 回退窗口（playTick D 分支）要覆盖这段重建期，否则重建期间播放头提前走到下一段又触发一次重建（振荡）。C 落地时显式处理"重建中禁止再次触发跨段"

现状：`PlayerManager.destroy()` 是 TODO 空壳（media.js:38-41）——补实现（注意 pool 是死代码，元素实际在 previewState 里，destroy 要按 key 从 previewState 找元素）：

```js
destroy(key) {
  // 元素在 previewState.visualEls / audioEls（pool 是死代码，v1.1 修正）
  const rec = previewState.visualEls.get(key) || previewState.audioEls.get(key);
  const el = rec ? (rec.el.firstElementChild || rec.el) : null;
  if (!el) return;
  el.pause();
  el.removeAttribute("src");   // 关键：清 src 触发元素彻底复位
  el.load();                   // 复位解码状态（消灭 WebView2 状态残留）
  el.remove();                 // 从 DOM 移除
  if (rec) previewState.visualEls.delete(key) || previewState.audioEls.delete(key);
}
```

跨段时（`handleCrossSegment`）：
```
旧 video 元素：保留显示最后一帧（CSS opacity 过渡遮闪）→ 新元素 ready 后移除
新 video 元素：PlayerManager.create → setMediaSrc(新段源窗口) → seek 到源偏移 → play
```

> 注意：VideoNode 里要带 path + 源窗口，跨段时据此判断"是否同素材同窗口"——若同素材同窗口（如同一 MP4 的相邻切片）可考虑轻量 seek 而非重建；不同素材才重建。**收敛策略里允许这个优化，但默认先全重建（简单、正确）**。

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

### 6.2 export_draft 改吃它 —— ⚠️ v1.3：不是"只换参数来源"，是对象构建链重排

- `export_draft`（main.py L3262）里视频/音频段映射（L3377-3387 / L3413-3421）**不再自己拼换算**，改为遍历 `_playback_graph(self.draft)` 的平铺结果：
  - `start/duration` → `Timerange(clip.startUs, clip.durationUs)`
  - `source_timerange` → `Timerange(clip.srcStartUs, clip.srcEndUs - clip.srcStartUs)`
  - `volume` → `clip.gain`（⚠️ v1.3：clip.gain 不含 previewMuted，导出天然正确）；`speed` → `clip.speed`
  - 关键帧/遮罩仍走 `_seg_anims/_seg_masks`
- **v1.3 修正（三审问题 3）**：当前导出循环里 VideoSegment 是一体建的（main.py:3388-3398：`vseg = VideoSegment(path, t, **kwargs)` → `_apply_keyframes_to_segment(vseg,...)` → `_apply_mask_to_segment(vseg,...)`），关键帧/遮罩**绑定在同一个 vseg 对象**上。改吃 graph 平铺后，循环结构要从"遍历 self.draft[track]"改成"遍历 graph 的节点列表"，对象构建链整体重排（vseg 的构造参数来源、关键帧/遮罩的挂载时机都要动）——**工期按 1 天估，不是 0.5 天**
- 保留现有 skipped 容错逻辑（重叠跳过等）

### 6.3 解决什么问题

- **预览 ≠ 导出的缝**：两端读同一平铺结果（公式一致 + 对拍保证）
- 以后加字段（如新特效参数）：只改规范 + 两端实现 + 对拍一次

---

## 7. 播放中外部修改（Phase E，改轮询链路）

### 7.1 现状问题

播放时 `renderTimeline` 冻结 + `renderPreviewMaybe` 播放期 return（防撕裂），但 **AI 在播放中改 draft → 轮询刷新被冻结 → 播的还是旧时间轴**（"AI 放的对，我看的错"的机制之一）。

### 7.2 改法 —— ⚠️ v1.3：与 Phase C 的衔接写清（三审问题 4）

```
refresh()（HTML L2316 附近）：
  拿到新 draft 后，先比较版本指纹（JSON 结构 hash，轻量）
  若变化 且 isPlaying：
    graph = buildPlaybackGraph(newDraft)     // 重平铺（纯函数）
    AudioEngine.setClips(graph.audioClips)   // 增量：新 clip 进调度，删的 stop
    视频节点 diff → 增删重建对应元素         // 不中断播放头墙钟
  若变化 且 !isPlaying：走现有 renderAll（时间轴+预览刷新）
```

**v1.3 衔接规则（三审问题 4）**：Phase E 的视频重建**必须走 Phase C 的 destroy 路径**（同一套销毁→建新逻辑），并**复用 §5.1 的"重建中禁止再次触发跨段"锁**（crossSegmentPending / mediaClockReady 覆盖重建期）——否则 Phase E 的"播放中 diff 重建"和 Phase C 的"跨段重建"会同时操作 previewState，造成两套时序互踩。一句话：**Phase E 只负责"发现变化 + 触发重平铺"，元素操作全部委托 Phase C 的机制**。

- 时间轴 DOM 仍冻结（防撕裂）——但**播放内容**实时反映 AI 修改
- 播放头墙钟不动（master 纪律不变）

### 7.3 解决什么问题

- AI 播放中改时间轴，你看到的和 AI 放的立即一致
- 不引入"播放中重绘时间轴"的撕裂风险

---

## 8. 缩略图补缺（Phase F，独立小项，同批顺手）—— ⚠️ v1.1：已实现部分不重复做

**审查实锤**：缩略图前端已实现（timeline.js:130-139 background-image 瓦片平铺 + 素材面板 HTML:788）。**Phase F 只修唯一真缺口**：

- makeSeg（timeline.js）用 `s.path` 而非 `resolveSegPath` → 段仅含 material_id 无 path 时（store.js:86-96 未来去 path 化场景）缩略图缺失
- 改法：makeSeg 缩略图取值改用 `resolveSegPath(s)`（与渲染层一致），~0.5h
- 不重复实现 <img> 方案，不碰已有 background-image 瓦片

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
  F. 缩略图补缺（只修 material_id 场景，不重复实现）
验收：V1~V6 统一跑（不中途验收 —— 中途状态必然不一致，会误导）；V2 依赖 B/C 先落地

**v1.3 补充（三审弱逻辑提醒）**：A 阶段**本质不可独立验收**——对拍全绿只能证明"JS 平铺 == Python 平铺"（结构一致），证明不了"播放正确"（预览不变速是现状缺口）。因此 A 的验收标准 = **结构对拍一致 + 静态走查**（字段表逐项核对），V2 真机验证整体后置到 B/C 落地后。落地 A 后**不要误以为已经搞定播放器**。
```

### 9.2 风险与缓解（v1.1 新增 3 行 ⚠️）

| 风险 | 缓解 |
|------|------|
| decodeAudioData 大文件内存 | LRU 缓存上限 8 个素材 + 按需解码 |
| WebView2 AudioContext 限制 | 现有 unlockAudio 手势解锁复用 ✅ |
| 拖动/seek 后调度错乱 | stopAll + setClips 重排（seek 路径已接） |
| 视频重建瞬间闪 | 旧元素最后一帧 + opacity 过渡遮闪（0.15s） |
| 两端平铺不一致 | 对拍脚本进 tools/，每次改字段必跑 |
| 音频变速音调 | change_pitch（保调）后置：先保证变速时长/节奏对 |
| ⚠️ **CORS 拦截 fetch 解码**（一审提出、**二审推翻=误诊，v1.2 撤销**） | 页面经本地 HTTP 同源加载（main.py:3908），无需 ACAO；仅当未来 file:// 打开页面才需要加头 |
| ⚠️ **AudioEngine 时钟基准**（二审发现，最实质） | setAnchor 锚定偏移（§4.2 timelineToCtx），每次 setClips/seek 重新锚定 |
| ⚠️ **"换 src/不换 src"两套纪律并存**（一审发现） | Phase C 一次收敛成单一策略（§5.1，含 startPlay 第三条触发点 + 轨级 key 映射 + 重建期防振荡） |
| ⚠️ **假对拍**：A 单独落地时对拍全绿但预览不变速（一审发现） | speed 字段标注"预览端待 B 接管"；V2 验收排在 B/C 后（§0 已标依赖） |
| ⚠️ **resolveGain 污染导出端**（三审发现，唯一会导出声错的逻辑 bug） | v1.3 已拆两层：clip.gain 不含 previewMuted，导出直接吃；previewMuted 播放端叠加（§3.4） |

### 9.3 工期（诚实估计）

| Phase | 工期 |
|-------|------|
| A 语义层（两端+对拍） | 0.5-1 天（验收=结构对拍+静态走查，非真机） |
| B 音频引擎 | 1 天 |
| C 视频重建 | 0.5 天 |
| D 导出切换 | **1 天**（v1.3：对象构建链整体重排，非 0.5） |
| E 播放中修改 | 0.5 天 |
| F 缩略图 | 0.5h |
| **合计** | **2.5-3.5 天** |

---

## 10. 完成后的形态

```
draft
  → buildPlaybackGraph（唯一换算点：源窗口/变速/音量/兼容）
      ├── 播放：AudioEngine（audio 轨 Web Audio，含变速 playbackRate）+ 视频独立元素（video 内嵌声）
      ├── 导出：export_draft 消费同一平铺结果
      └── 对拍：tools/graph_consistency.py 保证两端恒等
→ 预览 = 导出（同一语义）
→ 跨段无声/卡帧（状态机竞态）→ 架构消除
→ 同轨不同素材相邻 → 播正确内容（v1.1：现有"不换 src"缺陷一并修）
→ 预览变速 → 随 B 落地生效（v1.1：现状不变速缺口补上）
→ AI 播放中修改 → 实时反映
```
