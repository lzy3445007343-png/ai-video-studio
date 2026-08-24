# -*- coding: utf-8 -*-
"""
M6-6a Document Protocol v1 —— VideoDocument 唯一事实来源的协议定义与三态校验。

设计（对齐 09 方案 M6 6a，2026-08-24 落码）：
- VideoDocument = 现有 draft_state.json 结构的协议化定义，**不推倒重来，迁移层透明**。
  顶层结构（对齐 main.py load_state 的 empty 与 migrate 产出）：
      {
        "materials": [...],                          # 素材资产列表
        "draft": {                                   # 时间轴（timeline 语义）
            "overlay": [{"type": ..., "segs": [...]}, ...],   # 混排池（0=最顶）
            "main":    {"segs": [...]},                        # 主场景（恒定，video/image）
            "audio":   [{"segs": [...]}, ...],                # 音轨
            "canvas":  {"ratio": "16:9", "locked": False},    # 画布
            "_track_meta": {"overlay": [], "main": {}, "audio": [{}]},
        },
        "version": 0, "schemaVersion": 1, "domain_version": 0,
        "metadata": {"name": ..., "created_at": ..., "updated_at": ...},   # v1 新增（预留，缺省补空）
        # 预留段（v1 不落实现，仅保留命名空间）：plugins / extensions / animation
      }
- 三态校验 validate_document(raw) -> {ok, errors, warnings, repaired}：
    errors    不可修复的结构错误 —— 调用方不得落盘（09 验收①：非法返回 errors 不静默修复）
    warnings  可运行但有隐患（未知段类型、缺省自动补等）
    repaired  可自动修复的缺省（路径式补丁 + segments 级补丁，由 load_document 应用）
- load_document(raw) = validate + 应用 repaired，返回可直接运行的 state。
- 纯函数模块：不读写文件、不依赖 main.py（migrate/乐观锁/落盘由 main.py 调用方集成）。

字段事实（对齐 main.py add_to_timeline 真实 seg 构造，2026-08-24 grep 确认）：
  seg = {id, name, path, type, start(us), duration(us), src_start, src_end,
         src_full, speed, change_pitch, animations, material_id?, has_audio?}
  注意：seg 用 start/duration，不是 timeline_start/timeline_duration（别被旧文档误导）。
"""

DOCUMENT_SCHEMA_VERSION = 1

# 允许的段类型（对齐 TYPE_TRACK / 前端 mtype）
SEG_TYPES = {"video", "image", "audio", "text", "sticker", "effect"}

# 段必填字段（v1：缺这些 = 不可修复错误）
SEG_REQUIRED = ("id", "type", "start", "duration")

# 轨道容器要求：(key, 默认值, 期望类型)。默认值与 main.py load_state empty 一致。
_TRACK_CONTAINERS = (
    ("overlay", [], "list"),
    ("main", {"segs": []}, "dict"),
    ("audio", [{"segs": []}], "list"),
    ("canvas", {"ratio": "16:9", "locked": False}, "dict"),
    ("_track_meta", {"overlay": [], "main": {}, "audio": [{}]}, "dict"),
)


def _iter_segs(draft):
    """遍历 draft 全部段（overlay 各轨 + main + audio 各轨），对齐 _iter_all_segs。"""
    if not isinstance(draft, dict):
        return
    for t in draft.get("overlay", []) or []:
        if isinstance(t, dict):
            for s in t.get("segs", []) or []:
                yield s
    m = draft.get("main")
    if isinstance(m, dict):
        for s in m.get("segs", []) or []:
            yield s
    for t in draft.get("audio", []) or []:
        if isinstance(t, dict):
            for s in t.get("segs", []) or []:
                yield s


def validate_document(raw):
    """三态校验：{ok, errors, warnings, repaired}。只读不改 raw。

    repaired 格式：
      {"draft.overlay": [...], "draft.main": {...}, ...}   轨道级路径补丁
      {"segments": {seg_id: {"animations": {}}, ...}}      seg 级补丁（按 id 应用）
    """
    errors, warnings = [], []
    repaired = {}

    if not isinstance(raw, dict):
        return {"ok": False,
                "errors": ["文档必须是 JSON 对象（收到 %s）" % type(raw).__name__],
                "warnings": [], "repaired": {}}

    # ---- 顶层 ----
    if not isinstance(raw.get("materials"), list):
        errors.append("materials 必须是数组")
    if not isinstance(raw.get("draft"), dict):
        errors.append("draft 必须是对象")
        return {"ok": False, "errors": errors, "warnings": warnings, "repaired": repaired}

    # ---- 轨道容器 ----
    draft = raw["draft"]
    for key, default, kind in _TRACK_CONTAINERS:
        v = draft.get(key)
        if v is None:
            repaired["draft." + key] = default
            warnings.append("draft.%s 缺失，loadDocument 将补默认" % key)
        elif kind == "list" and not isinstance(v, list):
            errors.append("draft.%s 必须是数组" % key)
        elif kind == "dict" and not isinstance(v, dict):
            errors.append("draft.%s 必须是对象" % key)

    # ---- seg 级 ----
    seg_fixes = {}
    for i, seg in enumerate(_iter_segs(draft)):
        if not isinstance(seg, dict):
            errors.append("第 %d 个段不是对象" % i)
            continue
        sid = seg.get("id", "?")
        for f in SEG_REQUIRED:
            if f not in seg or seg[f] is None:
                errors.append("段(id=%s) 缺少必填字段 %s" % (sid, f))
        st = seg.get("type")
        if st not in SEG_TYPES:
            warnings.append("段(id=%s) 未知类型 %r（loadDocument 不拦，导出可能异常）" % (sid, st))
        dur = seg.get("duration")
        if not isinstance(dur, (int, float)) or dur <= 0:
            errors.append("段(id=%s) duration 必须为正数，收到 %r" % (sid, dur))
        if "animations" not in seg or not isinstance(seg.get("animations"), dict):
            seg_fixes[sid] = {"animations": {}}

    if seg_fixes:
        repaired["segments"] = seg_fixes
        warnings.append("部分段缺 animations 字段，loadDocument 将补空对象")

    return {"ok": len(errors) == 0, "errors": errors,
            "warnings": warnings, "repaired": repaired}


def load_document(raw):
    """validate + 应用 repaired，返回可直接运行的 state。

    返回 {"ok": True, "document": state, "warnings": [...], "repaired": {...}}
      或 {"ok": False, "errors": [...], "warnings": [...]}（不修复、不落盘）。
    只 setdefault（不覆盖已有值），保证零丢失。
    """
    import copy as _copy

    doc = _copy.deepcopy(raw)
    vres = validate_document(doc)
    if vres["errors"]:
        return {"ok": False, "errors": vres["errors"], "warnings": vres["warnings"]}

    draft = doc.get("draft") if isinstance(doc, dict) else None
    for path, default in vres["repaired"].items():
        if path.startswith("draft.") and isinstance(draft, dict):
            key = path.split(".", 1)[1]
            if draft.get(key) is None:
                draft[key] = default

    for sid, fix in (vres["repaired"].get("segments") or {}).items():
        for seg in _iter_segs(draft):
            if seg.get("id") == sid:
                for k, v in fix.items():
                    seg.setdefault(k, v)

    doc.setdefault("schemaVersion", DOCUMENT_SCHEMA_VERSION)
    doc.setdefault("version", 0)
    doc.setdefault("domain_version", 0)
    doc.setdefault("metadata", {})
    return {"ok": True, "document": doc,
            "warnings": vres["warnings"], "repaired": vres["repaired"]}
