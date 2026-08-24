# -*- coding: utf-8 -*-
"""
M6-6b Plugin v0 隔离测试。
- plugin/plugin.py 纯 Python 直测（PluginManifest/PluginManager/builtin_effects_manifest）。
- main.py 的 _load_effects 用 AST 抽真实函数 + 桩命名空间 exec，跑真实 effects.json，
  验证 EFFECT_META 已含 css_expr/css_when（前端编译数据源）。
运行：python tests/test_6b_plugin.py
"""
import ast
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from plugin.plugin import PluginManifest, PluginManager, builtin_effects_manifest  # noqa: E402

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s %s" % (name, ("— " + detail) if detail else ""))


print("== 1 PluginManifest ==")
m = PluginManifest("test", "1.0")
check("默认 registers 四类", set(m.registers.keys()) == {"effects", "masks", "commands", "exporters"})
check("id/version 记录", m.id == "test" and m.version == "1.0")
try:
    PluginManifest("")
    check("空 id 抛 ValueError", False)
except ValueError:
    check("空 id 抛 ValueError", True)
d = m.to_dict()
check("to_dict 自描述", d["id"] == "test" and "effects" in d["registers"])

print("== 2 PluginManager register/query/list ==")
pm = PluginManager()
r = pm.register(PluginManifest("p1", "2.0", registers={"effects": {"blur": {"meta": {}}}}))
check("register 返回 ok", r["ok"] is True and r["plugin"] == "p1")
r2 = pm.register(PluginManifest("p1", "2.1"))
check("同 id 覆盖（幂等）", pm.query("effects") == {} and len(pm.list_plugins()) == 1
      and pm.list_plugins()[0]["version"] == "2.1")
pm2 = PluginManager()
pm2.register(PluginManifest("a", "1", registers={"effects": {"e1": 1}, "masks": {"m1": 2}}))
pm2.register(PluginManifest("b", "1", registers={"effects": {"e2": 3}}))
check("query 跨插件合并 effects", set(pm2.query("effects").keys()) == {"e1", "e2"})
check("query 单 key", pm2.query("effects", "e1") == 1)
check("query 未注册能力返回空", pm2.query("exporters") == {})

print("== 3 builtin_effects_manifest 包装 ==")
fake_registry = {"blur": {"css": lambda p: "", "ffmpeg": lambda p: ""}}
fake_meta = {"blur": {"label": "模糊", "params": {"radius": {}}, "css_expr": "blur({radius}px)", "css_when": "radius > 0"}}
bm = builtin_effects_manifest(fake_registry, fake_meta)
check("包装为 builtin-effects 插件", bm.id == "builtin-effects")
check("effects 注册含 blur", "blur" in bm.registers["effects"])
entry = bm.registers["effects"]["blur"]
check("entry 含 meta/css/ffmpeg", entry["meta"] is fake_meta["blur"] and entry["css"] is not None and entry["ffmpeg"] is not None)

print("== 4 main.py _load_effects 真实集成（AST 抽取 + 真 effects.json）==")
src = open(os.path.join(ROOT, "main.py"), encoding="utf-8").read()
tree = ast.parse(src)
funcs = {}
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in ("_build_effect_filter", "_load_effects"):
        funcs[node.name] = ast.get_source_segment(src, node)
for fn in ("_build_effect_filter", "_load_effects"):
    check("抽到 %s" % fn, fn in funcs)

ns = {"os": os, "json": json, "__file__": os.path.join(ROOT, "main.py")}
for fn in ("_build_effect_filter", "_load_effects"):
    exec(compile(funcs[fn], "<ast:%s>" % fn, "exec"), ns)
reg, meta = ns["_load_effects"]()
check("真实 effects.json 加载 9 个特效", len(meta) == 9, "got=%d" % len(meta))
check("meta 含 css_expr/css_when", all(
    "css_expr" in v and "css_when" in v for v in meta.values()),
    "missing=%s" % [k for k, v in meta.items() if "css_expr" not in v or "css_when" not in v])
check("blur 模板正确", meta["blur"]["css_expr"] == "blur({radius}px)" and meta["blur"]["css_when"] == "radius > 0")
check("opacity 模板正确", meta["opacity"]["css_expr"] == "opacity:{value}" and meta["opacity"]["css_when"] == "value != 1")
check("registry css/ffmpeg 函数已编译", callable(reg["blur"]["css"]) and callable(reg["blur"]["ffmpeg"]))
check("css 无操作返回空串（与前端 identity 对齐）", reg["blur"]["css"]({"radius": 0}) == "")
check("css 有值返回模板", reg["blur"]["css"]({"radius": 5}) == "blur(5px)")
check("ffmpeg 独立编译", reg["brightness"]["ffmpeg"]({"value": 2}) == "eq=brightness=2")

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
