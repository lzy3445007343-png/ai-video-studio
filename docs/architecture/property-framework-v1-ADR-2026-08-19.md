# ADR-2026-08-19 · Property Framework v1 —— 参数面板 UI 内核（vanilla JS）

> 状态：**待用户 sign-off（本设计稿不改代码）**
> 依据：2026-08-19 全天参数面板问题复盘 + ChatGPT 独立评估（用户贴回）+ OpenCut classic 真源码对照
> 仓库内参考：`reference/opencut-classic/apps/web/src/components/editor/panels/properties/`、`reference/opencut-classic/apps/web/src/masks/components/masks-tab.tsx`

---

## 1. 决策背景

参数面板（右侧 7 tab：关键帧/音频/速度/遮罩/字幕/贴纸/特效）今天出现连环问题：点不动、输不进、抓手光标、换素材变样。复盘确认**五个真实根因**：

| 根因 | 层面 | 状态 |
|---|---|---|
| HTML 标签未闭合（面板被吸进 display:none 子树） | DOM 结构 | ✅ 已修（15a40a9） |
| `allow_reuse_port=True` 旧进程抢答 8080 发旧构建 | 服务器 | ✅ 已修（404e607） |
| WebView2 缓存旧 HTML | 缓存 | ✅ 已修（no-cache + `?v=时间戳` + 版本戳） |
| **A：innerHTML 全量重建（500ms 轮询吞交互）** | **前端架构** | ⚠️ 已缓解（结构守卫），未根治 |
| **D：`.seg` 类名污染参数面板段名 span** | **全局 CSS** | ❌ 未修 |

**核心结论（评估确认）**：问题本质不是"OpenCut 没抄好"，而是**把 React/组件式交互迁移到 vanilla JS 时只迁移了一半**——state 变化 → `innerHTML=""` → 重新生成节点 → 焦点丢失。结构 key 守卫只是"React reconciliation 的低配手工实现"，**不是终点**。

**项目已进入剪辑软件 UI 架构阶段**：目标从"面板能显示"升级为"正在操作的属性控件不允许被销毁"（剪辑软件铁律）。

---

## 2. 目标与非目标

### 目标
1. 建立**可复用的 Property Framework**（Field 组件 + DraftStore + 事件代理 + 面板生命周期），一次覆盖全部 7 个 tab。
2. 根治根因A：**用户正在交互的控件 DOM 永不被销毁**（结构变化才重建）。
3. 根治根因D：类名命名空间化，杜绝全局类名误伤。
4. 根治根因B：字幕/贴纸从白名单死锁解耦为常驻入口。
5. 渐进改造，**不破坏现有播放/时间轴/MCP 链路**（这些是已验证资产）。

### 非目标（明确不做）
- ❌ 不推倒重写整个编辑器（Timeline Kernel / playback graph / MCP / effect schema 是资产）。
- ❌ 不引入 React / 框架依赖（保持纯 vanilla JS，项目技术栈冻结）。
- ❌ 本阶段不改 `Store → renderAll` 的播放链路（订阅切片放 Phase 2，见 5.5）。

---

## 3. 架构总览

```
property/                          ← 新目录，独立于现有 8 个外部 JS
 ├── PropertyPanel.js              面板外壳：三态路由 + tab 切换 + 面板生命周期
 ├── registry.js                   tab 注册表（对齐 OpenCut registry.tsx）
 ├── Field.js                      Field 基类：DOM 生命周期 + 值同步 + 事件挂载
 ├── NumberField.js                数字输入（draft + blur commit + 步进/钳制）
 ├── SliderField.js                滑块（拖动实时预览 + debounce commit）
 ├── ToggleField.js                开关（即时反馈 + commit）
 ├── SelectField.js                下拉（选择即 commit）
 ├── DraftStore.js                 draft/commit 两阶段状态管理
 └── names.js                      类名常量（命名空间，根因D 根治）
```

数据流（对齐 OpenCut `usePropertyDraft` 两阶段）：

```
用户输入
   ↓
DraftStore.preview(value)  →  只改内存 + 调预览渲染器（不碰后端、不触发全局重渲）
   ↓ (blur / Enter)
DraftStore.commit()        →  调后端 Command → 成功后 refresh 回填 Store
```

---

## 4. 核心设计

### 4.1 Field 基类（对齐 OpenCut `PropertyParamField` / `NumberField`）

每个控件 = 一个 Field 实例，**DOM 在 mount 时创建一次，之后只同步值**：

```js
class Field {
  constructor({ id, label, buildDom(), read(state), write(el, value), onPreview, onCommit }) {
    this.el = null;               // 挂载后的根元素（组件持有，永不销毁）
    this._handlers = [];          // 事件绑定记录（unmount 时统一解绑）
  }
  mount(host) { this.el = this.buildDom(); host.appendChild(this.el); this.bind(); }
  update(value) { this.write(this.el, value); }   // 只改 value / dataset / class
  unmount() { this._handlers.forEach(h => h()); this.el?.remove(); }
  on(el, type, fn) { el.addEventListener(type, fn); this._handlers.push(() => el.removeEventListener(type, fn)); }
}
```

