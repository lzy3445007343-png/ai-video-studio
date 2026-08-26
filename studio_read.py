"""
AI剪辑工作台 —— 细粒度读取模块（agent 理解草稿的"眼睛"）

设计背景：
- 原 get_state() 把整个 draft_state.json（~100KB）一次性甩给 agent，等于黑盒：
  agent 要么读不全（爆窗口），要么被迫吞下无关信息。
- 本模块提供"按需抽小数据"的纯函数：轨道排布 / 字幕 / 单段详情 / 特效 / 波形包络。
- 每个函数只返回几百~几千字符的聚焦数据，对应 8-12 定的「跳切读取铁律」
  （绝不直接把整份草稿丢给 agent）。

所有函数只读共享文件 draft_state.json，与 main.Api 写同一份状态，不会分叉。
本模块不依赖 MCP 启动，可独立 import 测试（mcp_server.py 导入后包成 tool）。

[1e 迁移，2026-08-23] 读取层从旧模型（draft.video/audio/text/... 为 list[list]）
改为 X 模型（draft.main.segs + draft.overlay[].segs + draft.audio[].segs）。
overlay 每条轨带 type（text/sticker/image/video），main 为单一主视频轨，
audio 为音频轨列表。迁移后 list_tracks/get_track_text/get_segment_detail/
get_segment_peaks 都能读到正确数据（验收点见 09 方案 M1-1e）。
"""
import os
import json
import subprocess
import tempfile
import wave
import array

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "draft_state.json")
US = 1_000_000  # 1 秒 = 1_000_000 微秒


# ---------------------------------------------------------------------------
# X 模型读取辅助
# ---------------------------------------------------------------------------
def _main_segs(draft):
    """主视频轨的段列表（draft.main.segs）。"""
    m = draft.get("main")
    if isinstance(m, dict):
        return m.get("segs", []) or []
    return []


def _overlay_tracks(draft):
    ov = draft.get("overlay")
    return ov if isinstance(ov, list) else []


def _audio_tracks(draft):
    au = draft.get("audio")
    return au if isinstance(au, list) else []


def _overlay_by_type(draft, ttype):
    """overlay 中指定 type 的轨列表（text/sticker/image/video）。"""
    return [tr for tr in _overlay_tracks(draft) if isinstance(tr, dict) and tr.get("type") == ttype]


def _resolve_segs(draft, track_type, track_index):
    """按 (track_type, track_index) 解析出段列表；不存在返回 None。

    约定（与 list_tracks 完全对应）：
      - "video"/"main"：track_index==0 → 主视频轨；否则 → overlay 中的 video 轨（PiP）。
      - "audio"：audio 列表下标。
      - "text"/"sticker"/"image"：overlay 中该 type 的第 track_index 条轨。
    """
    if track_type in ("video", "main"):
        if track_index == 0:
            return _main_segs(draft)
        vids = _overlay_by_type(draft, "video")
        if 0 <= track_index - 1 < len(vids):
            return vids[track_index - 1].get("segs", []) or []
        return None
    if track_type == "audio":
        au = _audio_tracks(draft)
        if 0 <= track_index < len(au):
            return au[track_index].get("segs", []) or []
        return None
    ov = _overlay_by_type(draft, track_type)
    if 0 <= track_index < len(ov):
        return ov[track_index].get("segs", []) or []
    return None


def _track_block(ttype, ti, segs):
    """把一段段列表压成紧凑的轨道块（位置/时长/素材引用）。"""
    total = 0
    rows = []
    for si, seg in enumerate(segs):
        if not isinstance(seg, dict):
            continue
        dur = seg.get("duration", 0)
        total += dur
        row = {
            "idx": si,
            "name": seg.get("name", ""),
            "start_us": seg.get("start", 0),
            "dur_us": dur,
            "material_id": seg.get("material_id", ""),
        }
        if ttype == "text":
            row["text"] = seg.get("text", "")
        rows.append(row)
    return {
        "track_index": ti,
        "type": ttype,
        "seg_count": len(rows),
        "total_dur_us": total,
        "segments": rows,
    }


def load_state():
    """读取共享草稿状态（与 main.Api.get_state 同一文件）。"""
    if not os.path.exists(STATE_PATH):
        return {"draft": {"main": {"segs": []}, "overlay": [], "audio": [{"segs": []}]},
                "materials": []}
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# 1) 轨道排布 —— agent 理解"时间轴怎么回事"的主视图
# ---------------------------------------------------------------------------
def list_tracks(state=None):
    """紧凑的轨道布局：每种类型下每条轨道的片段清单（位置/时长/素材引用）。
    不返回素材二进制、不返回全量 JSON，体量约几 KB。

    [1e] 输出按 X 模型分组：video(主轨+overlay video) / audio / text / sticker / image，
    每个分组内 track_index 与 get_segment_detail / get_track_text 的解析完全一致。
    """
    state = state or load_state()
    dr = state.get("draft", {})
    out = {}
    # 主视频轨（track_index 0）
    out["video"] = [_track_block("video", 0, _main_segs(dr))]
    # overlay 中的 video（PiP）接在主轨之后，track_index 顺延
    for ti, tr in enumerate(_overlay_by_type(dr, "video")):
        out["video"].append(_track_block("video", ti + 1, tr.get("segs", []) or []))
    # 音频轨
    out["audio"] = [_track_block("audio", ti, tr.get("segs", []) or [])
                    for ti, tr in enumerate(_audio_tracks(dr))]
    # overlay 按 type 分组
    for ttype in ("text", "sticker", "image"):
        blocks = [_track_block(ttype, ti, tr.get("segs", []) or [])
                  for ti, tr in enumerate(_overlay_by_type(dr, ttype))]
        if blocks:
            out[ttype] = blocks
    return out


