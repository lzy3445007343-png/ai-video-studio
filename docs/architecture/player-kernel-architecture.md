# 播放器内核架构（2026-08-16 根治收官·冻结基线）

> 状态：**已冻结**（V1-V6 真机全过，commit `19555e6`）。后续任何播放器改动必须过回归（V1-V6 + REGRESSION.md）。
> 本文把 2026-08-16 两天踩坑的**最终形态**固化：为什么这样设计、哪些是 WebView2/标准库的硬坑、未来元素（关键帧/蒙版/特效/文本）怎么接入而不动内核。
> 配套文档：`playback-rootfix-bundled.md`（方案演进史）、`video-player-pool-ab-design.md`（MediaSlot 设计稿）、`audio-engine-migration.md`（C.0 迁移稿）。

---

## 0. 一句话总览

```
Timeline(draft JSON)  ←── Command/MCP 层可改（未来 AI 入口）
        │
        ▼
   Player：播放头墙钟 = 唯一 MasterClock（playTick 每帧推进）
        │
   ┌────┴───────────────┐
   ▼                    ▼
 Renderer(视频 MediaSlot)   AudioEngine(Web Audio lookahead)
```

**时间权威铁律：播放头墙钟是 master，视频/音频都是 follower，自己追上播放头。** 媒体时钟（video.currentTime / AudioContext.currentTime）只做辅助校准，绝不反写播放头。

---

## 1. 媒体数据通道（本次根治的根基）

### 1.1 file:// 为什么不行
WebView2（Chromium）安全策略禁止 `file://` 文档加载本地媒体（本地文件访问限制）。V0.1 能播是当时的加载方式/WebView2 版本放行，现代版本已封死。**必须走 HTTP**（`http://127.0.0.1:8080/local/<编码后的绝对路径>`）。

### 1.2 HTTP 下 seek 依赖 Range——标准库的坑
- Chromium 视频元素要 seek 到**当前缓冲范围外**，必须发 `Range: bytes=...` 请求拿该位置的字节；服务器不支持 Range（返回 200 全量）时，**必须下载完整文件才能定位**（大文件 = seek 阻塞 1-3 秒 + currentTime 永远不落位）。
- **Python 标准库 `SimpleHTTPRequestHandler` 从不支持 Range**（源码无 206 分支，社区长期吐槽 "Chrome cannot seek on servers without Range support"）。main.py 注释"支持 Range"是错误假设，实测 200 全量。
- 修复：`_SilentHTTPRequestHandler._serve_file()` 手动实现 206 Partial Content（见 main.py，含 `bytes=start-end / start- / -suffix`、越界 416、**off-by-one：HTTP Range 含结束偏移**，`bytes=0-1023` → 1024 字节）。

### 1.3 8080 端口混听（隐形帮凶）
- `allow_reuse_port=True`（Windows）允许多进程同绑 8080，连接随机分发——**旧版 main.py 残留进程会随机接走新连接**，表现"改了代码没生效/行为随机"。
- 混听根源：**MCP server（mcp_server.py）`import main` → 触发模块级 `_start_local_server()` → 又绑 8080**，WorkBuddy 拉起 MCP 时就会带一个服务器，杀一个冒一个。
- 防线：`start.bat` 启动前杀干净 `*ai-video-studio*main.py*` 进程；**main.py 代码一致后混听无害**（任何新拉起进程都是新代码）。

---

## 2. 视频播放：MediaSlot A/B 双槽（renderer.js / player.js）

### 2.1 WebView2 的核心坑
**video 元素 seek 到当前缓冲范围外 → 媒体管线重置（readyState 4→1，位置丢失）→ 反复播开头/从 0 起播。** 这是浏览器固有行为，打补丁修 seek 时机无效。

