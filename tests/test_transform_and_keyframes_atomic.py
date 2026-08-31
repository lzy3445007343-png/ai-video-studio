# -*- coding: utf-8 -*-
"""画布位置与 X/Y 关键帧必须在单次写盘中原子完成。"""
import ast
import copy
import os
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "main.py")
source = open(SOURCE, encoding="utf-8").read()
tree = ast.parse(source)
method = None
for node in tree.body:
    if isinstance(node, ast.ClassDef) and node.name == "Api":
        for child in node.body:
            if isinstance(child, ast.FunctionDef) and child.name == "update_transform_and_keyframes":
                method = ast.get_source_segment(source, child)
assert method

def seg_by_id(draft, sid):
    for bucket in (draft.get("main", {}).get("segs", []),):
        for seg in bucket:
            if seg.get("id") == sid:
                return seg
    return None

ns = {"_seg_by_id": seg_by_id, "_track_segs": lambda *args: None,
      "_write_param": lambda seg, path, value: seg.setdefault("params", {}).__setitem__(path, value),
      "_frame_snap_us": lambda value: value, "_seg_anims": lambda seg: seg.setdefault("animations", {}),
      "KF_KEYFRAMEABLE": {"transform.positionX", "transform.positionY"},
      "_FIELD_TO_PARAM": {"x": "transform.positionX", "y": "transform.positionY"},
      "uuid": uuid, "save_state": lambda state: True}
exec(compile(method, "<ast:update_transform_and_keyframes>", "exec"), ns)

class ApiStub:
    def __init__(self):
        self.draft = {"main": {"segs": [{"id": "s", "duration": 2_000_000,
            "transform": {"x": 0, "y": 0}, "params": {}, "animations": {}}]}}
        self.state = {"draft": self.draft}
    def _reload(self): pass
    def _push_undo(self): pass

ApiStub.update_transform_and_keyframes = ns["update_transform_and_keyframes"]
api = ApiStub()
r = api.update_transform_and_keyframes(segid="s", transform={"x": 100, "y": 200}, keyframes=[
    {"path": "transform.positionX", "time_us": 1_000_000, "value": 100},
    {"path": "transform.positionY", "time_us": 1_000_000, "value": 200},
])
assert r["ok"] is True and len(r["keyframes"]) == 2, r
assert set(api.draft["main"]["segs"][0]["animations"]) == {"transform.positionX", "transform.positionY"}
assert api.draft["main"]["segs"][0]["params"] == {"transform.positionX": 100, "transform.positionY": 200}
print("test_transform_and_keyframes_atomic: ALL PASSED")
