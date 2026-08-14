# 播放引擎媒体操作点核查（2026-08-15，可自验）

> 用途：Codex 额度用完，用户无法交叉验证我的分析。本报告把"直接操作 video/audio 元素"的代码位置全部列出，
> 行号是死的，用户或任何未来工具都能打开 `工作台v0.8时间轴.html` 按行号核对。
> 本文件是**本地诊断**，未进 git，可随时删除。

## 一、怎么自己核对（不用读代码也能验）
1. 用记事本 / Notepad++ 打开 `C:\Users\34450\Desktop\ai-video-studio\工作台v0.8时间轴.html`
2. 跳到下面列出的行号（Notepad++ 按 Ctrl+G）
3. 看那一行是不是真的在直接改 `play()` / `pause()` / `muted` / `currentTime` / `src` / `load`
4. 如果行号和下面写的对不上，说明我的分析有偏差——以你看到的为准

## 二、原始数据：每个"直接操作媒体"的位置
统计命令（可重跑）：
`grep "\.play\s*\(|\.pause\s*\(|\.muted\s*=|\.currentTime\s*=|\.load\s*\(|\.src\s*=" 工作台v0.8时间轴.html`

下面按"所在函数"分组。⚠️ 标【图片】的是缩略图/占位图，不是播放媒体，与"没声/卡顿"无关。

### renderPreview（创建/复用媒体元素，设置 src、seek）
- L1144 `v.src = fileURL(path)` —— 给 video 元素设源
- L1146 `v.muted = !!muted || previewMuted` —— 设静音
- L1155 `img.src = ...` ——【图片】素材缩略图
- L1177 `el.currentTime = t` —— 直接 seek
- L1211 `el.currentTime = target` —— 直接 seek（try 内）

### _tryReloadMedia（媒体 error 后重载恢复）
- L1276 `el.load()` —— 重载媒体

### seekActiveMediaToPlayhead（跨段时停车/恢复）
- L1287 `el.muted = true`
- L1290 `el.muted = !(stillActive && want)`
- L1293 `const p = el.play()` —— 直接播

### 刷新/预览同步（refresh 或 renderPreviewMaybe，播放期也会跑）
- L1375 `media.muted = isTrackMuted(...) || previewMuted`
- L1462/1463 `rec.img.src = ...` ——【图片】预览图
- L1646 `v.pause(); v.muted = true` —— 非命中视频停车静音
- L1652 `rec.el.pause(); rec.el.muted = true` —— 非命中音频停车静音

### playAllMedia（播放主逻辑，最大的一块）
- L1481 `a.muted = previewMuted`
- L1491 `rec.el.src = src` —— 给 audio 设源
- L1512 `rec.el.pause()`
- L1513 `rec.el.muted = true`
- L1563 `v.pause()`
- L1566 `rec.el.pause()`
- L1586 `v.muted = previewMuted || trackMuted` ——（toggleMute 内复用？需核对上下文）
- L1592 `rec.el.muted = previewMuted || isTrackMuted("audio", ti)` ——（toggleMute 内）
- L1615 `el.muted = true`
- L1619 `el.muted = !(stillActive && want)`
- L1622 `const p = el.play()` —— 直接播
- L1629 `const r = el.play()` —— 直接播（重试）

### toggleMute（全局静音按钮）
- L1586 `v.muted = previewMuted || trackMuted`
- L1592 `rec.el.muted = previewMuted || isTrackMuted("audio", ti)`

### _handleCrossSegment（跨段处理）
- L1705 `v.pause(); v.muted = true` —— 非活动视频停车
- L1707 `v.muted = isTrackMuted("video", ti) || previewMuted`
- L1714 `a.pause(); a.muted = true` —— 非活动音频停车
- L1715 `a.muted = previewMuted || isTrackMuted("audio", ti)`

### 图片占位（与播放无关，列出仅为完整）
- L753 `emptyImg.src = ...`（1x1 透明 gif 占位）
- L1137/1141 `wrap.dataset.muted = ...`（DOM 属性，非元素静音）

## 三、计数（如实）
- 匹配行总数：33
- 其中【图片/占位】6 行（L753/1137/1141/1155/1462/1463）与播放无关
- **真正直接操作 video/audio 播放状态：约 27 处**
- 分散在 **至少 8 个函数**：renderPreview / _tryReloadMedia / seekActiveMediaToPlayhead / 刷新同步 / playAllMedia / toggleMute / _handleCrossSegment（+ 1 处待核对 L1375）

> 我之前口语说"30+ 处"，精确说是 audio/video 播放相关约 27 处，含图片则 33。数量级属实，但"30+"略虚，特此更正。

## 四、我的判断：事实 vs 解读（请你分开看）
**事实（可核对，不是我说的）：** 上面 27 处直接改媒体状态，分布在 8 个函数里，每个函数都觉得自己有权直接 `play/pause/seek/mute` 同一个 `<audio>`/`<video>`。

**我的解读（工程判断，可能错）：** 因为"媒体元素归谁管"这件事没有单一_owner，一个函数加的静音/播放规则，会踩到另一个函数的旧逻辑。所以"修 A 出 B"不是运气差，是结构性的——这是 Codex 说的"控制权边界错"。

**我有多大把握：** 方向（应该收口到一个 Player 层）我有把握，因为这是结构事实推导出来的。但"具体哪个 bug 是哪一行的锅"这种逐点判断，我之前翻过车（见第五节），不能全信。

## 五、我之前说过头 / 说错的地方（诚实清单）
1. 多轮说"修好这个就稳了" —— 错。在分散架构下修单点没底，已证伪。
2. "30+ 处" —— 略虚，精确约 27 处音频/视频相关。
3. 我自己的 G1/G2/G3 补丁**新增了其中若干处**（如 L1615/1619/1622/1629 的静音起播+重试、L1276 的 load 重载）。也就是说，现在的混乱有一部分是我自己打补丁堆出来的——这反而更说明"继续打补丁"是错的路。
4. Codex 曾说"缩放后播放头跑到 2 秒 = 媒体时钟污染播放头"，我核对后发现那个函数早被删了，是误诊；真因是渲染冻结+缩放不同步（已修）。说明外部分析+我的核对都可能在旧代码快照上出错。

## 六、信任边界（我能保证 / 不能保证）
- ✅ 能保证：行号是真的（你跳过去能验）；"媒体操作分散在多个函数"是结构事实。
- ❌ 不能保证：我对每个具体 bug 的根因定位 100% 对；我的补丁不再引入新问题。
- 📌 因此：以后凡是我说"根因是 X"，都会附行号；凡是要改代码，先出方案你确认，diff 你看得到，不再"修完就说稳了"。