### 2.2 对策：把"重置"移出用户视线
- **每轨双槽**：`active`（正在播）+ `prepare`（后台预加载下一段）。
- `preloadNextVideoSlot()`：buildPlaybackGraph 找同轨下一段 → prepare 槽建元素 + setMediaSrc + 后台 seek → canplay 后确认 currentTime 到位 → **READY**。
- 跨段 `SWAP`：prepare READY → 旧 active 转 prepare（后台加载 N+2），prepare 转 active 直接播——**切段无感**。
- prepare 未 READY → 降级原 destroy+重建兜底。
- 状态机：`EMPTY/LOADING/READY/ACTIVE/STUCK`（STUCK = canplay 但 currentTime 未到位，防伪 ready）。

### 2.3 边界
- `SWAP` 必须校验 `rec._preloadKey === h.key`——拖动回跳（段2→段0）时 prepare 预加载的是段3，误 swap 会播错内容。
- 间隙（无素材区间）时 visualHits 空 → playTick 手动补 prepare 调度。
- destroy 判断用 `key`（轨:段索引）而非 `path`：同素材相邻段 path 相同但段不同，必须重建；轮询刷新 key 不变则不重建。

---

## 3. 音频播放：AudioEngine 实时锚定（audio-engine.js）

### 3.1 机制
Web Audio `BufferSourceNode` + 500ms lookahead 调度：每 clip 提前解码，到时间轴起点即 `src.start(startCtx, offset, dur)`。audio 轨不建 `<audio>` 元素（renderer 只算 audioHits 语义），MP3 等独立音频轨全走引擎；MP4 内嵌声仍走 video 元素。

### 3.2 为什么"一次性锚定"会跨段无声（本次根治的核心）
- AudioContext 时钟与播放头墙钟存在 **~0.166s 系统性偏差**（resume 异步 + 时钟基准差异）。
- 旧代码只在 setClips 时 `anchor = ctx.currentTime - playheadUs` 锚定一次 → 播放头到 6s 切段时重排 → `clip.startCtx = 6 + anchor ≈ 5.834 < ctx.currentTime(5.840)` → **startCtx 落进"过去"，tick 永不命中 → 第二/三段永不调度**。
- 日志铁证：`setClips us=5004799 anchor=-0.165`（ctx=4.840 时播放头已 5.005）。

### 3.3 实时锚定（修复）
- `AudioEngine.setPlayhead(us)`：**playTick 每帧喂入播放头**。
- tick/schedule 用 `startCtx = clip.startUs/1e6 + (ctx.currentTime - playheadUs/1e6)` 实时换算——**偏差每帧自愈**。
- `schedule(c, startCtxSnapshot)`：decode 是异步的，必须用 tick 调度时刻的 startCtx 快照（decode 完成时播放头已前进，重算会漂移）。
- `PAST_SLACK = 0.5s`：startCtx 略早于 now 立即补播（防 tick 抖动漏调度）；整段已错过（startCtx+dur < now）不补。

### 3.4 跨段不重排（修复）
- **播放中自然跨段绝不 setClips**：lookahead 已按时间轴提前排好，到点自然响；setClips → stopAll 会**硬杀正在播/刚响的 clip**（第一段尾被切 0.38s，第三段反复 stop 出卡顿声）。
- `seekActiveMediaToPlayhead(us, reanchorAudio=false 默认)`：仅起播（player.js startPlay 传 true）/暂停恢复（media.js resume 传 true）/显式同步（syncTimeline 传 true）才重排。
- 日志验证：正常播放全程只有 1 次 `setClips n=3 us=0`（起播）。

### 3.5 纪律
- 时钟锚定相关：`setAnchor/timelineToCtx` 保留兼容但**主路径不用**（用 `_anchorNow`）。
- 解码缓存 LRU（8 素材）；`_epoch` 代际取消防 in-flight 竞态。
- 音频解锁：`unlockAudio()` 必须在用户手势内调 `audioCtx.resume()`（WebView2 自动播放策略）。

---

## 4. 生命周期与纪律（player.js / media.js）

