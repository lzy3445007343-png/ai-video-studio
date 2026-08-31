# -*- coding: utf-8 -*-
"""持久化安全网：写前快照与无路径摘要的隔离回归。"""
import ast
import json
import os
import tempfile
import uuid


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "main.py")
tree = ast.parse(open(SOURCE, encoding="utf-8").read())
names = {"_state_summary", "_backup_previous_state"}
nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
assert len(nodes) == len(names), "持久化安全网函数缺失"
ns = {"os": os, "json": json, "tempfile": tempfile, "time": __import__("time"), "uuid": uuid,
      "STATE_BACKUP_KEEP": 2}
exec(compile(ast.Module(body=nodes, type_ignores=[]), SOURCE, "exec"), ns)


def state(materials, ids):
    return {
        "materials": [{"uid": str(i)} for i in range(materials)],
        "draft": {
            "main": {"segs": [{"id": sid} for sid in ids]},
            "overlay": [{"segs": []}],
            "audio": [{"segs": []}],
        },
        "version": 7,
    }


summary = ns["_state_summary"](state(2, ["b", "a"]))
assert summary == {"materials": 2, "tracks": 3, "segments": 2, "segment_ids": ["a", "b"]}, summary

with tempfile.TemporaryDirectory() as directory:
    ns["STATE_BACKUP_DIR"] = directory
    first = ns["_backup_previous_state"](state(1, ["s1"]))
    second = ns["_backup_previous_state"](state(2, ["s1", "s2"]))
    third = ns["_backup_previous_state"](state(3, ["s1", "s2", "s3"]))
    files = sorted(name for name in os.listdir(directory) if name.endswith(".json"))
    assert len(files) == 2, files
    assert os.path.exists(second) or os.path.exists(third), files
    payload = json.load(open(third, encoding="utf-8"))
    assert payload["materials"][2]["uid"] == "2", payload

print("test_state_backup: ALL PASSED")
