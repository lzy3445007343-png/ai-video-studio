# 预览拖动 + 关键帧自动打点 · 方案 v2（2026-08-20，已吸收 GPT 评审）

> 状态：**v1 已评审，v2 吸收全部修改点，待用户 sign-off 后落码**
> 目标：在预览（播放器）里直接拖动素材 → 实时改位置/缩放/旋转 → 松手提交；已开关键帧动画的属性，拖动自动在播放头处打关键帧（对齐 OpenCut 交互）。
> 前置：KF 面板 UI 已对齐 OpenCut（section 分组 + ◆ 开关，用户已验收）。Property Framework v1 已落地（audio/speed/mask/effect/kf 五面板）。
> **v2 变更**（GPT 评审 7 条全吸收）：①baseTransform → seg.transform ②applyKfTransform 三层解析 ③新增 interactionDraft 中间态 ④播放中拖动延后 ⑤wrap hit-test 不提前优化 ⑥后端 update_segment_transform ⑦undo transaction。

---

## 1. 目标行为（用户真机确认的 OpenCut 行为）

1. 选中时间轴素材 → 预览里**拖动素材本体** → 位置跟着走（实时预览）
2. **前提**：先在属性面板点 ◆ 开启某属性（如 X/Y）的关键帧动画
3. 播放头拖到后面的时间 → 再在预览里拖素材 → **自动在该播放头位置打一个关键帧**（值=新位置）
4. 时间轴素材段上出现**白色菱形**（关键帧标记）
5. 属性面板对应字段 ◆ 变实心蓝 + 值同步

用户实测截图证实：X/Y 通道 ◆ 实心蓝、素材段上菱形、播放器素材位移三处联动，且关键帧是"拖预览自动打上的"，非面板操作。

> **v2 定位升级**：这不是一个 UI 功能，是在补齐编辑器模型层——Timeline Kernel → Playback Graph → Renderer → **Interaction Layer**。本质是定死 transform/animation 基础对象（AI Agent 可操作的视频编辑 DSL）。

## 2. 现状事实（已读代码核实）

### 2.1 预览渲染（renderer.js:76 renderPreview）
- 每条视频轨一个 **DOM div**（`previewState.visualEls`，wrap 元素），内部挂 media（video/img）
- `applyKfTransform(el, seg, localUs)`（renderer.js:665）每帧把 transform 应用到 div：
  - `el.style.transform = translate(x*sc, y*sc) scale(sx,sy) rotate(r)`；`el.style.opacity = o`
  - x/y/sx/sy/r/o 全部从 `seg.animations["transform.positionX"]` 等通道 `kfVal` 插值读出；无通道 → 默认 0/0/1/1/0/1
- 播放中由 `applyKfLiveAll()`（renderer.js:684）每帧驱动

### 2.2 关键帧数据模型
- `KF_PATHS_BY_TYPE`（HTML:1409）：video/image/sticker 各 6 通道（positionX/Y、scaleX/Y、rotate、opacity），**路径名即 OpenCut 风格** `transform.positionX`
- 前端打点：`addKfAtPlayhead(path, val)`（HTML:1637）→ 后端 `add_keyframe` 命令
- 开关：`toggleKf(path)`（HTML:1624）→ 有 key 清空（`clear_keyframes`）/ 无 key 打点
- 插值：`kfVal(anims, path, localUs)`（HTML:1484）线性插值

### 2.3 画布坐标
- `canvasPxJS()`（HTML:1488）：按 ratio 返回 {W,H}（长边 1080）
- `applyKfTransform` 用 `sc = previewStack 实际宽 / cp.W` 换算像素

### 2.4 事件现状
- **预览元素（wrap div）目前无任何 pointer/mouse 事件绑定**
- 预览区域无 hit-test；`resolveHits(us)` 只用于渲染层排序，无交互命中

## 3. 关键模型缺口（v2 已定：seg.transform，不叫 baseTransform）

**OpenCut 两层**：`element.transform`（静态状态）+ `animations`（动态覆盖）。
**我们一层**：`seg.animations` 通道；无通道时 `applyKfTransform` 读不到 → 默认 0/1。

→ **v2 定案**：给 seg 加 `transform`（**不是** baseTransform，语义=静态状态，未来可扩展 crop/anchor/flip/blend/perspective）：
```js
seg.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }
```
**三层解析**（剪辑软件核心 resolveTransform）：
```
animation（关键帧插值） → transform（静态） → default（兜底）
```
即：`kfVal(animations, "transform.positionX", t) ?? seg.transform.x ?? 0`（每个属性同理）。

## 4. 完整链路设计（v2：interactionDraft + undo transaction）

### 4.0 状态结构（v2 新增）
```
Store
 ├── document（正式态：seg.transform + seg.animations）
 ├── draft.interaction（拖动中间态：{ elementId, transform, localUsSnap }）
 └── commit（松手落库）
```
对齐 OpenCut usePropertyDraft / Property Framework DraftStore。