# ---------------------------------------------------------------------------
# 2) 字幕 / 文本轨内容
# ---------------------------------------------------------------------------
def get_track_text(track_index, state=None):
    """返回某条文本轨上每段字幕：{idx, start_us, dur_us, text}。
    字幕类 skill（自动加花字/校字幕）直接吃这个，不用读全量。

    [1e] 文本轨在 X 模型中 = overlay 中 type=="text" 的轨；track_index 为该类型内的下标。
    """
    state = state or load_state()
    segs = _resolve_segs(state.get("draft", {}), "text", track_index)
    if segs is None:
        return {"error": f"text track {track_index} 不存在"}
    out = []
    for si, seg in enumerate(segs):
        if not isinstance(seg, dict):
            continue
        out.append({
            "idx": si,
            "start_us": seg.get("start", 0),
            "dur_us": seg.get("duration", 0),
            "text": seg.get("text", ""),
        })
    return out


# ---------------------------------------------------------------------------
# 3) 单段详情 —— agent 理解"这一段是什么、特效放哪"的聚焦视图
# ---------------------------------------------------------------------------
def get_segment_detail(track_type, track_index, index, state=None):
    """返回单个片段的完整但聚焦信息：时间轴位置、源素材入出点、关联素材元数据、
    以及落在它身上的特效（若 effect 模型支持）。对应"特效怎么放"的查询。

    [1e] track_type ∈ {video, main, audio, text, sticker, image}，按 _resolve_segs 解析。
    """
    state = state or load_state()
    dr = state.get("draft", {})
    segs = _resolve_segs(dr, track_type, track_index)
    if segs is None:
        return {"error": f"{track_type} track {track_index} 不存在"}
    if index >= len(segs):
        return {"error": f"第 {track_index} 轨第 {index} 段不存在（共 {len(segs)} 段）"}
    seg = segs[index]

    # 关联素材
    mid = seg.get("material_id", "")
    mat = None
    for m in state.get("materials", []):
        if isinstance(m, dict) and (m.get("uid") == mid or m.get("path") == seg.get("path")):
            mat = {k: m[k] for k in ("name", "type", "size", "path", "thumbnail") if k in m}
            break

    # 落在这一段上的特效（effect 模型为空时返回空列表，不报错）
    effects_on_seg = _effects_on_segment(state, track_type, track_index, index)

    return {
        "track_type": track_type,
        "track_index": track_index,
        "index": index,
        "name": seg.get("name"),
        "type": seg.get("type"),
        "timeline_start_us": seg.get("start"),
        "duration_us": seg.get("duration"),
        "src_start_us": seg.get("src_start"),
        "src_end_us": seg.get("src_end"),
        "material_id": mid,
        "path": seg.get("path"),
        "text": seg.get("text") if track_type == "text" else None,
        "material": mat,
        "effects": effects_on_seg,
    }


def _effects_on_segment(state, track_type, track_index, index):
    """从 draft.overlay[type=effect] 轨道筛出作用于该段的特效。

    与 get_effects / _track_segs / export / renderer 同源访问（单一真源 effects.json + overlay 轨道），
    不再读已废弃的 draft.effect 死路径。
    - target.type=="adjustment"：调整层，盖整栈 → 命中所有段。
    - target.type=="clip"：按 target.track/ti 绑定到具体段（si 同源）。"""
    draft = state.get("draft", {})
    out = []
    for tr in draft.get("overlay", []):
        if not (isinstance(tr, dict) and tr.get("type") == "effect"):
            continue
        for e in tr.get("segs", []):
            if not isinstance(e, dict):
                continue
            tgt = e.get("target") or {}
            ttype = tgt.get("type")
            if ttype == "adjustment":
                out.append(e)
            elif ttype == "clip":
                if tgt.get("track") == track_index and tgt.get("ti") == index:
                    out.append(e)
    return out


