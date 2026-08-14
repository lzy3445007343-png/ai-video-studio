# 播放状态机诊断地图（只读 · 未改代码）

> **定位**：这是「诊断评审 Phase 1」的交付物，纯只读。基于 `工作台v0.8时间轴.html` 真实代码（2026-08-15 抓取的当前行号）绘制三张地图：①当前播放状态机 ②所有 `playheadUs` 写入/读取路径 ③所有媒体控制路径。目的是给参谋 GPT 和后续执行者一张「地图」，在动刀前看清三个核心权力（Timeline / Playback Controller / Media Element）现在各自散落在哪、谁在打架。**本文档未修改任何代码。**

---

## 0. 一句话结论（先看这个）

代码**已经没有显式状态机**。播放状态靠一个布尔 `isPlaying` 加上 6 个标志位（`mediaClockReady` / `crossSegmentPending` / `playStartUs`+`playStartWall` / `lastHitSig` / `_lastPlayAll`）拼出来。**这正是剩余 bug 的根源形态**：两个"纠正系统"在播放循环里并行跑、互不门控，跨段时打架 → Bug A；播放头写入权分裂（拖拽用 `Store.set`、播放循环用裸赋值）且墙钟锚点不被拖拽刷新 → Bug B。

> **对参谋 GPT 假设的证实 / 证伪**（这是地图最直接的产出）：
> - ✅ **Bug A「两个纠正系统互殴」被证实**：`playTick` 每帧调用 `correctActiveMediaDrift`（L1807），而跨段时 `_handleCrossSegment`（L1750）异步向同一批媒体发 seek。两者都调用 `_seekMedia`，但**只有 `crossSegmentPending` 锁住了 `_handleCrossSegment` 的重入，没有锁住 `correctActiveMediaDrift`**。所以跨段期间 drift 仍在每帧发 seek，与跨段 seek 抢同一元素。
> - ❌ **Bug B「0.5s 轮询 `refresh()` 覆盖播放头」被证伪**：`refresh()`（L3381）只写 `draft / materials / peaks / meta / selectedKey / bookmarks`，**根本不碰 `playheadUs`**（已逐行核对）。Bug B 的真因在别处（见 §4.2）。

---

## 1. 当前播放状态机（隐式）

### 1.1 状态表（都是隐式的，没有 `enum`）

| 状态 | 判定条件（真实标志） | 入口 | 出口 |
|---|---|---|---|
| **Idle（暂停）** | `isPlaying === false` | 初始 / `pausePlay()` / 播放到末尾 | `startPlay()` → Starting |
| **Starting** | `startPlay()` 执行中（async，未进 RAF） | `startPlay()` | 屏障完成 → `playTick()` → Playing |
| **Playing** | `isPlaying === true` 且 RAF 在跑 | `playTick()` 首帧 | `pausePlay()` / `us>=maxUs` / 末端无素材 → Idle |
| **CrossSegment** | `crossSegmentPending === true` | `playTick` 检测到 `keySig` 变化 → `_handleCrossSegment()`（fire-and-forget，不离开 Playing） | `finally` 置 `crossSegmentPending=false` → 回到 Playing |

> 注意：**CrossSegment 不是 Playing 的子状态，而是与 Playing 并发的异步任务**。Playing 的 RAF 循环在 `_handleCrossSegment` 跑 await 屏障期间**从不暂停**，两者同时操作媒体 → 这就是竞态的物理来源。

### 1.2 转移表（带真实行号）

| 转移 | 触发 | 代码位置 |
|---|---|---|
| Idle → Starting | 点击播放 / `togglePlay()` | L1527 `togglePlay` → L1528 `startPlay` |
| Starting → Playing | seek 屏障完成 + `playAllMedia()` + `playTick()` | L1551-1554 |
| Playing → Playing（自环） | 每帧 RAF：墙钟推进 + drift 纠正 | L1775 `playTick` 内 L1781/L1807/L1809/L1820 |
| Playing → CrossSegment | `keySig !== lastHitSig` | L1816-1818 |
| CrossSegment → Playing | `finally { crossSegmentPending = false }` | L1771-1773 |
| Playing → Idle | `pausePlay()` / `us>=maxUs` / 末端无素材 | L1556 `pausePlay`；L1791/L1798 |
| Idle → Idle | `seekPlayhead()` 拖拽（**只改 `playheadUs`，不动任何状态标志**） | L1018-1023 |

