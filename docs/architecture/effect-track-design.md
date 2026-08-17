# 特效轨实施方案（路线 B · #290 · v1 重写版）

> 状态：设计稿已按用户拍板重写，待 sign-off（纪律：设计稿→sign-off→落码→真机验收）
> 关联：ADR-001（预览=导出同源 / 护城河=Video DSL）、plan-2026-08-17 §3 P0-0、今日边界讨论（2026-08-17 20:43）
> 对标：OpenCut `EffectTrack`(EffectLayer 全局滤镜)+`effects[]`(片段级)；FableCut `adjustment layer`(全局)+`clip.props`(逐片段)。**我们采用独立轨 + `target` 绑定，不学 FableCut 属性式。**

---

## 0. 范围拍板（用户硬决策，推翻旧版"全局特效轨"）

| 档 | 内容 | 决策 |
|----|------|------|
| **v1 本阶段** | 特效段活在独立轨道（lane），可拖拽/拉长/缩短；**逐片段特效**（filter 挂在指定素材层）+ **可选全局调色层**（多参数 grade，对齐剪映「调节」）；关键帧（参数时间曲线）；特效只作为"盖在上面的数据"，预览=导出同源；能直接导出 mp4（ffmpeg 烘焙 CSS 原语）。 | ✅ 做 |
| **v1 后置（本阶段不做 UI）** | 特效属性面板、关键帧编辑面板、遮罩区域把手面板、变速面板；文字动效面板。**注意：参数栏现有 UI 已知有 bug（关键帧/遮罩/变速），先记账、轨道做好后修。** | ⏸ 记账后置 |
| **v2 后置（需 WebGL 后端）** | 绿幕抠像(chroma key)、扭曲/位移(warp)、粒子、高级蒙版(亮度/毛边/跟踪)。 | ❌ 不做（有开源底座可抄） |

**用户原话锚点**：
- "全局特效一个效果盖整段视频不如不做" → 不做单效果全局开关；只接受多参数全局**调色层**。
- "特效不焊死在片段里，只是导出时算，盖在上面一层数据" → 复用「预览=导出同源」铁律，特效段=overlay 数据。
- "肯定要直接导出视频" → v1 导出 mp4（ffmpeg 把 CSS 滤镜烘焙进去），不只导剪映草稿。
- "特效也像个层，能拉长缩短做显示时间" → 特效段复用 segment 拖拽/trim 交互。
- "参数栏(keyframe/遮罩/变速)有 bug，先做好轨道逻辑再改" → UI 面板全部后置。
- "特效去 GitHub 找可商用的开源" → 阶段 F 专做素材/库接入（花字/文字动效/特效）。

---

## 1. 现状缺口（为什么是最大缺口，仍成立）

| 层 | 现状 | 证据 |
|----|------|------|
| 数据模型 | `draft.effect` 数组已存在，剪映导入能映射成 `type:"effect"` | `main.py:3908`/`3923-3961` |
| 后端增删 | **无 `add_effect`**；只有导入映射，不能从零创建特效段 | grep 全仓无 `add_effect` |
| 时间轴泳道 | **无特效泳道**（lane 循环只渲染 video/audio/text/sticker） | `工作台v0.8时间轴.html:1353`；`effects:"placeholderPanel"`(`915`) |
| 渲染器 | **零特效合成**——`renderPreview` 只有 visual/text/sticker/audio | `renderer.js:68-242`（无 effect 分支） |
| 语义层 | `buildPlaybackGraph` 只平铺 video/audio，**无 effectNodes**（text/sticker 也缺，见 A1） | `playback-graph.js:122-150` |
| 导出 | 剪映导入的 effect 段走原生字段；自建 effect 无导出映射 | `main.py:3615-3747`（sticker/text 有，effect 无） |

**结论**：特效轨是 5 类轨道里唯一"数据模型有、全链路缺"的轨道。修复必须按铁律走完整链路，不能塞一次性代码。

---

