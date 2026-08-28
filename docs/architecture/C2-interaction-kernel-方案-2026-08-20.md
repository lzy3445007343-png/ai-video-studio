# C2 · Interaction Kernel 方案（2026-08-20）

> 状态：**v2（GPT 评审通过，落码中）**
> 位置：`docs/architecture/C2-interaction-kernel-方案-2026-08-20.md`
> 依据：编辑器内核差距对照 D3 + GPT 评审"PreviewInteraction 缺状态机" + 完整分步计划 C2 定义

## v2 变更（GPT 评审 16:39，必改 5 条全吸收）

| # | v1 原设计 | v2 定案 |
|---|---|---|
| 1 | OverlayState = 拖动 override {x,y} | **通用 path overlay**：`OverlayState.set(segId, "transform.positionX", v)`——与 C1 Property Kernel path 打通，缩放/旋转/框选/多选未来都进 overlay |
| 2 | 状态 prepare/dragging/committed/cancelled | **pending → active → ended**（生命周期状态）；commit/cancel 是**方法**不是状态 |
| 3 | Refresh Lock 留在 preview-drag | **上移 InteractionManager**：`blocksRefresh()`/`notePendingRefresh()`/`takePendingRefresh()`——refresh 管道不知道具体操作 |
| 4 | ctx 散字段 startX/startY/startTransform | **三层 ctx**：pointer（鼠标）/ target（操作对象）/ snapshot（事务前 path 快照）；DragSession 专属引用（seg/el/key）放 ctx 顶层 |
| 5 | 预留 Resize/Rotate 代码 | **不预留**——只保证可 `extends GestureSession`，用到再抽 |

其余保持：DragSession 放 preview-drag.js（kernel 不知道 seg/previewStack/renderer/坐标）；commit 接口存在但实现仍调旧 command（C3 再统一 CommandManager）；不改 renderer 主链语义（仅拖动跳过判断换成 InteractionManager）；不碰 undo transaction。

---

## 1. 目标

把预览交互从"零散事件 + 局部变量"升级为**统一交互内核**：

```
现在的 preview-drag.js（可用但散）：
  pointerdown → 局部变量 previewDrag
  pointermove → 改 el.style + PreviewInteraction.override
  pointerup   → commit（位置参数，刚修好弹回）

目标 GestureSession 状态机（GPT 定义）：
  Idle → Prepare（pointerdown，未超阈值）→ Dragging（超阈值）→ Commit/Cancel → Idle
```

**为什么现在做**：未来缩放手柄/旋转手柄/框选/多选/整组缩放全部要状态机（B8/B9、OpenCut 已证实），
现在不抽，每加一个手势 preview-drag.js 就膨胀一层，会重蹈"打补丁"覆辙。

**范围边界（本次只做）**：
- ✅ GestureSession 状态机框架（纯新增，可复用）
- ✅ InteractionManager（唯一 session 入口，防并发）
- ✅ DragSession（把现有"拖位置"迁进状态机，**行为必须与当前完全一致**）
- ✅ OverlayState（PreviewInteraction 升级为正式 OverlayState，渲染读 overlay）
- ❌ 不做缩放手柄/旋转手柄（B8 留给后面复用同一框架）
- ❌ 不做多选整组拖（R8）
- ❌ 不碰 Timeline/Playback/MCP 主链路

---

## 2. 现状盘点（已读代码）

| 现状 | 位置 | 说明 |
|---|---|---|
| `previewDrag` 局部变量 | property/preview-drag.js:36 | pointerdown 时记录 seg/起始快照/moved/last/localSnap |
| `PreviewInteraction` 对象 | property/preview-drag.js:21-34 | {active, segId, override, pendingRefresh} + begin/update/dragging/end |
| Refresh Lock | property/preview-drag.js + HTML refresh() | 拖动期间 refresh() 见 active 直接 return + pendingRefresh（P0 资产） |
| 位置参数 commit | property/preview-drag.js:117-135 | 刚修好的弹回根因（6b06e2b），**不能回归** |
| renderer 读拖动值 | renderer.js:679 applyKfTransform | `PreviewInteraction.dragging(seg)` 时用 override 应用 |

**关键约束**：preview-drag 的拖动链路刚真机验收通过（弹回修复），C2 迁移 = **行为等价重构**，
不是功能开发。任何状态机设计都不得改变 pointerdown/move/up 的事件语义和 commit 结果。

---

## 3. 设计

### 3.1 InteractionManager（唯一入口）

```js
const InteractionManager = {
  session: null,               // 当前活跃手势会话
  begin(session) { this.end(); this.session = session; },  // 新会话顶掉旧会话（防并发）
  end() { if (this.session) { this.session.destroy(); this.session = null; } },
  get active() { return !!this.session; },
};
```

- 所有预览交互（拖动/未来缩放/旋转/框选）都通过 `InteractionManager.begin(session)` 进入
- `end()` 统一清理（含 Refresh Lock 释放、pointer capture 释放）
- 单会话模型：同一时刻只有一个手势（符合"一次只能拖一个"的产品语义）

### 3.2 GestureSession 状态机（基类）

```js
class GestureSession {
  constructor(ctx) {
    this.ctx = ctx;              // { seg, el, key, startCX, startCY, ... } 手势上下文
    this.state = "prepare";      // prepare → dragging → committed / cancelled
  }
  // 子类实现
  onPointerMove(e) {}            // prepare 超阈值 → 转 dragging
  onPointerUp(e) {}              // → commit()
  onPointerCancel() {}           // → cancel()
  commit() { this.state = "committed"; }   // 子类覆写：真正的落库
  cancel() { this.state = "cancelled"; }   // 子类覆写：丢弃
  destroy() { /* 子类覆写：释放 capture/lock */ }
}
```

