# -*- coding: utf-8 -*-
"""
M7-7a Intent v0 隔离测试。
- intent/intent.py 纯函数直测：validate（schema+资源可达）/ plan（规则映射）。
- main.py Api.submit_intents / create_project 用 AST 抽真实函数 + 桩验证事务流。
运行：python tests/test_7a_intent.py
"""
import ast
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from intent.intent import validate_intents, plan_intents  # noqa: E402

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s %s" % (name, ("— " + detail) if detail else ""))


print("== 1 validate_intents ==")
errs, cleaned = validate_intents([{"type": "create-project", "args": {"name": "测试"}}])
check("合法 create-project 通过", errs == [] and cleaned[0]["type"] == "create-project")
check("intents 非数组 → errors", validate_intents("x")[0][0] == "intents 必须是非空数组")
check("未知类型 → errors", "未知类型" in validate_intents([{"type": "hack"}])[0][0])
check("apply-preset 缺 preset_id → errors", any("preset_id" in e for e in validate_intents([{"type": "apply-preset"}])[0]))
errs, _ = validate_intents([{"type": "apply-preset", "args": {"preset_id": "koubo"}}], presets={"koubo": {}})
check("apply-preset 模板存在 → 通过", errs == [])
errs, _ = validate_intents([{"type": "apply-preset", "args": {"preset_id": "nope"}}], presets={"koubo": {}})
check("apply-preset 未知模板 → errors", any("未知模板" in e for e in errs))
errs, _ = validate_intents([{"type": "import-media", "args": {"paths": ["C:/不存在.mp4"]}}])
check("import-media 文件不存在 → errors", any("文件不存在" in e for e in errs))
errs, _ = validate_intents([{"type": "add-subtitles", "args": {"cues": []}}])
check("add-subtitles 空 cues → errors", any("cues 必须是非空数组" in e for e in errs))
errs, _ = validate_intents([{"type": "add-subtitles", "args": {"cues": [{"text": "你好", "start": 0, "duration": 2}]}}])
check("add-subtitles 有效 cues → 通过", errs == [])

print("== 2 plan_intents ==")
plan = plan_intents([
    {"type": "create-project", "args": {"name": "A"}},
    {"type": "apply-preset", "args": {"preset_id": "koubo", "cues": [{"text": "x"}]}},
    {"type": "add-subtitles", "args": {"cues": [{"text": "y"}], "style": {"font_size": 50}}},
])
check("create-project → create_project 命令", plan[0]["cmd"] == "create_project" and plan[0]["args"]["name"] == "A")
check("apply-preset → apply_preset + 透传模板变量", plan[1]["cmd"] == "apply_preset"
      and plan[1]["args"]["preset_id"] == "koubo" and "cues" in plan[1]["args"]["args"])
check("add-subtitles → add_subtitles + style 透传", plan[2]["cmd"] == "add_subtitles"
      and plan[2]["args"]["style"] == {"font_size": 50})

print("== 3 main.py Api.submit_intents（AST 抽取 + 桩事务流）==")
src = open(os.path.join(ROOT, "main.py"), encoding="utf-8").read()
tree = ast.parse(src)
found = {}
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name in ("submit_intents", "create_project"):
        found[node.name] = ast.get_source_segment(src, node)
check("抽到 submit_intents", "submit_intents" in found)
check("抽到 create_project", "create_project" in found)


def make_self(**over):
    state = {"call_log": [], "begin": 0, "commit": 0, "abort": 0}
    self_obj = types.SimpleNamespace(
        draft={"overlay": [], "audio": [{"segs": []}], "main": {"segs": []}},
        state={"draft": {"overlay": [], "audio": [{"segs": []}], "main": {"segs": []}}, "materials": [], "metadata": {}},
        _reload=lambda: None,
        begin_transaction=lambda *a, **k: (state.__setitem__("begin", state["begin"] + 1), {"ok": True})[1],
        commit_transaction=lambda *a, **k: (state.__setitem__("commit", state["commit"] + 1), {"ok": True})[1],
        abort_transaction=lambda *a, **k: state.__setitem__("abort", state["abort"] + 1),
        execute=lambda cmd, args, m=None: state["call_log"].append((cmd, args)) or {"ok": True},
    )
    for k, v in over.items():
        setattr(self_obj, k, v)
    return self_obj, state


def run_submit(self_obj, intents):
    ns = {
        "Api": types.SimpleNamespace(cmd_mgr=types.SimpleNamespace()),
        "_load_presets": lambda: {"koubo": {"id": "koubo", "steps": []}},
        "_validate_intents": validate_intents,
        "_plan_intents": plan_intents,
        "json": json,
    }
    exec(compile(found["submit_intents"], "<ast:submit_intents>", "exec"), ns)
    return ns["submit_intents"](self_obj, intents)


obj, st = make_self()
r = run_submit(obj, [{"type": "create-project", "args": {"name": "A"}},
                     {"type": "add-subtitles", "args": {"cues": [{"text": "x", "start": 0, "duration": 2}]}}])
check("正常执行 applied=2", r["ok"] is True and r["applied"] == ["create-project", "add-subtitles"], "applied=%s" % r["applied"])
check("begin/commit 各 1 次", st["begin"] == 1 and st["commit"] == 1 and st["abort"] == 0)
check("execute 按计划调命令", [c for c, a in st["call_log"]] == ["create_project", "add_subtitles"])
check("execute args 透传", st["call_log"][1][1]["cues"] == [{"text": "x", "start": 0, "duration": 2}])
# 校验失败不执行
obj2, st2 = make_self()
r2 = run_submit(obj2, [{"type": "hack"}])
check("非法意图 → errors 不执行", r2["ok"] is False and "errors" in r2 and st2["begin"] == 0 and st2["call_log"] == [])
# 步骤失败 abort
def bad_execute(cmd, args, m=None):
    if cmd == "create_project":
        return {"ok": False, "error": "建项目失败"}
    return {"ok": True}
obj3, st3 = make_self(execute=bad_execute)
r3 = run_submit(obj3, [{"type": "create-project"}])
check("步骤失败 → abort + error", r3["ok"] is False and "已整体回滚" in r3["error"] and st3["abort"] == 1 and st3["commit"] == 0)

print("== 4 main.py Api.create_project（AST + 桩）==")
def run_create(self_obj, name=None):
    ns = {"_ensure_track_tids": lambda d: None, "DEFAULT_CANVAS": "16:9",
          "save_state": lambda s, record=True: True}
    exec(compile(found["create_project"], "<ast:create_project>", "exec"), ns)
    return ns["create_project"](self_obj, name)

obj4 = types.SimpleNamespace(
    draft={}, state={"draft": {}, "materials": [{"uid": "m1"}], "metadata": {"name": "旧"}},
    _reload=lambda: None,
)
r4 = run_create(obj4, "新工程")
check("create_project 返回 ok+name", r4["ok"] is True and r4["name"] == "新工程")
check("materials 清空", obj4.state["materials"] == [])
check("draft 重置为空结构", obj4.state["draft"]["overlay"] == [] and obj4.state["draft"]["main"] == {"segs": []}
      and obj4.state["draft"]["canvas"]["ratio"] == "16:9")

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
