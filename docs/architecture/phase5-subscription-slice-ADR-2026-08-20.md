# ADR-2026-08-20 · Phase 5 订阅切片（Subscription Slicing）方案（v2，已吸收 GPT 审阅修改）

> 状态：**v2 待用户最终 sign-off；执行约束已定（见 §8）**
> 前置：Property Framework v1 已落地（Phase 0-4 完成）。本方案只改前端订阅机制，**禁止修改 player.js / timeline kernel / MCP**。
> 位置：`docs/architecture/phase5-subscription-slice-ADR-2026-08-20.md`
> v2 变更（GPT 审阅）：subscribePath→subscribeSlice；不长期双跑（feature flag）；renderAll 保留不删；5.2 不碰 preview/video/audio；drag 拆子切片；新增 5.0 KF 前置。

---

## 1. 背景与问题（现状审计）

### 1.1 当前机制（store.js:43-71）
```js
Store.set(patch)   // Object.assign(state, patch) + _emit() 全量广播
Store.subscribe(fn) // 目前唯一订阅者 = renderAll（工作台v0.8时间轴.html:1139）
_emit()            // for (fn of _subs) fn(state)
```

### 1.2 全量广播的成本
任何 `Store.set`（哪怕只改 `pxPerSec` 或 `playheadUs` 一格）→ `renderAll`（1122-1138）全跑：
```
renderMedia（素材面板） + renderTimeline（时间轴，播放中冻结） + renderPreviewMaybe（预览 seek）
+ renderTimecode + renderSkill + renderMcp + showToolTab→renderPropertyPanel（参数面板）
```

### 1.3 Store.set 调用点分类（~30 处，grep 实证）

| 状态切片 | 触发点 | 真正需要重渲的模块 |
|---|---|---|
| `playheadUs` | 2061/2072/2110（播放头拖动，**高频**） | 播放头 DOM + 时间码 + 预览 seek |
| `drag`/`pendingDrag`/`pendingBox`/`groupScale` | 1745/1833/1836/1943/1963/1994/2007/2013（拖拽，**高频**） | 仅时间轴 |
| `selectedKey`/`selectedKeys` | 1384-1385/1703/1705/1872/1978/1980/2336/2340 | 时间轴高亮 + 参数面板 + 工具栏 |
| `selectedMaterialUid` | 1389/1682 | 素材面板 + 工具栏 |
| `pxPerSec` | 759 | 时间轴缩放 |
| `materials`/`thumbMap`/`waveMap` | refresh() 回填 | 素材面板 |
| `draft` | refresh() 回填（**全量**） | 全模块（后端状态真变了） |
| `effects` | 921/2953 | 特效面板 |
| `bookmarks` | 2687/2697/2897 | 时间轴标尺 |
| `filter`/`mediaView` | 2490 等 | 素材面板 |
| `snapOn`/`rippleOn` | 1671/1677 | 工具栏 |

### 1.4 结论
- **"广播全量"是架构债务**：模块多了互相拖累，`Store.set` 越频繁（播放/拖拽/未来 MCP 高频操作）浪费越大。
- **但它是"能跑通"的**：所有模块都依赖"喊一声全到"，播放链路已验证。所以本方案**必须渐进、带兜底**。

---

## 2. 目标与非目标

### 目标
1. Store 支持**按状态切片订阅**：`Store.subscribePath("playheadUs", fn)`——只在该切片变化时通知。
2. 高频路径（播放头拖动/拖拽/选中）从"全量渲染"降为"定向渲染"。
3. 迁移过程**行为零变化**（旧 renderAll 保留兜底），每步可回退。
4. 为未来 MCP/Agent 高频操作铺路（tool 上线后 Store.set 频率上升，定向订阅是刚需）。

### 非目标（明确不做）
- ❌ 不改播放器内核（player.js 的 RAF/MasterClock/MediaSlot 不动）。
- ❌ 不改后端 / 命令层 / MCP。
- ❌ 不重写 renderAll（只拆订阅入口，渲染函数本身不动）。
- ❌ 本阶段不做"渲染器级 diff"（时间轴 DOM diff 等），那是另一层优化。

---

## 3. 方案设计

### 3.1 Store 层：新增切片订阅 API（向后兼容 + feature flag 控制双跑）