## 2. 数据模型（v1，per-clip + global grade 两档）

特效段住在 `draft.effect[track_index][seg_index]`（独立轨模型，与 video/audio/text/sticker 并列）：

```python
{
  "type": "effect",                 # 固定
  "effect_type": "filter",          # v1: "filter"(逐片段调色/模糊等) | "grade"(全局调色层)
  "target": "global",               # "global"=盖整栈(调色层)；或 素材段 key 如 "video:0:0"=绑该片段
  "start": 0,                       # 时间轴起点(us)，同其它段
  "duration": 2_000_000,            # 作用时长(us)；右拖拉长=纯时长(复用 _trim_core 非媒体分支)
  "src_start": 0, "src_end": 2_000_000,  # 占位，保持字段齐整（非媒体段不消费源窗口）
  "params": {                       # 原语参数字典（filter/grade 共用同一套，缺省=无效果）
    "brightness": 1.0,              # 0.5~1.5
    "contrast":   1.0,              # 0.5~2.0
    "saturate":   1.0,              # 0~3
    "blur":       0,                # 0~20 px
    "grayscale":  0,                # 0~1
    "sepia":      0,                # 0~1
    "hue_rotate": 0,                # 0~360 deg
    "invert":     0,                # 0~1
    "opacity":    1.0               # 0~1（filter 段→目标层 opacity；grade 段→previewStack.opacity）
  },
  "keyframes": []                   # v1 关键帧：[{param, time(us,相对段起点), value, easing}]；为空=静态
}
```

**设计取舍**：
- **逐片段（`target=素材段key`）**：filter 挂到该素材层的 DOM 元素（video/image/text/sticker 各自的层），CSS filter 天然逐层模型，最顺手。
- **全局调色层（`target="global"` + `effect_type="grade"`）**：filter 挂 `previewStack`（全部视觉层父容器），多参数 grade 盖整片，对齐剪映「调节」。
- **不做单效果全局开关**（用户明确否决）。
- `keyframes` 是数据模型扩展，renderer 按播放头插值；DOM/CSS 与未来 WebGL 后端都能挂 —— 横切所有特效类。
- 不变量同其它非媒体段：右拖拉长=纯时长（`_trim_core` 已支持），`src_start/src_end` 占位不消费。

---

## 3. 落地路线（阶段化，每阶段含前后端 file:line）

> 行号随重构可能漂移，落码前以 grep 当前实际为准。纪律：**每阶段落码→真机验收→再进下一阶段**，不并行。

### 阶段 A — 后端数据模型 + MCP（Python · main.py）
- 新增 `add_effect(track_index, effect_type="filter", target="global", start, duration, params=None, keyframes=None)`（照 `add_text_track`/`add_sticker` 模板：`main.py:3190`/`3265`）。
- `_ensure_effect_track` 参照 `_ensure_sticker_track`（`main.py:3220`）：首次使用 `draft.setdefault("effect", [[]])`。
- `update_effect(track_index, seg_index, **patch)` / `remove_effect(track_index, seg_index)`（照 `update_sticker`/`remove_segment`）。
- 读取端兜底：渲染/导出用 `_num(seg.params.get("brightness",1.0),1.0)`，对齐 `_num`/`_graphVolume` 纪律。
- `mcp_server.py` 注册 `add_effect`/`update_effect`/`remove_effect`（照 `add_text_track` 的 MCP 包装）。

### 阶段 B — 语义层平铺（JS · playback-graph.js，修 A1 一致性）
- `buildPlaybackGraph`（`playback-graph.js:122-150`）新增 effect 遍历，产出 `effectNodes`（与 `videoNodes`/`audioClips` 同级）。
- `_flattenEffect(seg, ti, idx)`：`{key, trackKey:"effect:"+ti, target, effectType, params, keyframes, startUs, durationUs, hidden}`。
- **顺带把 text/sticker 也平铺进 `textNodes`/`stickerNodes`**（修 A1 缺陷），语义层完整，`tools/graph_consistency.py` 对拍脚本才覆盖全。