def get_effects(state=None):
    """返回所有已放置特效（紧凑）。agent 查"现在挂了哪些特效"用这个。

    单一真源：遍历 draft.overlay 中 type=="effect" 的轨道，收集其 segs
    （与 _track_segs / export / renderer 同源访问，不再读已废弃的 draft.effect 死路径）。
    每个段附带 _track 字段标明所属特效轨序号，便于 AI 审计/定位。"""
    state = state or load_state()
    draft = state.get("draft", {})
    out = []
    for ti, tr in enumerate(draft.get("overlay", [])):
        if isinstance(tr, dict) and tr.get("type") == "effect":
            for s in tr.get("segs", []):
                if isinstance(s, dict):
                    s = dict(s)
                    s["_track"] = ti
                    out.append(s)
    return out


# ---------------------------------------------------------------------------
# 4) 波形包络 —— 跳切 / 静音检测 / 情绪踩点 skill 的输入
# ---------------------------------------------------------------------------
def _extract_audio_wav(path, start_us, dur_us, sr=8000):
    """用 ffmpeg 抽出指定时间范围的单声道 8k wav，返回临时文件路径（调用方负责清理）。"""
    tmp = tempfile.mktemp(suffix=".wav")
    cmd = ["ffmpeg", "-y", "-ss", f"{start_us / US:.6f}", "-i", path]
    if dur_us and dur_us > 0:
        cmd += ["-t", f"{dur_us / US:.6f}"]
    cmd += ["-ac", "1", "-ar", str(sr), "-f", "wav", tmp]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=120)
    except Exception:
        return None
    return tmp if os.path.exists(tmp) and os.path.getsize(tmp) > 0 else None


def _wav_to_peaks(wav_path, max_points=240):
    """读 wav，按 max_points 个桶计算 RMS 包络，归一化到 0~1。无音频返回空列表。"""
    try:
        w = wave.open(wav_path, "rb")
        n = w.getnframes()
        raw = w.readframes(n)
        w.close()
    except Exception:
        return []
    if not raw:
        return []
    samples = array.array("h")
    try:
        samples.frombytes(raw)
    except Exception:
        return []
    if not samples:
        return []
    total = len(samples)
    bucket = max(1, total // max_points)
    peaks = []
    for i in range(0, total, bucket):
        chunk = samples[i:i + bucket]
        if chunk:
            rms = (sum(x * x for x in chunk) / len(chunk)) ** 0.5
            peaks.append(rms)
    if not peaks:
        return []
    mx = max(peaks)
    if mx > 0:
        peaks = [p / mx for p in peaks]
    return [round(p, 3) for p in peaks]


def get_material_peaks(path, max_points=240):
    """素材级波形包络（整段）。跳切 skill 判断"哪里该剪"用。
    path 可为视频（取音轨）或音频。
    返回 dict：{peaks: 归一化RMS列表, has_audio: 是否有音轨, points: 点数}。
    无音频时 peaks=[] 且 has_audio=false（如纯 B-roll 静音片段），便于 agent 区分。"""
    if not path or not os.path.exists(path):
        return {"peaks": [], "has_audio": False, "points": 0, "error": f"文件不存在: {path}"}
    wav = _extract_audio_wav(path, 0, 0, sr=8000)
    if not wav:
        return {"peaks": [], "has_audio": False, "points": 0}
    try:
        pk = _wav_to_peaks(wav, max_points)
        return {"peaks": pk, "has_audio": bool(pk), "points": len(pk)}
    finally:
        try:
            os.remove(wav)
        except Exception:
            pass


def get_segment_peaks(track_type, track_index, index, max_points=240, state=None):
    """片段级波形包络：抽出该段 src_start~src_start+duration 的音频做包络。
    对应 8-12 铁律的 get_segment_peaks(track_type,ti,idx)。
    返回 dict：{peaks, has_audio, points}，语义同 get_material_peaks。

    [1e] 用 _resolve_segs 按 X 模型解析段（不再用旧的 draft[track_type][ti][idx]）。
    """
    state = state or load_state()
    segs = _resolve_segs(state.get("draft", {}), track_type, track_index)
    if segs is None or index >= len(segs):
        return {"peaks": [], "has_audio": False, "points": 0,
                "error": f"{track_type} 轨{track_index} 段{index} 不存在"}
    seg = segs[index]
    path = seg.get("path")
    src_start = seg.get("src_start", 0)
    dur = seg.get("duration", 0)
    if not path or not os.path.exists(path):
        return {"peaks": [], "has_audio": False, "points": 0, "error": f"片段源文件不存在: {path}"}
    wav = _extract_audio_wav(path, src_start, dur, sr=8000)
    if not wav:
        return {"peaks": [], "has_audio": False, "points": 0}
    try:
        pk = _wav_to_peaks(wav, max_points)
        return {"peaks": pk, "has_audio": bool(pk), "points": len(pk)}
    finally:
        try:
            os.remove(wav)
        except Exception:
            pass


if __name__ == "__main__":
    import sys
    s = load_state()
    print("list_tracks:", json.dumps(list_tracks(s), ensure_ascii=False)[:800])
    print("get_track_text(0):", get_track_text(0, s))
    print("get_segment_detail(video,0,0):", json.dumps(get_segment_detail("video", 0, 0, s), ensure_ascii=False)[:400])