**铁律**：`mount` 只在结构变化时调用；`update` 是唯一的值同步路径；`unmount` 保证无泄漏。

### 4.2 具体 Field（对齐 OpenCut 的 ui 组件族）

| Field | DOM | 交互 | commit 时机 |
|---|---|---|---|
| `NumberField` | `<input type="text" inputmode="decimal">` + unit | input→preview（本地态），blur/Enter→commit | blur/Enter |
| `SliderField` | `<input type="range">` | input→preview（实时预览渲染器），change→commit | change/debounce |
| `ToggleField` | `<div class="switch">` | click→本地翻转 + commit | click |
| `SelectField` | `<select>` | change→commit | change |

所有 Field 的输入控件带命名空间类（见 4.6），CSS 全局兜底 `property-field input { cursor: text !important }`。

### 4.3 DraftStore（对齐 OpenCut `use-property-draft.ts`）

```js
// 每个 Field 一个 draft；编辑中只动本地态，blur/Enter 才落库
class DraftStore {
  constructor({ getValue, preview, commit }) {}
  onInput(raw) { this.draft = parse(raw); this.preview(this.draft); }  // 内存态 + 预览渲染
  onCommit()  { this.commit(this.draft ?? this.getValue()); }          // 后端落库
}
```

关键区别 vs 现状：现在 audio/speed 的 preview/commit 是**手写在每个面板里**；DraftStore 把它变成**每个 Field 的内建能力**，所有面板一致。

### 4.4 容器级事件代理（评估补的关键项）

面板容器只绑一次事件，用 `data-*` 路由（对齐当前 mask 面板的委托做法，推广到全部面板）：

```js
// PropertyPanel 挂载时绑定一次，面板生命周期内永不解绑
panelEl.addEventListener("input",  e => routeFieldEvent(e, "input"));
panelEl.addEventListener("change", e => routeFieldEvent(e, "change"));
panelEl.addEventListener("click",  e => routeAction(e));   // data-act="toggle-kf" / "add-kf" ...
```

**根治重复绑定/丢失/泄漏**：kf/effect 现有的"每次 rebuild 重新 `querySelectorAll().addEventListener`"全部废除。

### 4.5 面板生命周期（对齐 OpenCut `PropertiesPanel`）

```
renderPropertyPanel()
 ├─ 三态：无选中(EmptyView) / 多选(MultiView) / 单选(单 tab)
 └─ 单选：key = 段身份 + 类型 + 结构性开关（关键帧通道集/形状类型/特效参数集）
     ├─ key 相同 → panel.update(state)     // 只 Field.update，绝不重建
     └─ key 变化 → panel.rebuild(state)    // unmount 旧 Field 树 → mount 新 Field 树
```

面板外壳（PropertyPanel）与 Field 树的关系：**外壳持有关键帧/遮罩等结构性状态；Field 树持具体控件**。切换段 → 外壳换 key → Field 树整体重建（控件是新段的，合理）；播放头移动/值变化 → 只 Field.update。

### 4.6 命名空间化（根因D 根治，评估建议"两个都做"）

**① 段名 span 改名**：7 个面板 head 的 `<span class="seg" id="xxxSegName">` → `class="property-seg-name"`（HTML 476/487/496/533/568/574/579），配套 CSS `.tools-content .head .seg`（212）改 `.tools-content .head .property-seg-name`。

**② 全局 `.seg` 收窄**：`.seg { ... }`（321-322）→ `.tl-content .seg`（仅时间轴），并 grep 确认无其他区域依赖裸 `.seg`。

**③ 新命名空间约定**（本项目内生效）：
- 时间轴：`tl-*`（tl-seg / tl-track / tl-ruler）
- 参数面板：`property-*`（property-panel / property-field / property-num / property-switch / property-seg-name）
- 素材：`media-*`（media-card 已是）
- **禁止再出现裸 `.seg` / `.clip` / `.track` / `.item` 这类全局通用类名**（剪辑软件 UI 极易撞名）。

### 4.7 字幕/贴纸常驻入口（根因B 解耦）

现状：`PROPERTY_TABS_BY_TYPE` 把 `sub`/`sticker` 锁在"必须先选中对应段"白名单（text→["sub"] / sticker→["sticker",...]），而字幕/贴纸面板本质是**创建型入口**（ASR 生成字幕 / 添加贴纸）→ 鸡生蛋。

改造（对齐 OpenCut：字幕/贴纸有独立面板，不依赖选中）：
- rail 按钮 `sub`/`sticker` **常驻可用**（不依赖选中类型）。
- 点击进入：无选中 → 显示"创建/生成"控件（ASR 源选择 + 生成按钮 / 添加贴纸按钮）；选中对应类型段 → 额外显示编辑控件。
- `PROPERTY_TABS_BY_TYPE` 的 `text`/`sticker` 白名单仅用于"选中对应段时 rail 高亮"，不再作为"能否进入"的锁。