### 1.3 控制标志清单（状态机的"变量"全在这）

```
isPlaying          (L1084)  总开关：是否处于播放
mediaClockReady    (L1090)  媒体是否已 seek 到位；false 时 playTick 信任墙钟
_mcrWaitAt         (L1091)  mediaClockReady 看门狗计时起点
playStartUs        (L1087)  起播时的 playheadUs（墙钟锚点）
playStartWall      (L1087)  起播时的 performance.now()（墙钟锚点）
lastHitSig         (L1539)  当前命中段签名，用于检测跨段
crossSegmentPending(L1748)  跨段重入锁
crossSegmentQueuedUs(L1749) 跨段期间最新目标（队列）
_lastPlayAll       (L1602)  playAllMedia 防抖计时
```

> **核心缺陷**：上面这些标志分散在播放逻辑各处，没有收敛到一个 `PlaybackController` 对象。任何函数都能读、部分函数能写 → 状态不变量无法保证。这正是参谋 GPT 说的"三个权力没分开"。

---

## 2. 所有 `playheadUs` 写入 / 读取路径

### 2.1 写入点（谁能动播放头 —— 这是 Bug B 的关键）

| # | 写入方式 | 位置 | 调用场景 | 是否播放中生效 |
|---|---|---|---|---|
| W1 | `Store.set({ playheadUs: ... })` | L1020（`seekPlayhead`） | 拖拽 / 点击时间轴 / 键盘步进 | 暂停时改；**播放时不被 `playTick` 读回** |
| W2 | `Store.set({ playheadUs: 0 })` | L1531（`startPlay`） | 起播时若已在末尾则归零 | 起播瞬间 |
| W3 | `Store.state.playheadUs = maxUs` | L1791（`playTick`） | 播放到末尾 | 播放中（裸赋值，绕过 Store.set） |
| W4 | `Store.state.playheadUs = maxUs` | L1798（`playTick` 空隙末端） | 末尾后无素材 | 播放中（裸赋值） |
| W5 | `Store.state.playheadUs = us` | L1809（`playTick`） | **每帧墙钟推进** | 播放中（裸赋值，唯一播放期推进源） |
| W6 | `Store.set({ playheadUs: clientXToUs(...) })` | L2772 | 时间轴 mousedown | 交互 |
| W7 | `Store.set({ playheadUs: clientXToUs(...) })` | L2783 | 时间轴 drag | 交互 |
| W8 | `Store.set({ playheadUs: us })` | L2795 | 拖拽结束 / 点击 | 交互 |

> **关键发现（Bug B 根因）**：
> - 播放期推进播放头的**唯一来源是 W5**（`playTick` 用 `us = playStartUs + (now - playStartWall)*1000` 算，见 L1781）。
> - 但 **W1/W6/W7/W8（拖拽）从不更新 `playStartUs` / `playStartWall` 这两个墙钟锚点**（见 `seekPlayhead` L1018-1023，只写 `playheadUs`，没有重锚）。
> - 后果：**播放中拖拽播放头 → 下一帧 `playTick` 用旧锚点算出的 `us` 直接覆盖你的拖拽值 → 回弹**。这就是 Bug B 的真正机制，与 `refresh()` 无关。
> - 另一个代码气味：W1/W2/W6/W7/W8 走 `Store.set`，W3/W4/W5 走裸 `Store.state.playheadUs =`，两种写入机制并存，没有任何封装。

### 2.2 读取点（只列最核心的，其余见 grep 全量）

播放头读取几乎全部通过 `Store.state.playheadUs`（L600/1327/1363/1496/1531/1535/1539/1544/1551/1603/1618/1762/1791/1809 等），用于：计算预览元素 seek 目标、判定 `resolveHits` 命中、`playTick` 墙钟推进。`refresh()` 不读也不写它。

