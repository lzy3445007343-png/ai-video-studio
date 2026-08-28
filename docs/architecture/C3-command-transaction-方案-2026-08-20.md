# C3 · Command Transaction 方案（2026-08-20）

> 状态：**v2（GPT 评审通过，落码中）**
> 位置：`docs/architecture/C3-command-transaction-方案-2026-08-20.md`
> 依据：完整分步计划 C3 定义 + GPT 评审"一次拖动可能改 x/y/scale/rotation 多个 = 必须一条 undo" + 编辑器内核差距对照 D6 命令统一入口

## v2 变更（GPT 评审 16:54，全部吸收）

| # | 建议 | 落地 |
|---|---|---|
| 1 | 快照事务模型 ✅（不要改逆操作式） | 保持：事务 = 一条含 begin 前快照的 Command |
| 2 | begin_transaction 放 CommandManager ✅ | 保持（UI/Agent/MCP/API 统一） |
| 3 | **DragSession 不直接知道命令细节**——OverlayState.diff + CommandService.commit("drag-transform", patch) | DragSession.commit 只负责"开始/结束动作"，命令细节在 CommandService |
| 4 | **事务超时保护**（_tx.created_at，30s 自动 abort） | 新增：begin 时记录时间戳，超时事务自动放弃（防 begin 成功→update 失败→commit 卡住） |
| 5 | undo 时事务先 abort 再返回 ✅ | 保持（拖动中 Ctrl+Z = 放弃未完成动作，再按一次才撤销上一步） |
| 6 | **Command 加 changed_paths**（{command, paths:[...]}——属性历史/Agent 审计/UI 提示/增量保存） | Command.__slots__ 加 changed_paths；事务内 execute 累计 paths |
| 7 | 只迁 DragSession ✅ | 保持（C3.3 面板迁移后续 Strangler） |
| 8 | **落地顺序调整**：C3.1 后端事务 → C3.2 CommandService 封装 → C3.3 DragSession 接入 → **C3.4 undo 压力测试** | 按此顺序落码；A2 验证=连续拖 A/B/C → Ctrl+Z×3 → 期待 C/B/A 撤销，不出现空项目 |

---

## 1. 目标

```
一次手势 / 一次用户动作 / 一次 Agent 操作 = 一条 undo。
前端所有写操作统一走 execute 入口（语义 Command + 审计 meta），Agent/MCP 复用同一入口。
```

**为什么现在做**：C2 后拖动已稳定，但未来缩放手柄（B8）、KF 打点、Agent 批量操作都是"一次动作多次写"——
现在不建事务，undo 栈会变成"拖一下弹 5 步"的灾难。

---

## 2. 现状（已读代码核实）

### 2.1 后端已具备的基础（好消息）

| 能力 | 位置 | 说明 |
|---|---|---|
| CommandManager 快照式 undo | main.py:905-971 | history/redo_stack，Command 含 saved_state/post_state |
| **统一写入口 execute()** | main.py:923 / 2357 | `execute(cmd_id, args, meta)`：构造语义 Command → 调现有方法 → 双录防护（弹掉内部 save_state 的 snapshot）→ 入栈 + 审计。**一次 execute = 一条 undo** |
| 审计 | main.py:968 | `audit_log(limit, actor)`，meta 带 actor/reason/confidence/source |
| save_state 自动快照 | main.py:974-994 | 草稿变化才压 snapshot（record=True），校验失败不污染栈 |

### 2.2 缺口（C3 要补的）

1. **没有事务**：execute 一次一条 undo。一次动作调 N 次 execute → N 条 undo（无 begin/commit 合并）
2. **前端没走 execute**：各面板直接 `call("set_segment_volume", ...)` / `call("update_segment_transform", ...)` / `call("add_keyframe", ...)` ——
   只有 save_state 的 snapshot 兜底，**无语义 Command、无审计 meta、无事务**。Agent/MCP 无法复用前端写路径
3. **A2 undo 快照污染**（历史问题：拖动→全空→ctrl+z 异常）——需验证是否已被 P0/6b06e2b 解决

---

## 3. 设计

### 3.1 后端：CommandManager 加事务（快照合并策略）

快照式 undo 的天然优势：**事务 = 一条含「事务前快照」的 Command**，undo 一次回到 begin 前状态。
不需要逆操作——与现有架构完全一致。

```python
# CommandManager 新增（main.py:905 类内）
def begin_transaction(self, api, label="batch", meta=None):
    """开启事务：事务内 execute 只执行不入栈。返回 {ok}。"""
    if self._tx is not None:
        return {"ok": False, "error": "已有进行中的事务"}
    self._tx = {"label": label, "meta": meta or {},
                "saved_state": copy.deepcopy(api.draft), "count": 0}
    return {"ok": True, "tx": True}

def commit_transaction(self, api):
    """事务结束：合并成一条快照 Command 入栈（undo 一次=回 begin 前）。"""
    if self._tx is None:
        return {"ok": False, "error": "没有进行中的事务"}
    tx = self._tx; self._tx = None
    if tx["count"] == 0:
        return {"ok": True, "tx": False, "count": 0}    # 空事务不压栈
    cmd = Command("tx:" + tx["label"], tx["label"], tx["meta"])
    cmd.saved_state = tx["saved_state"]                 # 事务前快照
    cmd.count = tx["count"]
    self.history.append(cmd)
    if len(self.history) > self._cap: self.history.pop(0)
    self.redo_stack.clear()
    return {"ok": True, "tx": True, "count": tx["count"]}

def abort_transaction(self, api):
    """回滚事务内全部改动（恢复 begin 前快照，不入栈）。"""
    if self._tx is None:
        return {"ok": False, "error": "没有进行中的事务"}
    tx = self._tx; self._tx = None
    api.draft = copy.deepcopy(tx["saved_state"])
    api.state["draft"] = api.draft
    save_state(api.state, record=False)
    return {"ok": True, "count": tx["count"]}

# execute() 改造：事务内不弹栈不追加（count++），事务外保持现状
# __init__ 加 self._tx = None
```