- **PlaySession 状态机**（`STARTING → MUTED_PLAYING → PLAYING → PAUSED`）：事务化激活（`_PLAY_REASON` 枚举 START/RECOVER/HANDOFF/RESUME）。
- **muted 单一写者** `setMediaMute(el, value, reason, label)`：全局唯一 muted 写者（render-cache 的 dataset.muted 除外），所有静音/恢复必须带 reason 走它。
- **止血原则**（B.5.5-STAB）：播放头墙钟绝不被媒体 await 阻塞——prime/seek/play 都是 fire-and-forget，媒体自己追上；drift 只做被动收口（软 seek，禁 pause/play）。
- 跨段统一走 `PlayerManager.handleCrossSegment(us)`（fire-and-forget，不阻塞 RAF）。

---

## 5. 未来扩展点（关键帧 / 蒙版 / 特效 / 文本 —— 差异化武器）

> 原则：**加元素/加轨道不改内核**。MasterClock、AudioEngine、MediaSlot 不感知具体元素类型——它们只消费平铺后的 graph。

### 5.1 现状
- 轨道：video / audio / text / image / sticker（draft.video / audio / text / image / sticker）。
- 关键帧：PropertiesPanel 有关键帧 tab + `applyKfLiveAll()` 每帧刷新（transform/不透明度），但能力弱、无曲线编辑、无图形化。
- 蒙版：**未做**。特效：**未做**（MG 动效未做）。

### 5.2 关键帧（下一步重点）
- 数据模型：segment 内 `keyframes: [{t, prop, value, easing}]`（t=时间轴微秒）。
- 播放：`applyKfLiveAll()` 已有雏形（每帧插值），扩展为**统一插值器**（线性/贝塞尔 easing），支持任意可动画属性（transform / opacity / filter）。
- 与导出一致：导出走同一插值器（预览=导出铁律）。

### 5.3 蒙版
- 播放：renderer 层对元素应用 CSS `clip-path`/`mask`（或未来 canvas 合成）。
- 数据：segment `mask: {shape, params, keyframes}`。
- 口播场景：人像圈住放角落（市面 AI 剪辑标配）——蒙版是差异化刚需。

### 5.4 特效（MG 动效）
- 原语引擎规划：**10~20 个 Agent 可调用原语**（如 fade/zoom/pan/blur/chroma-key…），Skill 组合成效果。
- 播放：renderer filter/transform 扩展点 + 关键帧驱动参数。
- 参考：OpenReel Video（WebGPU 太重，抄思路不抄代码）、FableCut（drawFrame(t) 单一代码路径，与我们"预览=导出"同构）、KubeezCut（全 GPU 转场，同样只抄思路）。
- 用户判断：MG 动效我们做不好，从 GitHub 拉特效/MG 动效源码/方法借鉴——合理，但**接入必须走原语引擎扩展点，不许散落成一次性特效**。

### 5.5 接入流程（未来元素通用模板）
1. Timeline Schema 加字段（含向后兼容兜底，参考现有 `_num`/`_graphVolume` 容错风格）。
2. buildPlaybackGraph 平铺出新字段（两端一致，对拍脚本更新）。
3. renderer 消费新字段（applyKfLive / filter / mask 挂载点）。
4. 导出端同一平铺结果（预览=导出）。
5. MCP 工具暴露操作（走 Command 层审计）。

---

## 6. 冻结基线与回归

- **验收基线**：V1（17s 3+3 段完整播放不反复）、V2（prepare READY 日志）、V3（SWAP 日志）、V4（拖动不播错）、V5（间隙穿过）、V6（连续跳剪）。
- 回归套件：`REGRESSION.md`（R0 基线 + T1-T5 功能 + P1-P5 播放器）。**任何播放器改动后跑一遍**。
- 回退锚点：`git checkout v0.9-freeze`（播放器根治前基线）或按 commit 回退（59ed558 Range / 19555e6 音频）。

## 7. 已知待办（不在冻结范围内）
- 素材缺失检测 + 重链 UI（文件移动后标红 + 手动定位，参考 KubeezCut media relinking）。
- 拖动播放头时音频重排（seekPlayhead 只改状态，同段内拖动音频不重排——当前可接受，后置）。
- 多进程撤销互踩、播放中修改（Phase E）、导出共享语义（Phase D）。
