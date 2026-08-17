# 特效轨实施方案（路线 B · #290 · v1 终审版）

> 状态：**已 sign-off（用户 2026-08-17 终审）** → 进入落码。纪律：设计稿→sign-off→落码→真机验收。
> 关联：ADR-001（预览=导出同源 / 护城河=Video DSL）、plan-2026-08-17 §3 P0-0、今日边界讨论（2026-08-17）。
> 对标：OpenCut `EffectTrack`+`effects[]`；FableCut `adjustment layer`+`clip.props`。**我们采用独立轨 + `target` 绑定 + 注册表双 adapter，不学 FableCut 属性式。**
> 架构哲学（用户终审钉死）：**特效不是"塞进播放器的一段代码"，而是 Agent 可操作的 Effect DSL 节点**；特效层是第一个验证「扩展即加 Node」的模块。

---

## 0. 范围拍板（用户硬决策）

| 档 | 内容 | 决策 |
|----|------|------|
| **v1 本阶段** | 特效段=独立轨道（lane），可拖拽/拉长/缩短；**Effect 是与 clip 平级的时间实体**（自带 id/range/target/params/keyframes）；**逐片段特效**（filter 挂指定素材层）+ **调整层（Adjustment Layer，多参数 grade，对齐 PR/剪映）**；关键帧；**Effect Registry 提进阶段 A**（预览/导出/未来 v2 同源扩展）；能直接导出 mp4（ffmpeg 烘焙）。 | ✅ 做 |
| **v1 后置（不做 UI）** | 特效属性面板、关键帧编辑面板、遮罩区域把手面板、变速面板、文字动效面板。参数栏现有 UI 已知有 bug（keyframe/遮罩/变速），先记账、轨道做好后修。 | ⏸ 记账后置 |
| **v2 后置（需 WebGL 后端）** | 绿幕抠像(chroma key)、扭曲/位移(warp)、粒子、高级蒙版(亮度/毛边/跟踪)。 | ❌ 不做（有开源底座可抄） |

**用户原话锚点**：
- "全局特效一个效果盖整段视频不如不做" → 不做单效果全局开关；只接受多参数调整层。
- "特效不焊死在片段里，只是导出时算，盖在上面一层数据" → 复用「预览=导出同源」铁律，特效段=overlay 数据。
- "肯定要直接导出视频" → v1 导出 mp4（ffmpeg 烘焙 CSS 原语），不只导剪映草稿。
- "特效也像个层，能拉长缩短做显示时间" → 特效段复用 segment 拖拽/trim 交互。
- "参数栏(keyframe/遮罩/变速)有 bug，先做好轨道逻辑再改" → UI 面板全部后置。
- "特效去 GitHub 找可商用的开源" → 阶段 F 专做素材/库接入（花字/文字动效/特效）。
- **"进入特效层不是做特效功能，是给 Video DSL / Agent 可操作内核补一个 Effect Node 系统"** → 本方案一切围绕注册表 + 生命周期 + Adapter，不围绕单次渲染。
- **"Effect 应该和 clip 平级，是时间实体，要加 id + range"** → §2.0 冻结 Schema。
- **"Effect Registry 不要等 E，提进 A/B"** → §2.3 / 阶段 A 落地。

---

## 1. 现状缺口（为什么是最大缺口）

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

## 2. 数据模型（v1，Effect = 时间实体，与 clip 平级）

### 2.0 冻结 Effect Schema（Agent/MCP 契约，落码前定死，不轻易改）

> 采纳用户终审（2026-08-17）：Effect 必须是与 clip 平级的时间实体；外加 `id` + `range{startUs,endUs}`。

```json
{
  "type": "effect",                 // 段类型判别符(与 video/audio/text/sticker 并列)；注册表 key 见下 effect_type
  "id": "effect_xxx",               // NEW: 特效段稳定 id，add_effect 时生成(effect_<n> 或 uuid)；Agent 后续按 id 改/删/复制
  "effect_type": "blur",            // 注册表 key：blur/brightness/contrast/saturate/hue_rotate/grayscale/sepia/invert/opacity(v1)；预留 transition/mask/text_anim
  "target": {"type":"clip","track":0,"ti":0,"si":0},  // 绑指定素材段；type 还可为 "track"(整轨)/"adjustment"(调整层=盖整栈)
  "range": {"startUs":1000000,"endUs":3000000},        // 时间区间(us)；= 段在特效轨上的起止
  "params": {"radius":12},          // 该 effect_type 的原语参数(见注册表 §2.3)
  "keyframes": []                   // 参数时间曲线：[{param, time(us,相对段起点), value, easing}]；为空=静态
}
```

