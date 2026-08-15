# Step 5 — Command 层设计稿（Command Layer）

> 日期：2026-08-15
> 状态：**设计稿 v2.0（用户拍板：方案 X 为主路线）**
> 上游：Step 1-4 完成（拆 JS / 播放隔离 / Asset 分离 / 回归基线）
> 用户决策背景：skill 侧（codebuddy）已实测 Agent 能落地粗剪/口误/字幕/花字/关键帧/变速/蒙版等操作 → 平台底座必须配得上 Agent：**操作有语义、可回退、可审计** → 选方案 X（Command 取代快照栈），不选轻量 Y。

---

## 1. 现状审计（改前事实）

| 项 | 事实 |
|----|------|
| undo 机制 | **快照式**：`save_state(record=True)` 检测到草稿变化时，把「变化前」整个 draft 深拷贝压入 `Api.undo_stack`（main.py 450-467） |
| `_push_undo` | 已废弃为空占位（1569-1576），撤销栈完全由 save_state 自动记录 |
| undo/redo | 弹栈交换整个 draft 快照，`save_state(record=False)`（1578-1598） |
| 写操作数 | **30+ 个 `save_state` 调用点**，40+ 写操作方法 |
| 前端 | Ctrl+Z/Y / 按钮 → `call("undo"/"redo")`，API 不变 |
| MCP | mcp_server 暴露 undo/redo 工具（走同一 Api） |

**快照 undo 的优点**：无脑可靠、校验失败不污染栈、AI 编辑自动入栈。
**快照 undo 的缺陷**：栈里是「草稿快照」不是「操作」——无法回答"谁做了什么/为什么"，Agent 无法按操作意图审计/选择性撤销。

## 2. OpenCut 参考实现（已精读源码，这就是方案 X 的模板）

### 2.1 Command 基类（`commands/base-command.ts`）

```ts
export abstract class Command {
  abstract execute(): CommandResult | undefined;  // 正着做
  undo(): void { throw new Error("Undo not implemented..."); }  // 反着做
  redo(): CommandResult | undefined { return this.execute(); }  // 重做默认复用 execute
}
```

### 2.2 CommandManager（`core/managers/commands.ts`）

```ts
class CommandManager {
  private history: CommandHistoryEntry[] = [];   // undo 栈
  private redoStack: CommandHistoryEntry[] = []; // redo 栈
  execute({command}) {
    const result = command.execute();
    // ripple 处理 + selection 快照 + reactor 通知
    this.history.push({ command, previousSelection });
    this.redoStack = [];
  }
  undo() { const entry = this.history.pop(); entry.command.undo(); this.redoStack.push(entry); }
  redo() { const entry = this.redoStack.pop(); entry.command.redo(); this.history.push(entry); }
  canUndo() / canRedo() / clear()
}
```

### 2.3 SplitElementsCommand（`commands/timeline/element/split-elements.ts`）—— 关键模式

```ts
class SplitElementsCommand extends Command {
  private savedState: SceneTracks | null = null;   // ★ execute 前保存整棵树
  execute() {
    this.savedState = editor.scenes.getActiveScene().tracks;  // ★ 快照
    ... 执行分割逻辑（snap-once 不变量）...
  }
  undo() { editor.scenes.getActiveScene().tracks = this.savedState; }  // ★ 恢复快照
}
```

**关键发现：OpenCut 的 undo 不是"步骤反走"，而是「Command 语义 + 内部快照还原」。**
- Command 负责**语义**（谁做了什么、execute/undo 接口）
- undo 内部 = 恢复 execute 前保存的 savedState 快照

→ **这大幅降低我们的落地成本**：我们已有成熟的 save_state 自动快照机制，方案 X 不需要给 30+ 操作手写"反向步骤"，只需**给每个操作包一层 Command 壳**（execute=现有逻辑，undo=恢复保存的快照）。

## 3. 方案 X（主路线）—— Command 取代快照栈

### 3.1 目标结构

```
写操作（UI / MCP / Agent）
        │ 统一入口
        ▼
CommandManager.execute(cmd_id, args, meta)
        │
        ├─ 构造 Command 对象（含 meta: actor/reason/confidence/source）
        ├─ command.execute()  → 现有数据变更逻辑 + save_state（写文件+版本戳）
        ├─ 入 history 栈（Command 对象，不再是裸快照）
        └─ 清空 redoStack
undo() → history.pop() → command.undo()（恢复 execute 前快照）→ save_state(record=False)
redo() → redoStack.pop() → command.redo()（= execute 重放）→ 入 history
```

### 3.2 Command 结构（Python 版）

```python
class Command:
    """一次可审计、可回退的操作。"""
    __slots__ = ("cmd_id", "label", "meta", "saved_state")
    def __init__(self, cmd_id, label, meta=None):
        self.cmd_id = cmd_id
        self.label = label
        self.meta = meta or {}          # {actor, reason, confidence, source, reversible}
        self.saved_state = None         # execute 前快照（undo 用）
```

### 3.3 CommandManager（Python 版，挂 Api）

