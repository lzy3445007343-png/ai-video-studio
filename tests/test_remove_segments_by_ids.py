# -*- coding: utf-8 -*-
"""稳定 ID 批量删除：分割/移动后不再按索引误删。"""
import ast
import copy
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "main.py")
source = open(SOURCE, encoding="utf-8").read()
tree = ast.parse(source)
wanted = {"_seg_by_id", "_pop_seg_by_ref"}
functions = {node.name: ast.get_source_segment(source, node) for node in tree.body
             if isinstance(node, ast.FunctionDef) and node.name in wanted}
for node in tree.body:
    if isinstance(node, ast.ClassDef) and node.name == "Api":
        for method in node.body:
            if isinstance(method, ast.FunctionDef) and method.name == "remove_segments_by_ids":
                functions[method.name] = ast.get_source_segment(source, method)
assert set(functions) == wanted | {"remove_segments_by_ids"}, functions.keys()

saves = []
ns = {"copy": copy, "save_state": lambda state: saves.append(copy.deepcopy(state)) or True,
      "_collapse_empty_tracks": lambda draft: None,
      "apply_ripple_adjustments": lambda draft, changes: None,
      "compute_ripple_adjustments": lambda before, after: []}
for name in ("_seg_by_id", "_pop_seg_by_ref", "remove_segments_by_ids"):
    exec(compile(functions[name], "<ast:%s>" % name, "exec"), ns)

class ApiStub:
    def __init__(self):
        self.draft = {"main": {"segs": [{"id": "main-a"}]}, "overlay": [
            {"segs": [{"id": "overlay-a"}, {"id": "overlay-b"}]}], "audio": [{"segs": []}]}
        self.state = {"draft": self.draft}
    def _reload(self): pass
    def _push_undo(self): pass

ApiStub.remove_segments_by_ids = ns["remove_segments_by_ids"]
api = ApiStub()
r = api.remove_segments_by_ids(["overlay-b", "main-a"])
assert r["ok"] is True and r["removed"] == 2, r
assert [s["id"] for s in api.draft["overlay"][0]["segs"]] == ["overlay-a"], api.draft
assert saves, "成功删除必须持久化"

before = copy.deepcopy(api.draft)
r = api.remove_segments_by_ids(["overlay-a", "missing"])
assert r["ok"] is False and api.draft == before, r
print("test_remove_segments_by_ids: ALL PASSED")
