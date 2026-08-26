"""AST 隔离回归：remove_segment 的 count 字段语义（修复占位 -1）。

main.py 无法直接 import（依赖 pyJianYingDraft/pywebview/ffmpeg），
故用 AST 抽取真实源码 exec 进 ns，stub 掉外部依赖，仅验证 count 逻辑。

验证点：
- segid 分支（特效常用）：删除后 count = 该轨剩余段数（含删到空=0）
- track_tid 分支：count = 剩余段数
- index 分支：count = 剩余段数
- 空轨自动折叠（_collapse_empty_tracks）
"""
import ast
import copy
import sys

SRC = open(r"C:\Users\34450\Desktop\ai-video-studio\main.py", encoding="utf-8").read()
TREE = ast.parse(SRC)


def grab(name):
    for n in ast.walk(TREE):
        if isinstance(n, ast.FunctionDef) and n.name == name:
            return ast.get_source_segment(SRC, n)
    raise RuntimeError("not found: " + name)


# ---- stub / 真实辅助 ----
def save_state(state):
    return True


def _track_by_tid(draft, tid):
    for i, tr in enumerate(draft.get("overlay", [])):
        if isinstance(tr, dict) and tr.get("tid") == tid:
            return (tr.get("type"), i, tr.get("segs"))
    return None


def _track_segs(draft, tt, ti):
    ov = draft.get("overlay", [])
    if 0 <= ti < len(ov) and ov[ti].get("type") == tt:
        return ov[ti].get("segs")
    return None


def _collapse_empty_tracks(draft):
    ov = draft.get("overlay", [])
    draft["overlay"] = [tr for tr in ov if tr.get("segs")]


ns = {
    "save_state": save_state,
    "_track_by_tid": _track_by_tid,
    "_track_segs": _track_segs,
    "_collapse_empty_tracks": _collapse_empty_tracks,
    "copy": copy,
}
# 真实源码：被改过的两个函数 + remove_segment
for fn in ("_seg_by_id", "_pop_seg_by_ref", "remove_segment"):
    exec(grab(fn), ns)


class T:
    def __init__(self, draft):
        self.state = {"draft": draft}
        self.draft = self.state["draft"]

    def _reload(self):
        self.draft = self.state["draft"]

    def _push_undo(self):
        pass


T.remove_segment = ns["remove_segment"]


def mk_draft():
    """video 轨 1 段 + effect 轨 2 段。"""
    return {
        "overlay": [
            {"type": "video", "tid": "vid0", "segs": [{"id": "v0", "type": "video"}]},
            {"type": "effect", "tid": "eff0", "segs": [
                {"id": "e0", "type": "effect", "effect_type": "blur"},
                {"id": "e1", "type": "effect", "effect_type": "brightness"},
            ]},
        ]
    }


def test_segid_branch_count():
    d = mk_draft()
    api = T(d)
    r = api.remove_segment("effect", 0, 0, segid="e0")
    assert r["ok"] is True, r
    assert r["removed"]["id"] == "e0", r
    assert r["count"] == 1, f"删 1 后该轨应剩 1 段, got {r['count']}"
    assert [s["id"] for s in d["overlay"][1]["segs"]] == ["e1"]


def test_segid_branch_last_remaining_count_zero():
    d = {
        "overlay": [
            {"type": "effect", "tid": "eff0", "segs": [
                {"id": "e0", "type": "effect", "effect_type": "blur"},
            ]},
        ]
    }
    api = T(d)
    r = api.remove_segment("effect", 0, 0, segid="e0")
    assert r["ok"] is True
    assert r["count"] == 0, f"删空后 count 应为 0, got {r['count']}"
    # 空轨被折叠
    assert d["overlay"] == [], f"空轨应被折叠, got {d['overlay']}"


def test_segid_not_found():
    d = mk_draft()
    api = T(d)
    r = api.remove_segment("effect", 0, 0, segid="nope")
    assert r["ok"] is False, r
    assert "未找到段" in r["error"], r


def test_track_tid_branch_count():
    d = mk_draft()
    api = T(d)
    r = api.remove_segment("effect", 0, 0, track_tid="eff0")
    assert r["ok"] is True
    assert r["removed"]["id"] == "e0", r
    assert r["count"] == 1, f"track_tid 删 1 后应剩 1, got {r['count']}"


def test_index_branch_count():
    d = mk_draft()
    api = T(d)
    r = api.remove_segment("effect", 1, 1)  # overlay[1]=effect 轨, index=1=e1
    assert r["ok"] is True
    assert r["removed"]["id"] == "e1", r
    assert r["count"] == 1, f"index 删 1 后应剩 1, got {r['count']}"
    assert [s["id"] for s in d["overlay"][1]["segs"]] == ["e0"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
