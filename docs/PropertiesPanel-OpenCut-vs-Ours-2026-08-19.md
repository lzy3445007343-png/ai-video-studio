# 参数面板 — OpenCut vs 我们（对照 + 待办）

> **目的**：你说"先 UI 再功能 + 一个一个拎出来"——本表把每个面板拆开列：**OpenCut 长啥样 / 我们现在怎样 / 缺什么 / 估计工作量**，让你选从哪个先开始。
> 调研时间：2026-08-19 14:30
> 读完 OpenCut 源码：properties/index.tsx + registry.tsx + element-params-tab.tsx + property-param-field.tsx + keyframe-toggle.tsx + section.tsx + properties-store + 3 个 hook + speed-tab + masks-tab

---

## 整体架构对比

| 维度 | OpenCut | 我们 | 差距 |
|---|---|---|---|
| **入口** | `PropertiesPanel({selectedElements})`（store 自动响应） | `renderPropertyPanel()`（手动 selectKey 触发） | 大 |
| **左侧 tab 栏** | icon + tooltip，点击切换 | icon + 文字 + 点击切换 | 视觉风格差异 |
| **Tab 内容接口** | `content({trackId, element})` — **稳定 id 入口** | 用 `selectedSeg()` + `selectedKey` 解析 ti:idx | ❌ 之前的 A 诊断 bug |
| **每个 element 类型的 tab 列表** | `getPropertiesConfig({element, mediaAssets})` switch | `PROPERTY_TABS_BY_TYPE` 配置 | 结构相似 |
| **每个类型默认 tab 记忆** | `activeTabPerType[element.type]` | 无 | ❌ 缺失 |
| **面板 UI 容器** | `<Section collapsible>` + 标题栏 + chevron | 直接堆字段 | ❌ 视觉风格差异 |
| **空选中** | `EmptyView` | `emptyPanel`（"暂未实现"） | 视觉差异 |
| **多选** | "{count} elements selected" | `multiPanel`（"X 个片段已选中"） | 一致 |
| **数字输入控件** | `NumberField`（拖拽 scrub + 显示单位 + reset） | 滑块 + 输入框 | ❌ 视觉差异 |

---

## 各面板逐项（按 element 类型分组）

### 1. 视频段（video）— 6 个 tab

OpenCut 配置：transform / audio（条件） / speed / blending / masks / effects（默认 transform）

| Tab | OpenCut UI（你截图看） | 我们现状 | 待做 |
|---|---|---|---|
| **transform** | "变换"折叠标题栏 + 6 字段（位置X/Y、缩放X/Y、旋转、不透明度），每字段 `◆ + 标签 + 输入` | 合并在 kfPanel 里（结构对，风格旧） | 拆出来独立 panel + Section 风格 |
| **audio** | "音频"折叠标题栏 + 音量滑块（带预览/提交） | placeholder "已加入路线图" | UI + 接 seg.audio / `update_segment` |
| **speed** | "速度"标题栏 + 速度滑块 + Change Pitch 开关（截图里 OpenCut 速度面板就是这个） | placeholder "已加入路线图" | UI + 接 `update_segment` retime |
| **blending** | "融合"标题栏 + 不透明度 + 混合模式下拉 | 没做 | UI + 接 segment.opacity/blendMode |
| **masks** | "遮罩"标题栏 + + 添加遮罩按钮（hover 预览 mask 形状）+ 已添加 mask 列表 + 每个 mask 参数（Position X/Y、Size W/H、Rotation、Feather、Stroke 宽度/颜色/对齐） | `renderMaskPanel` 几乎空（只有 6 个 mask 类型文字） | 大：完整重做（含 hover 预览 + 6 个 mask 类型参数） |
| **effects** | "影响"标题栏 + + 添加 effect + 已添加 effect 列表（每 effect 有 filter 参数） | `renderEffectPanel` 有滑块但写死 CSS 特效 | UI 重做（hover preview 添加 + 资源化） |

**video 工作量**：6 个 tab × UI + 后端，最重

### 2. 图片段（image）— 4 个 tab

OpenCut：transform / blending / masks / effects

| Tab | 我们现状 | 待做 |
|---|---|---|
| transform | kfPanel 里 | 拆出来 |
| blending | 没做 | UI + segment.opacity/blendMode |
| masks | 空 | 同 video.masks |
| effects | 有（renderEffectPanel） | UI 重做 |