**命名说明（重要）**：本轨系统段判别符已占 `type:"effect"`，故用户 schema 里的 `type:"blur"` 在此落地为 `effect_type`（注册表 key），语义完全等价。内部存储同时保留 `start`/`duration`(us) 以复用轨道拖拽/trim 泛型(`_trim_core`)；`range` 与 `start/duration` 由 `_flattenEffect` 双向映射（`range.startUs = start`，`range.endUs = start + duration`）。

**设计取舍（采纳 ChatGPT review + 用户终审）**：
- **逐片段（`target:{type:"clip",track,ti,si}`）**：filter 挂到该素材层 DOM，CSS filter 天然逐层模型。
- **调整层 / Adjustment Layer（`target:{type:"adjustment"}`）**：特效段指向调整层，filter 挂 `previewStack`(整栈)。多段 adjustment 叠加=多参数 grade，对齐 PR/剪映「调整层」(非单效果全局开关)。
- **target 结构化而非字符串**：避免 `video:0:0` 绑死；未来扩 `type:"track"`/多目标/group。
- **稳定 id（v1 落地）**：特效段自带 `id`，Agent 按 id 操作，不依赖轨道索引。
- **稳定 clip id（v1.x 跟进）**：v1 用 `track/ti/si` 索引引用 clip；后续给每个 segment 发稳定 `id`(如 `clip_xxx`) 后升级 `target:{type:"clip",id:"clip_xxx"}`，轨道重排不打断绑定。
- `keyframes` 横切所有特效类；DOM/CSS 与未来 WebGL 后端都能挂。
- 不变量同其它非媒体段：右拖拉长=纯时长(`_trim_core` 已支持)，src 窗口不消费。

### 2.1 Effect DSL → Adapter 架构（Agent 能力接口，采纳用户终审）

特效不是"塞进播放器的一段代码"，而是一层 **Agent 可操作的能力接口**。流向：

```
Agent / MCP
   ↓  (按冻结 Schema 描述意图：add_effect / update_effect / remove_effect / duplicate_effect)
Effect DSL（draft.effect 段 + Effect Registry 契约）
   ↓  buildPlaybackGraph 平铺成 effectNodes（预览=导出同源的桥）
Adapter（按 effect_type 分发，注册表驱动）
   ├── CSS Adapter      → 预览(renderer 用 effects.js 的 css())
   ├── Canvas Adapter   → (v2 预留)
   ├── WebGL Adapter    → (v2 预留，kampos/gl-transitions)
   └── FFmpeg Adapter   → 导出(main.py 用 ffmpeg())
```

- 思想对齐：**Blender Modifier Stack（Object→Modifier Stack）** / **AE Layer→Effects→Animation** —— `Clip → Effect Stack`。特效是 Clip 上的一摞可叠加节点，不是 clip 属性。
- 每个 `effect_type` 只在一个地方声明它的全部后端能力(注册表 §2.3)，新增 blur/glow/vintage/film/shake/zoom/rgb 只是加一条注册，不动内核。
- 这条是本项目真正值钱处：特效层是第一个验证「扩展即加 Node」的模块，后面字幕/贴纸/转场/口型/AI 包装都会变成同一种 Node。

### 2.2 Effect 生命周期（采纳 ChatGPT review「必补 2」+ 用户终审加 duplicate）

用户视角(操作语义) → 内核视角(实现) 映射：

| 用户语义 | 内核阶段 | MCP 入口 |
|----------|----------|----------|
| create(建特效) | create → add_effect / 导入映射（写 draft.effect，发 id） | `add_effect` |
| attach(绑目标) | create 时带 target | `add_effect(target=...)` |
| update params | update → update_effect / trim / 拖拽 | `update_effect` |
| animate(关键帧) | update 时写 keyframes | `update_effect(keyframes=...)` |
| detach/delete | delete → remove_effect | `remove_effect` |
| **duplicate** | **clone 段+新 id** | **`duplicate_effect`（用户终审新增，不要等以后补）** |

