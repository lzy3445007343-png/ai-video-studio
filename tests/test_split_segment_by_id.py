# -*- coding: utf-8 -*-
"""分割命令按稳定段 ID 定位，避免轨道索引漂移后切错片段。"""
import ast
import copy
import os
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "main.py")
source = open(SOURCE, encoding="utf-8").read()
tree = ast.parse(source)
functions = {}
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in {"_seg_by_id", "_locate_seg"}:
        functions[node.name] = ast.get_source_segment(source, node)
    if isinstance(node, ast.ClassDef) and node.name == "Api":
        for method in node.body:
            if isinstance(method, ast.FunctionDef) and method.name in {"_split_segment_core"}:
                functions[method.name] = ast.get_source_segment(source, method)
assert len(functions) == 3, functions.keys()

ns = {"copy": copy, "uuid": uuid}
ns["_track_segs"] = lambda draft, typ, ti: draft["main"]["segs"] if typ == "video" and ti == 0 else draft["overlay"][ti]["segs"]
ns["get_media_duration"] = lambda path: 3
ns["_seg_speed"] = lambda seg: float(seg.get("speed", 1.0) or 1.0)
ns["_seg_anims"] = lambda seg: seg.get("animations", {}) or {}
ns["_split_animations"] = lambda anims, local: (copy.deepcopy(anims), {})
for name in ("_seg_by_id", "_locate_seg", "_split_segment_core"):
    exec(compile(functions[name], "<ast:%s>" % name, "exec"), ns)

class ApiStub:
    def __init__(self):
        self.draft = {"main": {"segs": [{"id": "left", "start": 0, "duration": 1_000_000,
                                           "src_start": 0, "src_end": 1_000_000, "path": "x.mp4", "type": "video"},
                                          {"id": "target", "start": 1_000_000, "duration": 2_000_000,
                                           "src_start": 0, "src_end": 2_000_000, "path": "x.mp4", "type": "video"}]},
                       "overlay": [], "audio": []}
    draft = None

ApiStub._split_segment_core = ns["_split_segment_core"]
api = ApiStub()
result = api._split_segment_core("video", 0, 0, 2_000_000, "target")
assert result["ok"] is True, result
assert [s["id"] for s in api.draft["main"]["segs"]] == ["left", "target", result["right"]["id"]]
assert api.draft["main"]["segs"][1]["duration"] == 1_000_000
print("test_split_segment_by_id: ALL PASSED")
