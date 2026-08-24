# -*- coding: utf-8 -*-
"""
M6-6c Preset v0 隔离测试。
- presets/preset.py 纯函数直测：load/get/plan（模板填充、变量缺失保留、递归填充）。
- main.py Api.apply_preset 用 AST 抽真实函数 + 桩验证事务流分支（未知模板/ensure_track 跳过/
  缺变量跳过/正常执行/步骤失败 abort 回滚）。
运行：python tests/test_6c_presets.py
"""
import ast
import json
import os
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from presets.preset import load_presets, get_presets, plan_preset, _fill_template  # noqa: E402

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s %s" % (name, ("— " + detail) if detail else ""))


print("== 1 load_presets / get_presets（内置 3 模板）==")
presets = load_presets()
check("加载 3 个内置模板", set(presets.keys()) == {"koubo", "xhs", "text_base"}, "got=%s" % list(presets.keys()))
check("koubo steps 3 步", len(presets["koubo"]["steps"]) == 3)
check("xhs 有 ensure_track", presets["xhs"]["steps"][1].get("ensure_track") == "text")
catalog = get_presets()
check("目录 3 条", len(catalog) == 3)
check("目录字段齐", all(all(k in p for k in ("id", "label", "desc", "categories", "kind")) for p in catalog))

print("== 2 plan_preset 模板填充 ==")
p = presets["koubo"]
plan = plan_preset(p, {"cues": [{"text": "你好", "start": 0, "duration": 2}]})
check("cues 变量被填充", plan[2]["args"]["cues"] == [{"text": "你好", "start": 0, "duration": 2}])
check("subtitle_style 用 defaults", plan[2]["args"]["style"] == {"font_size": 60, "color": "#FFFFFF", "position": "bottom"})
check("ensure_track 保留在 step", plan[1].get("ensure_track") == "text")
check("args 覆盖 defaults", plan_preset(p, {"subtitle_style": {"font_size": 90}})[2]["args"]["style"] == {"font_size": 90})
plan2 = plan_preset(p, {})   # 不传 cues
check("缺变量保留 {{cues}}（供跳过检测）", "{{cues}}" in json.dumps(plan2[2]["args"]))
check("_fill_template 递归 dict（整串变量原样嵌入：数字 int/list 原样）",
      _fill_template({"a": "{{x}}", "b": [1, "{{y}}"], "c": "p{{z}}q"}, {"x": 1, "y": 2, "z": "Z"})
      == {"a": 1, "b": [1, 2], "c": "pZq"})

print("== 3 main.py Api.apply_preset（AST 抽取 + 桩事务流）==")
src = open(os.path.join(ROOT, "main.py"), encoding="utf-8").read()
tree = ast.parse(src)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name == "apply_preset":
        apply_src = ast.get_source_segment(src, node)
        break
else:
    apply_src = None
check("抽到 apply_preset", apply_src is not None)

FAKE_PRESETS = {
    "koubo": {"id": "koubo", "steps": [
        {"cmd": "set_canvas", "args": {"ratio": "16:9"}},
        {"cmd": "add_text_track", "args": {}, "ensure_track": "text"},
        {"cmd": "add_subtitles", "args": {"track_index": 0, "cues": "{{cues}}"}},
    ]},
}


def make_self(**over):
    state = {"call_log": [], "begin": 0, "commit": 0, "abort": 0}
    self_obj = types.SimpleNamespace(
        draft={"overlay": [], "audio": [{"segs": []}], "main": {"segs": []}},
        state={"domain_version": 0},
        _reload=lambda: None,
        begin_transaction=lambda *a, **k: (state.__setitem__("begin", state["begin"] + 1), {"ok": True})[1],
        commit_transaction=lambda *a, **k: (state.__setitem__("commit", state["commit"] + 1), {"ok": True})[1],
        abort_transaction=lambda *a, **k: state.__setitem__("abort", state["abort"] + 1),
        execute=lambda cmd, args, m=None: state["call_log"].append((cmd, args)) or {"ok": True},
    )
    for k, v in over.items():
        setattr(self_obj, k, v)
    return self_obj, state


def run_apply(self_obj, preset_id="koubo", args=None, track_exists=None, cmd_mgr=None):
    ns = {
        "Api": types.SimpleNamespace(cmd_mgr=cmd_mgr or types.SimpleNamespace()),
        "_load_presets": lambda: FAKE_PRESETS,
        "_plan_preset": plan_preset,
        "_track_exists": (lambda d, t: True) if track_exists is None else track_exists,
        "json": json,
    }
    exec(compile(apply_src, "<ast:apply_preset>", "exec"), ns)
    return ns["apply_preset"](self_obj, preset_id, args)


obj, st = make_self()
s = run_apply(obj, args={"cues": [{"text": "你好", "start": 0, "duration": 2}]}, track_exists=lambda d, t: True)   # 轨已存在 → ensure 步跳过
check("未知模板返回 error", run_apply(make_self()[0], "nope").get("ok") is False and "未知模板" in run_apply(make_self()[0], "nope").get("error", ""))
check("正常执行 applied=2（ensure 轨已存在被跳过）", s["ok"] is True and s["applied"] == ["set_canvas", "add_subtitles"], "applied=%s" % s["applied"])
check("ensure 步记入 skipped", "add_text_track(轨已存在)" in s["skipped"])
check("begin/commit 各 1 次", st["begin"] == 1 and st["commit"] == 1 and st["abort"] == 0)
check("execute 收到填充后 args", st["call_log"][0] == ("set_canvas", {"ratio": "16:9"}))

obj_a, st_a = make_self()
sa = run_apply(obj_a, track_exists=lambda d, t: False)   # 轨不存在 → ensure 步执行（建轨）
check("ensure 轨不存在 → 建轨步执行", sa["ok"] is True and "add_text_track" in sa["applied"]
      and not any("轨已存在" in x for x in sa["skipped"]))

obj2, st2 = make_self()
s2 = run_apply(obj2, args=None, track_exists=lambda d, t: False)
check("缺变量步跳过（cues 未传）", s2["ok"] is True and "add_subtitles(缺变量)" in s2["skipped"]
      and s2["applied"] == ["set_canvas", "add_text_track"], "applied=%s skipped=%s" % (s2["applied"], s2["skipped"]))

def failing_execute(cmd, args, m=None):
    if cmd == "set_canvas":
        return {"ok": False, "error": "画布失败"}
    return {"ok": True}
obj3, st3 = make_self(execute=failing_execute)
s3 = run_apply(obj3, track_exists=lambda d, t: False)
check("步骤失败 → abort + error", s3["ok"] is False and "已整体回滚" in s3["error"] and st3["abort"] == 1 and st3["commit"] == 0)

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
