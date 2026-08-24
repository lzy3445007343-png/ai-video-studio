# -*- coding: utf-8 -*-
"""
M6-6a Document Protocol v1 隔离测试：doc_protocol/schema.py 是纯函数模块（零依赖），直接 import 真函数验证。
覆盖：三态校验（errors/warnings/repaired）、load_document 应用修复、零丢失 setdefault 语义。
运行：python tests/test_6a_document_protocol.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from doc_protocol.schema import (  # noqa: E402
    validate_document, load_document, DOCUMENT_SCHEMA_VERSION,
)

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s %s" % (name, ("— " + detail) if detail else ""))


def valid_doc():
    """最小合法 VideoDocument（对齐真实 seg 字段：start/duration，非 timeline_start）。"""
    return {
        "materials": [{"uid": "m1", "path": "C:/x.mp4"}],
        "draft": {
            "overlay": [{"type": "video", "segs": [
                {"id": "s1", "name": "a", "path": "C:/x.mp4", "type": "video",
                 "start": 0, "duration": 1_000_000, "src_start": 0, "src_end": 1_000_000,
                 "src_full": 1_000_000, "speed": 1.0, "change_pitch": False, "animations": {}}]}],
            "main": {"segs": []},
            "audio": [{"segs": []}],
            "canvas": {"ratio": "16:9", "locked": False},
            "_track_meta": {"overlay": [], "main": {}, "audio": [{}]},
        },
        "version": 0,
        "schemaVersion": 1,
    }


print("== 1 三态校验（validate_document）==")
r = validate_document(valid_doc())
check("合法文档 ok=True", r["ok"] is True, "errors=%s" % r["errors"])
check("合法文档 errors 空", r["errors"] == [])
check("合法文档 warnings 空", r["warnings"] == [])

r = validate_document("not a doc")
check("非 dict → ok=False", r["ok"] is False and "JSON 对象" in r["errors"][0])

r = validate_document({"materials": [], "draft": {}})
check("缺轨道容器 → repaired 5 项", len(r["repaired"]) == 5, "repaired=%s" % list(r["repaired"].keys()))
check("缺轨道容器 → warnings 提示", any("缺失" in w for w in r["warnings"]))
check("缺轨道容器但结构合法 → ok=True", r["ok"] is True)

r = validate_document({"materials": [], "draft": {"overlay": [], "main": [], "audio": [], "canvas": {}, "_track_meta": {}}})
check("main 必须是 dict → errors", any("main 必须是对象" in e for e in r["errors"]))
check("main 类型错误 → ok=False", r["ok"] is False)

d = valid_doc()
del d["draft"]["main"]["segs"][:0]  # no-op
bad = valid_doc()
del bad["draft"]["main"]
r = validate_document(bad)
check("缺 draft.main → repaired 补默认（可修复）", "draft.main" in r["repaired"]
      and r["repaired"]["draft.main"] == {"segs": []} and r["ok"] is True)

print("== 2 seg 级校验 ==")
s1 = valid_doc()
del s1["draft"]["overlay"][0]["segs"][0]["id"]
r = validate_document(s1)
check("seg 缺 id → errors", any("缺少必填字段 id" in e for e in r["errors"]))

s2 = valid_doc()
s2["draft"]["overlay"][0]["segs"][0]["duration"] = 0
r = validate_document(s2)
check("seg duration=0 → errors", any("duration 必须为正数" in e for e in r["errors"]))

s3 = valid_doc()
s3["draft"]["overlay"][0]["segs"][0]["type"] = "magic"
r = validate_document(s3)
check("未知段类型 → warnings 不拦", any("未知类型" in w for w in r["warnings"]) and r["ok"] is True)

s4 = valid_doc()
del s4["draft"]["overlay"][0]["segs"][0]["animations"]
r = validate_document(s4)
check("seg 缺 animations → repaired.segments", "segments" in r["repaired"]
      and "s1" in r["repaired"]["segments"])

print("== 3 load_document 应用修复 ==")
sparse = {"materials": [], "draft": {"overlay": [{"type": "video", "segs": [
    {"id": "s1", "type": "video", "start": 0, "duration": 500_000}]}]}}
r = load_document(sparse)
check("稀疏文档 load ok=True", r["ok"] is True, "errors=%s" % r.get("errors"))
doc = r["document"]
seg0 = doc["draft"]["overlay"][0]["segs"][0]
check("overlay 段字段保留（id/type/start/duration 不被覆盖丢失）",
      seg0["id"] == "s1" and seg0["type"] == "video" and seg0["start"] == 0
      and seg0["duration"] == 500_000)
check("补 main", doc["draft"]["main"] == {"segs": []})
check("补 audio", doc["draft"]["audio"] == [{"segs": []}])
check("补 canvas 默认 16:9", doc["draft"]["canvas"] == {"ratio": "16:9", "locked": False})
check("补 _track_meta", isinstance(doc["draft"]["_track_meta"], dict))
check("seg 补 animations={}", doc["draft"]["overlay"][0]["segs"][0]["animations"] == {})
check("补 schemaVersion=%d" % DOCUMENT_SCHEMA_VERSION, doc["schemaVersion"] == DOCUMENT_SCHEMA_VERSION)
check("补 metadata={}", doc["metadata"] == {})

keep = valid_doc()
keep["draft"]["overlay"][0]["segs"][0]["animations"] = {"transform.positionX": {"keys": [1]}}
r = load_document(keep)
check("已有 animations 不被覆盖（零丢失 setdefault）",
      r["document"]["draft"]["overlay"][0]["segs"][0]["animations"]["transform.positionX"]["keys"] == [1])

bad_doc = {"materials": [], "draft": {"main": []}}  # main 类型错
r = load_document(bad_doc)
check("非法文档 load ok=False 不修复", r["ok"] is False and "document" not in r)
check("非法文档带 errors", len(r.get("errors", [])) > 0)

print("\n结果: %d PASS / %d FAIL" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
