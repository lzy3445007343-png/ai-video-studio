"""M2 回归：undo/redo 的 domain_version 回退（修复撤销死循环 2c bug）。

抽 main.py 真实 CmdManager.undo / redo 方法（AST 递归查找，不经 import 主模块），
构造最小 self/api/cmd 桩，验证：
  A. 两步操作链：undo×2 + redo×2 全程 ok，domain_version 正确回退/恢复（修复前第2次 undo 必 conflict）
  B. 外部改动拦截：磁盘 dv 被外部 bump 后 undo 仍判 conflict（防护不丢）
  C. 单步操作：undo/redo 各一次 ok
"""
import ast
import copy
import types

SRC = open("main.py", encoding="utf-8").read()
tree = ast.parse(SRC)

def find_class(node, name):
    for n in ast.walk(node):
        if isinstance(n, ast.ClassDef) and n.name == name:
            return n
    return None

save_calls = []
def fake_save(state, record=True):
    save_calls.append((state.get("domain_version"), record))
    return True

cm = find_class(tree, "CommandManager")
funcs = {f.name: f for f in cm.body if isinstance(f, ast.FunctionDef) and f.name in ("undo", "redo")}
ns = {"copy": copy, "save_state": fake_save}
for name, node in funcs.items():
    src = ast.get_source_segment(SRC, node)
    exec(compile(src, f"<main.{name}>", "exec"), ns)
undo = ns["undo"]
redo = ns["redo"]

def mkcmd(dv_before, dv_after, tag):
    return types.SimpleNamespace(
        dv_before=dv_before, dv_after=dv_after,
        saved_state={"d": f"saved-{tag}"}, post_state={"d": f"post-{tag}"},
        selection_before=None, selection_after=None,
    )

def self_obj(history, redo_stack):
    return types.SimpleNamespace(history=history, redo_stack=redo_stack, _tx=None, _cap=1000)

fails = []
def check(cond, msg):
    print(("PASS" if cond else "FAIL"), msg)
    if not cond:
        fails.append(msg)

# ---- A. 两步操作链 ----
c1 = mkcmd(0, 1, "1"); c2 = mkcmd(1, 2, "2")
selfA = self_obj([c1, c2], [])
apiA = types.SimpleNamespace(draft={}, state={"domain_version": 2})
r1 = undo(selfA, apiA); check(r1["ok"], "A undo#1 ok")
check(apiA.state["domain_version"] == 1, "A undo#1 domain_version 回退到 dv_before=1")
r2 = undo(selfA, apiA); check(r2["ok"], "A undo#2 ok（修复前此处必 conflict=死循环）")
check(apiA.state["domain_version"] == 0, "A undo#2 domain_version 回退到 dv_before=0")
check(selfA.redo_stack == [c2, c1], "A redo_stack 顺序 [c2,c1]")
r3 = redo(selfA, apiA); check(r3["ok"], "A redo#1 ok")
check(apiA.state["domain_version"] == 1, "A redo#1 domain_version 恢复到 dv_after=1")
r4 = redo(selfA, apiA); check(r4["ok"], "A redo#2 ok")
check(apiA.state["domain_version"] == 2, "A redo#2 domain_version 恢复到 dv_after=2")

# ---- B. 外部改动拦截 ----
c = mkcmd(1, 2, "ext")
selfB = self_obj([c], [])
apiB = types.SimpleNamespace(draft={}, state={"domain_version": 5})  # 外部 bump 到 5
rb = undo(selfB, apiB)
check(rb.get("conflict") is True, "B 外部改动(dv=5) undo 判 conflict（防护不丢）")
check(apiB.state["domain_version"] == 5, "B conflict 时 domain_version 不被回退")

# ---- C. 单步 ----
c = mkcmd(0, 1, "single")
selfC = self_obj([c], [])
apiC = types.SimpleNamespace(draft={}, state={"domain_version": 1})
rc1 = undo(selfC, apiC); check(rc1["ok"], "C 单步 undo ok")
check(apiC.state["domain_version"] == 0, "C 单步 undo domain_version→0")
rc2 = redo(selfC, apiC); check(rc2["ok"], "C 单步 redo ok")
check(apiC.state["domain_version"] == 1, "C 单步 redo domain_version→1")

print("\nFAKE_SAVE_CALLS:", save_calls)
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAIL -> {fails}")
assert not fails, fails
