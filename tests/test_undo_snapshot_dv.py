# -*- coding: utf-8 -*-
"""
M2 2c-fix2 回归测试：push_snapshot 兜底命令的 dv 配对（撤销死循环根治）。

根因（2026-08-24 用户真机撞到）：push_snapshot 创建快照 Command 不设 dv → dv_after 恒为 0。
撤销栈一旦混入 snapshot 命令，undo 门控 disk_dv(N) != cmd_dv(0) 永久判"外部已改动"
→ 纯手动操作撤销十几步后卡死。本测试验证修复后 snapshot 命令可正常 undo/redo。
运行：python tests/test_undo_snapshot_dv.py
"""
import ast
import copy
import os
import sys
import time
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s %s" % (name, ("— " + detail) if detail else ""))


src = open(os.path.join(ROOT, "main.py"), encoding="utf-8").read()
tree = ast.parse(src)
segments = {}
cmd_cls_lines = []
for node in ast.walk(tree):
    if isinstance(node, ast.ClassDef) and node.name == "CommandManager":
        for sub in node.body:
            if isinstance(sub, ast.FunctionDef) and sub.name in ("push_snapshot", "undo", "redo"):
                segments[sub.name] = ast.get_source_segment(src, sub)
    if isinstance(node, ast.ClassDef) and node.name == "Command":
        cmd_cls_lines.append((node.lineno, ast.get_source_segment(src, node)))
if cmd_cls_lines:
    cmd_cls_lines.sort()
    segments["Command"] = cmd_cls_lines[0][1]   # 取第一个 class Command（CommandManager 前的那个）
for fn in ("Command", "push_snapshot", "undo", "redo"):
    check("抽到 %s" % fn, fn in segments)

# 构造命名空间：真实 Command 类 + 桩 save_state/_append_audit
ns = {"copy": copy, "time": time}
ns["_append_audit"] = lambda *a, **k: None
ns["save_state"] = lambda state, record=True: True
exec(compile(segments["Command"], "<ast:Command>", "exec"), ns)
for fn in ("push_snapshot", "undo", "redo"):
    exec(compile(segments[fn], "<ast:%s>" % fn, "exec"), ns)
Command = ns["Command"]
PushSnapshot = ns["push_snapshot"]
Undo = ns["undo"]
Redo = ns["redo"]


def make_api(dv, draft=None):
    return types.SimpleNamespace(
        state={"domain_version": dv, "draft": draft or {"v": 0}},
        draft=draft or {"v": 0},
    )


print("== 1 push_snapshot dv 记录 ==")
cm = types.SimpleNamespace(history=[], redo_stack=[], _cap=2000, _tx=None)
saved = {"v": 1}
PushSnapshot(cm, saved, dv=5)
cmd = cm.history[0]
check("snapshot 命令 dv_before=5", cmd.dv_before == 5, "got=%s" % cmd.dv_before)
check("snapshot 命令 dv_after=6（变化后）", cmd.dv_after == 6, "got=%s" % cmd.dv_after)
check("saved_state 记录", cmd.saved_state == {"v": 1})
check("source=snapshot", cmd.source == "snapshot")

print("== 2 undo 门控：snapshot 命令可撤销（修复后）==")
api = make_api(6, draft={"v": 1})   # 磁盘 dv=6 == snapshot.dv_after=6
r = Undo(cm, api)
check("undo 通过（disk_dv=6 == dv_after=6）", r["ok"] is True, "r=%s" % r)
check("undo 后 dv 回退到 5", api.state["domain_version"] == 5, "got=%s" % api.state["domain_version"])
check("redo 栈有该命令", len(cm.redo_stack) == 1)

print("== 3 旧行为复现（不传 dv → 误判冲突，证明修复必要）==")
cm2 = types.SimpleNamespace(history=[], redo_stack=[], _cap=2000, _tx=None)
PushSnapshot(cm2, {"v": 1})   # 旧代码路径：不传 dv
api2 = make_api(6, draft={"v": 1})
r2 = Undo(cm2, api2)
check("旧行为：dv_after=0 → undo 冲突（bug 复现）", r2.get("conflict") is True and r2["ok"] is False)

print("== 4 混合序列：execute + snapshot 连续撤销全通过 ==")
cm3 = types.SimpleNamespace(history=[], redo_stack=[], _cap=2000, _tx=None)
# 手动构造 execute 命令（dv_after=3）+ snapshot 命令（dv_before=3, dv_after=4）
c1 = Command("move", "移动", {})
c1.saved_state = {"v": 1}
c1.post_state = {"v": 2}
c1.dv_before, c1.dv_after = 2, 3
c1.source = "execute"
s1 = Command("snapshot", "自动快照")
s1.saved_state = {"v": 2}
s1.post_state = {"v": 3}
s1.dv_before, s1.dv_after = 3, 4
s1.source = "snapshot"
cm3.history = [c1, s1]
api3 = make_api(4, draft={"v": 3})   # 磁盘 dv=4
r3 = Undo(cm3, api3)   # undo snapshot
check("混合序列 undo snapshot 通过", r3["ok"] is True, "r=%s" % r3)
check("dv 回退到 3", api3.state["domain_version"] == 3)
r3b = Undo(cm3, api3)   # undo execute
check("混合序列 undo execute 通过", r3b["ok"] is True, "r=%s" % r3b)
check("dv 回退到 2", api3.state["domain_version"] == 2)

print("== 5 redo 对称 ==")
r5 = Redo(cm3, api3)   # redo execute（检测基准 dv_before=2）
check("redo execute 通过（基准 dv_before=2）", r5["ok"] is True, "r=%s" % r5)
check("redo 后 dv=3", api3.state["domain_version"] == 3)
r5b = Redo(cm3, api3)   # redo snapshot（检测基准 dv_before=3）
check("redo snapshot 通过（基准 dv_before=3）", r5b["ok"] is True, "r=%s" % r5b)
check("redo 后 dv=4", api3.state["domain_version"] == 4)

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