### 3. 文本段（text）— 3 个 tab

OpenCut：text / transform / blending

| Tab | 我们现状 | 待做 |
|---|---|---|
| **text** | `renderSubPanel` 只读显示段名 | UI + 后端：`update_text` / 字体/字号/颜色/对齐/字间距/行高/背景框 |
| transform | kfPanel 里 | 拆出来 |
| blending | 没做 | UI + opacity/blendMode |

### 4. 音频段（audio）— 2 个 tab

OpenCut：audio / speed

| Tab | 我们现状 | 待做 |
|---|---|---|
| audio | placeholder | UI + 音量滑块（提交 update_segment） |
| speed | placeholder | UI + speed 滑块 + pitch 开关 |

### 5. 贴纸段（sticker）— 3 个 tab

OpenCut：transform / blending / effects

| Tab | 我们现状 | 待做 |
|---|---|---|
| transform | kfPanel 里 | 拆出来 |
| blending | 没做 | UI + opacity |
| effects | 有 | UI 重做 |

### 6. 特效段（effect）— 1 个 tab

OpenCut：effects（StandaloneEffectTab — 调整层 vs 绑段，绑段时可调目标段）

| Tab | 我们现状 | 待做 |
|---|---|---|
| effects | renderEffectPanel 已有滑块 | UI 区分 adjustment / clip 目标 + 选目标段 UI |

---

## 关键 UI 组件（一次性先做，6 个面板复用）

按你说的"先 UI 再功能"，**UI 基础组件**先做出来，后面 6 个面板都用得上：

| 组件 | 复用度 | 状态 | 估计 |
|---|---|---|---|
| **Section 折叠面板**（标题栏 + chevron + 折叠动画） | 极高（所有 tab 都用） | ❌ 没做 | 1-2h |
| **SectionField**（label + beforeLabel + input） | 极高（每个字段） | ❌ 没做（用 div） | 1h |
| **NumberField**（输入框 + scrub 拖拽 + 单位 + reset） | 高（所有数字字段） | ❌ 没做（用 type=range） | 2-3h |
| **KeyframeToggle**（◆ 按钮） | 中（仅 transform/blending 字段） | 有（简陋） | 0.5h |
| **Switch**（开关） | 中（speed change pitch / 等） | | 0.5h |
| **Select**（下拉） | 中（blend mode / font 等） | | 0.5h |
| **ColorPicker** | 低（仅文本背景/stroke） | | 2h |

---

## 建议工作顺序

**你说"先 UI 再功能、一个一个拎出来"**——下面是我建议的拆批：

### 第 1 批：UI 基础（必做，所有面板地基）
- Section / SectionField / NumberField / KeyframeToggle 4 个组件
- 整体面板入口改造（activeTabPerType 记忆 + 接收 `{element, trackId}`）
- **不接功能**：每个 tab 用 mock 数据能渲染出 OpenCut 视觉就行
- 工作量：**半天**

### 第 2 批：4 个面板的 UI 模仿（先做 UI，能看不能用）
- audio / speed / blending — 这 3 个结构最简单，先做
- text（先 UI）— 内容字段多但都是输入框
- **不接功能**：能渲染 OpenCut 风格，每个字段显示当前值/可改但改完不存
- 工作量：**1 天**

### 第 3 批：核心面板的 UI + 功能
- transform 拆出（从 kfPanel 拆）+ 关键帧读写真正工作（之前 A 诊断的 segid bug 必须修）
- masks（最复杂：mask 类型 + hover 预览 + 6 个 mask 参数）
- effects（调整层 vs 绑段 + filter 资源化）
- 工作量：**2-3 天**

### 第 4 批：剩余面板 + 功能
- sticker / text / audio 完整功能
- 多选 / 空选 UI 收尾
- 工作量：**1 天**

---

## 拍板：你怎么开始？

**先做哪批？** 你回 **1 / 2 / 3 / 4** 即可：
- **1**：UI 基础（Section + NumberField 等），先做地基
- **2**：audio/speed/blending/text 的 UI（用 mock 数据）
- **3**：核心面板（transform + masks + effects）
- **4**：sticker/text/audio 完整功能

**或者你心里有别的排序**，告诉我。比如"先把 audio/speed/blending 的 UI + 功能一起做完"也行。