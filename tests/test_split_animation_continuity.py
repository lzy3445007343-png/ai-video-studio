"""分割关键帧后，切点画面必须与分割前连续。"""
import ast
import copy
import sys
import uuid


SRC = open("main.py", encoding="utf-8").read()
TREE = ast.parse(SRC)


def grab(name):
    for node in TREE.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(SRC, node)
    raise RuntimeError("not found: " + name)


NS = {"copy": copy, "uuid": uuid}
for NAME in ("_bezier_solve_x", "_bezier_value", "_kf_interp", "resolve_kf_value", "_split_animations"):
    exec(compile(grab(NAME), "<ast:%s>" % NAME, "exec"), NS)


def check(name, condition):
    print(("PASS" if condition else "FAIL") + " - " + name)
    return condition


anims = {
    "transform.positionX": {
        "type": "scalar",
        "keys": [
            {"id": "x0", "t": 0, "v": 0.0, "seg": "linear"},
            {"id": "x1", "t": 1_000_000, "v": 200.0, "seg": "linear"},
        ],
    },
    "text.bold": {
        "type": "discrete",
        "keys": [
            {"id": "b0", "t": 0, "v": False, "seg": "hold"},
            {"id": "b1", "t": 1_000_000, "v": True, "seg": "hold"},
        ],
    },
}

left, right = NS["_split_animations"](anims, 500_000)
before_x = NS["resolve_kf_value"](anims, "transform.positionX", 500_000)
left_x = NS["resolve_kf_value"](left, "transform.positionX", 500_000)
right_x = NS["resolve_kf_value"](right, "transform.positionX", 0)
before_bold = NS["resolve_kf_value"](anims, "text.bold", 500_000)
right_bold = NS["resolve_kf_value"](right, "text.bold", 0)

ok = True
ok &= check("分割点左段保留插值 X", abs(left_x - before_x) < 1e-9)
ok &= check("分割点右段保留插值 X", abs(right_x - before_x) < 1e-9)
ok &= check("右段从切点边界帧开始", right["transform.positionX"]["keys"][0]["t"] == 0)
ok &= check("通道类型在分割后保留", right["text.bold"]["type"] == "discrete")
ok &= check("离散属性在切点连续", right_bold is before_bold)

print("\nRESULT:", "ALL PASS" if ok else "HAS FAILURE")
sys.exit(0 if ok else 1)