### 4.1 命中（pointerdown）
- `previewStack` 容器上监听 pointerdown → 自实现 hit-test
- 遍历 `previewState.visualEls` 中 display!=none 的 wrap，取**最上层（zIndex 最高）**命中（OpenCut topmostHit）
- 点击空白 → 无命中（第一版不做框选）
- 单击（位移 < 3px 阈值）→ 仅选中；拖动（位移 ≥ 阈值）→ 进入拖动
- **v2：拖动开始调 `beginTransaction("move element")`**（undo 事务起点）

### 4.2 拖动（pointermove，v2 只写 draft）
- 记录 mousedown 时鼠标在 wrap 内的偏移 `offset = e.client - wrapRect`（抓哪拖哪）
- 每次 move：`newPos = e.client - offset - stackRect` → 除以 `sc` 换算画布单位
- **只写 `draft.interaction.transform`**（不写 document，不做 upsert）
- **渲染**：renderer 优先读 draft.interaction（该元素），其次三层解析；**不触发 renderAll**
- **v2：播放中禁止拖动**（拖动入口先判 isPlaying → 不允许/提示暂停）

### 4.3 提交（pointerup，v2 一次 commit + 事务收口）
- 松手后**一次** commit + `commitTransaction()`（一条 undo）：
  - 有动画通道 → 后端 `add_keyframe`（path, localUsSnap, value）
  - 无动画通道 → 后端 `update_segment_transform`（{ segmentKey, transform: {x,y} }）
- `refresh()` 回填；清空 draft.interaction

### 4.4 关键帧联动（自动打点）
- 前提：用户已 ◆ 开启通道（hasKeyframesForPath=true）
- 拖动松手 → 当前位置 upsert key → `renderKfGraph`/KF 面板 ◆ 高亮/时间轴菱形标记 全部自然同步（读同一数据源）

## 5. 风险清单与对策（v2 更新）

| # | 风险 | 对策 |
|---|------|------|
| R1 | **无静态 transform 模型**（最大） | seg.transform + 三层解析 + 后端 update_segment_transform（§3） |
| R2 | video 黑边（letterbox）：wrap 尺寸≠可视内容 | 第一版 wrap rect（可接受误差）；第二版 content-box；第三版 mask shape（**不提前优化**） |
| R3 | 拖动状态分叉（播放刷新/resize/render 中途打断） | **interactionDraft 中间态**：拖动只写 draft，renderer 读 draft，任何刷新不丢状态 |
| R4 | 播放中拖动被 applyKfLiveAll 覆盖 | **v2：播放中禁止拖动**（编辑/播放状态分离，Premiere/剪映同款） |
| R5 | 拖动触发全局刷新（性能） | 拖动中只渲染该元素（读 draft），绝不 refresh/renderAll |
| R6 | pointerup 丢失（拖出窗口） | pointer capture（setPointerCapture） |
| R7 | 单击 vs 拖动混淆 | 位移阈值（3px）内视为单击=选中 |
| R8 | 多选状态拖动语义 | 第一版：仅拖焦点段（selectedKey）；多选整体拖后续 |
| R9 | 提交时机（每帧 vs 松手） | 松手一次 commit + **undo transaction**（begin/commitTransaction），绝无 100 条 undo |
| R10 | 与文本层/未来 overlay 冲突 | 事件绑 previewStack 委托，按 zIndex 分层 |
| R11 | DPI/缩放 | 全部换算走 stackRect 实测尺寸 / cp.W，不硬编码 |
| R12 | 缩放手柄/旋转手柄 | 第二批；先做位置拖动 |

## 6. 实施顺序（v2：GPT 修订版，每步 commit + 真机验收）

```
Step 0  Transform Schema 冻结：seg.transform + seg.animations 命名定死（不叫 baseTransform）
Step 1  renderer 三层解析：animation → transform → default（resolveTransform）
        → 验收：面板改 X 值（无 ◆）→ 素材位置变，刷新不丢
Step 2  Preview interaction：pointerdown + hit-test + beginTransaction
Step 3  drag draft：interactionDraft 实时预览（只写 draft，renderer 读 draft）
Step 4  commit：无 KF → update_segment_transform；有 KF → add_keyframe
        → 验收：◆ 开后拖预览 → 播放头位置出现菱形 + 面板 ◆ 实心 + 曲线图更新
Step 5  undo transaction 收口 + 边界（capture/拖出）打磨
Step 6  缩放手柄 / 旋转手柄（第二批）
```

## 7. 待定问题 → v2 定案归档

| # | v1 问题 | v2 定案（GPT） |
|---|---------|---------------|
| 1 | baseTransform vs 拆 element.transform | **seg.transform**（不叫 base，语义=静态状态，未来扩展 crop/anchor/flip） |
| 2 | 后端命令命名 | **update_segment_transform**（{segmentKey, transform:{...}}，不新建 set_segment_base_transform） |
| 3 | 实时 upsert vs 松手打点 | 松手一次 commit；**加 interactionDraft 中间态**防状态分叉 |
| 4 | 播放中拖动 | **V1 不支持**（编辑/播放分离，暂停后编辑）；V1.1 再支持 |
| 5 | wrap rect vs object-fit | **第一版 wrap hit-test**，不做 object-fit（MVP 优先，不做 AE） |

---

*设计者：WorkBuddy · 2026-08-20 · v2 已吸收 GPT 评审（7 条全采纳）· 待用户 sign-off 落码*