### 阶段 C — renderer 合成（JS · renderer.js，核心：特效显示出来）
- `renderPreview`（`renderer.js:68-242`）在 visual/text/sticker 之后新增 effect 分支：
  - 按播放头算激活特效段；`target="global"` → 合并到 `previewStack.style.filter`+`opacity`；`target=素材段key` → 定位该素材层 DOM 元素挂 `filter`。
  - 多段叠加：filter 函数拼接 + opacity 相乘；无激活段 → `filter="none"; opacity=1` 复位。
  - **关键帧插值**：`applyKeyframes(params, keyframes, relUs)` 算当前时间点参数值（linear/easing），驱动调色渐变、遮罩移动。
  - 几何遮罩（`target` 层用 `clip-path`/`mask-image`）：v1 先支持圆/椭圆/矩形/多边形 + 渐变羽化（固定参数，区域把手 UI 后置）。
- 隐藏/失活：`isTrackHidden`/`h.seg.hidden` 直接复用。

### 阶段 D — 前端特效泳道（HTML/JS · 工作台v0.8时间轴.html）
- lane 循环加入 `"effect"`：`for (const type of ["video","audio","text","sticker","effect"])`（`1353`）。
- `makeSeg`（`timeline.js:111` 附近）补 effect 段渲染（占位条 + 名称 + 选中把手），**复用 video/text/sticker 的通用选中/拖动/裁剪路径**（`relocate_segment`/`trim_segment` 已是 `draft[track_type]` 泛型，天然支持 effect）—— 这就是用户要的"能拉长缩短做显示时间"。
- **本阶段不建属性面板**：新增特效段用后端默认 params（如 brightness 1.0=无效果，先用脚本/MCP 给一个有可见效果的默认值让特效"显示出来"）；`effects:"placeholderPanel"`(`915`) 暂保留占位，面板后置。

### 阶段 E — 导出 mp4（Python · main.py，预览=导出同源）
- 读 `effectNodes` → 生成 ffmpeg filter 图（CSS 原语→ffmpeg 等价）：
  - `eq=brightness/contrast` / `gblur`(blur) / `saturation`(saturate) / `hue`(hue_rotate) / `colorbalance` / `fade`(opacity 渐入渐出)。
  - 几何遮罩 → ffmpeg `crop`/`mask`；逐片段 filter → 该流 overlay/滤镜；grade 层 → 整片滤镜。
  - 关键帧 → 分段 filter 或 `enable` 表达式。
- **铁律**：预览（renderer 用的 effectNodes）与导出（同 effectNodes）同源于 `buildPlaybackGraph`，不各写一套。
- 当前 `main.py` 仅 `export_draft`→剪映，但已集成 ffmpeg（`_ffmpeg_bin`/转码/抽音轨），新增 `export_video`（直出 mp4）复用同一 ffmpeg。

### 阶段 F — 开源可商用特效/花字素材接入（调研 + 集成）
> 用户硬需求："去 GitHub 找可商用的开源"。本阶段把特效目录从"手写 CSS 原语"扩成"可复用开源库/预设"。

- **调研清单（落码前 sign-off 时定具体选型）**：
  - 文字动效/花字(kinetic typography)：`anime.js`(MIT)、`textillate.js`(MIT)、`GSAP`(现 MIT，Webflow 收购后开源)、`Motion Canvas`(MIT，代码即时间轴+实时预览+ffmpeg 锁帧导出，范式参考)。
  - 特效/滤镜：`kampos`(MIT，~4KB WebGL 滤镜/转场)、`gl-transitions`(MIT，现成转场 GLSL)。
  - 抠像(v2 用)：`gl-chromakey`/`greenscreenstream`(MIT，WebGL2 像素着色器+ML 分割)。
  - 图节点合成(v2 架构对齐)：`VideoContext`(BBC, Apache-2.0)——与 `buildPlaybackGraph` 同构孪生。