全链路（内核视角，单一职责）：
```
create   → add_effect / 导入映射         （写 draft.effect）
update   → update_effect / trim / 拖拽    （改 params/target/时间）
activate → buildPlaybackGraph 平铺         （生效到 effectNodes，预览=导出同源）
render   → renderer 消费 effectNodes       （经 CSS Adapter 算 filter/opacity/mask）
serialize→ draft_state.json 落盘           （人和 AI 共用同一份）
export   → export_video 读 effectNodes      （经 FFmpeg Adapter 烘焙 mp4）
```
- 原则：**activate 之后的 render/export 只读 effectNodes，不回头碰 draft**（与 ADR-001「Agent 永不直接碰 Timeline」一致，特效也只是 Graph 上的一个 Node）。

### 2.3 Effect Registry（双 adapter，预览=导出同源的 operational 化，用户终审：提进阶段 A）

> 用户终审核心改动：Registry 不要等 E，要在 A 阶段就定义。它决定今后 GitHub 特效接入 / Agent 调用 / ffmpeg 导出 / WebGL v2 全部怎么扩。

注册表是「每个 effect_type 声明它的全部后端能力」的单一表。v1 双 adapter（css 预览 + ffmpeg 导出），读同一份 params 规格：

```javascript
// effects.js（预览端；阶段 C 落地，但 key 在 A 冻结）
const Effects = {
  blur:      { preview(p){ return { filter:`blur(${p.radius}px)` }; } },
  brightness:{ preview(p){ return { filter:`brightness(${p.value})` }; } },
  contrast:  { preview(p){ return { filter:`contrast(${p.value})` }; } },
  saturate:  { preview(p){ return { filter:`saturate(${p.value})` }; } },
  hue_rotate:{ preview(p){ return { filter:`hue-rotate(${p.value}deg)` }; } },
  grayscale: { preview(p){ return { filter:`grayscale(${p.value})` }; } },
  sepia:     { preview(p){ return { filter:`sepia(${p.value})` }; } },
  invert:    { preview(p){ return { filter:`invert(${p.value})` }; } },
  opacity:   { preview(p){ return { opacity:p.value }; } },
  // 后续 glow/vintage/film/shake/zoom/rgb 只加一条；v2 加 webgl/canvas adapter
};
```

```python
# main.py EFFECT_REGISTRY（导出端；阶段 A 即定义，阶段 E 消费）
EFFECT_REGISTRY = {
  "blur":      {"css": lambda p: f"blur({p['radius']}px)",        "ffmpeg": lambda p: f"gblur=sigma={p['radius']}"},
  "brightness":{"css": lambda p: f"brightness({p['value']})",     "ffmpeg": lambda p: f"eq=brightness={p['value']}"},
  "contrast":  {"css": lambda p: f"contrast({p['value']})",       "ffmpeg": lambda p: f"eq=contrast={p['value']}"},
  "saturate":  {"css": lambda p: f"saturate({p['value']})",       "ffmpeg": lambda p: f"eq=saturation={p['value']}"},
  "hue_rotate":{"css": lambda p: f"hue-rotate({p['value']}deg)",  "ffmpeg": lambda p: f"hue={p['value']}"},
  "grayscale": {"css": lambda p: f"grayscale({p['value']})",      "ffmpeg": lambda p: f"colorchannelmixer=rr=0.3:gg=0.59:bb=0.11"},
  "sepia":     {"css": lambda p: f"sepia({p['value']})",          "ffmpeg": lambda p: f"sepia={p['value']}"},
  "invert":    {"css": lambda p: f"invert({p['value']})",         "ffmpeg": lambda p: f"negate={int(p['value'])}"},
  "opacity":   {"css": lambda p: f"opacity:{p['value']}",         "ffmpeg": lambda p: f"format=rgba,colorchannelmixer=aa={p['value']}"},
}
```
- **铁律落地**：renderer 用 `css` adapter 拼 filter；`export_video` 用 `ffmpeg` adapter 拼滤镜图。**改一个特效类型只动注册表一处**（跨语言镜像两份，但 key+语义同源于本冻结表）。
- v1 仅 9 个 CSS 原语；后续 glow/vintage/film/shake/zoom/rgb 只加一条注册 + 可选 WebGL/Canvas adapter（v2）。
- 注：跨语言单一源在 v1 暂以「设计稿冻结表为准、两份镜像实现」实现；后续可生成。

