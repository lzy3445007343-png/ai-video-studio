# UI 体验优化设计稿（v0.9 → v1.0 面板系统重构）

> 状态：设计评审中（待用户 sign-off 后落码）
> 目标：把"面板很乱 + 特效面板是空的 + 工具栏图标不美观"一次治好，并给开源特效包留好落点。
> 范围：仅前端 `工作台v0.8时间轴.html`（重命名为 v0.9 工作台）。不动后端。

---

## 0. 已知问题清单（设计依据）

| # | 问题 | 根因（代码位置） | 严重度 |
|---|---|---|---|
| B1 | 点 ✨特效 tab 面板是空的 | `TAB_TO_PANEL.effects="placeholderPanel"`，且 `renderPropertyPanel` 对 effects 走 `else{c.innerHTML=""}` 留空（HTML ~998） | 高（核心缺口） |
| B2 | 选中特效段打开的是关键帧面板 | `PROPERTY_TABS_BY_TYPE` 无 `effect` key（HTML 930），fallback `["kf"]` | 高 |
| B3 | 面板视觉不一致/乱 | 4 套重复 CSS（`.kfpanel/.maskpanel/.subpanel/.stickerpanel`），`.head` 样式互相矛盾（重 vs 轻）；两套冲突的 `.rail-btn` 规则（157 vs 541） | 中（观感） |
| B4 | 工具栏图标不美观 | tools-rail 用 emoji（🎞🔊⏱🎭💬⭐✨），风格不统一、渲染随系统字体漂移 | 中（观感） |
| B5 | 选中段不总是开对面板 | 联动逻辑本身在（`refresh→renderAll→showToolTab`），但 `effect` 缺 key 让它失效（与 B2 同根） | 中 |
| B6 | keyframe/遮罩/变速 面板已知旧 bug | 历史 postponed，待审计（见 §5） | 中（功能） |

---

## 1. 设计原则

1. **单一真源（数据驱动）**：特效面板的参数控件不手写，由 `get_effect_registry`（后端 `EFFECT_META`）自动生成。开源特效包只要注册进 `EFFECT_REGISTRY`+`EFFECT_META`，面板自动长出对应滑块——**零额外 UI 代码**。这是 Stage F 的落点。
2. **一套 Inspector 体系**：所有右侧面板统一为 `.insp` 基类 + 共享子部件样式，删掉重复 CSS。
3. **选中即开对面板**：选什么段就自动切到对应 tab（音频→音频、特效→特效、文本→字幕）。
4. **图标语言统一**：tools-rail 改用内联 SVG 线性图标（统一描边 1.6px / currentColor），去掉 emoji 漂移。
5. **不改交互内核**：复用现有 `selectKey`/`showToolTab`/`update_effect` 通道，只重排 UI 层。

---

## 2. P1 — 统一 Inspector 面板系统（治"乱"）

### 2.1 CSS 收口
- 新增统一 token 类（替换 4 套重复）：
  - `.insp`（面板容器）、`.insp-head`、`.insp-body`、`.insp-row`、`.insp-label`、`.insp-val`、`.insp-gen`、`.insp-chk`、`.insp-status`、`.insp-seg`、`.insp-tf`。
- 删除：`.kfpanel/.maskpanel/.subpanel/.stickerpanel` 各自的 `.head/.body/.row/.gen/.chk/.status` 重复块；删掉 541–543 行那套与 157 冲突的 `.rail-btn`（只保留 `.tools-rail .rail-btn` 一处）。
- 统一规格：头部高 38px、标签宽 56px、滑块/输入统一圆角与配色、`--primary-dim` 高亮选中态。
- 影响面：kfPanel / maskPanel / subPanel / stickerPanel / effectPanel（新建）/ emptyPanel / multiPanel 全部改用 `.insp-*`。**行为不变，只换皮肤。**

### 2.2 面板显示逻辑
- `placeholderPanel` 仅保留给"真正未实现"的 tab；audio/speed 改为进入统一 `.insp` 面板（见 §4）。
- 选中态/多选态（emptyPanel/multiPanel）保持，但统一样式。

---

## 3. P0 — 特效属性面板（核心交付，开源包落点）

### 3.1 触发与路由（修 B1/B2/B5）
- `PROPERTY_TABS_BY_TYPE` 增加：`effect: ["effects"]`；`PROPERTY_DEFAULT_TAB_BY_TYPE.effect = "effects"`。
- `TAB_TO_PANEL.effects = "effectPanel"`（新建专用面板，不再用 placeholder）。
- 选中特效段 → `refresh→renderAll→showToolTab("effects")` → 自动打开特效面板（B5 修复）。

### 3.2 特效库（左栏素材库 · 新增「特效」tab）—— 用户定：库与素材库放一起
- 左侧 `assets` 的 `mediaTabs` 增加「特效」分类（现有：全部/视频/音频/图片/文本 → 加 **特效**）。
- 该 tab 用 `get_effect_registry()` 枚举所有特效，渲染为卡片（图标 + 名 + EFFECT_META 一句话说明 + 支持参数提示）。
- **点击卡片的落点规则**：
  - 若当前选中了媒体段（video/image/audio/sticker）→ `add_effect(effect_type, target={type:"clip",ti,si})`。
  - 否则（无选中）→ `add_effect(effect_type, target=adjustment)`（整段时间轴生效，方便快速整段调色/转场）。
  - 建段后：时间轴出现青绿特效条 + 右栏自动打开参数面板（§3.3）。
