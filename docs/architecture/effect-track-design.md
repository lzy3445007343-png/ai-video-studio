# 特效轨实施方案（路线 B · #290 · v1 重写版）

> 状态：设计稿已按用户拍板重写，待 sign-off（纪律：设计稿→sign-off→落码→真机验收）
> 关联：ADR-001（预览=导出同源 / 护城河=Video DSL）、plan-2026-08-17 §3 P0-0、今日边界讨论（2026-08-17 20:43）
> 对标：OpenCut `EffectTrack`(EffectLayer 全局滤镜)+`effects[]`(片段级)；FableCut `adjustment layer`(全局)+`clip.props`(逐片段)。**我们采用独立轨 + `target` 绑定，不学 FableCut 属性式。**

---

## 0. 范围拍板（用户硬决策，推翻旧版"全局特效轨"）

| 档 | 内容 | 决策 |
|----|------|------|
| **v1 本阶段** | 特效段活在独立轨道（lane），可拖拽/拉长/缩短；**逐片段特效**（filter 挂在指定素材层）+ **可选调整层（Adjustment Layer，多参数 grade，对齐 PR/剪映 调整层）**；关键帧（参数时间曲线）；特效只作为"盖在上面的数据"，预览=导出同源；能直接导出 mp4（ffmpeg 烘焙 CSS 原语）。 | ✅ 做 |
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
  "target": {"type":"clip", "track":"video", "ti":0, "si":0},  # 绑指定素材段；type 还可为 "track"(整轨)/"adjustment"(调整层=盖整栈)。v1 索引式引用，后续升级稳定 clip id
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

**设计取舍（采纳 ChatGPT review：target 结构化 + 调整层命名）**：
- **逐片段（`target:{type:"clip",track,ti,si}`）**：filter 挂到该素材层的 DOM 元素，CSS filter 天然逐层模型，最顺手。
- **调整层 / Adjustment Layer（`target:{type:"adjustment"}`）**：filter 挂 `previewStack`（全部视觉层父容器），多参数 grade 盖整片。**术语对齐 PR/剪映「Adjustment Layer」，弃用易歧义的 "global"**。
- **不做单效果全局开关**（用户明确否决）。
- **target 结构化而非字符串**：避免 `video:0:0` 绑死；未来可扩展 `type:"track"`(整轨)/多目标/group/adjustment，Agent 操作更鲁棒。
- **稳定 clip id（v1.x 跟进）**：v1 用 `track/ti/si` 索引引用；后续给每个 segment 发稳定 `id` 后升级为 `target:{type:"clip",id:"clip_xxx"}`，轨道重排不再打断绑定。
- `keyframes` 是数据模型扩展，renderer 按播放头插值；DOM/CSS 与未来 WebGL 后端都能挂 —— 横切所有特效类。
- 不变量同其它非媒体段：右拖拉长=纯时长（`_trim_core` 已支持），`src_start/src_end` 占位不消费。

---

## 2.1 Effect Schema 冻结（Agent 接口契约，落码前定死）

> 采纳 ChatGPT review「必补 1」：先冻结类型，否则 Agent/MCP 接口会乱。与 ADR-001（护城河=Video DSL，Agent 可操作内核）同目标。

```typescript
EffectNode      // buildPlaybackGraph 平铺产物：{key, trackKey, target, effectType, params, keyframes, startUs, durationUs, hidden}
EffectSegment   // draft.effect[t][i] 原始段：见 §2 数据模型
EffectTarget    // {type:"clip"|"track"|"adjustment", track?, ti?, si?, id?}
EffectParams    // {brightness,contrast,saturate,blur,grayscale,sepia,hue_rotate,invert,opacity} 数值字典
EffectType      // "filter"(逐片段) | "grade"(调整层) ；预留 "transition"/"mask"/"text_anim"
```
- 每个 `EffectType` 在注册表声明：`render`(CSS 规格) + `ffmpeg`(滤镜规格) 双 adapter（见阶段 E），保证预览=导出同源。
- 命名 + 字段一旦冻结，MCP `add_effect`/`update_effect` 严格按此契约，Agent 无需知道 DOM/ffmpeg 差异。

## 2.2 Effect 生命周期（采纳 ChatGPT review「必补 2」）

