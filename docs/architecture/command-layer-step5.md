# Step 5 — Command 层设计稿（Command Layer）

> 日期：2026-08-15
> 状态：**设计稿 v1.0，待用户拍板方案后落码**
> 上游：Step 1-4 完成（拆 JS / 播放隔离 / Asset 分离 / 回归基线）
> 目标：给所有写操作一个「可撤销、可审计、Agent 可调用」的统一语义层

---

## 1. 现状审计（改前事实）

| 项 | 事实 |
|----|------|
| undo 机制 | **快照式**：`save_state(record=True)` 检测到草稿变化时，把「变化前」整个 draft 深拷贝压入 `Api.undo_stack`（main.py 450-467） |
| `_push_undo` | 已废弃为空占位（1569-1576），撤销栈完全由 save_state 自动记录 |
| undo/redo | 弹栈交换整个 draft 快照，`save_state(record=False)`（1578-1598） |
| 写操作数 | **30+ 个 `save_state` 调用点**，40+ 写操作方法（split/trim/move/remove/duplicate/speed/mask/keyframe/track...） |
| 前端 | Ctrl+Z/Y / 按钮 → `call("undo"/"redo")`，API 不变 |
| MCP | mcp_server 暴露 undo/redo 工具（走同一 Api） |

**快照 undo 的优点**：无脑可靠、校验失败不污染栈、AI 编辑也自动入栈。
**快照 undo 的缺陷**：① 整个 draft 深拷贝（大项目性能差）② 栈里是「草稿快照」不是「操作」——无法回答"谁做了什么/为什么"③ Agent 无法"撤销到某个操作/按意图回放"。

## 2. 目标

- 每个写操作 = 一个 **Command**：`{id, label, apply, undo?, meta}`（meta 含 operation_context：actor/reason/confidence/source）
- Agent 调 MCP → Command；人不绕路，UI 也走 Command
- 撤销/审计有语义：能回答"谁改的、为什么改、能不能回退"
- **不推翻现有快照 undo**（它是可靠兜底），Command 层先作为语义/审计层叠加

## 3. 两个方案（用户拍板）

### 方案 X — Command 取代快照栈（正统重构）

```
save_state 不再压快照；undo 栈改存 Command
undo = 执行 cmd.undo() 还原数据 → save_state(record=False)
```

- 优点：undo 语义化、性能好、Agent 可选择性撤销
- 代价：**迁移全部 30+ 写操作**，每操作写 apply/undo 双向逻辑，风险高、工期 2-3 天
- 适用：后续需要"选择性撤销/大项目性能"时

### 方案 Y — 叠加 Command 审计层（推荐，先拿到价值）

```
CommandManager.execute(cmd)：
  cmd.apply()  → 执行现有数据变更
  save_state() → 现有快照 undo 照旧兜底
  audit log   → 追加 {actor, reason, confidence, ...}
undo 仍走现有快照栈（可靠性不变）
Agent 增补：MCP 工具改为「构造 Command 再执行」，自动记审计
```

- 优点：**零迁移风险**、现有 undo 照常、当天可用；Agent 得到"可审计操作语言"（护城河）
- 缺点：undo 仍是快照语义（不完美，但不影响当前规模）
- 代价：新增 CommandManager + audit log + MCP 包装，~0.5 天

**推荐 Y**：播放器冻结期先把 Agent 操作语义拿到手，快照 undo 继续兜底；X 留到"性能/选择性撤销"真正成为瓶颈时再做。

## 4. Command 接口（两方案通用）

```python
@dataclass
class Command:
    id: str                    # "split_segment" / "trim_segment" ...
    label: str                 # 人类可读："分割片段"
    meta: dict                 # operation_context: {actor, reason, confidence, source, reversible}
    # 方案 X 才需要：
    def apply(self, api): ...   # 执行数据变更（现有逻辑）
    def undo(self, api): ...    # 反向还原（X 专属）
```

## 5. CommandManager（方案 Y 落地结构）

```python
class CommandManager:
    def __init__(self, api, audit_path=None):
        self.api = api
        self.audit = []          # [{ts, cmd_id, meta, ok}] 追加式审计
        self._cap = 500          # 审计上限

    def execute(self, cmd_id, args, meta=None):
        """统一入口：任何写操作都经此构造+执行+审计。
        参数校验失败 → 不入审计；成功 → 追加 {cmd_id, meta, ok:True}。"""
        fn = getattr(self.api, cmd_id, None)
        if not callable(fn):
            return {"ok": False, "error": f"未知命令 {cmd_id}"}
        self.api._push_undo()          # 保留：现有 save_state 自动快照兜底
        result = fn(**args)
        self.audit.append({
            "ts": time.time(),
            "cmd_id": cmd_id,
            "args": args,
            "meta": meta or {},
            "ok": bool(result and result.get("ok")),
        })
        if len(self.audit) > self._cap:
            self.audit = self.audit[-self._cap:]
        return result

    def audit_log(self, limit=100, actor=None):
        """Agent 查询：谁做过什么（可审计）。"""
        rows = self.audit[-limit:] if not actor else [r for r in self.audit if r.get("meta", {}).get("actor") == actor][-limit:]
        return rows
```

## 6. 首批 Command 清单（核心编辑操作，方案 Y 即用）

| cmd_id | 现有方法 | 理由 |
|--------|---------|------|
| `split_segment` / `split_segment_left` / `split_segment_right` | 2577/2602/2627 | 核心编辑 |
| `trim_segment` | 2311 | 核心编辑 |
| `move_segment` / `move_group` / `relocate_segment` | 2249/2394/2645 | 核心编辑 |
| `remove_segment` / `remove_segments` | 2089/2116 | 核心编辑 |
| `duplicate_segment` | 2154 | 常用 |
| `add_to_timeline` | 1600 | 素材进轨 |
| `set_segment_speed` | 1792 | 变速 |
| `toggle_track_mute` / `toggle_track_visibility` | 1985/2069 | 轨状态 |

## 7. MCP / Agent 接入（护城河落地）

- MCP 现有工具（`split_segment` 等）**不改名**，内部改走 `CommandManager.execute(...)` → 自动审计
- 新增 MCP 工具：`audit_log(actor?, limit?)`、`get_command_list()` —— Agent 可查"操作历史"
- Agent 调用模式：`execute(cmd_id, args, meta={actor:"agent", reason:"去掉口误", confidence:0.9})`
- 未来（方案 X）undo 栈切换后，Agent 可 `undo(cmd_id)` 选择性撤销——接口已留位

## 8. 验收标准

| # | 场景 | 通过 |
|---|------|------|
| C1 | 手动 split/trim/move 各一次 | 功能与之前一致（回归 T1-T5 全过） |
| C2 | Ctrl+Z 撤销 | 照常工作（快照兜底） |
| C3 | Agent 调 `audit_log` | 返回刚才 3 次操作的 cmd_id/meta |
| C4 | Agent 用 `execute` 调 split | 数据变更 + 审计追加 |

## 9. 实施顺序（方案 Y，约 0.5 天）

```
5a 新增 CommandManager（main.py 内嵌）+ audit 存储
5b MCP 工具改走 execute（先 3 个试点：split/trim/move）
5c 前端无改动（API 名不变），回归基线验证
5d Agent 可用后：audit_log / get_command_list 工具
```

## 10. 一句话

**Step 5 不重构 undo，而是给现有操作加一个"语义层"：统一入口 + 审计 + Agent meta，快照 undo 继续兜底。先拿到"可审计的 Agent 操作语言"（护城河），Command 取代快照栈留到真正需要时。**