状态迁移（严格单向）：
```
       pointerdown               位移>3px               pointerup
Idle ────────────────> Prepare ──────────────> Dragging ────────> Commit ──> Idle
  ^                     |                                                  |
  |                     | pointercancel / Esc                             |
  └─────────────────────┴──────────────> Cancel ──────────────────────────┘
```

### 3.3 DragSession（拖位置，迁移 preview-drag）

```js
class DragSession extends GestureSession {
  // prepare：pointerdown 已记录 startCX/startCY/startX/startY/localSnap/hasAnimX/Y（沿用现有）
  // dragging：PreviewInteraction/OverlayState.update(nx, ny) + 只改 el.style.transform（现有逻辑不变）
  // commit：
  //   moved=false → 仅选中（已 selectKey，不落库）
  //   moved=true → 有动画 add_keyframe（位置参数） / 无动画 update_segment_transform（位置参数，刚修）
  //   → refresh（pendingRefresh 补刷）
  // cancel：恢复 renderer 接管，不落库
}
```

**迁移方式（Strangler）**：
- `preview-drag.js` 里 `onPreviewDragDown/Move/Up/Cancel` 四个函数**保留为薄壳**，
  内部改为 `InteractionManager.begin(new DragSession(ctx))` / `session.onPointerMove(e)` 等
- 事件绑定（bindPreviewDrag）不动——stack 上的 pointer 委托照旧
- 行为断言：拖动阈值 3px、选中联动、Refresh Lock、位置参数 commit、播放中禁止——**全部不变**

### 3.4 OverlayState（PreviewInteraction 升级）

```js
// PreviewInteraction 更名为 OverlayState（文档态与交互态分离的正式名字，GPT 定义）
// 但保留 PreviewInteraction 别名，renderer.js 引用不改（避免无谓改动）
const OverlayState = { ...现有 PreviewInteraction 逻辑... };
window.PreviewInteraction = OverlayState;   // 兼容别名
```

- 拖动中间态（override）就是 overlay——不碰 seg/后端
- renderer `applyKfTransform` 读 overlay 应用（现有逻辑不变）
- Refresh Lock 逻辑并入（pendingRefresh 由 session.destroy 统一释放）

---

## 4. 迁移步骤（每步独立 commit + jsdom + 真机）

```
C2.1  InteractionManager + GestureSession 基类 + OverlayState（纯新增，零行为）
      → jsdom：状态机流转（prepare→dragging→commit/cancel）、防并发（begin 顶掉旧会话）
C2.2  DragSession 迁移 preview-drag（薄壳化 + 行为等价）
      → jsdom：全链路断言复用上一轮 6b06e2b 的冒烟（位置参数 + 拖动 + refresh 锁）
      → 真机：拖动留位（弹回不回归）+ 开 ◆ 打点 + 单击选中 + 播放中禁拖
C2.3  收尾：PreviewInteraction 别名确认、旧注释清理、死代码检查
```

---

## 5. 文件影响

| 文件 | 改动 |
|---|---|
| `property/interaction-kernel.js`（新建） | InteractionManager + GestureSession 基类 + OverlayState |
| `property/preview-drag.js` | 四个 handler 薄壳化 + DragSession（内联在 preview-drag.js 或独立文件） |
| `工作台v0.8时间轴.html` | 引入 interaction-kernel.js（preview-drag.js 之前） |
| renderer.js / main.py / 其他 | **零改动**（renderer 仍读 PreviewInteraction 别名） |

---

## 6. 验证清单（jsdom）

1. 状态机：begin → prepare；move 超 3px → dragging；up → committed；cancel → cancelled
2. 防并发：新 begin 顶掉旧 session（旧 session.destroy 被调）
3. DragSession commit：位置参数 5 项逐位断言（回归 6b06e2b）
4. Refresh Lock：dragging 期间 refresh() 被锁 + pendingRefresh；commit 后补刷
5. 播放中禁止拖动：isPlaying 时 pointerdown 无 session
6. 单击不落库：moved=false → 无 commit call

---

## 7. 风险与护栏

| 风险 | 缓解 |
|---|---|
| **R1 弹回回归**（位置参数 commit 被状态机搞坏） | C2.2 真机必验拖动留位；jsdom 断言复用 6b06e2b 冒烟 |
| **R2 状态泄漏**（session 没清 → 渲染一直读 overlay） | InteractionManager.end() 统一 destroy；pointercancel 必走 cancel |
| **R3 并发手势**（点一个又拖另一个） | begin() 先 end() 旧会话（OpenCut 同语义） |
| **R4 过度设计**（为不存在的手势抽象） | 只做基类 + DragSession 一个实现；Resize/Rotate 等用到再加子类 |
| **R5 改名破坏引用** | OverlayState + PreviewInteraction 别名双保险，renderer 零改动 |

---

## 8. 待评审问题

1. GestureSession 状态命名（prepare/dragging/committed/cancelled）OK 吗？还是对齐 OpenCut 的 pending/dragging？
2. DragSession 放 interaction-kernel.js 还是独立 preview-drag.js？（我倾向后者：kernel 只放通用框架）
3. C2.3 要不要顺手把 `previewDrag` 局部变量并入 session.ctx？（干净但多一次改动）
4. 缩放/旋转手柄（B8）现在就在框架上预留扩展点，还是完全等用到再抽？

---

*设计者：WorkBuddy · 2026-08-20 16:30 · 待用户 + GPT 评审*
