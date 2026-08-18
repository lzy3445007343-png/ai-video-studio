# 时间轴拖拽与轨道管理统一设计稿

> 状态：设计稿待 sign-off（用户要求"先看 OpenCut 标准答案再改"，本稿完成前不落码）  
> 范围：前端 `工作台v0.8时间轴.html` + `timeline.js`，后端 `main.py`  
> 参考：OpenCut classic（`apps/web/src/timeline/{placement,group-move,controllers}`）

---

## 一、用户反馈的问题清单（映射到代码）

| # | 用户描述 | 当前代码位置 | 根因初判 |
|---|---|---|---|
| 1 | 覆盖轨预览方向错：素材实际到最顶，但预览轨显示在下面 | `renderTimeline()` 插 preview 到 `mainIdx`；`onPointerUp()` 实际插到 `videoTracks.length` | **预览与实际插入位置不一致** |
| 2 | 特效库拖到特效轨无高亮、仍拖不进 | `dragover` 用 `trackUnderY()`；`onTimelineDrop()` 特效分支 | hitTest 只认轨道 rect，特效可落区与显示反馈对不上 |
| 3 | 特效段向上拖新建轨，轨建到下方 | `onPointerMove()` 特效分支 targetTi=-1；`relocate_segment()` 无 insert_index 时追加 | 新建轨没根据垂直方向决定插入位置 |
| 4 | 空特效轨不自动删除 | `_collapse_empty_tracks()` | 只处理 video/audio/text，**漏了 effect** |
| 5 | 轨道逻辑要通用 | 视频/音频/文本/特效各写一套分支 | 缺少统一 display-index + direction 模型 |
| 6 | 音频向上拖不显示预览 | `renderTimeline()` preview 对非视频类型 `push()` 到末尾 | 音频新轨 preview 永远画在最下 |
| 7 | 媒体拖到主场景有时放不进 / 落位乱 | `add_to_timeline()` 调用 `_free_start_on_track()` | OpenCut 是"放得下就放，放不下新建轨"；我们是"同轨自动避让推时间" |

---

## 二、OpenCut 标准答案（源码精读）

### 2.1 轨道显示顺序

OpenCut 内部 `SceneTracks`：

```ts
{
  overlay: TimelineTrack[];  // 可含 video/text/graphic/effect
  main:    VideoTrack;        // 主轨
  audio:   AudioTrack[];
}
```

显示顺序 = `[...overlay, main, ...audio]`，**索引 0 是最顶层**，越往下索引越大。overlay 里 video/effect/text/graphic 可混排。

### 2.2 落点计算：`computeDropTarget` → `resolveTrackPlacement`

核心流程：

1. `getTrackAtY()`：把鼠标 Y 映射到 `orderedTracks` 的 `trackIndex` + `relativeY`。
2. 若鼠标落在**轨道间隙**（gap），根据 `verticalDragDirection` 决定靠上还是靠下：
   - 向上拖 → 归属到**上一条**轨道（`trackIndex = i`）
   - 向下拖 → 归属到**下一条**轨道（`trackIndex = i + 1`）
3. `resolveTrackPlacement({ strategy: "preferIndex" })`：
   - 优先用命中的同类型已有轨（同轨时间放得下）。
   - 放不下或类型不兼容 → `resolvePreferredNewTrackPlacement()` 算新建轨位置。
4. 新建轨方向：
   - `direction = "above"` → `insertIndex = safePreferredIndex`
   - `direction = "below"` → `insertIndex = safePreferredIndex + 1`
   - 视频不允许插到 main 之下（`insertIndex > mainTrackIndex` 时 clamp 到 `mainTrackIndex` + `"above"`）。

### 2.3 重叠处理

OpenCut **不会**把片段在同一条轨上自动推到空位；若目标轨在请求时间放不下，就**新建一条同类型轨**。

### 2.4 特效

- 特效 drag 数据带 `targetElementTypes`，若鼠标命中可绑定的片段（video/image/text 等），则把特效**绑定到该片段**（clip）。
- 若没命中片段，则找第一条已存在的 effect track；没有才新建 effect track。
- 默认新建位置：`getDefaultInsertIndexForTrack({ trackType: "effect" })` 返回 `0`，即**最顶层**。