```js
// store.js 增量（纯新增，不动现有 subscribe/set 语义）
Store._sliceSubs = {};                   // sliceKey -> [fn]
Store.renderSliceMode = "legacy";        // ⚠️ feature flag：legacy(双跑) | slice(只跑切片)
Store.subscribeSlice(key, fn) {
  (this._sliceSubs[key] || (this._sliceSubs[key] = [])).push(fn);
  return () => {                          // 返回退订函数，防泄漏
    const arr = this._sliceSubs[key]; if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
  };
}
Store.set(patch) {
  const changed = Object.keys(patch);
  Object.assign(this.state, patch);
  if (this.renderSliceMode === "slice") {
    // 切片模式：只通知对应切片订阅者（正常运行路径）
    for (const k of changed) (this._sliceSubs[k] || []).forEach(fn => { try { fn(this.state[k], this.state); } catch (e) { console.error("[Store] 切片订阅者异常:", e); } });
  } else {
    // legacy 模式（迁移期）：切片订阅者仍通知（验证用），同时 _emit 全量兜底——行为零变化
    for (const k of changed) (this._sliceSubs[k] || []).forEach(fn => { try { fn(this.state[k], this.state); } catch (e) { console.error("[Store] 切片订阅者异常:", e); } });
    this._emit();
  }
}
```

**关键决策（v2，吸收 GPT 审阅）**：
- **不长期双跑**：迁移期 `renderSliceMode="legacy"`（切片订阅者 + renderAll 双跑，用于对照验证）；迁移完成切 `"slice"`（只跑切片）。**避免"同一动作执行两套 UI 系统"的中间态长期存在**。
- **renderAll 保留不删除**：`renderAll()` 永远可用——debug / 导入项目 / MCP 大批量操作 / 故障恢复都调用它（显式调用，而非订阅广播）。
- 同一次 `set` 改多个 key → 对应订阅者各跑一次。**渲染函数必须幂等**（现状已是幂等）。

### 3.2 渲染函数 → 订阅切片映射（v2：drag 拆子切片）

| 切片 | 订阅者（新增定向渲染入口） |
|---|---|
| `playheadUs` | **仅**：播放头 DOM + `renderTimecode`（**不碰 video seek / audio sync / preview——播放器是引擎不是 UI**） |
| `drag.status` / `drag.position` / `drag.selection` | `renderTimeline`（拖拽临时态；**不订阅整个 drag 大对象**，否则只是"全量广播→大对象广播"，收益有限） |
| `selectedKey`/`selectedKeys` | `renderTimeline`（高亮）+ `renderPropertyPanel` + `updateToolbarState` |
| `pxPerSec` | `renderTimeline` + ruler |
| `materials`/`thumbMap`/`waveMap` | `renderMedia` |
| `effects` | `renderEffectPanelPF`（active 时） |
| `bookmarks` | `renderTimeline` 标尺 |
| `filter`/`mediaView` | `renderMedia` |
| `draft`（refresh 回填） | 显式调 `renderAll()`（后端全量变化；不走切片，**renderAll 保留为正常/恢复路径**） |

### 3.3 迁移路径（v2：加 5.0 KF 前置 + 每步独立验收）

**Phase 5.0 — 冻结 + KF 功能修复（前置，必须先做）**
- 冻结：Player / Timeline Kernel / MCP（一行都不动）。
- 修：KF 链路（用户真机反馈：打点/曲线/插值未做完、不全）。
- 验收：◆打点 → 曲线显示 → 播放头插值 → 预览应用 → 导出，全链路真机走通。
- **理由**：KF bug + subscription bug 混在一起无法定位谁造成的；验收会被污染（GPT 审阅确认）。

**Step 5.1 — subscribeSlice API（纯新增，零行为变化）**
- store.js 加 `subscribeSlice` + `renderSliceMode` + `set` 通知切片订阅者；`_emit()` 保留。
- 不迁移任何业务渲染。
- 验证：jsdom——`set({pxPerSec:200})` 时切片订阅者被调、renderAll 仍被调；退订生效；`renderSliceMode="slice"` 时 `_emit` 不跑。

**Step 5.2 — 播放头 UI 切片（第一刀，范围最小）**
- **只做**：`playheadUs` → 播放头 DOM + 时间码。
- **不碰**：video seek / audio sync / preview（播放器是引擎，UI slicing 不碰引擎）。
- 改 2061/2072/2110 三个 `Store.set({playheadUs})` 调用点。
- 验证：真机——播放头拖动流畅、时间码跟手、**预览/声音/视频行为与 legacy 模式完全一致**。

**Step 5.3 — 选中态切片**
- `selectedKey`/`selectedKeys` 相关 set（8 处）→ `subscribeSlice("selectedKey")` 定向：时间轴高亮 + 参数面板 + 工具栏。
- 验证：真机——点选/多选/Ctrl 点选/框选后高亮与面板同步，无闪烁。