- **v1 集成目标**：把花字/文字动效做成"预设包"（一组 CSS/transform/opacity 关键帧模板），agent 可 `add_effect(effect_type="text_anim", params={preset:"typewriter"})` 调用；框架/组件从上面 MIT 库择一接入。
- **许可纪律**：只接 MIT/Apache-2.0/BSD 等可商用协议；GPL/AGPL 一律不接（商用风险）。每个引入库记 license 到 `docs/third-party.md`。

### 阶段 G — 属性面板 UI（后置，修已知 bug）
> 用户明确："参数栏(keyframe/遮罩/变速)UI 有 bug，先做好轨道再改" → 本阶段全部后置，不在 v1 落码范围。

- 修 `renderSpeedTab`/变速把手已知问题（参考 OpenCut Speed 面板：速度数值+保持音调，与 trim 独立）。
- 修关键帧面板、遮罩区域把手面板（clip-path 多边形编辑）。
- 特效属性面板（亮度/对比/饱和/模糊/灰度/色差滑块+不透明度，参照 `renderStickerPanel` 滑块回填）。
- 文字动效面板（花字预设选择器）。

### 阶段 H — v2 WebGL 后端（后置，仅记架构）
- 另起 WebGL 合成器（视频帧送着色器算图）；`buildPlaybackGraph` 扩展双后端（DOM/WebGL）；
- 烘焙管线（WebCodecs `VideoEncoder` 或逐帧渲染喂 ffmpeg）；ML 抠像库集成。
- 周级投入，等口播真有需求（杂乱背景智能去背）再上。

---

## 4. 预览=导出同源纪律（铁律）
- 新属性（params/keyframes/target）一律进 `buildPlaybackGraph` 平铺（effectNodes）→ renderer 与 export_video 同源消费。
- 更新 `tools/graph_consistency.py` 对拍脚本：加入 `effectNodes` 比对（顺带 text/sticker Nodes）。
- 落码后跑 V1-V6 播放器内核回归（`player-kernel-architecture.md`）。

---

## 5. 验收清单（分阶段，真机 + 回归）
- **A/B**：MCP `add_effect` 建段 → `draft_state.json` 出现 effect 段；`buildPlaybackGraph` 产出 effectNodes。
- **C**：播放头下激活 filter 段 → 目标层/整栈变亮+模糊；global grade 段盖整栈；多段叠加；隐藏轨复位。
- **D**：特效段在时间轴可拖拽/拉长/缩短（复用 segment 交互），duration 变化即时反映到播放器。
- **E**：`export_video` 出 mp4，滤镜/调色/渐入渐出已烘焙（播放器所见=导出所得）。
- **F**：花字/文字动效预设可由 agent/MCP 调用，商用许可已登记。
- **通用**：V1-V6 播放器回归全过；`graph_consistency` 对拍 pass。

---

## 6. 风险 / 不做项
- **风险 R1**：per-clip filter 需 renderer 能定位"目标素材层 DOM"。当前素材层按 track/seg key 索引，需在 renderer 建 `layerBySegKey` 映射（阶段 C 落码时补）。
- **风险 R2**：CSS filter 不会自动进 ffmpeg，需阶段 E 手写映射；blur/invert 个别 ffmpeg 等价需验证（gblur 有，invert 用 `negate`）。
- **不做**：单效果全局开关、FableCut 属性式（`clip.props`）、v2 的抠像/扭曲/粒子（阶段 H）。
- **不动**：MasterClock/AudioEngine/MediaSlot 内核（铁律：加元素不改内核）。

---

## 7. MVP 定义（钉死）
**能剪出一条完整的口播视频 = MVP 达成。** 阶段 A~E（逐片段调色 + 框人遮罩 + 文字动效 + 渐入渐出 + 关键帧 + 直出 mp4）足以支撑，无需 v2。阶段 F 扩充可商用特效目录，阶段 G/H 后置优化。