### 2.5 空轨

OpenCut **不自动删除空轨**（用户显式删）。但本项目从 v0.8 早期就有"空轨自动折叠"传统（保持轨道数量由素材决定），本次统一保持并扩展到 effect。

---

## 三、当前我们的模型

### 3.1 数据 vs 显示

| 类型 | 数据索引 | 显示顺序 |
|---|---|---|
| video | `video[0]` = 主场景（底）；`video[i>0]` = 叠加轨，索引越大越靠上 | `buildTracks()` 反转：`video[N]...video[1]`，最后 `video[0]` |
| audio | `audio[0]` 开始，索引越大越靠下 | 顺序渲染在视频下方 |
| text | `text[0]` 开始，索引越大越靠下 | 渲染在视频上方 |
| sticker | `sticker[0]` 开始 | 渲染在文本下、视频上 |
| effect | `effect[0]` 开始，索引越大越靠下 | 渲染在贴纸下、视频上 |

### 3.2 当前拖拽代码

- `onPointerMove()` 用 `hitTrack(e)` 取 `elementFromPoint` 最近 `.track`。
- 视频拖到空白设 `newAboveMain=true`，但 preview 和 actual 插入位置不一致。
- 音频/文本/特效拖到空白统一追加到类型数组末尾（显示最下）。
- 后端 `relocate_segment()` 支持 `insert_index` 但前端只给视频传了；effect/audio/text 都传 `null`。

---

## 四、统一模型设计

### 4.1 核心抽象：displayIndex

定义：**`buildTracks()` 返回数组中的下标，0 = 最顶层，依次向下。**

所有拖拽落点、新建轨、预览，先算 `displayIndex`，再映射回各类型的数据索引。

```js
// 伪代码：displayIndex → dataIndex（后端同逻辑）
function displayIndexToDataIndex(type, displayIndex, draft) {
  const tracks = buildTracks(draft); // 当前显示顺序
  const tr = tracks[displayIndex];
  if (tr) return tr.ti;
  // 越界：用于新建轨，需要按方向算
  ...
}
```

### 4.2 统一 hitTest

新增 `hitTestTrack(clientY, dragState)`：

```js
{
  track: { type, ti } | null,   // 命中的已有轨
  zone: "inside" | "above" | "below" | "aboveAll" | "belowAll" | "gap",
  direction: "above" | "below", // 仅 zone=gap 时有效
  displayIndex: number
}
```

规则：

1. 遍历 `buildTracks()` 结果（显示顺序）。
2. Y 在轨道 rect 内 → `inside`，`displayIndex = i`。
3. Y 在两条轨道间隙：
   - 向上拖（`clientY < startY`）→ 归属到上一条，`zone="above"`，`displayIndex = i`
   - 向下拖 → 归属到下一条，`zone="below"`，`displayIndex = i+1`
4. Y 在所有轨道之上 → `aboveAll`，`displayIndex = 0`
5. Y 在所有轨道之下 → `belowAll`，`displayIndex = tracks.length`

### 4.3 统一 resolveDropTarget

输入：元素类型、源轨、hit 结果、垂直方向  
输出：

```js
{
  kind: "existing" | "new",
  type: "video" | "audio" | "text" | "sticker" | "effect",
  displayIndex: number,          // 目标显示位置
  insertDirection: "above" | "below" | null, // 新建轨时有效
  timeUs: number
}
```

决策表：

| zone | 轨道类型兼容 | 结果 |
|---|---|---|
| inside | 兼容 | existing，落该轨 |
| inside | 不兼容 | new，direction = 上半部分 "above" / 下半部分 "below"（OpenCut 同式） |
| gap / aboveAll / belowAll | — | new，direction 由 zone + 垂直方向决定 |

特殊规则：
- 视频新建轨的 `displayIndex` 不能低于主场景（不能插到 main 下面）。
- 特效新建轨默认 direction="above"（新建在最顶），除非用户明确向下拖过最后一条特效轨。