---

## 3. 落地路线（阶段化，每阶段含前后端 file:line）

> 行号随重构可能漂移，落码前以 grep 当前实际为准。纪律：**每阶段落码→真机验收→再进下一阶段**，不并行。
> 顺序（用户终审）：**A Schema+Registry+MCP → B Graph → C Renderer → D UI → E Export adapter → F GitHub pack**（G/H 后置）。

### 阶段 A — Effect Schema + Registry + MCP（Python · main.py）★ 用户终审：Registry 提进本阶段
- **冻结 Schema 落地**：`add_effect` 写出的段严格遵循 §2.0 冻结结构（含 `id`、`effect_type` 注册表 key、`target` 结构化、`range`→内部 `start/duration`、`params`、`keyframes`）。
- 新增 `add_effect(track_index, effect_type, target, start, duration, params=None, keyframes=None)`（照 `add_text_track`/`add_sticker` 模板：`main.py:3190`/`3265`）：
  - 生成 `id="effect_<n>"`（或 uuid）；`target` 默认 `{"type":"adjustment"}`（调整层）或传入 `{"type":"clip",...}`。
  - 写 `draft.effect[track_index][seg_index]`；`range` 由 `start/duration` 推导。
- `_ensure_effect_track` 参照 `_ensure_sticker_track`（`main.py:3220`）：首次 `draft.setdefault("effect", [[]])`。
- `update_effect(track_index, seg_index, **patch)` / `remove_effect(track_index, seg_index)` / **`duplicate_effect(track_index, seg_index)`**（克隆段+新 id，照 `update_sticker`/`remove_segment` 模板）。
- **`EFFECT_REGISTRY` 在 main.py 定义（§2.3）**：9 原语 css+ffmpeg 双 adapter；阶段 E 直接消费，阶段 C 的 effects.js 镜像同一 key。
- 读取端兜底：`_num(seg.params.get("radius",0),0)` 对齐 `_num`/`_graphVolume` 纪律。
- `mcp_server.py` 注册 `add_effect`/`update_effect`/`remove_effect`/`duplicate_effect`。

### 阶段 B — 语义层平铺（JS · playback-graph.js，修 A1 一致性）✅ 已落码（2026-08-17）
- `buildPlaybackGraph`（`playback-graph.js:122-150`）新增 effect 遍历，产出 `effectNodes`（与 `videoNodes`/`audioClips` 同级）。
- `_flattenEffect(seg, ti, idx)`：`{key, trackKey:"effect:"+ti, target, effectType, params, keyframes, startUs, durationUs, hidden}`（读 `range` 或 `start/duration`）。
- **顺带把 text/sticker 也平铺进 `textNodes`/`stickerNodes`**（修 A1 缺陷），语义层完整，`tools/graph_consistency.py` 对拍脚本才覆盖全。

### 阶段 C — renderer 合成（JS，核心：特效显示出来，且不让 renderer.js 膨胀）✅ 已落码（2026-08-17）
> 采纳 ChatGPT review「阶段 C 收紧」：特效只是 Graph 上的一个 Node，不反向侵入播放核心；不要把 renderEffect/renderMask 内联进 renderer.js 堆成 5000 行。

- **抽独立模块 `effects.js`**（不参与播放内核）：纯函数 `computeEffectStyle(effectNodes, playheadUs) → {layerFilters:Map<segKey,filter>, stackFilter, stackOpacity, masks:Map<segKey,clipPath>}`。
  - renderer.js 只调用 `computeEffectStyle` 并把结果应用到 DOM，**自身不写滤镜逻辑**——保持 `Timeline Kernel → Playback Graph → Renderer` 单向，特效=Node。
  - `computeEffectStyle` 内部对每段查 `Effects[effectType].preview(params)`（§2.3 注册表 css adapter）算 filter —— 单一来源。
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

