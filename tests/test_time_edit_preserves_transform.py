"""时间轴编辑隔离回归：移动/换轨只改时间与轨道，绝不改变变换或关键帧。"""
import ast
import copy
import sys

SRC = open("main.py", encoding="utf-8").read()
TREE = ast.parse(SRC)


def grab(name):
    for node in ast.walk(TREE):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(SRC, node)
    raise RuntimeError("not found: " + name)


def _track_by_tid(draft, tid):
    if tid == "main":
        return "video", 0, draft["main"]["segs"]
    for index, track in enumerate(draft.get("overlay", []), start=1):
        if track.get("tid") == tid:
            return track.get("type"), index, track["segs"]
    return None


def _track_segs(draft, track_type, track_index):
    if track_type == "video" and track_index == 0:
        return draft["main"]["segs"]
    for track in draft.get("overlay", []):
        if track.get("type") == track_type:
            return track["segs"]
    return None


def _segments_overlap(a, b):
    return not (a["start"] + a["duration"] <= b["start"] or a["start"] >= b["start"] + b["duration"])


def _free_start_on_track(segs, desired, duration, exclude_index=None):
    for index, seg in enumerate(segs):
        if index != exclude_index and _segments_overlap({"start": desired, "duration": duration}, seg):
            return seg["start"] + seg["duration"]
    return desired


def _clear_persistent_if_needed(*_args):
    pass


def _collapse_empty_tracks(_draft):
    pass


def _locate_seg(_draft, _seg):
    return "video", 1, 0


NS = {
    "copy": copy,
    "save_state": lambda _state: True,
    "_track_by_tid": _track_by_tid,
    "_track_segs": _track_segs,
    "_segments_overlap": _segments_overlap,
    "_free_start_on_track": _free_start_on_track,
    "_clear_persistent_if_needed": _clear_persistent_if_needed,
    "_collapse_empty_tracks": _collapse_empty_tracks,
    "_locate_seg": _locate_seg,
}
for NAME in ("_seg_by_id", "move_segment", "relocate_segment"):
    exec(compile(grab(NAME), "<ast:%s>" % NAME, "exec"), NS)


class ApiStub:
    def __init__(self, draft):
        self.draft = draft
        self.state = {"draft": draft}

    def _reload(self):
        pass

    def _push_undo(self):
        pass


ApiStub.move_segment = NS["move_segment"]
ApiStub.relocate_segment = NS["relocate_segment"]


def draft_with_animated_seg():
    seg = {
        "id": "clip", "type": "video", "start": 1_000_000, "duration": 3_000_000,
        "transform": {"x": 120, "y": -80, "scaleX": 1.2, "scaleY": 0.9, "rotation": 15},
        "params": {"transform": {"positionX": 120, "positionY": -80, "scaleX": 1.2}},
        "animations": {
            "transform.positionX": {"keys": [{"id": "x0", "t": 0, "v": 120}, {"id": "x1", "t": 1_000_000, "v": 400}]},
            "transform.positionY": {"keys": [{"id": "y0", "t": 0, "v": -80}, {"id": "y1", "t": 1_000_000, "v": 40}]},
        },
    }
    return {"main": {"tid": "main", "segs": [seg]}, "overlay": [{"type": "video", "tid": "target", "segs": []}], "audio": []}


def transform_snapshot(seg):
    return copy.deepcopy({key: seg.get(key) for key in ("transform", "params", "animations")})


def test_move_preserves_transform_and_keyframes():
    draft = draft_with_animated_seg()
    api = ApiStub(draft)
    before = transform_snapshot(draft["main"]["segs"][0])
    result = api.move_segment("video", 0, 0, 2_000_000, segid="clip")
    assert result["ok"], result
    seg = draft["main"]["segs"][0]
    assert seg["start"] == 2_000_000
    assert transform_snapshot(seg) == before


def test_relocate_preserves_transform_and_keyframes():
    draft = draft_with_animated_seg()
    api = ApiStub(draft)
    before = transform_snapshot(draft["main"]["segs"][0])
    result = api.relocate_segment("video", 0, 0, 1, 2_000_000, segid="clip", to_track_tid="target")
    assert result["ok"], result
    seg = draft["overlay"][0]["segs"][0]
    assert seg["start"] == 2_000_000
    assert transform_snapshot(seg) == before


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    failures = 0
    for test in tests:
        try:
            test()
            print("PASS", test.__name__)
        except Exception as error:
            failures += 1
            print("FAIL", test.__name__ + ":", error)
    print("%d/%d passed" % (len(tests) - failures, len(tests)))
    sys.exit(1 if failures else 0)