明确特效段从生到出的全阶段，MCP/前端/导出各阶段只调对应入口：
```
create   → add_effect / 导入映射         （写 draft.effect）
update   → update_effect / trim / 拖拽    （改 params/target/时间）
activate → buildPlaybackGraph 平铺         （生效到 effectNodes，预览=导出同源）
render   → renderer 消费 effectNodes       （DOM/CSS 计算 filter/opacity/mask）
serialize→ draft_state.json 落盘           （人和 AI 共用同一份）
export   → export_video 读 effectNodes      （经注册表 ffmpeg adapter 烘焙 mp4）
```
- 原则：**activate 之后的 render/export 只读 effectNodes，不回头碰 draft**（与 ADR-001「Agent 永不直接碰 Timeline」一致，特效也只是 Graph 上的一个 Node）。

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

### 阶段 C — renderer 合成（JS，核心：特效显示出来，且不让 renderer.js 膨胀）
> 采纳 ChatGPT review「阶段 C 收紧」：特效只是 Graph 上的一个 Node，不反向侵入播放核心；不要把 renderEffect/renderMask 内联进 renderer.js 堆成 5000 行。

- **抽独立模块 `effects.js`**（不参与播放内核）：纯函数 `computeEffectStyle(effectNodes, playheadUs) → {layerFilters:Map<segKey,filter>, stackFilter, stackOpacity, masks:Map<segKey,clipPath>}`。
  - renderer.js 只调用 `computeEffectStyle` 并把结果应用到 DOM，**自身不写滤镜逻辑**——保持 `Timeline Kernel → Playback Graph → Renderer` 单向，特效=Node。
- **应用管线顺序（顺序错结果就错，必须冻结）**：
  ```
  Source Layer(视频/图)
    → Clip Transform(位移/缩放/旋转, 素材层 transform)
    → Clip Effect(blur/filter, 素材层 filter)      ← 先模糊
    → Mask(clip-path/mask-image, 素材层)           ← 后裁剪(模糊溢出的部分被裁掉)
    → Adjustment Layer(previewStack.filter, 整栈)   ← 调色层最后盖
    → Composite → Canvas/Video
  ```
  ⚠️ `blur→mask`（模糊再裁）≠ `mask→blur`（裁后再模糊边缘糊），CSS 天然 `filter` 先于 `clip-path` 合成，顺序天然正确，但文档显式冻结避免未来 WebGL 后端搞反。
- `computeEffectStyle` 细节：
  - 按播放头算激活特效段；`target.type="adjustment"` → 合并到 `stackFilter`+`stackOpacity`；`target.type="clip"` → 定位该素材层（需 `layerBySegKey` 映射，落码时补）挂 `layerFilters`。
  - 多段叠加：filter 函数拼接 + opacity 相乘；无激活段 → `filter="none"; opacity=1` 复位。
  - **关键帧插值**：`applyKeyframes(params, keyframes, relUs)` 算当前时间点参数值（linear/easing）。
  - 几何遮罩：`target` 层用 `clip-path`/`mask-image`，v1 先支持圆/椭圆/矩形/多边形 + 渐变羽化（区域把手 UI 后置）。
- 隐藏/失活：`isTrackHidden`/`h.seg.hidden` 直接复用。

### 阶段 D — 前端特效泳道（HTML/JS · 工作台v0.8时间轴.html）
- lane 循环加入 `"effect"`：`for (const type of ["video","audio","text","sticker","effect"])`（`1353`）。
- `makeSeg`（`timeline.js:111` 附近）补 effect 段渲染（占位条 + 名称 + 选中把手），**复用 video/text/sticker 的通用选中/拖动/裁剪路径**（`relocate_segment`/`trim_segment` 已是 `draft[track_type]` 泛型，天然支持 effect）—— 这就是用户要的"能拉长缩短做显示时间"。
- **本阶段不建属性面板**：新增特效段用后端默认 params（如 brightness 1.0=无效果，先用脚本/MCP 给一个有可见效果的默认值让特效"显示出来"）；`effects:"placeholderPanel"`(`915`) 暂保留占位，面板后置。

### 阶段 E — 导出 mp4（Python · main.py，预览=导出同源，经 Schema 注册表双 adapter）
> 采纳 ChatGPT review「别太早做 ffmpeg export / 别让 JSON 直接映射 ffmpeg」：预览(Web)与导出(ffmpeg)是两套实现，易漂（预览蓝、导出色不同）。解法=**每个 EffectType 在注册表声明 `render`(CSS) + `ffmpeg`(滤镜) 双 adapter，二者读同一 Schema**，从根上保证预览=导出同源。