---

## 3. 所有媒体控制路径（谁能碰 `<video>`/`<audio>` 元素）

> 这回答参谋 GPT 的"媒体元素该只归一个 Player 管"。现状是：**11 个地方能碰媒体**，但真正"推进时间"只有 playTick 一个（这点已收敛），"改变媒体"（play/seek/muted/load）却散在 6+ 函数。

| # | 函数 | 位置 | 它对媒体做什么 | 是否每帧/高频 |
|---|---|---|---|---|
| M1 | `renderPreview` / `_setVisualContent` | L1324 / L1136 | `createElement("video"|"audio")`、设 src、绑 `onplaying`/`onseeked` | 起播 / 跨段降级时 |
| M2 | `_seekMedia` | L1166 | **唯一的 seek 原语**：设 `el.currentTime` 或 `load()`+设 | 被 M5/M8/M9 调用 |
| M3 | `_waitSeekSettled` | L1187 | await `seeked`，**700ms 安全网强制放行**（L1220） | 每次 seek 后 |
| M4 | `startPlay` | L1528 | 编排：render→seek→playAllMedia→playTick | 点击播放 |
| M5 | `pausePlay` | L1556 | 暂停所有 video/audio | 暂停 |
| M6 | `playAllMedia` | L1596 | **播放原语**：命中媒体 `muted=true` 起播、`playing` 事件解除；处理 AbortError/NotSupportedError；250ms 防抖 | 起播 / 跨段 / 每 800ms 看门狗 |
| M7 | `toggleMute` | L1576 | 给所有媒体设 `muted`（全局静音） | 点喇叭 |
| M8 | `correctActiveMediaDrift` | L1659 | **每帧**检测漂移 >100ms 就 `_seekMedia`；`el.paused||el.seeking` 时跳过 | **每帧（L1807 调用）** |
| M9 | `seekActiveMediaToPlayhead` | L1691 | 批量 seek 命中媒体、停车非命中 | 起播 / 跨段 |
| M10 | `_handleCrossSegment` | L1750 | 异步：跨段 seek + 重读播放头补 seek + `playAllMedia` | 跨段时（并发） |
| M11 | `playTick` | L1775 | 调 M8 + 检测跨段触发 M10 + 推进播放头 | **每帧 RAF** |

### 3.1 媒体生命周期"主人"判定

- **创建 / 销毁**：M1（`renderPreview`）——但播放期被冻结（L2121 `if(!isPlaying) renderTimeline`），所以正常播放不会重建。✅ 这点已收口。
- **播放 / 暂停**：M4/M5/M6。M6 是实际 `play()` 调用处。
- **seek**：M2 是唯一定点，但被 M8（每帧）、M9、M10 三处触发 → **seek 权分散**。
- **muted**：M6（`playing` 解除）、M7（全局）、M9（停车时置 true）三处。

> 结论：媒体"创建"已收口，但**"seek 权"和"播放/静音权"仍分散**，且 M8 与 M10 在跨段时并发抢 seek —— 这就是 Bug A 的机制层说明。

---

## 4. Bug A / Bug B 嫌疑定位（基于地图，不靠猜）

### 4.1 Bug A（音频跨段跳 / 断）

**机制（已证实）**：跨段瞬间 `playTick`（每帧跑）与 `_handleCrossSegment`（异步跑）同时操作媒体：
1. `playTick` 检测到 `keySig` 变化 → 调 `_handleCrossSegment`（L1818），设 `mediaClockReady=false`、发 seek（L1758）、await 屏障（L1759）、重读播放头补 seek（L1762-1765）、`playAllMedia`（L1767）。
2. 但**同一时刻 `playTick` 每帧仍在调用 `correctActiveMediaDrift`（L1807）**。drift 在 `el.seeking` 时跳过（L1664），可一旦跨段那次 seek 落位，`onseeked` 把 `mediaClockReady` 置 true（L1364 等），drift 立刻看到"墙钟已前进 >100ms"→ 又发一次 `_seekMedia`（L1680）。
3. 于是 `_handleCrossSegment` 的补 seek 和 `correctActiveMediaDrift` 的 drift seek **在同一元素上交替发生** → 用户听到/看到跳、断。