---

## 5. 迁移计划（分阶段，每阶段独立验收）

### Phase 0 —— 根因D 修复（独立交付，10 分钟）
- 段名 span 改名 + `.seg` 收窄 + names.js 建立。
- 验收：jsdom 断言段名 span computed cursor = auto；真机：参数面板 head 无抓手。

### Phase 1 —— 基础设施（不迁移任何面板）
- `property/` 目录 + Field 基类 + 4 个具体 Field + DraftStore + 事件代理 + registry 骨架。
- 用一个测试面板（新建 `property-test` tab）验证三件套。
- 验收：jsdom 冒烟（Field mount 一次、update 只改值、unmount 无泄漏、事件代理路由正确）。

### Phase 2 —— 面板逐个迁移（每个 tab 一个 commit + 独立验收）
顺序：**audio → speed → mask → effect → kf → sub/sticker**（audio/speed 已有两阶段逻辑，迁移成本最低；sub/sticker 最后因含根因B 解耦）。
- 每个 tab：手写 innerHTML 模板 → Field 组件树；直接绑事件 → 事件代理；即时提交 → DraftStore。
- 验收（每个 tab）：jsdom（同段两次渲染控件同一 DOM 实例 / 结构变化重建 / 值更新正确）+ 真机（输入不丢焦点、拖动跟手、换段正常）。

### Phase 3 —— 订阅切片（渐进，单独评估后实施）
- 现状：`Store.subscribe(renderAll)` 全量广播，播放头/时间轴/面板全挂一起。
- 目标：`Store.subscribe("playhead", fn)` / `Store.subscribe("draft", fn)` 细粒度订阅；面板只订阅自己关心的切片。
- **护栏**：播放/时间轴链路在 Phase 3 前一律不动；切片改造按"新增订阅 API → 逐个订阅者迁移 → 验证后拆 renderAll"推进，**不做一刀切**。

### Phase 4 —— 收尾
- 删除结构守卫残留（`__key` 手写守卫全部收敛到 PropertyPanel 生命周期）。
- `_suppressPanelRender` 冻结机制评估是否可简化（面板已不重建，轮询冻结可弱化）。
- 更新 `docs/README.md` 索引。

---

## 6. 风险与回退

| 风险 | 缓解 |
|---|---|
| 全面板迁移回归（面板显示/交互被改坏） | 每 Phase 独立 commit + jsdom 冒烟 + 真机验收；面板逐个迁，不批量 |
| 播放链路被订阅切片破坏 | Phase 3 前不动播放链路；切片改造带验收护栏 |
| 事件代理路由误判（data-act 冲突） | data-act 命名带面板前缀（`data-act="kf-toggle"`）；registry 校验唯一性 |
| Field 体系过度设计（复杂化简单面板） | Field 基类最小化；sub/sticker 这类简单面板允许直接用 Field 组合而非子类 |

**回退**：每个 Phase 一个 git 分支/commit，出问题 `git revert` 单个 commit 即可。

---

## 7. OpenCut 对照表（设计点 → 源码依据）

| 我们的设计 | OpenCut 源码依据 | 文件 |
|---|---|---|
| PropertyPanel 三态 + tab 路由 | `PropertiesPanel` 组件 | `panels/properties/index.tsx` |
| registry 注册表驱动 | `getPropertiesConfig` + `visibleTabs` | `panels/properties/registry.tsx` |
| Field 基类 + 具体 Field | `PropertyParamField` + `NumberField`/`ColorPicker`/`Select` | `components/property-param-field.tsx`、`components/ui/number-field.tsx` |
| DraftStore 两阶段 | `usePropertyDraft`（onPreview/onCommit） | `hooks/use-property-draft.ts` |
| 面板生命周期（key→rebuild/update） | React reconciliation（组件不销毁） | 框架层行为 |
| 遮罩面板控件体系 | `MasksTab` + `MaskItem` + `MaskNumberField` | `masks/components/masks-tab.tsx` |

**关键认知**：我们不抄 React，抄它背后的**三条纪律**——控件组件化、draft state、状态订阅粒度（评估原文）。

---

## 8. 最终验收标准

1. 参数面板 7 个 tab：**输入/拖动/点击过程中，控件 DOM 绝不被销毁**（结构变化除外）。
2. 鼠标移入参数面板任意位置：**无抓手光标**（根因D 关闭）。
3. 字幕/贴纸：**不选中任何段也能进面板**（根因B 关闭）。
4. 播放/时间轴/素材/MCP 链路：回归测试全部通过（不破坏资产）。
5. 控制台无重复绑定/泄漏警告。

---

*设计者：WorkBuddy · 2026-08-19 23:30 · 待用户 sign-off 后按 Phase 0→4 落码*
