# -*- coding: utf-8 -*-
"""
M7-7b D5 最小任务队列隔离测试。
- main.py 模块级 _submit_task 用 AST 抽取 + 真 threading/time：提交后立即返回 task_id（不阻塞）、
  状态 running→done、result 登记；异常任务 → error 登记。
- Api.get_task_status / submit_transcribe / submit_import_media 用 AST 抽取 + 桩。
运行：python tests/test_7b_tasks.py
"""
import ast
import os
import sys
import threading
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
found = {}
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef) and node.name in ("_submit_task", "get_task_status", "submit_transcribe", "submit_import_media"):
        found[node.name] = ast.get_source_segment(src, node)
for fn in ("_submit_task", "get_task_status", "submit_transcribe", "submit_import_media"):
    check("抽到 %s" % fn, fn in found)

# ---- 真实 _submit_task（真 threading/time/dict + 模块级任务表桩） ----
ns = {"threading": threading, "time": time, "dict": dict,
      "_TASKS": {}, "_TASK_LOCK": threading.Lock(), "_TASK_SEQ": [0]}
exec(compile(found["_submit_task"], "<ast:_submit_task>", "exec"), ns)
submit_task = ns["_submit_task"]

print("== 1 _submit_task 异步流转 ==")
tid = submit_task(lambda: (time.sleep(0.5), "结果42")[1])   # 慢任务保证 running 可被观察到
check("立即返回 task_id（不阻塞）", tid.startswith("task_"))
with ns["_TASK_LOCK"]:
    st0 = ns["_TASKS"][tid]["status"]
check("提交瞬间 status=running", st0 == "running", "got=%s" % st0)
time.sleep(0.9)
with ns["_TASK_LOCK"]:
    t = ns["_TASKS"][tid]
check("完成后 status=done", t["status"] == "done", "got=%s" % t["status"])
check("result 登记", t["result"] == "结果42")

tid2 = submit_task(lambda: 1 / 0)   # 抛异常任务
time.sleep(0.3)
with ns["_TASK_LOCK"]:
    t2 = ns["_TASKS"][tid2]
check("异常任务 status=error", t2["status"] == "error")
check("error 登记", t2["error"] is not None)

# ---- Api 三个方法（AST + 桩） ----
def run_method(name, self_obj, *args):
    ns2 = {"_TASK_LOCK": ns["_TASK_LOCK"], "_TASKS": ns["_TASKS"], "os": os,
           "_submit_task": lambda fn, *a, **k: "task_FAKE"}
    exec(compile(found[name], "<ast:%s>" % name, "exec"), ns2)
    return ns2[name](self_obj, *args)

print("== 2 get_task_status ==")
self_s = types.SimpleNamespace(transcribe_media=lambda *a, **k: None, import_media_by_paths=lambda *a, **k: None)
r = run_method("get_task_status", self_s, "task_不存在")
check("未知任务 → error", r["ok"] is False and "未知任务" in r["error"])
r2 = run_method("get_task_status", self_s, tid)
check("已知任务 → status 透传", r2["ok"] is True and r2["status"] == "done")

print("== 3 submit_transcribe ==")
r3 = run_method("submit_transcribe", self_s, "C:/不存在的.mp4")
check("文件不存在 → error", r3["ok"] is False)
r4 = run_method("submit_transcribe", self_s, __file__)   # 用本文件当"存在的文件"
check("文件存在 → task_id", r4["ok"] is True and r4["task_id"] == "task_FAKE")

print("== 4 submit_import_media ==")
r5 = run_method("submit_import_media", self_s, ["C:/a.mp4"])
check("导入 → task_id", r5["ok"] is True and r5["task_id"] == "task_FAKE")

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
