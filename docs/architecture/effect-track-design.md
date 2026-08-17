# 特效轨设计稿（路线 B · #290）

> 状态：设计稿待 sign-off（落码前先评审，纪律：设计稿→用户/GPT sign-off→落码→真机验收）
> 关联：plan-2026-08-17.md §3 P0-0（特效轨独立轨 + 简单原语 + 占位 + 导出扩展位）、ADR-001（预览=导出同源 / 护城河=Video DSL）
> 对标：OpenCut `EffectTrack`(EffectLayer 全局滤镜) + `effects[]`(片段级)；FableCut `adjustment layer`(全局 clip) + `clip.props`(逐片段)。**我们采用独立轨（不学 FableCut 属性式）**。

## 0. 现状盘点（为什么是最大缺口）

| 层 | 现状 | 证据 |
|----|------|------|
| 数据模型 | `draft.effect` 数组已存在，剪映导入能把特效段映射成 `type:"effect"` | `main.py:3908`（`out` 含 `"effect":[]`）、`main.py:3923-3961`(`our="effect"` 分支) |
| 后端增删 | **无 `add_effect`**；只有导入映射，不能从零创建特效段 | grep 全仓无 `add_effect`/`create_effect` |
| 时间轴泳道 | **无特效泳道**（lane 循环只渲染 video/audio/text/sticker） | `工作台v0.8时间轴.html:1353` `for (const type of ["video","audio","text","sticker"])`；`effects:"placeholderPanel"`（`915`） |
| 渲染器 | **零特效合成**——`renderPreview` 只有 visual/text/sticker/audio 四档 | `renderer.js:68-242`（无 effect 分支） |
| 语义层 | `buildPlaybackGraph` 只平铺 video/audio，**无 effectNodes**（同时 text/sticker 也缺，见 A1） | `playback-graph.js:122-150` |
| 导出 | 剪映导入的 effect 段走原生字段；自建 effect 无导出映射 | `main.py:3615-3747`（sticker/text 有，`effect` 无独立导出循环） |

**结论**：特效轨是 5 类轨道里唯一"数据模型有、全链路缺"的轨道——坐实用户最大担忧"渲染上播放器的逻辑"。修复必须按铁律走完整 5 步，不能塞一次性代码。

## 1. 数据模型（v1）

特效段（住在 `draft.effect[track_index][seg_index]`，独立轨模型）：

```python
{
  "type": "effect",                 # 固定
  "effect_type": "filter",          # v1 仅 "filter"（CSS filter 原语组）；预留 "transition"/"animate"
  "start": 0,                       # 时间轴起点（us），同其它段
  "duration": 2_000_000,            # 作用时长（us）；右拖拉长=纯时长（复用本次 _trim_core 非媒体分支）
  "src_start": 0, "src_end": 2_000_000,  # 占位，保持字段齐整（非媒体段不消费源窗口）
  "params": {                       # 原语参数字典
    "brightness": 1.0,              # 0.5~1.5（CSS brightness）
    "contrast": 1.0,                # 0.5~2.0（CSS contrast）
    "saturate": 1.0,                # 0~3（CSS saturate）
    "blur": 0,                      # 0~20 px（CSS blur）
    "grayscale": 0,                 # 0~1（CSS grayscale）
    "sepia": 0,                     # 0~1（CSS sepia）
    "hue_rotate": 0,                # 0~360 deg（CSS hue-rotate）
    "invert": 0,                    # 0~1（CSS invert）
    "opacity": 1.0                  # 0~1 全局淡入淡出（映射到 previewStack.opacity）
  }
}
```

**设计取舍**：
- **全局轨（非逐片段）**：独立轨上的一段 = 在该时间段对整条预览栈（video+image+text+sticker）施加滤镜。符合 plan 定调"独立轨，不学 FableCut 属性式"，v1 最简、最少 bug。
- **v1 只做两端可表达的 CSS filter 原语**（plan §2 原则 A）。剪映独有特效（转场/关键帧动效）走 B 路线占位，不在 v1。
- `opacity` 单独处理（映射到 `previewStack.style.opacity`，不是 CSS filter 函数），实现"全局淡入淡出"。
- 不变量同其它非媒体段：右拖拉长=纯时长（`_trim_core` 已支持），`src_start/src_end` 占位不消费。

## 2. 接入铁律 5 步（逐条 file:line）

### 2.1 Schema 字段 + 容错兜底
- 新建 `add_effect(track_index, effect_type="filter", start, duration, params=None)`（照 `add_text_track`/`add_sticker` 模板：`main.py:3190` / `main.py:3265`）。
- `_ensure_effect_track` 参照 `_ensure_sticker_track`（`main.py:3220-3222`）：首次使用时 `draft.setdefault("effect", [[]])`。
- 读取端兜底：渲染/导出用 `_num(seg.params.get("brightness",1.0),1.0)` 等，对齐 `_num`/`_graphVolume` 纪律。

### 2.2 buildPlaybackGraph 平铺（两端一致，修 A1 一致性）
- `playback-graph.js:122-150` `buildPlaybackGraph` 新增 effect 遍历，产出 `effectNodes`（与 `videoNodes`/`audioClips` 同级）。
- 复用 `_flattenVideo` 的通用骨架写 `_flattenEffect(seg, ti, idx)`：`{key, trackKey:"effect:"+ti, startUs, durationUs, effectType, params, hidden}`。
- **顺带把 text/sticker 也平铺进 `textNodes`/`stickerNodes`**（修 A1 缺陷），保证语义层完整——`tools/graph_consistency.py` 对拍脚本才覆盖得全。