### 阶段 D — 前端特效泳道（HTML/JS · 工作台v0.8时间轴.html）  ✅ 已完成（2026-08-17）
- **落码位置**：`timeline.js`（buildTracks / makeSeg / contentWidth / showHide）+ `工作台v0.8时间轴.html`（CSS 变量 `--seg-effect`、`.seg.effect` 样式、buildSnapPoints、onPointerMove、onPointerUp）。
- **lane 渲染**：`buildTracks` 在 text→sticker 之后、video 之前插入 effect 轨（`for (const type of ["video","audio","text","sticker","effect"])` 同步 buildSnapPoints）。
- **段渲染**：`makeSeg` 补 `type==="effect"` 分支——`.seg.effect` 类名（青绿 `--seg-effect` + 虚线顶边图层语义），header 显示 `✦ 特效名 · 目标`（调整层/片段ti:si/轨ti/全局）；复用 video/text/sticker 通用选中/拖动/裁剪路径。
- **拖拽/裁剪约束**：`onPointerMove` 中 `d.type==="effect"` 强制 `targetType="effect"`/`targetTi=d.ti`/`newAboveMain=false`（只在本轨内移动，不跨视频/音频轨、不新建轨）；`onPointerUp` 的 move & resize 分支都路由到 `update_effect(range)`，不调 `move_segment`/`relocate_segment`/`trim_segment`。
- **几何**：`contentWidth` 纳入 effect 段算最大时长；`showHide` 放开 effect 轨显隐。
- **复用验证**：`findSeg`/`selectKey`/`renderKfPanel` 原生已 handle `effect` 类型（renderKfPanel 对非 video/audio 返空面板，不崩），故本阶段零新增交互逻辑。
- **本阶段不建属性面板**：新增特效段用后端默认 params（先用 MCP `add_effect` 建段让条显示出来）；`effects:"placeholderPanel"` 暂保留占位，面板后置（阶段 G）。
- **单测**：node vm 沙箱 `ALL_PHASE_D_TIMELINE_TESTS_PASS`（effect 轨生成、显示顺序 effect<video、className 含 effect、header `✦`+`调整层`/`片段0:0`、dataset.key `effect:0:0`）+ `contentWidth` 含 effect 段（2200px>视频1200px）；4 JS 文件 `node --check` 全过。

### 阶段 E — 导出 mp4（Python · main.py，预览=导出同源，经 Schema 注册表双 adapter）
> 采纳 ChatGPT review「别让 JSON 直接映射 ffmpeg」：预览(Web)与导出(ffmpeg)是两套实现，易漂（预览蓝、导出色不同）。解法=**每个 effect_type 在注册表声明 `render`(CSS) + `ffmpeg`(滤镜) 双 adapter，二者读同一 Schema**（§2.3 已在 A 定义）。

- 导出映射：逐片段 `clip` 目标 → `EFFECT_REGISTRY[effect_type]["ffmpeg"](params)` 拼该流滤镜；`adjustment` 目标 → 整片 `stackFilter`；几何遮罩 → ffmpeg `crop`/`mask`；关键帧 → 分段 filter 或 `enable` 表达式。
- **v1 出口策略（采纳 ChatGPT：先简单支持）**：仅对 9 个 CSS 原语走注册表双 adapter；blur(`gblur`)/invert(`negate`) 等价验证后开通；花哨转场/WebGL 特效留 v2。
- **验收硬指标**：同一组 effectNodes，预览渲染 vs 导出 mp4 逐帧比对无色差（预览=导出同源铁律的对拍项）。
- 当前 `main.py` 仅 `export_draft`→剪映，已集成 ffmpeg（`_ffmpeg_bin`/转码/抽音轨），新增 `export_video`（直出 mp4）复用同一 ffmpeg。

### 阶段 F — 开源可商用特效/花字素材接入（调研 + 集成）
> 用户硬需求："去 GitHub 找可商用的开源"。本阶段把特效目录从"手写 CSS 原语"扩成"可复用开源库/预设"。**不套完整剪辑器**（Remotion/Shotstack/MoviePy/Fabric/Konva 各有自己的时间系统），只接 Effect Schema 灵感的库 + CSS/WebGL 特效库作为 Adapter。

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
- **A/B**：MCP `add_effect` 建段 → `draft_state.json` 出现带 `id` 的 effect 段；`buildPlaybackGraph` 产出 effectNodes；`EFFECT_REGISTRY` 含 9 原语双 adapter。
- **C**：播放头下激活 filter 段 → 目标层/整栈变亮+模糊；adjustment 段盖整栈；多段叠加；隐藏轨复位。
- **D**：特效段在时间轴可拖拽/拉长/缩短（复用 segment 交互），duration 变化即时反映到播放器。
- **E**：`export_video` 出 mp4，滤镜/调色/渐入渐出已烘焙（播放器所见=导出所得，逐帧无色差）。
- **F**：花字/文字动效预设可由 agent/MCP 调用，商用许可已登记。
- **通用**：V1-V6 播放器回归全过；`graph_consistency` 对拍 pass。