**嫌疑排序**：
- ① **`correctActiveMediaDrift` 在跨段期间未被抑制**（最高嫌疑）：`crossSegmentPending` 只挡了 `_handleCrossSegment` 重入，没挡 drift。→ 参谋 GPT 的"加 `crossSegmentPending` 门控禁止 drift 直到 seek 完成 + 稳定 500ms"建议**方向正确、有代码依据**。
- ② **`_waitSeekSettled` 700ms 安全网（L1220）过早放行**：媒体未真落位就被放行，drift/play 接管半 seek 状态 → 跳。
- ③ `_handleCrossSegment` 重读播放头补 seek（L1762）与 drift 补 seek 重复，时序上可能互相覆盖。

### 4.2 Bug B（拖播放头回弹）

**机制（已证实，且与参谋 GPT 的 refresh 假设无关）**：
- 拖拽路径：`seekPlayhead`（L1018）→ `Store.set({playheadUs})`。它**只写播放头，不重锚 `playStartUs`/`playStartWall`**（L1018-1023 全文可见，无锚点更新）。
- 播放路径：`playTick`（L1775）每帧 `us = playStartUs + (now - playStartWall)*1000`（L1781），然后 `Store.state.playheadUs = us`（L1809）。
- 因此**播放中拖拽 → 下一帧 `playTick` 用旧锚点算出旧位置覆盖拖拽值 → 回弹**。
- `refresh()`（L3381）已逐行核对，**不写 `playheadUs`**，故非元凶。

**嫌疑排序**：
- ① **`seekPlayhead` 播放中拖拽未重锚墙钟**（最高嫌疑，机制清晰）。修复应在 Phase 2「单一推进时间权」内做：拖拽若 `isPlaying`，同步 `playStartUs = us; playStartWall = now`。
- ② 写入机制分裂（`Store.set` vs 裸赋值），无封装保证，任何新增写入点都可能破坏不变量。

---

## 5. 给参谋 GPT / 后续执行的下一步建议

基于地图，路线应为（对齐参谋 GPT 的 Phase 1→2→3，不要跳步）：

1. **Phase 1（已完成本图）**：地图已出。不再进 Round G。
2. **Phase 2（关闭竞争）**：
   - 抽 `PlaybackController` 对象，收敛 §1.3 所有标志位。
   - **单一推进时间权**：只有 `playTick` 能写播放头；`seekPlayhead` 播放中拖拽必须重锚墙钟（修 Bug B）。
   - **单一媒体变更权**：`play`/`seek`/`muted` 收口到 Player（M2/M6/M8/M9/M10 合并入口）；**`correctActiveMediaDrift` 在 `crossSegmentPending` 期间必须被抑制**（修 Bug A ①）。
   - 单一播放状态变更权：`startPlay`/`pausePlay` 已是主入口，标志位收进 Controller。
3. **Phase 3**：再做 Command 层（split/trim/move/delete），UI 与 Agent 同走。

> **验收基线（与之前 P0 计划一致，未变）**：修改任意 clip（split/trim/move）绝不触发媒体元素重建；Agent 改时间轴时正在播放的预览不被打断；播放中拖拽播放头不回弹；音频跨段不跳不断。

---

## 附：本图抓取依据（真实行号）

所有行号来自 2026-08-15 对 `C:\Users\34450\Desktop\ai-video-studio\工作台v0.8时间轴.html` 的 grep + 精读。关键函数定位：
`seekPlayhead` L1018 · `startPlay` L1528 · `pausePlay` L1556 · `playAllMedia` L1596 · `correctActiveMediaDrift` L1659 · `seekActiveMediaToPlayhead` L1691 · `_handleCrossSegment` L1750 · `playTick` L1775 · `refresh` L3381 · `_seekMedia` L1166 · `_waitSeekSettled` L1187 · `renderPreview` L1324。