```python
class CommandManager:
    def __init__(self):
        self.history = []        # undo 栈：Command 对象
        self.redo_stack = []
        self._cap = 100

    def execute(self, cmd_id, args, meta=None):
        fn = getattr(self.api, cmd_id, None)
        if not callable(fn):
            return {"ok": False, "error": f"未知命令 {cmd_id}"}
        cmd = Command(cmd_id, cmd_id, meta)
        cmd.saved_state = copy.deepcopy(self.api.draft)   # execute 前快照（对齐 OpenCut savedState）
        result = fn(**args)                               # 现有逻辑（内部会 save_state 写文件）
        if result and result.get("ok"):
            self.history.append(cmd)
            if len(self.history) > self._cap: self.history.pop(0)
            self.redo_stack.clear()
        return result

    def undo(self):
        if not self.history: return {"ok": False, "error": "没有可撤销的操作"}
        cmd = self.history.pop()
        self.api.draft = copy.deepcopy(cmd.saved_state)
        self.api.state["draft"] = self.api.draft
        save_state(self.api.state, record=False)
        self.redo_stack.append(cmd)
        return {"ok": True, "remaining": len(self.history)}

    def redo(self):
        if not self.redo_stack: return {"ok": False, "error": "没有可重做的操作"}
        cmd = self.redo_stack.pop()
        cmd.saved_state = copy.deepcopy(self.api.draft)
        result = getattr(self.api, cmd.cmd_id)(**cmd.last_args)   # 重放
        if result and result.get("ok"):
            self.history.append(cmd)
        return {"ok": True, "remaining": len(self.redo_stack)}
```

> 注：`last_args` 需在 execute 时存入 cmd（`cmd.last_args = args`）；`undo_stack/redo_stack` 全局变量（1538-1539）退役，由 CommandManager 接管；`undo()`/`redo()` API 方法改为转发 CommandManager，前端/MCP 调用签名不变。

### 3.4 meta / operation_context（审计语义，护城河）

每次 execute 必带 meta：

```python
meta = {
  "actor": "agent" | "user" | "mcp",     # 谁做的
  "reason": "去掉口误" / "切掉静音段",     # 为什么
  "confidence": 0.9,                     # 可信度（agent 用）
  "source": "skill:口播精剪",             # 来自哪个 skill
  "reversible": True,                    # 能否回退（数据层决定）
}
```

审计查询：`audit_log(actor?, limit?)` → 按 meta 过滤，回答"谁改了什么、为什么"。

## 4. 渐进迁移路径（30+ 操作不一次性重写）

| 阶段 | 内容 | 验收 |
|------|------|------|
| **5a** | CommandManager + Command 类 + `undo()/redo()` 转发；**快照栈切 Command 栈**（undo 语义立即升级，还原机制不变） | C2：Ctrl+Z 照常 |
| **5b** | 首批 8 个核心操作包壳：split×3 / trim / move / move_group / remove×2 / duplicate / add_to_timeline / set_speed —— 走 `CommandManager.execute` | C1：回归 T1-T5 全过；C3：audit_log 可查 |
| **5c** | MCP 工具改走 execute + 新增 `audit_log` / `get_command_list`（Agent 可审计） | C4：Agent 调 split → 数据变更 + 审计 |
| **5d** | 其余写操作（mask/keyframe/track/sticker/subtitle...）逐步包壳 | 回归基线逐项过 |

**风险控制**：每阶段独立 commit + 回归基线验证；5a 不动任何写操作逻辑（只换栈），5b 一次只包 2-3 个操作并验证。

## 5. 与现有机制的关系（保留/退役）

| 现有 | 处置 |
|------|------|
| `save_state` 写文件 + 版本戳 | **保留**（Command.execute 内部照调，record 参数语义微调：不再自动压快照栈，改由 CommandManager 入栈） |
| `Api.undo_stack/redo_stack`（1538-1539） | **退役**，CommandManager.history/redo_stack 接管 |
| `undo()`/`redo()` API 方法签名 | **不变**（前端/MCP 无感） |
| `_push_undo` 空占位 | 删除 |

## 6. 验收标准

| # | 场景 | 通过 |
|---|------|------|
| C1 | 手动 split/trim/move/remove/duplicate 各一次 | 功能与之前一致（回归 T1-T5 全过） |
| C2 | Ctrl+Z / Ctrl+Y 连续撤销重做 | 照常工作（Command 栈） |
| C3 | `audit_log()` | 返回操作的 cmd_id + meta（actor/reason） |
| C4 | Agent/MCP 调 `execute("split_segment", args, meta)` | 数据变更 + 审计追加 |
| C5 | 撤销后再次编辑 | redo 栈清空，历史一致 |

## 7. 一句话

**方案 X（用户拍板）= 把现有"快照栈"升级为"Command 栈"：每次操作包一层 Command（execute=现有逻辑，undo=恢复快照，meta=审计语义），还原机制照旧。参考 OpenCut 的 savedState 模式，落地成本远低于"手写反向步骤"。5 个阶段渐进迁移，每步可回退可验收。**