**Step 5.4 — 拖拽切片（drag 拆子切片）**
- `drag`/`pendingDrag`/`pendingBox`/`groupScale`（8 处）→ 拆 `drag.status`/`drag.position` 等子切片定向 renderTimeline。
- 验证：真机——拖素材/拖段/框选/整组缩放跟手，预览轨/落点线正常。

**Step 5.5 — slice mode 切换 + 对照验收**
- 确认所有 `Store.set` 调用点都被切片覆盖后，`renderSliceMode` 从 `"legacy"` 切 `"slice"`。
- **renderAll 保留**（不删除）：debug / 导入项目 / MCP 大批量操作 / 恢复路径显式调用。
- 验证：legacy vs slice 双模式功能对照一致（播放/拖拽/选中/参数面板/素材/书签逐项勾）。

---

## 4. 风险与护栏

| 风险 | 缓解 |
|---|---|
| **R0 双跑陷阱**（slice + renderAll 长期并存 = 两套 UI 系统同跑） | **feature flag 控制**：迁移期 legacy（双跑对照），迁移完成切 slice（只跑切片），**不留长期双跑** |
| **R1 漏订阅导致画面不更新**（渲染函数读了没订阅的切片） | 每步迁移前**审计该渲染函数读的 state 字段清单**，对照订阅切片；渲染函数幂等（现状已满足） |
| **R2 多切片组合 set 重复渲染** | 渲染函数幂等；可接受短暂重复，后续可加 microtask 合并（不在本方案范围） |
| **R3 播放链路被拆坏** | **播放器内核一行不动**；5.2 只做播放头 DOM + 时间码，**不碰 video seek/audio sync/preview**；`isPlaying` 时 renderTimeline 冻结逻辑保留 |
| **R4 迁移中途出问题** | 每步独立 commit；legacy 模式兜底——任何一步回退即回到全量广播 |
| **R5 拖拽中间态**（store.js 注释：`_emit` 用于逐帧拖拽原地改 state.drag） | **不订阅整个 drag 大对象**：拆 `drag.status`/`drag.position` 子切片定向 renderTimeline，避免"全量广播→大对象广播" |
| **R6 renderAll 被误删** | **renderAll 永远保留**：debug / 导入项目 / MCP 大批量操作 / 恢复路径显式调用，不是删除而是"从广播降级为显式" |

---

## 5. 验收标准

1. **行为等价**：legacy vs slice 双模式逐项对照一致（播放/拖拽/选中/参数面板/素材/书签）。
2. **性能可测**：console 计数（before/after）——播放头拖动 1 秒，`renderMedia`/`renderTimeline`/`renderPreviewMaybe` 调用次数显著下降（只调对应模块）。
3. **无闪烁**：高频路径（拖动/拖拽）下，非相关模块 DOM 不重建。
4. **订阅无泄漏**：切段/切 tab 后 `_sliceSubs` 无堆积（退订函数生效）。
5. **播放器零改动**：`git diff player.js` 为空（5.0 冻结验证）。

---

## 6. 前置依赖（v2 保留并强调）

用户真机反馈：**kf 实际功能（打点/曲线/插值）未做完、不全**。
**Phase 5.0 必须先把 KF 链路修好**（◆打点→曲线→插值→预览→导出全链路真机走通），否则 KF bug + subscription bug 无法定位、验收被污染。

---

## 7. 工作量与节奏（预估）

| Step | 内容 | 预估 |
|---|---|---|
| 5.0 | KF 功能修复（前置，需用户反馈具体 bug） | 待定 |
| 5.1 | subscribeSlice API + 测试 | 0.5h（纯新增） |
| 5.2 | 播放头 UI 切片（timecode + 播放头，不碰 preview） | 1h |
| 5.3 | 选中态切片 | 1h |
| 5.4 | 拖拽切片（拆子切片） | 1-1.5h |
| 5.5 | slice mode 切换 + 对照验收 | 1h |
| **合计** | | **4.5-6h（不含 5.0）** |

---

## 8. 执行约束（GPT 审阅定稿，WorkBuddy 必须遵守）

> **只实现 Phase 5.1，新增 subscribeSlice API 和测试，不迁移任何业务渲染。验收通过后再进入 5.2。禁止修改 player.js、timeline kernel、MCP。**
>
> 边界纪律：不要让 AI 一边修水电，一边顺手重盖房顶。这次控制边界，不再烧一天。

---

*设计者：WorkBuddy · 2026-08-20 00:15 → v2 00:30（GPT 审阅后修订）· 待用户最终 sign-off*