### 4.4 后端 `_insert_track` 改造

当前 `_insert_track(draft, track_type, insert_index)` 接受的是**数据索引**。改为同时接受 `display_index` 或 `insert_direction`，内部转换。

转换规则（以 video 为例）：

```python
def display_index_to_video_data_index(draft, display_index):
    v = draft.get("video", [[]])
    # 主场景在显示顺序中的位置 = len(v)-1
    main_display = len(v) - 1
    if display_index >= main_display:
        return 0  # 落到主场景
    # 否则是叠加轨：display 0 -> data len(v)-1, display main_display-1 -> data 1
    return len(v) - 1 - display_index
```

音频/文本/特效数据索引与显示索引同向（索引越大越靠下），转换更简单。

### 4.5 预览与实际一致

`renderTimeline()` 中：

- 根据 `resolveDropTarget` 的 `displayIndex` 插入 preview track。
- 被拖段渲染到 preview track。
- 高亮目标轨（existing 或 preview）。

`onPointerUp()` 中：

- 直接把 `displayIndex` + `insertDirection` 传给后端。
- 后端按统一规则转成数据索引并插入。

### 4.6 空轨折叠扩展到 effect

`_collapse_empty_tracks()` 增加 effect 分支：

```python
# effect 与 audio/text 同规则：空轨移除，全空保留一条 [[]]
for grp in ("audio", "text", "effect"):
    ...
```

### 4.7 素材库 drop 重叠处理

`add_to_timeline()` 修改：

1. 目标轨指定时，先检查请求时间是否放得下。
2. 放得下 → 精确落点。
3. 放不下 → 调用统一新建轨逻辑（按鼠标方向决定新轨位置），再落点。
4. 不再用 `_free_start_on_track()` 自动推时间（保持同轨不重叠不变量，但落点由用户鼠标决定）。

---

## 五、任务拆分（按依赖排序）

1. **后端**：改造 `_insert_track` 支持 `display_index`/`direction`（所有类型）。
2. **后端**：`relocate_segment` / `add_to_timeline` 接入新插入语义；扩展 `_collapse_empty_tracks` 到 effect。
3. **前端**：新增 `hitTestTrack` / `resolveDropTarget` 纯函数（可放 `timeline.js`）。
4. **前端**：`onPointerMove()` 用新 hitTest 替换 `hitTrack(e)`。
5. **前端**：`renderTimeline()` preview 按 resolved `displayIndex` 插入。
6. **前端**：`onTimelineDrop()` / `dragover` 用新 resolve 函数。
7. **真机验收**：覆盖视频/音频/文本/特效 四类拖拽场景。

---

## 六、验收清单

- [ ] 叠加 1 拖到叠加 2 上方 → preview 和实际都在叠加 2 之上。
- [ ] 视频段拖到主场景上方空白 → 新建覆盖轨到最顶，preview 同步在最顶。
- [ ] 特效段在特效轨之间可上下换轨。
- [ ] 特效段向上拖出最后一条特效轨 → 新建特效轨在最顶。
- [ ] 特效段向下拖出最后一条特效轨 → 新建特效轨在最下。
- [ ] 特效库拖到任意特效轨有高亮，松手落轨。
- [ ] 把特效段全部移走后，空特效轨自动消失。
- [ ] 音频段向上拖 → preview 显示在目标音轨之上。
- [ ] 音频段向下拖 → preview 显示在目标音轨之下。
- [ ] 媒体从素材库拖到主场景精确落点；与现有片段重叠时自动新建轨，不推时间。
- [ ] 所有类型轨道拖拽行为一致（高亮、preview、实际落位三位一体）。

---

## 七、风险与不做项

- **风险**：改动涉及前端 drag/move/drop 三条路径 + 后端 insert/relocate/add，必须真机逐项验收，不能只做语法检查。
- **不做项**：本次不改 OpenCut 的"空轨不自动删"行为（保持本项目自动折叠传统）；不碰吸附引擎（snap 仍按现有逻辑）；不碰关键帧/音频逻辑 bug（用户此前已排后）。
