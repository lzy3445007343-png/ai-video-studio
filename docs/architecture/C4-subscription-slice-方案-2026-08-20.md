# C4 · Subscription Slice 方案（2026-08-20）

> 状态：**待用户 + GPT 评审（sign-off 后落码）**
> 位置：`docs/architecture/C4-subscription-slice-方案-2026-08-20.md`
> 依据：完整分步计划 C4（原 5.3/5.4/5.5 合并）+ GPT 评审"先分边界再切片" + C1-C3 落地后的新现状

---

## 1. 目标

把前端从"广播式 renderAll"升级为"点名式切片订阅"：
任何 `Store.set` 只触发关心该字段的模块渲染，其余模块不跑。

**为什么现在做（GPT 定序）**：C1（数据边界）→ C2（交互态）→ C3（命令）已落地，
数据读写路径已统一、交互中间态已隔离——现在切片不会"越切越乱"。

---

## 2. 现状（已 grep 全部 Store.set 调用点，C1-C3 后）

### 2.1 已完成的切片基建（5.1/5.2）
- `Store.subscribeSlice(key, fn)` + `renderSliceMode`（"legacy"双跑 / "slice"只跑切片）——5.1 ✅
- `renderPlayheadUI()` 订阅 `playheadUs`（时间码+播放头，不碰播放器引擎）——5.2 ✅

### 2.2 Store.set 调用点全分类（主文件实测）

| 切片 | 调用点数 | 行号 | 该渲染什么 |
|---|---|---|---|
| `selectedKey/selectedKeys/selectedSegId/selectedMaterialUid` | ~11 | 1463/1464/1468/1782/1784/1790/1951/2057/2059/2415/2419 | 时间轴高亮 + 参数面板 + 工具栏（**C4.1 目标**） |
| `drag/pendingDrag` | 3 | 1824/1912/1915 | 时间轴拖拽临时态 → renderTimeline（**C4.2 目标**） |
| `pendingBox` | 2 | 2022/2042 | 框选待定态 → renderTimeline |
| `groupScale` | 3 | 2073/2086/2092 | 整组缩放临时态 → renderTimeline |
| `pxPerSec` | 1 | 817 | 时间轴缩放 → renderTimeline |
| `filter` | 1 | 2569 | 素材面板过滤 → renderMedia |
| `bookmarks` | 3 | 2766/2776/2976 | 标尺书签 → renderTimeline |
| `snapOn/rippleOn` | 2 | 1750/1756 | 工具栏状态（低频） |
| `effects` | 2 | 979/3041 | 特效注册表（已特殊处理） |
| `playheadUs` | 3 | 2140/2151/2189 | ✅ 5.2 已做 |
| **refresh 回填大 patch** | 1 | 3008 | draft 等全量 → 仍走 renderAll（合理） |

### 2.3 关键新现状（C2 影响）
- **预览拖动已不走 Store**（InteractionManager + OverlayState，interactionDraft）——原 5.4 的"预览拖拽切片"已无对象
- 时间轴拖拽（timeline.js）仍走 `Store.set({drag})`——**C4.2 的切片对象是它**

---

## 3. 设计

### 3.1 C4.1 选中态切片（最高频，用户感知最强）

```js
// 选中态订阅（boot 时注册一次）
Store.subscribeSlice("selectedKey", () => {
  if (renderSliceMode === "slice" || renderSliceMode === "legacy") {
    renderTimeline();            // 高亮
    renderPropertyPanel();       // 参数面板（当前 active tab）
    updateToolbarState();        // 工具栏选中态
  }
});
// selectedKeys/selectedSegId/selectedMaterialUid 同类
```

**注意**：选中态变化也改变 `Store.state.draft` 之外的 UI 态，renderAll 里 renderTimeline/renderPropertyPanel 会读它。
切片后：`set({selectedKey})` 只跑上面三个函数，**renderMedia/renderPreview 不跑**。

### 3.2 C4.2 拖拽临时态切片（时间轴）

```js
Store.subscribeSlice("drag", () => { if (renderSliceMode !== "legacy") renderTimeline(); });
Store.subscribeSlice("pendingDrag", () => { if (renderSliceMode !== "legacy") renderTimeline(); });
Store.subscribeSlice("pendingBox", () => { if (renderSliceMode !== "legacy") renderTimeline(); });
Store.subscribeSlice("groupScale", () => { if (renderSliceMode !== "legacy") renderTimeline(); });
```