- 顶部可加搜索框过滤（特效名/标签）。

### 3.3 参数面板（右栏 inspector · 选中特效段）
```
┌─ ✦ 模糊·整段 · 调整层                    [✕] ─┐
│ 参数                                                  │
│  模糊半径   [──────●─────]  8 px                      │
│  （由 EFFECT_META 自动生成每一行：label+滑块+单位）      │
│                                                      │
│ 关键帧  [◆ 不透明度 动画]  ← 支持的参数显示 ◆ 开启动画   │
│   已有关键帧：0.0s=1 → 1.5s=0   [＋在播放头加帧]         │
└──────────────────────────────────────────────────────┘
```
- 每个参数行 = `EFFECT_META[type].params[p]` → `{label, unit, default, min, max, step}` → 渲染为带 min/max/step 的 `<input type=range>` + 实时数值。
- 编辑 → 防抖 250ms 调 `update_effect(params={...})`（复用现有 MCP/后端通道）。
- 支持关键帧的参数（opacity/brightness…）：行尾 ◆ 切换，开启后显示关键帧列表 + "在播放头加帧"（复用 `add_keyframe`，path 形如 `effect.<param>`）。

### 3.4 为什么这是开源包的落点
Stage F 接入任意开源特效包时，只需：①在 `EFFECT_REGISTRY` 加 css+ffmpeg 适配器；②在 `EFFECT_META` 加 `{label, params}`。面板 §3.2 的两类上下文**自动渲染**，无需为每类特效写 UI。护城河（Video DSL）不变。

---

## 4. P2 — 选中联动 + audio/speed 面板归位

- 选中段自动开对应 tab（B5，随 §3.1 一并修）。
- `audio`/`speed` 改为 `TAB_TO_PANEL.audio="effectPanel"`? 否——新建轻量 `.insp` 面板（或复用 placeholderPanel 但换 `.insp` 皮肤 + 真实头部）。`renderAudioTab`/`renderSpeedTab` 现有逻辑不动，只把输出容器指向统一面板。`PROPERTY_TABS_BY_TYPE.audio/speed` 已正确，无需改键。

---

## 5. P3 — keyframe/遮罩/变速 面板旧 bug 审计+修复

- **先审计再修**：落码前用真机逐一点验这三类面板，列出实际坏点（记忆只记"有已知 bug"未记明细）。
- 假设性关注点（待实证）：
  - 关键帧：加帧/删帧/拖拽菱形/线性↔台阶切换；多参数行并存时渲染错位。
  - 遮罩：形状选择后预览未更新、变换手柄失效。
  - 变速：change_pitch 开关、ripple 联动。
- 审计结果写入本稿 §5 更新，修复与 P0/P1 同批真机验收。

---

## 6. 工具栏图标重设计（B4）

- tools-rail 7 个按钮改用内联 SVG 线性图标，统一：20×20、stroke 1.6、`fill:none`、`stroke:currentColor`；常态 `color:var(--muted)`，`.active` `color:var(--primary)`。
- 图标语义映射：
  | tab | 图标 |
  |---|---|
  | kf 关键帧 | 菱形 ◆ |
  | audio 音频 | 波形 |
  | speed 速度 | 时钟 |
  | mask 遮罩 | 遮罩形（圆缺一角）|
  | sub 字幕 | 文字行 |
  | sticker 贴纸 | 星 |
  | effects 特效 | 闪光 ✦ |
- topbar 的撤销/重做/导出保持，补 tooltip；不引入新依赖（图标内联，不打外部字体）。

---

## 7. 明确不在本次范围

- **导出 mp4（Stage E）**：用户定明天做。
- **Stage F 开源特效包实际接入**：本稿的特效面板是它的前置；包接入本身另立任务（面板就绪后做）。
- **时间轴框选多选（marquee）**：用户评"暂时不重要"，本期不做；`multiPanel` 已占位，后续可接。

---

## 8. 执行顺序（设计→落码→真机验收，严格串行）

1. **P1** 统一 Inspector CSS（去重/修冲突规则）→ 真机看面板风格一致。
2. **P0** 特效面板：路由修复 + effectPanel + 数据驱动参数 + 加特效库 → 真机：选中特效段能改参数、选媒体段能加特效。
3. **P2** audio/speed 归位 + 选中联动收尾。
4. **工具栏图标** SVG 替换 emoji。
5. **P3** 审计 keyframe/遮罩/变速 → 修 → 真机验收。
6. 整体回归 + 推 GitHub。

---

## 9. 开项裁定（已定，待 sign-off 落码）

- **Q1 工具栏图标**：✅ SVG 线性图标（统一描边 1.6px / currentColor），去掉 emoji 漂移。
- **Q2 特效库位置**：✅ 特效库放**左栏素材库**（mediaTabs 新增「特效」tab，卡片来自 `get_effect_registry`）；右栏只做参数面板（选中特效段改参数）。库与素材库放一起。
- **Q3 audio/speed 面板**：✅ 统一进 `.insp`（去掉 placeholderPanel 占位机制，与特效面板同体系）。

> 裁定后锁定，进入落码（§8 顺序：P1→P0→P2→工具栏→P3）。