### 2.3 renderer 消费（核心：补特效合成）
- `renderPreview`（`renderer.js:68-242`）在 visual/text/sticker 之后新增 effect 分支：
  ```js
  const effectHits = hits.filter(h => h.type === "effect" && !isTrackHidden(h.type, h.ti) && !h.seg.hidden);
  // 合并所有激活特效段：filter 函数拼接 + opacity 相乘
  let filter = "none", opacity = 1;
  for (const h of effectHits) {
    const p = h.seg.params || {};
    const fs = [];
    if (p.brightness!=null && p.brightness!==1) fs.push(`brightness(${p.brightness})`);
    if (p.contrast!=null && p.contrast!==1)   fs.push(`contrast(${p.contrast})`);
    if (p.saturate!=null && p.saturate!==1)   fs.push(`saturate(${p.saturate})`);
    if (p.blur)      fs.push(`blur(${p.blur}px)`);
    if (p.grayscale) fs.push(`grayscale(${p.grayscale})`);
    if (p.sepia)     fs.push(`sepia(${p.sepia})`);
    if (p.hue_rotate)fs.push(`hue-rotate(${p.hue_rotate}deg)`);
    if (p.invert)    fs.push(`invert(${p.invert})`);
    if (fs.length) filter = (filter==="none"?"":filter+" ") + fs.join(" ");
    if (p.opacity!=null) opacity *= p.opacity;
  }
  const stack = $("previewStack");
  stack.style.filter = filter;
  stack.style.opacity = opacity;
  ```
- 作用对象 `previewStack` 是全部视觉层的父容器，**一个 CSS filter 覆盖整栈**（含 text/sticker），正是全局特效语义。无激活段时 `filter="none"; opacity=1` 复位。
- 隐藏/失活特效轨：`isTrackHidden`/`h.seg.hidden` 已通用，直接复用。

### 2.4 导出映射（剪映草稿，扩展位）
- 独立循环（照 `main.py:3615-3648` sticker / `3728-3747` text 写法）遍历 `draft.effect`：
  - **v1 策略（plan §2 B 路线为主）**：把 CSS filter 原语尝试映射到剪映 `VideoSceneEffect`/颜色调整（brightness/contrast/saturate/grayscale/sepia/hue/invert 剪映多数有对应；blur 可能无→降级并记入 `skipped`）。
  - 复杂特效/blur 无对应 → `skipped.append({"reason":"剪映无对应，预览支持导出占位"})`，**不报错、不崩**。
  - 导出映射留扩展位：后续补 `transition`/`animate` 类型时只加分支。

### 2.5 MCP 工具暴露（agent 可操作）
- `mcp_server.py` 注册 `add_effect` / `update_effect` / `remove_effect`（照 `add_text_track` 的 MCP 包装 `mcp_server.py:150-152`）。
- 时间对齐：start/duration 用 us 整数，与现有 14 工具一致。

## 3. 时间轴泳道（前端）
- `工作台v0.8时间轴.html:1353` lane 循环加入 `"effect"`：`for (const type of ["video","audio","text","sticker","effect"])`。
- `makeSeg`（timeline.js）补 effect 段渲染（占位条 + 名称 + 选中把手），复用 video/text/sticker 的通用选中/拖动/裁剪路径（`relocate_segment`/`trim_segment` 已是 `draft[track_type]` 泛型，天然支持 effect）。
- `effects:"placeholderPanel"`（`915`）→ 改为真实特效属性面板（亮度/对比/饱和度/模糊/灰度/色差滑块 + 不透明度），参照 `renderStickerPanel`（`renderer.js:482`）的滑块回填模式。

## 4. 预览=导出同源纪律
- 新属性（params 各原语）进 `buildPlaybackGraph` 平铺（`effectNodes`）→ 两端一致。
- 更新 `tools/graph_consistency.py` 对拍脚本：加入 `effectNodes` 比对。
- 落码后跑 V1-V6 回归（播放器内核回归，见 `player-kernel-architecture.md`）。

## 5. 验收（真机 + 回归）
1. 加一段 filter 特效（亮度 1.3 + 模糊 2px）→ 播放器整栈变亮+模糊 ✅
2. 右拖拉长特效段 → 时长变长、滤镜持续更久（复用非媒体 _trim_core）✅
3. 多段特效重叠 → 滤镜叠加（brightness×contrast 等）✅
4. 隐藏特效轨 → 预览无滤镜（对齐 OpenCut 隐藏过滤）✅
5. 导出剪映 → 两端可表达原语进草稿；blur 等无对应记入 skipped 不崩 ✅
6. V1-V6 播放器回归全过 ✅

## 6. 风险 / 待 sign-off 问题
- **Q1（范围）**：v1 是否只做全局特效轨，不做"逐片段特效"（FableCut 属性式）？→ 建议 v1 只全局轨，逐片段后置（plan 已定调）。
- **Q2（导出）**：blur/invert 剪映无 1:1 对应，v1 是否接受"预览支持、导出占位+skipped"？→ 建议接受（plan B 路线）。
- **Q3（画幅设置）**：plan 把"画幅"列为 step1 最简项，但本次路线 B 用户聚焦轨道+特效。是否并行做画幅，还是特效轨先行、画幅单独立项？→ 建议特效轨先行，画幅作为独立小项后续。
- **Q4（A1 一致性）**：text/sticker 也缺 `buildPlaybackGraph` 平铺，本次是否一并补 `textNodes`/`stickerNodes`？→ 建议一并补（成本低、对拍脚本才完整）。

## 7. 不做项（明确）
- 不学 FableCut 把特效塞进 `clip.props`（属性式），保持独立轨模型。
- v1 不做转场/关键帧动效/蒙版抠像（plan 后置清单）。
- 不动 MasterClock / AudioEngine / MediaSlot 内核（铁律：加元素不改内核）。