**决策（给 GPT 审）**：drag 不拆子切片（status/position/selection）——时间轴拖拽对象很小，
renderTimeline 全量读它；拆子切片收益≈0，还增加订阅复杂度。OpenCut 拆是因为 canvas 渲染每帧全量。
若 GPT 坚持拆，可降级为"只按顶层 key 订阅"。

### 3.3 C4.3 其余低频切片

```js
Store.subscribeSlice("pxPerSec", () => { if (renderSliceMode !== "legacy") { renderTimeline(); } });
Store.subscribeSlice("filter", () => { if (renderSliceMode !== "legacy") renderMedia(); });
Store.subscribeSlice("bookmarks", () => { if (renderSliceMode !== "legacy") renderTimeline(); });
```

### 3.4 C4.4 slice mode 切换 + 对照验证

- `renderSliceMode = "legacy"`（默认，现在）：切片订阅者**和** renderAll 都跑 → 行为对照
- `renderSliceMode = "slice"`：只跑切片订阅者；renderAll 仅由 refresh 回填大 patch 触发
- **renderAll 保留不删**（GPT 定案）：debug / 导入项目 / MCP 大批量 / 恢复显式调用
- 验收：两种模式跑同一场景，输出完全一致（真机对照）

### 3.5 迁移方式（Strangler，每步独立 commit）

```
C4.1  选中态切片（selectedKey 等 11 处 set 点受益）
C4.2  拖拽临时态切片（drag/pendingDrag/pendingBox/groupScale）
C4.3  低频切片（pxPerSec/filter/bookmarks）
C4.4  slice mode 对照验证 + 收尾（renderAll 保留，refresh 大 patch 仍走它）
```

---

## 4. 验证

| 步 | jsdom | 真机 |
|---|---|---|
| C4.1 | set({selectedKey}) → renderTimeline/renderPropertyPanel 被调、renderMedia 不被调（mock 计数） | 点选/多选/Ctrl/框选 → 高亮+面板+工具栏同步；素材框不闪烁 |
| C4.2 | set({drag}) → 仅 renderTimeline | 时间轴拖拽跟手；其余模块不重建 |
| C4.3 | set({pxPerSec}) → 仅 renderTimeline | 缩放跟手；素材不重渲 |
| C4.4 | legacy vs slice 两种模式同一 set 序列输出一致 | 全功能回归（播放/拖拽/选中/面板/素材/书签） |

---

## 5. 风险与护栏

| 风险 | 缓解 |
|---|---|
| **R1 漏订阅导致画面不更新**（渲染函数读了没订阅的字段） | 每步审计渲染函数读的 state 字段清单（renderTimeline 读哪些、renderPropertyPanel 读哪些）对照订阅切片；legacy 双跑期先对照 |
| **R2 多 key 组合 set 重复渲染** | 渲染函数幂等（现状已满足）；同帧多次 set 各自触发一次，可接受 |
| **R3 播放链路被拆坏** | 播放器内核不动（5.2 已定）；playheadUs 切片只管 UI；`isPlaying` 时 renderTimeline 冻结逻辑保留 |
| **R4 拖拽中间态与 renderAll 打架** | C2 后预览拖动已隔离；时间轴拖拽切片定向 renderTimeline；refresh 锁（InteractionManager）已挡竞态 |
| **R5 legacy/slice 行为不一致** | C4.4 双模式对照验收；不一致 → 停切该切片（revert 该 commit） |

---

## 6. 待评审问题

1. **drag 不拆子切片**（时间轴拖拽对象小，拆了收益≈0）——同意吗？
2. **选中态切片范围**：selectedKey 变化时只渲染 时间轴高亮+参数面板+工具栏，素材框/播放器不跑——对吗？（选中段时播放器画面不该变）
3. **C4.4 slice 模式切换**：默认 legacy，手动/脚本切 slice 对照？还是直接默认 slice？
4. **renderAll 保留**：refresh 回填（draft 大 patch）继续走 renderAll——是否还要给 refresh 也切片（draft 变化只影响预览/时间轴/素材）？我倾向 refresh 保持全量（后端全量回填本就该全量重渲，避免漏字段）

---

*设计者：WorkBuddy · 2026-08-20 17:10 · 待用户 + GPT 评审*
