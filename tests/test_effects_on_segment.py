"""
回归测试：特效绑定查询（#513 续 — Step5 单段详情 seg_id 对齐）

背景：
- #513 修了 get_effects 读 draft.effect 死路径（全局盘点生效）。
- 黑盒测试发现 Step5 断裂：用 target.seg_id 姿势挂的特效，
  get_segment_detail().effects 永远返回空 —— 因为 _effects_on_segment 只认 track/ti，不认 seg_id。
- 本测试验证：_effects_on_segment / get_segment_detail 同时支持
  (a) 历史 track/ti 姿势 与 (b) 09 M1-1b seg_id 稳定段 id 姿势，且不串段。

运行：python tests/test_effects_on_segment.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import studio_read as sr  # noqa: E402


def build_craft():
    return {
        "draft": {
            "overlay": [
                {"type": "video", "tid": "vid0", "segs": [
                    {"id": "seg_v1", "type": "video", "material_id": "m_vid",
                     "start": 0, "duration": 5000000},
                ]},
                {"type": "text", "tid": "txt0", "segs": [
                    {"id": "seg_t1", "type": "text", "material_id": "m_txt",
                     "start": 0, "duration": 3000000},
                ]},
                {"type": "effect", "tid": "eff0", "segs": [
                    {"id": "eff_adj", "type": "effect", "effect_type": "blur",
                     "target": {"type": "adjustment"}, "params": {"radius": 8}},
                    {"id": "eff_segid", "type": "effect", "effect_type": "brightness",
                     "target": {"type": "clip", "seg_id": "seg_v1"}, "params": {"amount": 0.3}},
                    {"id": "eff_ti", "type": "effect", "effect_type": "contrast",
                     "target": {"type": "clip", "track": 1, "ti": 0}, "params": {"amount": 0.2}},
                ]},
            ],
            "materials": [
                {"uid": "m_vid", "name": "v.mp4", "type": "video"},
                {"uid": "m_txt", "name": "t.txt", "type": "text"},
            ],
        }
    }


def test_segid_binding_on_correct_segment():
    """video 轨第 0 段(seg_v1) 应命中 adjustment + seg_id 绑定特效 + track/ti 绑定特效。"""
    d = sr.get_segment_detail("video", 1, 0, build_craft())
    ids = [e["id"] for e in d["effects"]]
    # eff_adj(adjustment 盖整栈) + eff_segid(seg_id=seg_v1) + eff_ti(track1/ti0=video 段)
    assert set(ids) == {"eff_adj", "eff_segid", "eff_ti"}, f"video 段应命中 adj+segid+ti, got {ids}"


def test_segid_does_not_leak_to_other_segment():
    """text 轨第 0 段(seg_t1) 不应命中绑在 seg_v1 的特效（seg_id 不串段）。"""
    t = sr.get_segment_detail("text", 0, 0, build_craft())
    ids = [e["id"] for e in t["effects"]]
    assert ids == ["eff_adj"], f"text 段只该命中 adj, got {ids}"
    # 关键：seg_id=seg_v1 的特效绝不应出现在 text 段
    assert "eff_segid" not in ids


def test_track_ti_binding_still_works():
    """历史 track/ti 姿势仍生效。eff_ti 绑 track1/ti0 = video 轨第 0 段。"""
    d = sr.get_segment_detail("video", 1, 0, build_craft())
    ids = [e["id"] for e in d["effects"]]
    assert "eff_ti" in ids, f"track/ti 绑定应仍生效, got {ids}"


def test_get_effects_unchanged():
    """#513 全局盘点不受本次改动影响。"""
    all_eff = sr.get_effects(build_craft())
    assert len(all_eff) == 3
    assert all("_track" in e for e in all_eff)


if __name__ == "__main__":
    test_segid_binding_on_correct_segment()
    test_segid_does_not_leak_to_other_segment()
    test_track_ti_binding_still_works()
    test_get_effects_unchanged()
    print("test_effects_on_segment: ALL PASSED ✅")