Api 层加桥接：`begin_transaction(label, meta)` / `commit_transaction()` / `abort_transaction()`（走 cmd_mgr）。

**设计决策**：
- 事务内 execute 不单独入栈，只累计 count；commit 压一条合并快照 Command → **一次事务 = 一条 undo**
- **不支持嵌套事务**（begin 时已有事务直接报错）——防误用，Agent 也无需嵌套
- abort = 恢复 begin 前快照（record=False 不入栈）——异常路径安全回滚

### 3.2 前端：Cmd 统一封装（写操作唯一入口）

```js
// property/command.js（或并入 interaction-kernel？独立文件更清晰）
const Cmd = {
  beginTx(label, meta) { return call("begin_transaction", label || "batch", meta || {}); },
  commitTx() { return call("commit_transaction"); },
  abortTx() { return call("abort_transaction"); },
  // 统一写入口：走后端 execute（语义 Command + 审计），Agent/MCP 复用同一路径
  run(cmdId, args, meta) { return call("execute", cmdId, args || {}, meta || { actor: "ui" }); },
};
```

**迁移范围（Strangler，逐步）**：
```
C3.1  后端事务 API（CommandManager + Api 桥接）——纯新增，行为零变化
C3.2  前端 Cmd 封装 + DragSession.commit 事务化（beginTx → 落库 → commitTx）
      → 一次拖动 = 一条 undo 的正式保障（现在虽已满足，但加上事务语义）
C3.3  （Strangler 后续）audio/speed/mask/effect/kf 面板写调用 → Cmd.run(...)
      ——本次只做 DragSession，其余面板迁移列为后续（避免大改回归）
C3.4  A2 验证：真机拖动→ctrl+z 一次回一步、不出现全空
```

**DragSession.commit 事务化**（异步注意）：
```js
commit() {
  const c = this.ctx;
  const nx = OverlayState.get(...), ny = ...;
  Cmd.beginTx("preview-drag");
  const done = (r) => { if (r && r.ok === false) { Cmd.abortTx(); console.error(...); } else Cmd.commitTx(); refresh(); };
  // 有动画 → add_keyframe 事务内执行；无动画 → update_segment_transform 事务内执行
  // 事务跨 Promise：beginTx 先调 → 落库 call.then(done) 里 commitTx/abortTx
}
```

---

## 4. 迁移步骤（每步独立 commit + jsdom/真机）

```
C3.1  后端：CommandManager.begin/commit/abort_transaction + Api 桥接 + __init__._tx
      → py_compile + 后端单元验证（python -c 模拟事务：begin→改→commit→undo 一次回原）
C3.2  前端：property/command.js（Cmd 封装）+ HTML 引入
      + DragSession.commit 事务化（beginTx→落库→commitTx/abortTx）
      → jsdom：事务调用序列断言（begin→update_segment_transform→commit）
      → 真机：拖动→松手→ctrl+z 一次回一步，undo 栈不爆
C3.3  （后续，Strangler）面板写调用迁移 Cmd.run——本次不做
```

---

## 5. 文件影响

| 文件 | 改动 |
|---|---|
| main.py | CommandManager 事务（~40 行）+ Api 桥接 3 个方法 |
| property/command.js（新建） | Cmd 封装（beginTx/commitTx/abortTx/run） |
| property/preview-drag.js | DragSession.commit 事务化（~10 行） |
| 工作台v0.8时间轴.html | 引入 command.js |

---

## 6. 风险与护栏

| 风险 | 缓解 |
|---|---|
| **R1 事务泄漏**（begin 后没 commit，后续操作全进事务） | commit/abort 必须成对；DragSession destroy 里兜底 abort（若 tx 未结）；abort 幂等 |
| **R2 事务跨异步竞态**（落库 call 未返回就新一轮操作） | Refresh Lock（InteractionManager）已挡大部分；DragSession 单会话保证 |
| **R3 空事务压栈**（begin 后没操作） | commit 时 count==0 不压栈（return tx:false） |
| **R4 面板迁移回归** | 本次不迁移面板（C3.3 后续），零风险 |
| **R5 undo/redo 与事务冲突**（事务中 undo） | 事务中禁止 undo/redo（begin 时前端不提供 undo 按钮？后端 undo 若事务未结直接 abort 事务）——方案：undo() 检测 _tx 非空 → 先 abort 再 undo（简单粗暴，语义=放弃未完成事务） |

---

## 7. 待评审问题

1. **快照合并策略**（事务=一条含 begin 前快照的 Command）符合现有架构，对吗？还是必须逆操作式（undo 逐条反做）？
2. **不支持嵌套事务**（begin 时报错）——同意吗？Agent 批量是否可能天然嵌套？
3. 前端写调用**本次只迁移 DragSession**（C3.3 面板迁移后续）——范围 OK 吗？
4. 事务中触发 undo：**先 abort 再 undo**（放弃未完成事务）合理吗？
5. A2 undo 污染是否本轮真机验证（拖动→ctrl+z）即可，还是需要单独查 undo 栈？

---

*设计者：WorkBuddy · 2026-08-20 16:55 · 待用户 + GPT 评审*
