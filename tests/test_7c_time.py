# -*- coding: utf-8 -*-
"""
M7-7c 时间统一收口测试（后端侧）。
- snap_frame（AST 抽真实函数）：30fps 帧长 33333 语义、四舍五入、fps 参数。
- 与前端 TimelineMapper.snapFrame 公式（Math.round(us/f)*f）对拍一致（整数 us 下等价）。
运行：python tests/test_7c_time.py
"""
import ast
import os
import sys

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
    if isinstance(node, ast.FunctionDef) and node.name in ("snap_frame", "_frame_snap_us"):
        found[node.name] = ast.get_source_segment(src, node)

ns = {"__builtins__": __builtins__, "TICKS_PER_SECOND": 1_000_000}
for fn in ("snap_frame", "_frame_snap_us"):
    exec(compile(found[fn], "<ast:%s>" % fn, "exec"), ns)
snap = ns["snap_frame"]
snap_legacy = ns["_frame_snap_us"]


def frontend_snap(us, fps=30):   # 前端公式：Math.round(us/f)*f（half-up 模拟）
    f = round(1_000_000 / fps)
    return int(int(us) / f + 0.5) * f


print("== 1 snap_frame 数值语义（30fps）==")
check("整帧不动", snap(0) == 0 and snap(33333) == 33333 and snap(99999) == 99999)
check("半帧内吸到下帧（16667 → 33333）", snap(16667) == 33333, "got=%s" % snap(16667))
check("半帧下吸到本帧（16666 → 0）", snap(16666) == 0, "got=%s" % snap(16666))
check("50000 → 66666", snap(50000) == 66666, "got=%s" % snap(50000))
check("fps=25 帧长 40000", snap(20000, 25) == 40000 and snap(19999, 25) == 0)
check("fps=60 帧长 16667", snap(16667, 60) == 16667 and snap(8334, 60) == 16667 and snap(8333, 60) == 0)

print("== 2 _frame_snap_us 5d 别名 ==")
check("别名 = snap_frame(t,30)", snap_legacy(16667) == snap(16667, 30) == 33333
      and snap_legacy(50000) == snap(50000, 30) == 66666)

print("== 3 与前端公式对拍（整数 us 全域一致）==")
points = [0, 1, 33332, 33333, 33334, 16666, 16667, 50000, 99999, 123456, 1234567]
ok = all(snap(u) == frontend_snap(u, 30) for u in points)
check("30fps 对拍 %d 点全一致" % len(points), ok)
ok25 = all(snap(u, 25) == frontend_snap(u, 25) for u in points)
check("25fps 对拍 %d 点全一致" % len(points), ok25)

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
