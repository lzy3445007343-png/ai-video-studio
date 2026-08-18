# UI 重构设计 v0.9-Panel（面板布局 + 工具栏 + 特效拖拽）

> 状态：**已签批并落码**（commit 22f0a0d）。关键帧/蒙版逻辑修补仍按用户决定延后。
> 日期：2026-08-17｜基线 commit：a0551d7（P3 关键帧/变速修复）之后

## 0. 本次范围（锁定的）

用户原话要点：
- 撤销/重做在标题栏 → 应进工具层
- 工具栏图标丑/乱 → 统一成 SVG 线性图标（与右侧属性 rail 同款）
- 素材面板乱：去掉"全部"；分类重排为 **媒体(视频+图片) / 音频 / 文本 / 特效**；音频单独 tab
- 网格/列表切换没用 → **直接删掉**，固定网格双列
- 特效应能**拖进时间轴**（当前只能点击）
- 拖拽"有的地方拖不进" → 参考 OpenCut 交互（**本次只画清楚正确交互，深修留后**）
- 关键帧/蒙版"逻辑不全、没实际作用" → **本次不做**，后面再说

## 1. 不做的事（明确划界）

| 项 | 状态 |
|---|---|
| 关键帧面板逻辑修补 | 不做（用户：后面再说） |
| 蒙版面板逻辑修补 | 不做（用户：后面再说） |
| 拖拽 drop 逻辑深层修复（哪些区域拖不进的真 bug） | 不做深修；本次只把"类型不匹配轨道显禁用态 + 空白区新建轨道"的**视觉反馈**画进设计，落码时一并补上这条反馈 |
| 导出 mp4（Stage E） | 不在本次，按排期明天 |
| 开源特效包接入（Stage F） | 不在本次；但特效卡片可拖拽是 Stage F 的载体，先打通 |

## 2. 改动清单

### 2.1 撤销/重做 relocation（topbar → tl-toolbar）
- 从 `.topbar` 移除 `undoBtn`/`redoBtn`（329–330 行）。
- 移入 `.tl-toolbar`（607–623 行）最左，位于分割工具（`splitBtn`）之前。
- 点击事件、`Ctrl+Z`/`Ctrl+Shift+Z`/`Ctrl+Y` 快捷键逻辑不变，仅 DOM 位置变。

### 2.2 tl-toolbar 全 SVG 化
- 现 9 个工具仍为 emoji（✂ / ◀✂ / ✂▶ / 🔗 / ⏩ / ⧉ / 🗑 / ⌁ / ≈）。
- 改为 20×20 `viewBox="0 0 20 20" stroke="currentColor" stroke-width="1.6"` 线性图标，与右侧 `toolsRail` 的 rail-btn 同风格。
- 图标语义（已锁定，见设计图 v09_toolbar_icons）：
  - 撤销 ↶ / 重做 ↷（移入）
  - 分割 ✕ / 左切 / 右切
  - 原声（时钟+圆圈）/ 变速（双箭头+刻度）
  - 复制（方块+角）/ 删除（两条横杠）
  - 吸附 / 波纹（缩放 − ＋ 保留）

### 2.3 素材 tabs 重分类
- `.tabs#mediaTabs`（341–346 行）改为：
  - `媒体`（筛选 `video`+`image` 合并）
  - `音频`（audio）
  - `文本`（text）
  - `特效`（effect）
- 删除 `全部` tab；`renderMedia` 里 `s.filter === "all"` 分支删除，媒体 tab 走 `filter in [video, image]`。
- 头部删除 `viewGrid`/`viewList` 两个按钮（339 行），固定网格视图；`Store.state.mediaView` 相关逻辑清理。

### 2.4 特效卡片可拖拽
- `renderEffectLibrary`（887 行）给 `.effect-card` 加 `draggable=true` + `dragstart`，payload：`{kind:"effect", type}`。
- `onTimelineDrop`（2006 行）识别 `kind==="effect"`：调用 `add_effect(0, type, {type:"adjustment"})`，无选中段即 adjustment 层；有选中段则绑定该段（复用 `addEffectFromLibrary` 的 target 判定）。
- 落点视觉：特效拖入空白轨道区显示"新建调整层"提示（复用 `dropNewTrackHint`），与媒体拖入一致。

### 2.5 拖拽反馈补全（参考 OpenCut）
- `trackUnderY` 类型不匹配时，当前无任何视觉反馈 → 补：`showDropPreview` 对不匹配轨道加 `drop-disabled` 态（灰红描边 + 提示"轨道类型不兼容"）。
- 空白区仍走"新建同类型轨"逻辑（逻辑已通，只补提示文案）。

## 3. 执行顺序（签批后）

1. 2.1 撤销/重做 relocation（DOM 移动 + 绑定保留）
2. 2.2 tl-toolbar SVG 化（替换 emoji 为 SVG，含 undo/redo）
3. 2.3 素材 tabs 重分类 + 删列表切换
4. 2.4 特效卡片可拖拽 + 2.5 拖拽反馈补全
5. `node --check` 内联脚本 → 提交 → 用户重启 `start.bat` 热加载验收

## 4. 设计图（已出，供回看）

- `v09_overall_layout`：整体布局（标题栏精简 + 工具栏在其下 + 左素材面板 + 轨道区落点）
- `v09_toolbar_icons`：工具栏 12 个 SVG 线性图标定稿
- `v09_asset_panel_tabs`：素材 tabs 重排 + 特效卡拖拽示意

## 5. 待用户签批点

- [ ] 分类「媒体(视频+图片)/音频/文本/特效」认可？
- [ ] 列表视图直接删除认可？
- [ ] 撤销/重做放工具栏最左认可？
- [ ] 工具栏 SVG 图标定稿认可（见 v09_toolbar_icons）？
- [ ] 特效拖拽 = 新建 adjustment 层（有选中段则绑段）认可？
- [ ] 是否把"UI 改动 design-first 工作流"沉淀为 skill 复用？