---

## 6. 风险 / 不做项
- **风险 R1**：per-clip filter 需 renderer 能定位"目标素材层 DOM"。当前素材层按 track/seg key 索引，需在 renderer 建 `layerBySegKey` 映射（阶段 C 落码时补）。
- **风险 R2**：CSS filter 不会自动进 ffmpeg，需阶段 E 手写映射（已通过 §2.3 注册表解决）；blur/invert 个别 ffmpeg 等价需验证（gblur/negate 有）。
- **不做**：单效果全局开关、FableCut 属性式（`clip.props`）、v2 的抠像/扭曲/粒子（阶段 H）。
- **不动**：MasterClock/AudioEngine/MediaSlot 内核（铁律：加元素不改内核）。

---

## 7. MVP 定义（钉死）
**能剪出一条完整的口播视频 = MVP 达成。** 阶段 A~E（逐片段调色 + 框人遮罩 + 文字动效 + 渐入渐出 + 关键帧 + 直出 mp4）足以支撑，无需 v2。阶段 F 扩充可商用特效目录，阶段 G/H 后置优化。

---

## 8. 外部架构 review 采纳记录

### 8.1 ChatGPT 评审（2026-08-17，用户转述）
与 ADR-001 高度一致（特效=Graph 上的 Node，不侵入播放核心）。采纳项：
- ✅ **target 结构化**（弃 `video:0:0` 字符串，改 `{type,track,ti,si}`）+ 稳定 clip id 路线。
- ✅ **术语统一**：global → **Adjustment Layer（调整层）**，对齐 PR/剪映。
- ✅ **阶段 C 抽 `effects.js` 独立模块**，renderer.js 只调用不内联，防 5000 行膨胀；冻结应用管线顺序（Transform→Effect→Mask→Adjustment→Composite）。
- ✅ **阶段 E 改 Schema 注册表双 adapter**（render+ffmpeg 读同一 Schema），防预览/导出漂移；v1 先简单支持 9 原语。
- ✅ **必补 Effect Schema 冻结（§2.0/§2.1）+ Effect 生命周期（§2.2）**，服务 Agent 可操作内核。
- ✅ **阶段 F 把 `pixi.js`(MIT) 列为花字/粒子重点研究对象**（v2 WebGL 底座）。
- ⚠️ **部分采纳**：ChatGPT 建议完整 OOP 渲染器分层（LayerRenderer/EffectRenderer/...）。v1 仅抽 `effects.js` 纯函数模块，不做全类层级重写（避免过度工程，等特效类型增多再演进）。
- ⏸ ChatGPT sign-off：A/B/C ✅、D ⚠️、E ⏸先简单、F ✅、G/H ⏸后置 —— 与本项目纪律一致。

### 8.2 用户终审（2026-08-17，本版定稿依据）
- ✅ **Effect 是时间实体，与 clip 平级**：冻结 Schema 加 `id` + `range{startUs,endUs}`（§2.0）。
- ✅ **Effect Registry 提进阶段 A**（不在 E 等）：§2.3 + 阶段 A 即定义 `EFFECT_REGISTRY`，预览/导出/未来 v2 同源扩展。
- ✅ **生命周期补 `duplicate_effect`**：MCP 四件套 `add/update/remove/duplicate`（§2.2）。
- ✅ **架构定性**：特效=Effect DSL 节点（Agent 能力接口），非"塞播放器的一段代码"；流向 Agent→DSL→Adapter(CSS/Canvas/WebGL/FFmpeg)（§2.1）。
- ✅ **不套完整剪辑器**：GitHub 只接 Effect Schema 灵感 + CSS/WebGL 特效库作 Adapter（§F）。
- ✅ **方向 sign-off**：A Schema+Registry+MCP → B Graph → C Renderer → D UI → E Export → F GitHub pack，开干。