- **`EFFECT_REGISTRY`**（落 `effects.js` 或 `effects_schema.py` 共享定义）：
  ```python
  EFFECT_REGISTRY = {
    "brightness": {"css": lambda v: f"brightness({v})", "ffmpeg": lambda v: f"eq=brightness={v}"},
    "blur":       {"css": lambda v: f"blur({v}px)",     "ffmpeg": lambda v: f"gblur=sigma={v}"},
    # ... contrast/saturate/hue_rotate/grayscale/sepia/invert/opacity 同理
  }
  ```
  - renderer 用 `css` adapter 拼 `filter`；`export_video` 用 `ffmpeg` adapter 拼滤镜图。**改一个特效类型只动注册表一处**。
- 导出映射：逐片段 `clip` 目标 → 该流滤镜；`adjustment` 目标 → 整片 `stackFilter`；几何遮罩 → ffmpeg `crop`/`mask`；关键帧 → 分段 filter 或 `enable` 表达式。
- **v1 出口策略（采纳 ChatGPT：先简单支持）**：仅对 9 个 CSS 原语做注册表双 adapter；blur/invert 个别 ffmpeg 等价（`gblur`/`negate`）验证后开通；花哨转场/WebGL 特效留 v2。
- **验收硬指标**：同一组 effectNodes，预览渲染 vs 导出 mp4 逐帧比对无色差（预览=导出同源铁律的对拍项）。
- 当前 `main.py` 仅 `export_draft`→剪映，已集成 ffmpeg（`_ffmpeg_bin`/转码/抽音轨），新增 `export_video`（直出 mp4）复用同一 ffmpeg。

### 阶段 F — 开源可商用特效/花字素材接入（调研 + 集成）
> 用户硬需求："去 GitHub 找可商用的开源"。本阶段把特效目录从"手写 CSS 原语"扩成"可复用开源库/预设"。

- **调研清单（落码前 sign-off 时定具体选型；采纳 ChatGPT 优先级）**：
  - **特效/滤镜（v1 可接）**：`gl-transitions`(MIT，转场 GLSL)、`kampos`(MIT，~4KB WebGL 滤镜/转场管线)。
  - **花字/文字动效/粒子（重点看 `pixi.js`，MIT）**：其 `Filter/Container/Sprite/RenderTexture` 思想非常适合后续花字/粒子/动效；`anime.js`(MIT)/`textillate.js`(MIT)/`GSAP`(MIT)/`Motion Canvas`(MIT，代码即时间轴+实时预览+ffmpeg 锁帧导出) 作预设范式参考。**pixi.js 偏 WebGL，v1(DOM/CSS) 不直接依赖，作为 v2 花字/粒子底座重点研究**。
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

---

## 8. 外部架构 review 采纳记录（2026-08-17 ChatGPT 评审）

用户把路线交给外部 GPT 评审，结论与 ADR-001 高度一致（特效=Graph 上的 Node，不侵入播放核心）。采纳项：
- ✅ **target 结构化**（弃 `video:0:0` 字符串，改 `{type,track,ti,si}`）+ 稳定 clip id 路线。
- ✅ **术语统一**：global → **Adjustment Layer（调整层）**，对齐 PR/剪映。
- ✅ **阶段 C 抽 `effects.js` 独立模块**，renderer.js 只调用不内联，防 5000 行膨胀；冻结应用管线顺序（Transform→Effect→Mask→Adjustment→Composite）。
- ✅ **阶段 E 改 Schema 注册表双 adapter**（render+ffmpeg 读同一 Schema），防预览/导出漂移；v1 先简单支持 9 原语。
- ✅ **必补 Effect Schema 冻结（§2.1）+ Effect 生命周期（§2.2）**，服务 Agent 可操作内核。
- ✅ **阶段 F 把 `pixi.js`(MIT) 列为花字/粒子重点研究对象**（v2 WebGL 底座）。
- ⚠️ **部分采纳**：ChatGPT 建议完整 OOP 渲染器分层（LayerRenderer/EffectRenderer/...）。v1 仅抽 `effects.js` 纯函数模块，不做全类层级重写（避免过度工程，等特效类型增多再演进）。
- ⏸ ChatGPT sign-off：A/B/C ✅、D ⚠️、E ⏸先简单、F ✅、G/H ⏸后置 —— 与本项目纪律一致。
