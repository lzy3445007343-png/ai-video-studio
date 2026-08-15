# Step 2 — 播放状态隔离审计（Playback Isolation Audit）

> 日期：2026-08-15
> 上游：Step 1 拆 JS（store/media/player/timeline/renderer 5 文件）+ Step 2a 播放变量收口（9 个播放变量移入 player.js）
> 目标：确认「编辑态 ↔ 播放态」边界是否干净——UI 层只能读播放状态 + 走播放入口，绝不能直接写播放变量或碰媒体元素

---

## 1. 审计方法

三个 grep 面（当前工作区，排除 tmp_check.js 旧快照）：

| 面 | 模式 | 回答的问题 |
|----|------|-----------|
| A | HTML 里引用 `isPlaying/mediaClockReady/previewMuted/currentSession/PlayerManager.` | UI 层碰了哪些播放状态 |
| B | HTML 里调用 `togglePlay/pausePlay/startPlay/playAllMedia` | UI 层走哪些播放入口 |
| C | HTML 里直接碰 `previewState/.play()/.pause()/.muted/.currentTime` | UI 层有没有绕过 PlayerManager 摸媒体元素 |

## 2. 审计结果

### A. HTML → 播放状态（全部只读，共 4 处）

| 行号 | 代码 | 判定 |
|------|------|------|
| 550/554 | 缩放逻辑读 `isPlaying`（播放期手动重定位片段块+标尺） | ✅ 合理（只读） |
| 724 | `renderAll`: `if (!isPlaying) renderTimeline(s)` | ✅ 合理（播放中冻结时间轴重建，OpenCut 纪律） |
| 729 | `renderPreviewMaybe`: `if (isPlaying) return` | ✅ 合理（播放期预览由 playTick 驱动，不重复重建） |

**HTML 里没有任何 `isPlaying = xxx` 写入** —— Step 2a 收口后直接写播放状态 = 0。

### B. HTML → 播放入口（接口调用，共 7 处）

| 行号 | 触发 | 调用 | 判定 |
|------|------|------|------|
| 1377/1388 | 拖动播放头 / 标尺定位 | `pausePlay()` | ✅ 合理（编辑操作先停播放） |
| 1955/1977 | 空格键 / K 键 | `togglePlay()` | ✅ 合理 |
| 1966/1981/1982 | 方向键 / J / L 步进 | `pausePlay()` + `seekPlayhead()` | ✅ 合理 |

### C. HTML → 媒体元素（共 1 处）

| 行号 | 代码 | 判定 |
|------|------|------|
| 975 | `applyKfLiveAll()` 遍历 `previewState.visualEls` 做关键帧动画 | ⚠️ 只读预览元素做动画，**不 play/pause/muted/currentTime**；职责属渲染/动画层，理想归属 renderer.js（低优先级整理项，非隔离缺口） |

### D. player.js → Store（播放层读编辑状态）

- 读：`Store.state.draft`（42）、`playheadUs`（145/263/269/345/351/355/357/366/487）、`track_meta`（292/300）、`resolveHits` —— **播放头是 master、媒体是 follower，播放层读播放头是纪律要求** ✅
- 写：516/523/533/534 直接写 `Store.state.playheadUs`（播放结束置位 / playTick 推进）—— 有意绕开 `Store.set` 避免每帧整树重绘，配合 `positionPlayhead()/renderTimecode()` 局部更新。**这是播放期专用写入通道，唯一写入方是 player.js 自身** ✅

## 3. 结论

**Step 2 播放隔离实质完成。** 拆 JS + Step 2a 收口后：

```
HTML（UI/协调层）           player.js（播放层）
    │  只读 isPlaying ×4         │
    │  pausePlay/togglePlay ×7   │
    │  ─────────────────────────► │
    │                            │ 读 Store.state（播放头/draft）✅
    │                            │ 写 playheadUs（专用通道）✅
    └── 直接写播放状态：0 处      └── 直接改编辑状态：0 处
    └── 直接摸媒体元素：1 处(只读) └── 渲染/时间轴：0 处
```

**不再存在「编辑操作碰播放变量 / 播放操作改编辑状态」的耦合点。** 这两天「改 A 坏 B」的根源（播放状态与 UI/渲染同文件平铺、互写）在物理上已消除。

## 4. 剩余可选收口（低优先级，非阻塞）

| 项 | 说明 | 何时做 |
|----|------|--------|
| `applyKfLiveAll`（HTML 975）迁入 renderer.js | 动画每帧应用，职责属渲染层；当前只读 previewState，无风险 | Step 4 回归基线后顺手 |
| `renderMedia`(652)/`renderTimecode`(707)/`renderPreviewMaybe`(721) 归位 | 属于渲染函数，当前留 HTML 作为 `renderAll` 协调器的一部分；可接受 | 不强制 |
| 删除 `tmp_check.js`（136KB，8-13 旧语法校验快照，未跟踪） | 不参与运行，纯占空间 | 随手清理 |

## 5. 下一步

Step 2 完成后进入 **Step 3 Asset 分离**（materials 独立、segment 去 path 耦合、验证 snap-once 不变量）——播放隔离已为它腾出干净的边界。
