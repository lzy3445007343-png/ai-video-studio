"""
AI剪辑工作台 v0.1 —— 桌面窗口 + 原子能力（逐步接入）
技术：PyWebView（纯 Python，系统原生 WebView 窗口）
架构：前端 HTML 负责显示与交互；Python 负责"干实事"（文件对话框、复制素材、将来写剪映草稿）。
      前端通过 window.pywebview.api.<方法>() 调用这里的 Python 函数——这就是将来 MCP 能力的同构雏形
      （一个方法 = 一个原子能力，将来只需在外面套一层 MCP server 即可被外部 Agent 驱动，不返工）。

当前已接入：导入素材、拖放导入、双击进轨（add_to_timeline 真实登记进草稿状态，音视频用 ffprobe 读真实时长）、
导出草稿（弹框选路径+填名 → export_draft 用 pyJianYingDraft 落盘成标准剪映草稿文件夹，并自动记住默认导出路径）
后续：MCP server（把原子能力暴露给 WorkBuddy 驱动）、Skill 落地（口播精剪等）

说明：
- 真实时长：音视频用系统 ffprobe 读取真实时长落盘；没装 ffmpeg 时回退占位时长并提示安装。
- 默认导出路径：存于项目根目录 settings.json（已在 .gitignore 忽略），用户导出一次后自动记住，下次弹框自动填入；想改路径手动选别的即可。
- PyWebView 原生拖放（WinForms 窗体 DragDrop）在 WebView2 下会被浏览器控件吞掉，不可靠；拖文件改用「网页层 ondrop 读 base64 → api.drop_files」方案。
"""
import os
import json
import copy
import base64
import hashlib
import shutil
import time
import uuid
import subprocess
import http.server
import socketserver
import threading
import tempfile
import re
# 写操作文件锁：防止桌面进程和 MCP 进程同时写 draft_state.json 导致数据互踩
try:
    import portalocker
    _HAS_LOCK = True
except ImportError:
    portalocker = None
    _HAS_LOCK = False
# pywebview 的导入名是 webview（不是 pywebview）。MCP server 进程不需要 GUI 窗口，
# 这里用容错导入：无窗口环境（如 AI 经 MCP 驱动）也能 import 本模块并调用底层原子能力。
try:
    import webview
except ImportError:
    webview = None

# 剪映草稿写入（pyJianYingDraft：生成原生 draft_content.json，不烤像素，剪映可直接打开）
from pyJianYingDraft import (
    DraftFolder, TrackSpec, TrackType,
    VideoSegment, AudioSegment, TextSegment, StickerSegment, Timerange, KeyframeProperty,
)
from pyJianYingDraft.segment import ClipSettings
from pyJianYingDraft.text_segment import TextStyle, TextBackground
from pyJianYingDraft.exceptions import SegmentOverlap

# 本文件所在目录
HERE = os.path.dirname(os.path.abspath(__file__))
# 界面原型 HTML（剪映式布局：左素材 / 中预览 / 右Skill库 / 底时间轴）
HTML_PATH = os.path.join(HERE, "工作台v0.8时间轴.html")
# 本地文件转成 file:// URI（Windows 路径反斜杠需换成斜杠）
FILE_URL = "file:///" + HTML_PATH.replace("\\", "/")

# ---------------------------------------------------------------------------
# 本地 HTTP 服务器：把项目目录（含 assets 素材）通过 http://127.0.0.1:PORT 暴露。
# WebView2 不允许 file:// 文档里的 <video>/<audio> 加载本地文件（安全上下文限制），
# 走 localhost HTTP 后视频/音频/图片都能正常加载，且支持 seek（Range 请求）。
# ---------------------------------------------------------------------------
ALLOWED_LOCAL_EXT = (".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".aac",
                     ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".json", ".srt")

class _SilentHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # 支持 Range 持久连接，避免视频缓冲中途断流卡顿
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)
    def log_message(self, format, *args):
        pass  # 关闭访问日志，保持控制台干净
    def do_GET(self):
        # /local/ 前缀：代理任意本地绝对路径（导入剪映工程时引用原素材，避免大文件复制占空间）
        if self.path.startswith("/local/"):
            import urllib.parse
            abs_path = urllib.parse.unquote(self.path[len("/local/"):])
            abs_path = os.path.normpath(abs_path)
            if os.path.isfile(abs_path) and abs_path.lower().endswith(ALLOWED_LOCAL_EXT):
                # 复用 SimpleHTTPRequestHandler 的 Range 能力：临时把服务目录切到文件父目录
                orig_dir = self.directory
                self.directory = os.path.dirname(abs_path)
                self.path = "/" + os.path.basename(abs_path)
                try:
                    super().do_GET()
                finally:
                    self.directory = orig_dir
                return
            self.send_error(403, "Forbidden path")
            return
        super().do_GET()

def _start_local_server(preferred=(8080, 8081, 8082, 8083, 8084, 8085)):
    """尝试绑定 preferred 端口，失败则随机选 8000-9000 内可用端口。"""
    class _ReusableTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        allow_reuse_port = True
    for port in preferred:
        try:
            srv = _ReusableTCPServer(("127.0.0.1", port), _SilentHTTPRequestHandler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            return srv, port
        except OSError:
            continue
    for port in range(8000, 9000):
        try:
            srv = _ReusableTCPServer(("127.0.0.1", port), _SilentHTTPRequestHandler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            return srv, port
        except OSError:
            continue
    raise RuntimeError("无法为本地媒体服务器找到可用端口")

_local_httpd, _LOCAL_PORT = _start_local_server()
LOCAL_BASE_URL = f"http://127.0.0.1:{_LOCAL_PORT}"
HTTP_URL = f"{LOCAL_BASE_URL}/工作台v0.8时间轴.html"

# 导入的素材统一复制到这里（相对项目，便于管理和将来写草稿时引用）
ASSETS_DIR = os.path.join(HERE, "assets")
# 用户设置（默认_export路径等）持久化文件
SETTINGS_PATH = os.path.join(HERE, "settings.json")
# MCP 连接状态文件：MCP server 被 agent 启动/连接后写入，桌面窗口据此显示真实状态（灰/绿 + agent 名）
MCP_STATE_PATH = os.path.join(HERE, "mcp_state.json")
# 草稿 + 素材共享状态文件：人和 AI/MCP 共用同一份「真相」，前端轮询刷新即可实时看到彼此的改动
STATE_PATH = os.path.join(HERE, "draft_state.json")

# 扩展名 → 素材类型（前端列表用不同颜色标签）
EXT_TYPE = {
    ".mp4": "video", ".mov": "video", ".avi": "video", ".mkv": "video",
    ".flv": "video", ".wmv": "video", ".webm": "video",
    ".mp3": "audio", ".wav": "audio", ".aac": "audio", ".m4a": "audio", ".flac": "audio",
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".bmp": "image",
    ".srt": "text", ".ass": "text", ".vtt": "text",
}

# 变速/重定时常量（对齐 OpenCut retime/rate.ts）
DEFAULT_SPEED = 1.0
MIN_SPEED = 0.01
MAX_SPEED = 5.0

# 贴纸默认变换（归一化坐标：x/y 以画布中心为 0，范围约 -1~1；scale 倍率；rotation 角度；opacity 0~1）
DEFAULT_STICKER_TRANSFORM = {
    "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0,
    "opacity": 1.0, "flipH": False, "flipV": False,
}
# 预览/导出时 scale=1 对应的画布高度占比（导出把此占比换算成 ClipSettings 真实缩放，保证预览≈导出）
STICKER_BASE_HEIGHT_RATIO = 0.4


def load_settings():
    """读取本地 settings.json，失败返回空字典。"""
    if not os.path.exists(SETTINGS_PATH):
        return {}
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(settings):
    """把设置写回 settings.json。"""
    try:
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def get_setting(key, default=None):
    return load_settings().get(key, default)


def set_setting(key, value):
    settings = load_settings()
    settings[key] = value
    return save_settings(settings)


# ---------------------------------------------------------------------------
# MCP 连接状态（左上角灰/绿指示 + agent 名字）
# ---------------------------------------------------------------------------
MCP_HEARTBEAT_TTL_MS = 10_000  # 超过 10 秒没收到心跳，就认为 MCP 已断开


def load_mcp_state():
    """读取 mcp_state.json，返回 {connected, agent_name, connected_at, transport, updated_at}。

    关键：不能只看文件里的 connected 字段——电脑关机/进程被杀/ agent 没启动时，
    文件可能还残留 true。这里加 TTL 心跳判断：最后一次更新在 10 秒内才算真连接，
    否则自动视为断开，避免"假绿色"。
    """
    empty = {"connected": False, "agent_name": "", "connected_at": None, "transport": "stdio", "updated_at": 0}
    if not os.path.exists(MCP_STATE_PATH):
        return empty
    try:
        with open(MCP_STATE_PATH, "r", encoding="utf-8") as f:
            s = json.load(f)
        for k, v in empty.items():
            s.setdefault(k, v)
        now = int(time.time() * 1000)
        if s.get("connected") and (now - s.get("updated_at", 0)) > MCP_HEARTBEAT_TTL_MS:
            s["connected"] = False
            s["agent_name"] = ""
        return s
    except Exception:
        return empty


def save_mcp_state(data):
    """把 MCP 连接状态写回 mcp_state.json，并打上 updated_at 时间戳。"""
    try:
        data["updated_at"] = int(time.time() * 1000)
        with open(MCP_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 草稿 + 素材 共享状态（人和 AI 共用同一份真相）
# ---------------------------------------------------------------------------
def _segments_overlap(a, b):
    """判断两个片段是否时间重叠（a、b 为 dict，含 start/duration，单位微秒）。"""
    a0, a1 = a["start"], a["start"] + a["duration"]
    b0, b1 = b["start"], b["start"] + b["duration"]
    return not (a1 <= b0 or a0 >= b1)


def _free_start_on_track(segs, desired, duration, exclude_index=None):
    """在一条轨道的片段列表里，找「不与任何片段重叠、且 >= desired」的最早起始时间。

    exclude_index：移动自身的片段在列表里的下标，判断重叠时跳过它。
    若 desired 处被占用，自动向右推到冲突片段的末尾，再检查；直到找到空位。
    返回微秒（>=0）。用于「落点重叠自动避让」：拖到被占的位置自动挪到最近空位。
    """
    desired = max(0, int(desired or 0))
    duration = int(duration or 0)
    for _ in range(len(segs) + 2):
        conflict = None
        for i, s in enumerate(segs):
            if i == exclude_index:
                continue
            s0, s1 = s["start"], s["start"] + s["duration"]
            if not (desired + duration <= s0 or desired >= s1):  # 重叠
                conflict = s
                break
        if conflict is None:
            return desired
        desired = conflict["start"] + conflict["duration"]  # 推到冲突片段末尾
    return desired


def _ensure_track(draft, track_type, index):
    """确保 draft 里 track_type 类型存在第 index 条轨道；不存在则补空轨。

    index == -1 表示「自动新建一条该类型轨道」，返回新建后的索引。
    同步维护 _track_meta，保证每个轨道都有元数据槽位。返回最终可用的轨道索引。
    """
    tracks = draft.setdefault(track_type, [[]])
    meta = _ensure_track_meta(draft, track_type)
    if index == -1:
        tracks.append([])
        meta.append({})
        return len(tracks) - 1
    while len(tracks) <= index:
        tracks.append([])
    while len(meta) < len(tracks):
        meta.append({})
    return index


def _insert_track(draft, track_type, insert_index):
    """在 draft[track_type] 的第 insert_index 个位置插入一条空轨道（拖到空隙在中间新建轨用）。

    同步维护 _track_meta。返回新轨道的索引（clamp 到 [0, len]）。video 列表索引即数据索引，
    render 反转渲染下，前端已按「上边界轨数据索引」换算好 insert_index，这里只负责插在正确位置。
    """
    tracks = draft.setdefault(track_type, [[]])
    meta = _ensure_track_meta(draft, track_type)
    if not tracks:
        tracks.append([])
    if not meta:
        meta.append({})
    ins = max(0, min(int(insert_index), len(tracks)))
    # 视频组保护：主轨永远在 video[0]，不允许插到它之上（会把主轨挤下去）
    if track_type == 'video':
        ins = max(1, ins)
    tracks.insert(ins, [])
    meta.insert(ins, {})
    return ins


def _ensure_track_meta(draft, track_type):
    """确保 draft 中存在 _track_meta 且对应 track_type 有列表。"""
    meta = draft.setdefault("_track_meta", {})
    return meta.setdefault(track_type, [])


def _set_track_persistent(draft, track_type, index, persistent=True):
    """标记/取消标记某条轨道为「显式创建的空轨」（即使为空也不自动折叠）。"""
    meta = _ensure_track_meta(draft, track_type)
    while len(meta) <= index:
        meta.append({})
    if persistent:
        meta[index]["persistent_empty"] = True
    elif "persistent_empty" in meta[index]:
        del meta[index]["persistent_empty"]


def _clear_persistent_if_needed(draft, track_type, index):
    """当某条轨道被放入片段时，取消它的 persistent_empty 标记（有素材自然保留）。"""
    meta = draft.get("_track_meta", {}).get(track_type, [])
    if 0 <= index < len(meta) and meta[index].get("persistent_empty"):
        del meta[index]["persistent_empty"]


def _remove_track_meta(draft, track_type, index):
    """删除 draft._track_meta 中指定轨道的元数据，并保持与轨道列表长度一致。"""
    meta = draft.get("_track_meta", {}).get(track_type)
    if not meta:
        return
    if 0 <= index < len(meta):
        meta.pop(index)


def _collapse_empty_tracks(draft):
    """移除空轨道（保持 list-of-list 不变量）。

    规则：有素材的轨保留，没素材的轨自动消失。用户不需要手动删轨。
    - 视频：保留主轨 video[0]（锚点，永远存在），移除其余为空的覆盖轨。
    - 音频 / 文本：移除为空的轨；若整组都空，保留一条空轨 [[]] 以免破坏结构。
    这样「片段被移走后留下的空轨会自动消失」，轨道数量始终由素材决定。
    """
    meta = draft.setdefault("_track_meta", {})
    v = draft.get("video", [[]])
    v_meta = meta.get("video", [])
    new_v = [v[0]]
    new_v_meta = [v_meta[0] if len(v_meta) > 0 else {}]
    for i in range(1, len(v)):
        if len(v[i]) > 0:
            new_v.append(v[i])
            new_v_meta.append(v_meta[i] if i < len(v_meta) else {})
    draft["video"] = new_v
    meta["video"] = new_v_meta

    for grp in ("audio", "text"):
        tracks = draft.get(grp, [[]])
        t_meta = meta.get(grp, [])
        new_tracks = []
        new_meta = []
        for i, t in enumerate(tracks):
            if len(t) > 0:
                new_tracks.append(t)
                new_meta.append(t_meta[i] if i < len(t_meta) else {})
        if not new_tracks:
            new_tracks = [[]]
            new_meta = [{}]
        draft[grp] = new_tracks
        meta[grp] = new_meta


def _distribute_to_tracks(segments):
    """把一组可能重叠的扁平片段，分配到多条同类型轨道，保证同轨内不重叠。

    采用按原序贪心 first-fit：先出现的片段优先放底层轨，后出现的重叠片段向上新增轨道。
    这样迁移后，原顺序中「后加」的片段会盖住「先加」的片段，符合直觉。
    """
    tracks = []
    for seg in segments:
        placed = False
        for track in tracks:
            if not any(_segments_overlap(seg, s) for s in track):
                track.append(seg)
                placed = True
                break
        if not placed:
            tracks.append([seg])
    return tracks


def load_state():
    """读取 draft_state.json。不存在/损坏返回空草稿。

    多轨模型：draft 的 video/audio/text 每个都是「轨道列表的列表」。
    video[0] = 主视频轨（不可删，最底层），video[1:] = 覆盖轨（上盖下）。
    旧项目若还是扁平列表，自动按不重叠原则拆成多轨。
    """
    empty = {
        "materials": [],
        "draft": {
            "video": [[]], "audio": [[]], "text": [[]],
            "canvas": {"ratio": DEFAULT_CANVAS, "locked": False},
        },
        "version": 0,
    }
    if not os.path.exists(STATE_PATH):
        return empty
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            s = json.load(f)
        s.setdefault("materials", [])
        s.setdefault("draft", {"video": [[]], "audio": [[]], "text": [[]]})
        s["draft"].setdefault("canvas", {"ratio": DEFAULT_CANVAS, "locked": False})
        s.setdefault("version", 0)
        # 兼容历史脏数据：materials 偶尔会被写成 dict（空对象 {}），统一归一化为 list
        if isinstance(s["materials"], dict):
            s["materials"] = list(s["materials"].values()) if s["materials"] else []
        if not isinstance(s["materials"], list):
            s["materials"] = []
        draft = s["draft"]
        draft.setdefault("_track_meta", {})
        meta = draft["_track_meta"]
        for key in ("video", "audio", "text"):
            draft.setdefault(key, [[]])
            data = draft[key]
            # 迁移：如果是扁平列表（元素是片段 dict），按不重叠拆成多轨
            if data and not isinstance(data[0], list):
                data = _distribute_to_tracks(data)
            # 规范化：保证一定是「轨道列表的列表」，且至少保留一条空轨。
            # 否则 video=[dict,...] / text=[] 这类旧格式或异常数据会破坏渲染与导出。
            if not isinstance(data, list) or (data and not isinstance(data[0], list)):
                data = [[]]
            elif len(data) == 0:
                data = [[]]
            draft[key] = data
            # 同步 _track_meta 长度：旧草稿可能没有，或者迁移后长度不一致
            meta.setdefault(key, [])
            while len(meta[key]) < len(data):
                meta[key].append({})
            if len(meta[key]) > len(data):
                meta[key] = meta[key][:len(data)]
            # 规范化轨道开关默认值，保证 undo 后状态一致
            for m in meta[key]:
                m.setdefault("muted", False)
                m.setdefault("hidden", False)
        # 兼容旧项目：给所有段补 speed/change_pitch 默认值
        _ensure_seg_speeds(draft)
        # 兼容旧项目：给所有段补 animations 默认值
        _ensure_seg_animations(draft)
        return s
    except Exception:
        return empty


def save_state(state, record=True):
    """把状态写回 draft_state.json，并打上版本时间戳（前端靠 version 判断是否变化）。

    撤销快照自动记录（record=True 时）：若草稿相对上次已提交状态发生变化，
    把「变化前」的快照压入撤销栈并清空重做栈。因此：
      - 校验失败提前 return（不调用 save_state）→ 不入栈，撤销栈不被污染；
      - 无变化的操作（如拖到原位）→ 不入栈；
      - undo/redo 自身调用 save_state(record=False)，避免把撤销动作又记成一次可撤销操作。
    record=False 时仅更新「已提交」基线，不压栈（专供 undo/redo 使用）。

    加文件锁防竞态：如果 MCP 进程正在写，桌面进程会等待它写完再写，反之亦然。
    无 portalocker 时回退到无锁写（单进程场景够用，多进程有低概率互踩）。"""
    if record and Api.last_committed is not None and state["draft"] != Api.last_committed:
        Api.undo_stack.append(copy.deepcopy(Api.last_committed))
        if len(Api.undo_stack) > Api.MAX_HISTORY:
            Api.undo_stack.pop(0)
        Api.redo_stack.clear()
    Api.last_committed = copy.deepcopy(state["draft"])
    try:
        state["version"] = int(time.time() * 1000)
        if _HAS_LOCK:
            with open(STATE_PATH, "w", encoding="utf-8") as f:
                portalocker.lock(f, portalocker.LOCK_EX)
                json.dump(state, f, ensure_ascii=False, indent=2)
        else:
            with open(STATE_PATH, "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


# =====================================================================
# 波纹编辑引擎（对齐 OpenCut src/ripple/：diff.ts + apply.ts + shift.ts）
# ---------------------------------------------------------------------
# 设计契约（与 OpenCut 一致，务必守住）：
#   1. 波纹是「编辑前 / 编辑后」两帧时间轴快照的区间 diff：算出哪些位置
#      "空出来了"（vacated），减去「被新片段占掉」的（joined），得到一堆
#      {轨道, 从哪个时间点之后, 平移量}，再把该轨道此点之后的片段统一左移收拢。
#   2. 引擎只收拢「空出来的区间」——所以自然生效的是：删除、裁短右边界、
#      同轨左移；而拉长右边界 / 同轨右移 / 跨轨移动【不】波纹（OpenCut 本身如此）。
#   3. 段必须有稳定 id 才能在 before/after 之间配对；故 _ensure_seg_ids 在
#      _reload 时给所有缺 id 的段补 uuid，且任何「深拷贝生成新段」处都必须
#      给新段重发 id（见 split/duplicate/paste），否则 diff 会错配。
# =====================================================================

def _ensure_seg_ids(draft):
    """给草稿里所有缺 id 的段补一个 uuid（浅改 self.draft，首次 save_state 落盘）。"""
    for t, tracks in draft.items():
        if not isinstance(tracks, list):
            continue
        for segs in tracks:
            if not isinstance(segs, list):
                continue
            for seg in segs:
                if isinstance(seg, dict) and "id" not in seg:
                    seg["id"] = uuid.uuid4().hex


def _ensure_seg_speeds(draft):
    """给草稿里所有 video/audio 段补 speed/change_pitch 默认值（兼容旧项目）。"""
    for t, tracks in draft.items():
        if t not in ("video", "audio"):
            continue
        if not isinstance(tracks, list):
            continue
        for segs in tracks:
            if not isinstance(segs, list):
                continue
            for seg in segs:
                if isinstance(seg, dict):
                    seg.setdefault("speed", DEFAULT_SPEED)
                    seg.setdefault("change_pitch", False)


def _seg_speed(seg):
    """返回段的实际变速倍率（clamp 到合法范围）。"""
    if not isinstance(seg, dict):
        return DEFAULT_SPEED
    rate = seg.get("speed", DEFAULT_SPEED)
    if not isinstance(rate, (int, float)) or rate <= 0 or not (rate == rate):
        return DEFAULT_SPEED
    return max(MIN_SPEED, min(MAX_SPEED, float(rate)))


# ===================== 关键帧 / 动画（对齐 OpenCut ElementAnimations） =====================
# 数据模型：seg["animations"] = { propertyPath: {"keys": [{id, t, v, seg}]} }
# - propertyPath 形如 "transform.positionX" / "transform.scaleX" / "transform.rotate" / "transform.opacity"
# - t: 段内局部时间（微秒，0..duration）；v: 数值（像素/倍数/角度/0~1）；seg: 插值方式 linear|hold
# 与 OpenCut 的差异：OpenCut 用 media time + 嵌套 ScalarAnimationChannel（含 bezier 句柄）；
# 我们用段级局部时间 + 扁平 keys，导出时直接映射到 pyJianYingDraft 的 KeyframeProperty（线性插值）。
# 坐标约定（模型层，统一用「设计画布像素 / 倍数 / 角度 / 0~1」，导出时再换算成剪映单位）：
#   positionX/positionY：像素，中心原点（0,0=画布中心，+x 右、+y 下）；scaleX/scaleY：倍数(1.0=100%)；
#   rotate：角度，顺时针；opacity：0~1（1.0=不透明）。
KF_PROPS = {
    "transform.positionX": {"label": "位置 X", "default": 0.0, "export": "position_x", "coord": "px_x"},
    "transform.positionY": {"label": "位置 Y", "default": 0.0, "export": "position_y", "coord": "px_y"},
    "transform.scaleX":    {"label": "缩放 X", "default": 1.0, "export": "scale_x", "coord": None},
    "transform.scaleY":    {"label": "缩放 Y", "default": 1.0, "export": "scale_y", "coord": None},
    "transform.rotate":    {"label": "旋转",   "default": 0.0, "export": "rotation", "coord": None},
    "transform.opacity":   {"label": "不透明度", "default": 1.0, "export": "alpha", "coord": None},
}
KF_KEYFRAMEABLE = tuple(KF_PROPS.keys())


def _ensure_seg_animations(draft):
    """给草稿里所有段补 animations 默认值（兼容旧项目）。"""
    for t, tracks in draft.items():
        if t not in ("video", "audio", "text"):
            continue
        if not isinstance(tracks, list):
            continue
        for segs in tracks:
            if not isinstance(segs, list):
                continue
            for seg in segs:
                if isinstance(seg, dict):
                    seg.setdefault("animations", {})


def _seg_anims(seg):
    if not isinstance(seg, dict):
        return {}
    a = seg.get("animations")
    return a if isinstance(a, dict) else {}


def _seg_masks(seg):
    if not isinstance(seg, dict):
        return []
    ms = seg.get("masks")
    return ms if isinstance(ms, list) and ms else []


# 可导出到剪映的遮罩形状映射（pyJianYingDraft.MaskType 仅支持这 5 种；
# diamond / cinematic-bars 剪映基础遮罩无对应，仅做预览，导出时跳过并提示）
MASK_EXPORT_MAP = {
    "rectangle": "矩形",
    "ellipse": "圆形",
    "star": "星形",
    "heart": "爱心",
    "split": "线性",
}


def _apply_mask_to_segment(vseg, mask):
    """把我们的 Mask 映射到 pyJianYingDraft.add_mask（剪映原生遮罩）。"""
    from pyJianYingDraft import MaskType
    name = MASK_EXPORT_MAP.get(mask["type"])
    if not name:
        raise ValueError(f"该遮罩形状({mask['type']})剪映不支持导出，仅预览可用")
    mt = getattr(MaskType, name)
    p = mask["params"]
    W, H = vseg.material_size  # 素材像素尺寸 (width, height)
    scale = float(p.get("scale", 1)) or 1
    cx = float(p.get("centerX", 0)) * W      # 归一化中心偏移占整元素宽，×W 得像素
    cy = float(p.get("centerY", 0)) * H
    size = max(0.01, float(p.get("height", 0.6)) * scale)   # 剪映 size = 占素材高比例
    feather = float(p.get("feather", 0))
    rot = float(p.get("rotation", 0))
    inv = bool(p.get("inverted", False))
    kwargs = dict(center_x=cx, center_y=cy, size=size, rotation=rot, feather=feather, invert=inv)
    if mask["type"] == "rectangle":
        kwargs["rect_width"] = max(0.01, float(p.get("width", 0.6)) * scale)
    vseg.add_mask(mt, **kwargs)


# 字幕默认样式（对齐 OpenCut：底部居中、白字粗体、自动换行、可选黑底描边）
def _seg_text_segment(seg, timerange):
    """把我们的 text 段（可能带 inline 字幕内容 / 样式）转成剪映 TextSegment。

    关键修复：此前导出只把 seg['name'] 当文字，ASR/SRT 生成的字幕内容
    （存在 seg['text']）被丢弃。现在优先用 seg['text']，name 仅作回退。
    """
    text = (seg.get("text") or "").strip() or seg.get("name") or ""
    # 样式：每段可独立覆盖，缺省走「字幕默认」
    sub = seg.get("sub_style") or {}
    size = float(sub.get("font_size", seg.get("sub_font", 10.0))) or 10.0
    bold = bool(sub.get("bold", seg.get("sub_bold", True)))
    color_hex = sub.get("color", seg.get("sub_color", "#ffffff"))
    align = int(sub.get("align", seg.get("sub_align", 1)))  # 1=居中
    bg_on = bool(sub.get("bg", seg.get("sub_bg", False)))
    bg_color = sub.get("bg_color", seg.get("sub_bg_color", "#000000"))
    rgb = _hex_to_rgb01(color_hex)
    style = TextStyle(
        size=size, bold=bold, color=rgb, align=align,
        auto_wrapping=True, max_line_width=0.82,
    )
    bg = None
    if bg_on:
        bg = TextBackground(color=bg_color, alpha=0.55, style=1,
                            round_radius=0.1, height=0.16, width=0.9,
                            horizontal_offset=0.5, vertical_offset=0.88)
    return TextSegment(text, timerange, style=style, background=bg)


def _hex_to_rgb01(hex_str):
    """#RRGGBB → (r,g,b) 0~1 三元组，失败回退白色。"""
    try:
        h = hex_str.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r = int(h[0:2], 16) / 255.0
        g = int(h[2:4], 16) / 255.0
        b = int(h[4:6], 16) / 255.0
        return (r, g, b)
    except Exception:
        return (1.0, 1.0, 1.0)


def _seg_clip_settings(seg, W, H):
    """把贴纸段的 transform 换算成 pyJianYingDraft ClipSettings。

    - x/y：归一化 -1~1（画布中心为 0），直接给 transform_x/transform_y。
    - rotation/opacity/flip：原样映射。
    - scale：本地图片有 natural_h 时，换算成「占画布高度 STICKER_BASE_HEIGHT_RATIO 的真实缩放 ×
      用户 scale」；导入的剪映贴纸（无 natural）则直接用用户 scale（剪映自身相对原生）。
    """
    tf = seg.get("transform") or DEFAULT_STICKER_TRANSFORM
    scale = float(tf.get("scale", 1.0)) or 1.0
    natural_h = seg.get("natural_h")
    if natural_h and H:
        base_px = STICKER_BASE_HEIGHT_RATIO * H      # scale=1 时贴纸在画布上的高度（px）
        export_scale = (base_px / float(natural_h)) * scale
    else:
        export_scale = scale
    return ClipSettings(
        alpha=float(tf.get("opacity", 1.0)),
        flip_horizontal=bool(tf.get("flipH", False)),
        flip_vertical=bool(tf.get("flipV", False)),
        rotation=float(tf.get("rotation", 0.0)),
        scale_x=export_scale,
        scale_y=export_scale,
        transform_x=float(tf.get("x", 0.0)),
        transform_y=float(tf.get("y", 0.0)),
    )



def _kf_interp(keys, local_us):
    """对一条标量通道的 keys 做线性/hold 插值，返回 (value, found)。keys 元素 {t, v, seg}。"""
    if not keys:
        return None, False
    ks = sorted(keys, key=lambda k: k["t"])
    if local_us <= ks[0]["t"]:
        return ks[0]["v"], True
    if local_us >= ks[-1]["t"]:
        return ks[-1]["v"], True
    for i in range(len(ks) - 1):
        a, b = ks[i], ks[i + 1]
        if a["t"] <= local_us <= b["t"]:
            if a.get("seg") == "hold":
                return a["v"], True
            span = (b["t"] - a["t"]) or 1
            p = (local_us - a["t"]) / span
            return a["v"] + (b["v"] - a["v"]) * p, True
    return ks[-1]["v"], True


def resolve_kf_value(anims, path, local_us):
    """返回某属性在局部时间 local_us 的插值结果；无该通道返回 None。"""
    ch = anims.get(path) if isinstance(anims, dict) else None
    if not isinstance(ch, dict):
        return None
    keys = ch.get("keys")
    if not keys:
        return None
    v, _ = _kf_interp(keys, local_us)
    return v


def _split_animations(anims, local):
    """分割点 local（段内微秒）：<=local 的键留给左段；>=local 的键给右段并减 local。
    对齐 OpenCut splitAnimationsAtTime（含边界：恰好等于 local 的键同时出现在两侧）。"""
    left, right = {}, {}
    for path, ch in (anims or {}).items():
        if not isinstance(ch, dict):
            continue
        keys = ch.get("keys") or []
        if not keys:
            continue
        lk, rk = [], []
        for k in sorted(keys, key=lambda k: k["t"]):
            if k["t"] <= local:
                lk.append(dict(k))
            if k["t"] >= local:
                nk = dict(k)
                nk["t"] = k["t"] - local
                rk.append(nk)
        if lk:
            left[path] = {"keys": lk}
        if rk:
            right[path] = {"keys": rk}
    return left, right


def _clamp_animations_to_duration(anims, new_duration):
    """裁剪关键帧到新时长：丢弃 new_duration 之后的键；若原有关键帧超出边界，
    在边界处补一个插值关键帧（保持末值，对齐 OpenCut clampAnimationsToDuration）。"""
    out = {}
    for path, ch in (anims or {}).items():
        if not isinstance(ch, dict):
            continue
        keys = ch.get("keys") or []
        if not keys:
            continue
        kept = [dict(k) for k in keys if k["t"] <= new_duration]
        beyond = [k for k in keys if k["t"] > new_duration]
        if beyond:
            v, _ = _kf_interp(keys, new_duration)
            if v is not None:
                kept.append({"id": uuid.uuid4().hex, "t": int(new_duration), "v": v, "seg": "linear"})
                kept.sort(key=lambda k: k["t"])
        if kept:
            out[path] = {"keys": kept}
    return out


def _apply_keyframes_to_segment(seg_obj, anims, W, H):
    """把我们的段级关键帧模型映射到 pyJianYingDraft 的关键帧（线性插值）。

    seg_obj 是已创建的 VideoSegment / AudioSegment 实例（调用方随后 add_segment）。
    坐标换算（模型层→剪映单位）：
      - position_x：像素 / (W/2)（剪映单位 = 半个画布宽）
      - position_y：-像素 / (H/2)（剪映 y 轴向上为正，模型 y 向下为正，故取反）
      - scaleX/scaleY/rotate/opacity：直传（倍数 / 角度 / 0~1）
    单条关键帧异常（如音频段误带位置关键帧）跳过不影响其它。"""
    for path, ch in (anims or {}).items():
        meta = KF_PROPS.get(path)
        if not meta or not isinstance(ch, dict):
            continue
        keys = ch.get("keys") or []
        if not keys:
            continue
        prop = getattr(KeyframeProperty, meta["export"], None)
        if prop is None:
            continue
        half_w = (W / 2.0) or 1.0
        half_h = (H / 2.0) or 1.0
        for k in keys:
            try:
                v = float(k["v"])
            except (TypeError, ValueError):
                continue
            if meta["coord"] == "px_x":
                v = v / half_w
            elif meta["coord"] == "px_y":
                v = -v / half_h
            try:
                seg_obj.add_keyframe(prop, int(k["t"]), v)
            except Exception:
                continue


def _flatten_segs(draft):
    """把所有段摊平成 [(type, ti, seg), ...]，供 diff 遍历。"""
    out = []
    for t, tracks in draft.items():
        if not isinstance(tracks, list):
            continue
        for ti, segs in enumerate(tracks):
            if not isinstance(segs, list):
                continue
            for seg in segs:
                out.append((t, ti, seg))
    return out


def _seg_end(seg):
    return seg["start"] + seg["duration"]


def _normalize_intervals(intervals):
    """合并重叠区间（对齐 OpenCut normalizeIntervals）。"""
    valid = [list(iv) for iv in intervals if iv[1] > iv[0]]
    valid.sort(key=lambda x: x[0])
    if not valid:
        return []
    merged = [valid[0]]
    for iv in valid[1:]:
        last = merged[-1]
        if iv[0] <= last[1]:
            last[1] = max(last[1], iv[1])
        else:
            merged.append(list(iv))
    return [tuple(x) for x in merged]


def _subtract_intervals(source, overlapping):
    """从 source 区间集里挖掉 overlapping 区间集（对齐 OpenCut subtractIntervalSets）。"""
    result = []
    for (s, e) in source:
        remaining = [(s, e)]
        for (os_, oe) in overlapping:
            if oe <= s or os_ >= e:
                continue
            nxt = []
            for (rs, re) in remaining:
                if oe <= rs or os_ >= re:
                    nxt.append((rs, re))
                    continue
                if rs < os_:
                    nxt.append((rs, os_))
                if oe < re:
                    nxt.append((oe, re))
            remaining = nxt
            if not remaining:
                break
        result.extend(remaining)
    return result


def compute_ripple_adjustments(before, after):
    """对齐 OpenCut computeRippleAdjustments：返回 [(type, ti, afterTime, shiftAmount), ...]。

    - 每条轨道独立计算（轨道 key = (type, ti)）
    - vacated：before 有、after 没有的段（且没移到别的轨道）=> 其 [start,end] 空出；
      或 before 段末端被缩短 => [新末端, 旧末端] 空出
    - joined：after 有、before 没有的段 => 其 [start,end] 被占
    - freed = vacated 减去 joined；每个 freed 区间生成一条调整：把该轨道
      startTime >= 区间末端 的段左移 (区间长)
    """
    before_flat = _flatten_segs(before)
    after_flat = _flatten_segs(after)
    before_by_id = {seg["id"]: (t, ti, seg["start"], _seg_end(seg)) for (t, ti, seg) in before_flat}
    after_by_id = {seg["id"]: (t, ti, seg["start"], _seg_end(seg)) for (t, ti, seg) in after_flat}
    all_after_ids = set(after_by_id.keys())

    before_tracks = {}
    for (t, ti, seg) in before_flat:
        before_tracks.setdefault((t, ti), []).append((seg["id"], seg["start"], _seg_end(seg)))
    after_tracks = {}
    for (t, ti, seg) in after_flat:
        after_tracks.setdefault((t, ti), []).append((seg["id"], seg["start"], _seg_end(seg)))

    adjustments = []
    for (t, ti), bsegs in before_tracks.items():
        asegs = after_tracks.get((t, ti), [])
        before_ids_on_track = {bid for (bid, _, _) in bsegs}
        vacated = []
        joined = []
        for (bid, bstart, bend) in bsegs:
            a = after_by_id.get(bid)
            if a is None:
                if bid in all_after_ids:
                    continue  # 移到别的轨道了：OpenCut 跳过（不在原轨产生 vacated）
                vacated.append([bstart, bend])
            elif bend > a[3]:
                vacated.append([a[3], bend])  # 该段被缩短，末端空出
        for (aid, astart, aend) in asegs:
            if aid not in before_ids_on_track:
                joined.append([astart, aend])
        freed = _subtract_intervals(_normalize_intervals(vacated), _normalize_intervals(joined))
        for (s, e) in freed:
            shift = e - s
            if shift > 0:
                adjustments.append((t, ti, e, shift))
    return adjustments


def apply_ripple_adjustments(draft, adjustments):
    """对齐 OpenCut applyRippleAdjustments：按轨道把 afterTime 之后的段左移 shiftAmount。"""
    if not adjustments:
        return
    by_track = {}
    for (t, ti, afterTime, shift) in adjustments:
        by_track.setdefault((t, ti), []).append((afterTime, shift))
    for (t, ti), adjs in by_track.items():
        tracks = draft.get(t)
        if not isinstance(tracks, list) or ti >= len(tracks):
            continue
        segs = tracks[ti]
        # afterTime 从大到小应用，避免多次平移互相干扰（对齐 OpenCut 排序）
        for (afterTime, shift) in sorted(adjs, key=lambda x: -x[0]):
            for seg in segs:
                if seg["start"] >= afterTime:
                    seg["start"] -= shift


def has_ffmpeg():
    """检测系统是否装了 ffprobe（ffmpeg 套件）。"""
    try:
        subprocess.run(
            ["ffprobe", "-version"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False
        )
        return True
    except Exception:
        return False


def _extract_audio_wav(src, dst, sr=16000):
    """用 ffmpeg 把媒体抽成 16k 单声道 wav（Whisper 输入）。成功返回 True。"""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-ar", str(sr),
             "-f", "wav", dst],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1200, check=False,
        )
        return proc.returncode == 0 and os.path.isfile(dst) and os.path.getsize(dst) > 0
    except Exception:
        return False


# Whisper 模型缓存（同进程内只加载一次，避免重复下载/初始化）
_WHISPER_MODELS = {}


def _get_whisper_model(size="small"):
    """加载并缓存 faster-whisper 模型（纯 CPU + int8 量化，省内存）。

    首次会从 HuggingFace 下载模型（tiny~75MB / small~460MB / base~490MB），需联网；
    之后走缓存。compute_type 可在有 GPU 的机器改成 "float16" 提速。
    """
    from faster_whisper import WhisperModel
    if size not in _WHISPER_MODELS:
        _WHISPER_MODELS[size] = WhisperModel(size, device="cpu", compute_type="int8")
    return _WHISPER_MODELS[size]


def _srt_ts(s):
    s = (s or "").strip().replace(",", ".")
    m = re.match(r"^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$", s)
    if not m:
        return None
    h, mm, ss, ms = m.groups()
    return int(h) * 3600 + int(mm) * 60 + int(ss) + int(ms.ljust(3, "0")) / 1000.0


def _parse_srt(text):
    """解析 SRT 文本 → [{text,start,duration}]（秒）。宽松：容忍空行/缺序号。"""
    if not text:
        return []
    norm = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not norm:
        return []
    blocks = re.split(r"\n{2,}", norm)
    cues = []
    ts_pat = re.compile(
        r"(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})"
    )
    for block in blocks:
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        ts_idx = None
        for i, l in enumerate(lines):
            if ts_pat.search(l):
                ts_idx = i
                break
        if ts_idx is None:
            continue
        m = ts_pat.search(lines[ts_idx])
        body = " ".join(lines[ts_idx + 1:]).strip()
        if not body:
            continue
        start, end = _srt_ts(m.group(1)), _srt_ts(m.group(2))
        if start is None or end is None or end <= start:
            continue
        cues.append({"text": body, "start": start, "duration": end - start})
    return cues


def get_media_duration(path):
    """用 ffprobe 读取视频/音频真实时长（秒），失败返回 None。"""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=30, check=False,
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    return None


def get_media_dimensions(path):
    """读取视频/图片的像素宽高（w, h）。视频走 ffprobe，图片优先 PIL，失败返回 (None, None)。"""
    try:
        if path.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif")):
            try:
                from PIL import Image
                with Image.open(path) as im:
                    return im.width, im.height
            except Exception:
                return None, None
        # 视频：ffprobe 取宽高
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=width,height",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=30, check=False,
        )
        if result.returncode == 0:
            lines = [ln.strip() for ln in result.stdout.strip().splitlines() if ln.strip()]
            if len(lines) >= 2:
                return int(lines[0]), int(lines[1])
    except Exception:
        pass
    return None, None


def media_aspect_ratio(path, mtype):
    """返回素材的宽高比 w/h（float），无法探测返回 None。"""
    w, h = get_media_dimensions(path)
    if w and h:
        return w / h
    return None


def match_canvas_ratio(ar):
    """把素材宽高比匹配到最接近的预设画布比例名（找不到返回 None）。"""
    if not ar:
        return None
    best, best_diff = None, float("inf")
    for name, p in CANVAS_PRESETS.items():
        diff = abs(p["ratio"] - ar)
        if diff < best_diff:
            best, best_diff = name, diff
    # 返回最接近（便于把 4:3 素材放进最接近的 4:3 而非 16:9）
    return best


def duration_for(path, mtype):
    """根据类型和 ffprobe 结果，返回片段时长（微秒）。

    图片固定 3 秒；音视频优先读真实时长；没有 ffmpeg 则回退占位时长。
    """
    if mtype == "image":
        return 3_000_000
    if mtype in ("video", "audio"):
        seconds = get_media_duration(path)
        if seconds:
            return int(seconds * 1_000_000)
    # 回退占位
    return DEFAULT_DURATION.get(mtype, 3_000_000)

# 进轨默认时长（微秒，pyJianYingDraft 时间单位）。没有 ffprobe 时回退使用。
# 图片固定 3 秒；音视频在有 ffmpeg 时读取真实时长。
DEFAULT_DURATION = {
    "video": 5_000_000,   # 5 秒占位
    "audio": 3_000_000,   # 3 秒占位
    "image": 3_000_000,   # 图片默认展示 3 秒
    "text":  3_000_000,   # 3 秒占位
}
# 素材类型 → 草稿轨道（图片和视频都在视频主轨；音频独立一轨；文本独立一轨）
TYPE_TRACK = {
    "video": "video",
    "image": "video",
    "audio": "audio",
    "text":  "text",
}

# 画布（画幅）比例预设：剪映式。键为比例名，值为相对宽高 + 数值比例（用于素材比例自动匹配）。
CANVAS_PRESETS = {
    "16:9": {"w": 16, "h": 9,  "ratio": 16 / 9},
    "9:16": {"w": 9,  "h": 16, "ratio": 9 / 16},
    "4:3":  {"w": 4,  "h": 3,  "ratio": 4 / 3},
    "3:4":  {"w": 3,  "h": 4,  "ratio": 3 / 4},
    "1:1":  {"w": 1,  "h": 1,  "ratio": 1.0},
}
# 导出画布基准边长：较长边按此像素，保证剪映里分辨率够用（1080 级）。
CANVAS_BASE = 1080
# 默认画布比例（未手动选择、也无素材时）。
DEFAULT_CANVAS = "16:9"

# 画布（画幅）比例预设：剪映式。键为比例名，值为 (宽, 高) 相对值（导出时乘 BASE 得真实像素）。
# 数值比例 = w/h，用于「素材比例自动匹配画布」时比对。
CANVAS_PRESETS = {
    "16:9":  {"w": 16, "h": 9,  "ratio": 16 / 9},
    "9:16":  {"w": 9,  "h": 16, "ratio": 9 / 16},
    "4:3":   {"w": 4,  "h": 3,  "ratio": 4 / 3},
    "3:4":   {"w": 3,  "h": 4,  "ratio": 3 / 4},
    "1:1":   {"w": 1,  "h": 1,  "ratio": 1.0},
}
# 导出画布基准边长：选较长边作为基准像素，保证分辨率在剪映里够用（1080 级）。
CANVAS_BASE = 1080
# 默认画布比例（未手动选择、也无素材时）。
DEFAULT_CANVAS = "16:9"


def classify(path):
    """根据扩展名判断素材类型。"""
    ext = os.path.splitext(path)[1].lower()
    return EXT_TYPE.get(ext, "file")


def copy_to_assets(src):
    """把外部文件复制到项目 assets/，返回目标路径（失败返回 None）。

    点击导入和拖放导入共用此函数：都是把外部文件落到项目素材目录，
    并记录真实路径，供后面进轨/导出剪映草稿引用。
    """
    os.makedirs(ASSETS_DIR, exist_ok=True)
    name = os.path.basename(src)
    dst = os.path.join(ASSETS_DIR, name)
    # 同名文件：加时间戳避免覆盖
    if os.path.exists(dst):
        base, ext = os.path.splitext(name)
        dst = os.path.join(ASSETS_DIR, f"{base}_{int(time.time())}{ext}")
    try:
        shutil.copy2(src, dst)
        return dst
    except Exception:
        return None


def _ffmpeg_bin():
    """探测 ffmpeg / ffprobe：优先 PATH，其次 hotclip 自带的 static 目录。"""
    ff = shutil.which("ffmpeg")
    fp = shutil.which("ffprobe")
    base = r"D:/hotclip/app/resources/app.asar.unpacked/node_modules/ffmpeg-static"
    if not ff and os.path.exists(os.path.join(base, "ffmpeg.exe")):
        ff = os.path.join(base, "ffmpeg.exe")
    if not fp and os.path.exists(os.path.join(base, "ffprobe.exe")):
        fp = os.path.join(base, "ffprobe.exe")
    return ff, fp


def _has_audio_stream(path):
    """用 ffprobe 检测文件是否含音频流（提取原声按钮可用性判断）。失败/无音频返回 False。"""
    _, fp = _ffmpeg_bin()
    if not fp or not os.path.isfile(path):
        return False
    try:
        r = subprocess.run([fp, "-v", "error",
                            "-select_streams", "a",
                            "-show_entries", "stream=index",
                            "-of", "default=nw=1:nk=1", path],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def _video_duration_sec(path):
    """用 ffprobe 取视频时长（秒），失败返回 None。"""
    _, fp = _ffmpeg_bin()
    if not fp:
        return None
    try:
        out = subprocess.run(
            [fp, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20,
        )
        s = out.stdout.decode().strip()
        return float(s) if s else None
    except Exception:
        return None


def _ffprobe_ok(path):
    """ffprobe 能正常读出流信息则返回 True；剪映 XOR 混淆的「假 mp4」会返回 False。"""
    _, fp = _ffmpeg_bin()
    if not fp or not os.path.isfile(path):
        return False
    try:
        r = subprocess.run([fp, "-v", "error",
                            "-show_entries", "stream=codec_type",
                            "-of", "default=nw=1:nk=1", path],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def _decrypt_jianying_media(src):
    """剪映 onlineMaterial 缓存是单字节 XOR 混淆的「假媒体」（视频/图片都如此），浏览器与 ffmpeg
    都读不了，表现为预览黑屏/花屏。这里暴力枚举 256 个单字节密钥，找到能让文件头出现合法媒体魔数的那把，
    整文件 XOR 解密后再用 ffmpeg 强制转码成标准 H.264/AAC MP4，写进 preview_cache，返回转码路径；
    无法解密/转码返回 None。

    为什么解密后还要再转码：剪映 XOR 混淆后的 H.264 文件虽然容器结构能被 ffprobe 识别，但内部 NAL/sample
    数据仍不完全标准，WebView2 直接解码会报 PIPELINE_ERROR_DECODE / 画面花屏。ffmpeg 强制重编码一次可
    彻底消除这种「半加密」残留，得到浏览器稳定可播的视频。

    注意：本地自己录/导出的文件 ffprobe 直接能读，本函数直接放行、不碰。
    """
    if not src or not os.path.isfile(src):
        return None
    if _ffprobe_ok(src):
        return None  # 本来就能播，无需解密
    try:
        with open(src, "rb") as f:
            head = f.read(4096)
    except OSError:
        return None
    if not head:
        return None

    def _looks_media(d):
        # mp4/mov: box size 高 3 字节为 0，第 4-8 字节是 'ftyp'
        if d[4:8] == b"ftyp" and (d[0] | d[1] | d[2]) == 0:
            return True
        if d[:8] == b"\x89PNG\r\n\x1a\n":
            return True
        if d[:3] == b"\xff\xd8\xff" or d[:4] == b"JFIF" or d[:4] == b"Exif":
            return True
        if d[:4] == b"GIF8":
            return True
        if d[:4] == b"RIFF":  # webp / wav
            return True
        if d[:3] == b"ID3" or (d[0] == 0xff and (d[1] & 0xe0) == 0xe0):  # mp3
            return True
        return False

    found_key = None
    for k in range(256):
        d = bytes(b ^ k for b in head)
        if _looks_media(d):
            found_key = k
            break
    if found_key is None:
        return None
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_cache")
    os.makedirs(cache_dir, exist_ok=True)
    key = hashlib.md5((src + ":dec").encode("utf-8")).hexdigest()
    dst = os.path.join(cache_dir, key + ".mp4")
    if os.path.isfile(dst) and os.path.getsize(dst) > 0 and _ffprobe_ok(dst):
        return dst

    ff, _ = _ffmpeg_bin()
    if not ff:
        return None

    # 1) 先解密到临时文件
    tmp = dst + ".tmp.mp4"
    try:
        with open(src, "rb") as f, open(tmp, "wb") as out:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                out.write(bytes(b ^ found_key for b in chunk))
    except Exception:
        return None

    # 2) 再用 ffmpeg 强制重编码成浏览器绝对稳定的 H.264 Main Profile + AAC
    try:
        subprocess.run(
            [ff, "-y", "-err_detect", "ignore_err", "-fflags", "+discardcorrupt",
             "-i", tmp,
             "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
             "-preset", "veryfast", "-crf", "23",
             "-c:a", "aac", "-b:a", "128k",
             "-movflags", "+faststart", dst],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600,
        )
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return None
    finally:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
    if os.path.isfile(dst) and os.path.getsize(dst) > 0 and _ffprobe_ok(dst):
        return dst
    return None


def _prepare_preview_media(rp, mtype):
    """导入时把任意本地媒体处理成浏览器可预览的版本：
    1) 剪映 onlineMaterial 混淆件 → 单字节 XOR 解密成标准文件（preview_cache）
    2) 视频/音频若需转码（HEVC/MOV 等浏览器播不了的）→ H.264/AAC MP4（preview_cache）
    3) 图片/已是浏览器友好格式 → 直接返回（解密后即标准格式）
    转码/解密只用于本端预览；导出剪映仍引用原始素材，不破坏「导出零复制」。
    """
    dec = _decrypt_jianying_media(rp)
    if dec:
        rp = dec  # 解密件已是标准 H.264/jpg 等，浏览器原生可播
    if mtype in ("video", "audio"):
        return _transcode_for_preview(rp)
    return rp


def _transcode_for_preview(src):
    """把浏览器无法播放的本地视频/音频转成 H.264/AAC MP4 用于预览。

    背景：WebView2（Edge 内核）对 HEVC .MOV 等格式无解码器，导致预览黑屏。
    这里在导入时把这类素材转成标准 MP4（浏览器原生支持），让老板能直接看到画面。
    - 已是浏览器友好格式（.mp4/.m4v/.webm）→ 直接返回（半零复制，不重复转）
    - 已转码过 → 复用 preview_cache 缓存（按源路径 md5 命名），不重复转
    - 转码失败 → 退回原路径（预览可能黑，但不阻断导入）
    注意：转码只用于本端预览；导出剪映时仍引用原始素材，不破坏"导出零复制"。
    """
    if not src or not os.path.isfile(src):
        return src
    ext = os.path.splitext(src)[1].lower()
    if ext in (".mp4", ".m4v", ".webm"):
        return src  # 浏览器原生支持，无需转码
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview_cache")
    os.makedirs(cache_dir, exist_ok=True)
    key = hashlib.md5(src.encode("utf-8")).hexdigest()
    dst = os.path.join(cache_dir, key + ".mp4")
    if os.path.isfile(dst) and os.path.getsize(dst) > 0:
        return dst  # 缓存命中
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", src,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-c:a", "aac", "-b:a", "128k",
             "-movflags", "+faststart", dst],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600,
        )
    except Exception:
        return src
    if os.path.isfile(dst) and os.path.getsize(dst) > 0:
        return dst
    return src


def _resolve_media_file(p):
    """解析剪映素材的真实文件路径。

    剪映草稿里 video/audio 素材的 path 字段经常**缺失扩展名或末尾几字符**
    （例如素材库缓存 onlineMaterial/874d0cd6... 实际磁盘文件是 874d0cd6...9a.mp4）。
    直接 os.path.isfile 会失败。这里做兜底：文件不存在时，按「目录 + 同名前缀 +
    任意媒体扩展名」在目录内模糊匹配真实文件。
    """
    import glob as _glob
    if not p:
        return None
    p = os.path.normpath(p)
    if os.path.isfile(p):
        return p
    d, base = os.path.split(p)
    if not d or not base:
        return None
    exts = (".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav", ".aac",
            ".jpg", ".jpeg", ".png", ".webp")
    cands = sorted(_glob.glob(os.path.join(d, base + "*")), key=len)
    for c in cands:
        if os.path.splitext(c)[1].lower() in exts:
            return c
    return cands[0] if cands else None


def _make_thumbnail(video_path):
    """抽中段一帧存到 assets/thumbnails/，供时间轴片段帧平铺。返回绝对路径或 None。"""
    ff, _ = _ffmpeg_bin()
    if not ff:
        return None
    os.makedirs(os.path.join(ASSETS_DIR, "thumbnails"), exist_ok=True)
    base = os.path.splitext(os.path.basename(video_path))[0]
    out = os.path.join(ASSETS_DIR, "thumbnails", base + ".jpg")
    if os.path.exists(out):
        return out
    dur = _video_duration_sec(video_path)
    ss = max(0.1, (dur / 2 if dur else 1))
    try:
        subprocess.run(
            [ff, "-y", "-ss", f"{ss:.2f}", "-i", video_path,
             "-frames:v", "1", "-vf", "scale=160:-1", out],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
    except Exception:
        return None
    return out if os.path.exists(out) else None


def _audio_duration_sec(path):
    """用 ffprobe 取音频时长（秒），失败返回 None。"""
    _, fp = _ffmpeg_bin()
    if not fp:
        return None
    try:
        out = subprocess.run(
            [fp, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20,
        )
        s = out.stdout.decode().strip()
        return float(s) if s else None
    except Exception:
        return None


def _extract_audio_peaks(path, density=60):
    """用 ffmpeg 抽单声道 PCM，按 density 个/秒分桶取 RMS 振幅，返回归一化 0~1 列表。失败返回 None。

    对齐 OpenCut audio-waveform 的「分桶取振幅」逻辑，但用 RMS（均方根）代替纯峰值：
    峰值会把音乐/鼓点全顶到 1.0，画出来是实心块；RMS 更接近人耳感知的响度，
    能保留强弱起伏，波形才有「峰谷」。
    后端算好振幅数组存进素材，前端 canvas 按像素密度画 bar（缩放时波形依然清晰）。
    """
    ff, _ = _ffmpeg_bin()
    if not ff:
        return None
    try:
        proc = subprocess.run(
            [ff, "-y", "-i", path, "-ac", "1", "-ar", "22050",
             "-f", "s16le", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90,
        )
        raw = proc.stdout
        if not raw:
            return None
        raw = raw[: len(raw) // 2 * 2]  # 截成偶数长度（s16le 每样本 2 字节）
        sr = 22050.0
        bucket = max(1, int(sr / density))
        n = len(raw) // 2
        peaks = []
        # 优先 numpy 向量化（快），否则纯 Python 分桶
        try:
            import numpy as np
            arr = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            nb = n // bucket
            if nb > 0:
                block = arr[: nb * bucket].reshape(nb, bucket)
                # RMS per bucket
                peaks = np.sqrt(np.mean(block * block, axis=1)).tolist()
            if nb * bucket < n:
                rest = arr[nb * bucket:]
                if len(rest):
                    peaks.append(float(np.sqrt(np.mean(rest * rest))))
        except Exception:
            import array, math
            samples = array.array("h")
            samples.frombytes(raw)
            for b in range(0, n, bucket):
                end = min(n, b + bucket)
                ss = 0.0
                cnt = end - b
                for i in range(b, end):
                    v = samples[i] / 32768.0
                    ss += v * v
                peaks.append(math.sqrt(ss / cnt) if cnt else 0.0)
        if not peaks:
            return None
        # 归一化到全局最大≈1，保留 3 位小数减小 state 体积
        m = max(peaks)
        if m > 0:
            peaks = [round(min(1.0, p / m * 0.98), 3) for p in peaks]
        else:
            peaks = [0.0 for _ in peaks]
        return peaks[:60000]  # 安全阀：超长音频截断峰值数，避免 state 膨胀
    except Exception:
        return None


def _extract_text_content(mat):
    """从剪映 text 素材的 content 字段解析纯文字。

    content 可能是 JSON 字符串 {"styles":[...],"text":"..."} 或 {"styles":[...],"words":"..."}，
    或直接字符串。返回给人看的纯文字，供播放器文字层与时间轴段头显示。"""
    if not mat:
        return ""
    content = mat.get("content")
    if content is None:
        return mat.get("name") or ""
    if isinstance(content, str):
        try:
            obj = json.loads(content)
        except Exception:
            return content
    else:
        obj = content
    if isinstance(obj, dict):
        txt = obj.get("text") or obj.get("words") or ""
        if isinstance(txt, str):
            return txt
        if isinstance(txt, list):
            return "".join(w.get("text", "") if isinstance(w, dict) else str(w) for w in txt)
    return str(obj)


class Api:
    """暴露给前端（HTML）调用的 Python 能力。一个方法 = 一个原子能力。"""

    # 撤销/重做栈：类级共享（桌面窗口是单例持久，MCP 每次调用新建实例也能共享同一份历史）。
    # 每次会改草稿的操作前，把当前草稿深拷贝压栈；undo 弹栈还原、redo 弹重做栈还原。
    undo_stack = []
    redo_stack = []
    MAX_HISTORY = 100
    # 上次「已提交」的草稿快照；save_state 用它判断本次是否真的发生变化，从而决定是否入撤销栈。
    # 初始化为 None（尚未加载），Api.__init__ 加载后会设为当前草稿的深拷贝。
    last_committed = None
    copy_buffer = None   # 内存剪贴板：copy_to_buffer 存选中段深拷贝列表，paste_from_buffer 读取

    def __init__(self):
        # 草稿 + 素材状态从共享文件 draft_state.json 加载。
        # 人和 AI/MCP 改的都是同一份文件，前端轮询刷新即可互相看到改动。
        self.state = load_state()
        self.draft = self.state["draft"]  # 直接引用 state 里的草稿字典，改它就改 state
        # 记录「已提交」基线，供 save_state 判断真实变更（undo 快照自动记录机制依赖此）。
        Api.last_committed = copy.deepcopy(self.draft)

    def _reload(self):
        """修改状态前先从文件重载最新状态。

        关键：AI/MCP 可能是另一个独立进程，它们会写同一个 draft_state.json。
        如果窗口进程一直用内存里的旧 state，就会出现「后端提示已登记但时间轴不显示」
        的 bug。所以任何会改状态的操作前，都要先 reload。
        """
        self.state = load_state()
        self.draft = self.state["draft"]
        # 波纹引擎依赖段 id 配对 before/after，重载时顺手给缺 id 的段补上
        _ensure_seg_ids(self.draft)
        # 兼容旧项目：补 speed/change_pitch 默认值
        _ensure_seg_speeds(self.draft)
        _ensure_seg_animations(self.draft)

    def _push_undo(self):
        """【已废弃】保留为无操作占位。

        撤销快照现由 save_state 在每次「真实变更」时自动记录（仅当草稿相对上次提交状态
        发生变化才入栈，且校验失败提前 return 不调用 save_state，因此不会污染撤销栈）。
        历史 15 个调用点保留此空调用无害。
        """
        return

    def undo(self):
        """撤销上一步：弹撤销栈还原草稿（人与 AI 的编辑都记录在同一份历史里）。"""
        if not Api.undo_stack:
            return {"ok": False, "error": "没有可撤销的操作"}
        self._reload()
        Api.redo_stack.append(copy.deepcopy(self.draft))
        self.draft = Api.undo_stack.pop()
        self.state["draft"] = self.draft
        save_state(self.state, record=False)  # 撤销动作本身不入栈
        return {"ok": True, "remaining": len(Api.undo_stack)}

    def redo(self):
        """重做：弹重做栈还原草稿（撤销的反操作）。"""
        if not Api.redo_stack:
            return {"ok": False, "error": "没有可重做的操作"}
        self._reload()
        Api.undo_stack.append(copy.deepcopy(self.draft))
        self.draft = Api.redo_stack.pop()
        self.state["draft"] = self.draft
        save_state(self.state, record=False)  # 重做动作本身不入栈
        return {"ok": True, "remaining": len(Api.redo_stack)}

    def add_to_timeline(self, name, path, mtype, track_index=None, at_time_us=None, insert_index=None):
        """把素材登记进草稿对应轨道（双击或拖拽都走这里，真实进轨）。

        多轨模型：
        - video / image 默认进主视频轨 video[0]（最底层，不可删）
        - audio 默认进第一条音频轨 audio[0]；text 进 text[0]
        - track_index 指定该类型内轨道序号；track_index=-1 表示「自动新建一条该类型轨道」
        - at_time_us 指定落点时间（微秒，来自拖拽松手横向位置）；为 None 则接到该轨末尾
        同轨重叠自动避让：若落点被占用，自动推到该轨最近空位（不新建轨、不重叠）。
        返回登记结果（track_type/track_index/该轨段数/总段数/时长/start）。
        """
        self._reload()
        # 严重坑：path 不存在（AI 传了假路径/文件名）就直接进轨，导出剪映时 VideoSegment(None) 抛异常整段失败。
        # 进轨前必须校验文件真实存在，否则明确报错，避免把脏数据带进导出环节。
        if not path or not isinstance(path, str) or not os.path.isfile(path):
            return {"ok": False, "error": f"素材文件不存在，无法进轨：{path}"}
        self._push_undo()
        if mtype not in TYPE_TRACK:
            return {"ok": False, "error": f"不支持的素材类型：{mtype}"}
        track_type = TYPE_TRACK[mtype]
        tracks = self.draft.setdefault(track_type, [[]])
        if not tracks:
            tracks.append([])
        # 落点轨道优先级：指定 track_index（-1=新建追加）> insert_index（中间插入新轨）> 默认主轨/第一条
        if track_index is not None:
            if track_index == -1:
                idx = _ensure_track(self.draft, track_type, -1)
            else:
                idx = _ensure_track(self.draft, track_type, track_index)
        elif insert_index is not None:
            idx = _insert_track(self.draft, track_type, insert_index)
        else:
            idx = 0
        segs = tracks[idx]
        duration = duration_for(path, mtype)
        # 落点时间：指定则按落点 + 同轨重叠避让；否则接到该轨末尾
        if at_time_us is not None:
            start = _free_start_on_track(segs, at_time_us, duration)
        else:
            start = sum(s["duration"] for s in segs)
        seg = {
            "name": name,
            "path": path,
            "type": mtype,
            "start": start,
            "duration": duration,
            "src_start": 0,
            "src_end": duration,
            "speed": DEFAULT_SPEED,
            "change_pitch": False,
            "animations": {},
        }
        # Step 3 Asset 分离：段关联素材 uid（materials 按 path 精确匹配；匹配不到不设，
        # 保持无 material_id，前端 resolveSegPath 会 fallback seg.path，行为不变）。
        # 标准链路（导入素材→拖入时间轴）走 materials[].path（assets 副本），可精确命中；
        # MCP/脚本直接传原始路径时可能 miss，属可接受（旧数据兼容路径）。
        for _m in self.state.get("materials", []) or []:
            if isinstance(_m, dict) and _m.get("path") == path and _m.get("uid"):
                seg["material_id"] = _m["uid"]
                break
        # 视频段记录是否含音轨（提取原声按钮可用性；ffprobe 探测，仅视频类型）
        if mtype == "video":
            seg["has_audio"] = _has_audio_stream(path)
        # —— 画布（画幅）自动匹配：剪映式 ——
        # 在放入前判断「整条视频轨此前是否为空」；若为空、且用户尚未锁定画布比例，
        # 则用该素材真实宽高比自动匹配最接近的预设画布比例（主轨第一段决定画布）。
        canvas = self.draft.setdefault("canvas", {"ratio": DEFAULT_CANVAS, "locked": False})
        video_was_empty = (track_type == "video"
                           and not canvas.get("locked", False)
                           and not any(len(t) > 0 for t in self.draft.get("video", [[]])))

        segs.append(seg)
        # 轨道一旦被放入片段，就不再是「显式创建的空轨」，取消 persistent_empty 标记
        _clear_persistent_if_needed(self.draft, track_type, idx)

        if video_was_empty:
            ar = media_aspect_ratio(path, mtype)
            matched = match_canvas_ratio(ar)
            if matched:
                canvas["ratio"] = matched

        total = sum(len(t) for kind in ("video", "audio", "text") for t in self.draft.get(kind, []))
        save_state(self.state)
        fallback = (mtype in ("video", "audio") and not has_ffmpeg())
        return {
            "ok": True,
            "track_type": track_type,
            "track_index": idx,
            "count": len(segs),
            "total": total,
            "duration": duration,
            "start": start,
            "fallback": fallback,
        }

    def toggle_source_audio(self, track_type, track_index, index):
        """提取原声 / 还原音频（对齐 OpenCut toggle-source-audio）。

        ⚠️ 与 OpenCut 的关键差异：OpenCut 是「逻辑分离」（音频段引用同一 MP4、不重编码），
        但本项目的 pyJianYingDraft AudioMaterial 明确拒绝视频文件（含 video 轨即报错），
        所以本实现**真的用 ffmpeg 把音轨抽成独立 .m4a**，再让原视频段 volume=0 静音，
        避免导出后音频翻倍。这是「抄 OpenCut 但底层约束不同」的落地。

        行为：
        - 选中视频段且尚未提取、且确实含音轨 → 抽出独立音频文件，在音频轨生成一段
          引用该音频文件、同起点同长度的音频段；原视频段标记 source_audio_extracted + muted。
        - 已提取过（source_audio_extracted=True）→ 还原：删掉配对的音频段、清掉视频段标记与静音。
        返回 {"ok": True, "action": "extract"/"recover", "audio_path": ..., "audio_track_index": ...}
        或 {"ok": False, "error": 原因}。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        seg = segs[index]
        if seg.get("type") != "video":
            return {"ok": False, "error": "提取原声只能用于视频片段"}

        # —— 已提取过 → 还原 ——
        if seg.get("source_audio_extracted"):
            vid_id = seg.get("id")
            removed = 0
            for atracks in self.draft.get("audio", []):
                i = 0
                while i < len(atracks):
                    if atracks[i].get("extracted_from") == vid_id:
                        atracks.pop(i)
                        removed += 1
                    else:
                        i += 1
            seg.pop("source_audio_extracted", None)
            seg.pop("muted", None)
            _collapse_empty_tracks(self.draft)
            save_state(self.state)
            return {"ok": True, "action": "recover", "removed_audio_segments": removed}

        # —— 未提取 → 提取 ——
        if not (seg.get("has_audio") or _has_audio_stream(seg.get("path", ""))):
            return {"ok": False, "error": "该视频没有音轨，无法提取原声"}
        ff, _ = _ffmpeg_bin()
        if not ff:
            return {"ok": False, "error": "未找到 ffmpeg，无法抽取音轨（请安装 ffmpeg）"}
        # 抽出来的音频落项目内 extracted_audio/（保持源文件干净）
        cache_dir = os.path.join(HERE, "extracted_audio")
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except OSError:
            return {"ok": False, "error": f"无法创建音频缓存目录：{cache_dir}"}
        vid_id = seg.get("id") or uuid.uuid4().hex
        seg["id"] = vid_id
        out_path = os.path.join(cache_dir, f"{vid_id}.m4a")
        try:
            r = subprocess.run(
                [ff, "-y", "-i", seg["path"], "-vn", "-acodec", "aac", out_path],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
            )
            if r.returncode != 0 or not os.path.isfile(out_path):
                return {"ok": False, "error": "ffmpeg 抽取音轨失败：" + r.stderr.decode(errors="ignore")[:300]}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "ffmpeg 抽取音轨超时"}

        # 确保有音频轨，把抽出的音频段放进去（与视频段同起点、同长度、同 src 范围）
        if not self.draft.get("audio"):
            self.draft["audio"] = [[]]
        _ensure_track(self.draft, "audio", 0)
        atracks = self.draft["audio"]
        audio_seg = {
            "name": (seg.get("name", "音频") + " 音频"),
            "path": out_path,
            "type": "audio",
            "start": seg.get("start", 0),
            "duration": seg.get("duration", 0),
            "src_start": seg.get("src_start", 0),
            "src_end": seg.get("src_end", seg.get("duration", 0)),
            "speed": seg.get("speed", DEFAULT_SPEED),
            "change_pitch": seg.get("change_pitch", False),
            "extracted_from": vid_id,
            "id": uuid.uuid4().hex,
        }
        atracks[0].append(audio_seg)
        # 原视频段：标记已提取 + 静音（导出时 volume=0）
        seg["source_audio_extracted"] = True
        seg["muted"] = True
        save_state(self.state)
        return {"ok": True, "action": "extract", "audio_path": out_path, "audio_track_index": 0}

    def set_segment_speed(self, track_type, track_index, index, speed, change_pitch=None):
        """设置片段变速倍率（对齐 OpenCut updateElementRetime）。

        - 仅 video / audio 段可变速；text / image 不可变速。
        - speed 范围 [MIN_SPEED, MAX_SPEED]（0.01x ~ 5x），超出则 clamp。
        - 变速保持 src_start/src_end 不变，按 source_span / speed 重新计算时间轴 duration。
        - change_pitch: True=变调（如 0.5x 慢放时声音也变慢变低），False=保持原调。
          默认维持原调（False），与 OpenCut maintainPitch=true 等价。
        返回 {"ok": True, "speed": 实际倍率, "duration": 新时长, "src_start": ..., "src_end": ...}
        或 {"ok": False, "error": 原因}。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        seg = segs[index]
        if seg.get("type") not in ("video", "audio"):
            return {"ok": False, "error": "只有视频和音频片段可以变速"}
        try:
            rate = float(speed)
        except Exception:
            return {"ok": False, "error": "speed 必须是数字"}
        rate = max(MIN_SPEED, min(MAX_SPEED, rate))
        # 源范围兜底：旧数据或异常数据可能缺 src_end
        if "src_start" not in seg:
            seg["src_start"] = 0
        if "src_end" not in seg or not seg.get("src_end"):
            real = get_media_duration(seg.get("path")) if seg.get("type") in ("video", "audio") else None
            seg["src_end"] = int(real * 1_000_000) if real else seg["duration"]
        ss = seg["src_start"]
        se_ = seg["src_end"]
        source_span = max(1, se_ - ss)
        new_duration = int(round(source_span / rate))
        seg["speed"] = rate
        seg["change_pitch"] = bool(change_pitch) if change_pitch is not None else seg.get("change_pitch", False)
        seg["duration"] = new_duration
        save_state(self.state)
        return {
            "ok": True,
            "track_type": track_type,
            "track_index": track_index,
            "index": index,
            "speed": rate,
            "change_pitch": seg["change_pitch"],
            "duration": new_duration,
            "src_start": ss,
            "src_end": se_,
        }

    # ---------- 关键帧 / 动画 CRUD（对齐 OpenCut upsertKeyframe / removeKeyframe / retimeKeyframe） ----------
    def _kf_resolve_seg(self, track_type, track_index, index):
        """取关键帧编辑目标段，返回 (seg, None) 或 (None, error)。"""
        if track_type not in self.draft:
            return None, f"未知轨道类型：{track_type}"
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return None, f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return None, f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"
        return segs[index], None

    def add_keyframe(self, track_type, track_index, index, path, time_us, value, seg_mode="linear"):
        """在段内局部时间 time_us（微秒）为属性 path 添加一个关键帧。

        - path 必须是 KF_KEYFRAMEABLE 之一。
        - 若该时间已有关键帧（±1ms 内）则更新其值与插值方式；否则新增。
        - seg_mode: linear（线性）或 hold（台阶/保持）。
        返回 {ok, path, keyframes}（keyframes 为该 path 下全部键，供前端重绘）。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index)
        if err:
            return {"ok": False, "error": err}
        if path not in KF_KEYFRAMEABLE:
            return {"ok": False, "error": f"不支持关键帧的属性：{path}"}
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return {"ok": False, "error": "value 必须是数字"}
        if seg_mode not in ("linear", "hold"):
            seg_mode = "linear"
        dur = int(seg.get("duration", 0))
        t = max(0, min(int(time_us), dur))
        anims = _seg_anims(seg)
        ch = anims.get(path) if isinstance(anims.get(path), dict) else {"keys": []}
        keys = list(ch.get("keys", []))
        existing = next((k for k in keys if abs(k["t"] - t) <= 1000), None)
        if existing:
            existing["v"] = float(value)
            existing["seg"] = seg_mode
            kid = existing["id"]
        else:
            kid = uuid.uuid4().hex
            keys.append({"id": kid, "t": t, "v": float(value), "seg": seg_mode})
            keys.sort(key=lambda k: k["t"])
        anims[path] = {"keys": keys}
        seg["animations"] = anims
        save_state(self.state)
        return {"ok": True, "path": path, "keyframe_id": kid, "keyframes": keys}

    def update_keyframe(self, track_type, track_index, index, path, keyframe_id,
                        value=None, time_us=None, seg_mode=None):
        """更新某关键帧的 value / 时间(time_us) / 插值方式。未传的字段保持不变。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index)
        if err:
            return {"ok": False, "error": err}
        if path not in KF_KEYFRAMEABLE:
            return {"ok": False, "error": f"不支持关键帧的属性：{path}"}
        anims = _seg_anims(seg)
        ch = anims.get(path)
        if not isinstance(ch, dict) or not ch.get("keys"):
            return {"ok": False, "error": "该属性没有关键帧"}
        keys = ch["keys"]
        target = next((k for k in keys if k.get("id") == keyframe_id), None)
        if not target:
            return {"ok": False, "error": "找不到该关键帧"}
        if value is not None:
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return {"ok": False, "error": "value 必须是数字"}
            target["v"] = float(value)
        if time_us is not None:
            dur = int(seg.get("duration", 0))
            target["t"] = max(0, min(int(time_us), dur))
        if seg_mode is not None:
            if seg_mode not in ("linear", "hold"):
                return {"ok": False, "error": "seg_mode 必须是 linear 或 hold"}
            target["seg"] = seg_mode
        keys.sort(key=lambda k: k["t"])
        anims[path] = {"keys": keys}
        seg["animations"] = anims
        save_state(self.state)
        return {"ok": True, "path": path, "keyframes": keys}

    def remove_keyframe(self, track_type, track_index, index, path, keyframe_id):
        """删除一个关键帧；若该属性键被删空，则移除整条通道。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index)
        if err:
            return {"ok": False, "error": err}
        anims = _seg_anims(seg)
        ch = anims.get(path)
        if not isinstance(ch, dict) or not ch.get("keys"):
            return {"ok": False, "error": "该属性没有关键帧"}
        keys = [k for k in ch["keys"] if k.get("id") != keyframe_id]
        if keys:
            anims[path] = {"keys": keys}
        else:
            anims.pop(path, None)
        seg["animations"] = anims
        save_state(self.state)
        return {"ok": True, "path": path, "keyframes": anims.get(path, {}).get("keys", [])}

    def get_keyframes(self, track_type, track_index, index):
        """返回该段全部关键帧（animations），供前端面板渲染。"""
        seg, err = self._kf_resolve_seg(track_type, track_index, index)
        if err:
            return {"ok": False, "error": err}
        return {"ok": True, "animations": _seg_anims(seg)}

    def clear_keyframes(self, track_type, track_index, index, path=None):
        """清空关键帧：path 指定则只清该属性，否则清空整段。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index)
        if err:
            return {"ok": False, "error": err}
        anims = _seg_anims(seg)
        if path:
            anims.pop(path, None)
        else:
            anims.clear()
        seg["animations"] = anims
        save_state(self.state)
        return {"ok": True, "animations": anims}

    def _track_meta(self, track_type, track_index, ensure=True):
        """返回指定轨道的元数据 dict（不存在时按需创建）。"""
        meta = self.draft.setdefault("_track_meta", {}).setdefault(track_type, [])
        if ensure:
            while len(meta) <= track_index:
                meta.append({})
        if 0 <= track_index < len(meta):
            return meta[track_index]
        return {}

    def toggle_track_mute(self, track_type, track_index):
        """切换轨道静音（OpenCut: toggleTrackMute）。

        影响：该轨道内所有片段在预览/导出时静音（视频段的内嵌音频也静音）。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        m = self._track_meta(track_type, track_index, ensure=True)
        m["muted"] = not m.get("muted", False)
        save_state(self.state)
        return {"ok": True, "muted": m["muted"]}

    # ---------- 书签（纯 UI 标注，不参与剪辑/导出；存 state 顶层 bookmarks，对齐 OpenCut scene.bookmarks） ----------
    # 位置用微秒整数，1 帧容差（30fps）避免缩放/浮点误差导致同位置加不上或删不掉。
    BOOKMARK_TOL_US = 33333  # 1_000_000 / 30

    def add_bookmark(self, us, name=None):
        """在指定微秒位置加书签（同位置 1 帧内已存在则改名字）。"""
        self._reload()
        self._push_undo()
        us = int(round(float(us)))
        bms = self.state.setdefault("bookmarks", [])
        for b in bms:
            if abs(b["us"] - us) <= self.BOOKMARK_TOL_US:
                b["name"] = name or b.get("name") or ""
                save_state(self.state)
                return {"ok": True, "bookmarks": bms, "toggled": "updated"}
        bms.append({"us": us, "name": name or ""})
        bms.sort(key=lambda x: x["us"])
        save_state(self.state)
        return {"ok": True, "bookmarks": bms, "toggled": "added"}

    def remove_bookmark(self, us):
        """删除指定位置（1 帧容差）的书签。"""
        self._reload()
        self._push_undo()
        us = int(round(float(us)))
        bms = self.state.setdefault("bookmarks", [])
        new = [b for b in bms if abs(b["us"] - us) > self.BOOKMARK_TOL_US]
        removed = len(bms) - len(new)
        self.state["bookmarks"] = new
        save_state(self.state)
        return {"ok": True, "bookmarks": new, "removed": removed}

    def toggle_bookmark(self, us):
        """对齐 OpenCut ToggleBookmarkCommand：该位置有书签则删，无则加。"""
        self._reload()
        self._push_undo()
        us = int(round(float(us)))
        bms = self.state.setdefault("bookmarks", [])
        for i, b in enumerate(bms):
            if abs(b["us"] - us) <= self.BOOKMARK_TOL_US:
                bms.pop(i)
                self.state["bookmarks"] = bms
                save_state(self.state)
                return {"ok": True, "bookmarks": bms, "toggled": "removed"}
        bms.append({"us": us, "name": ""})
        bms.sort(key=lambda x: x["us"])
        save_state(self.state)
        return {"ok": True, "bookmarks": bms, "toggled": "added"}

    def rename_bookmark(self, us, name):
        """修改书签名（按位置 1 帧容差定位）。"""
        self._reload()
        self._push_undo()
        us = int(round(float(us)))
        bms = self.state.setdefault("bookmarks", [])
        for b in bms:
            if abs(b["us"] - us) <= self.BOOKMARK_TOL_US:
                b["name"] = name or ""
                save_state(self.state)
                return {"ok": True, "bookmarks": bms}
        return {"ok": False, "error": "未找到该位置的书签"}

    def list_bookmarks(self):
        """返回全部书签（MCP/调试用；前端由 get_state 直接带出）。"""
        self._reload()
        return {"ok": True, "bookmarks": self.state.get("bookmarks", [])}

    def toggle_track_visibility(self, track_type, track_index):
        """切换轨道可见性（OpenCut: toggleTrackVisibility）。

        影响：隐藏的视频/文本轨在预览和导出时完全不渲染；音频轨的 hidden 仅影响可视化，
        真正静音用 muted。这里只允许 video/text 轨切换 hidden（与 OpenCut canTrackBeHidden 一致）。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        if track_type not in ("video", "text"):
            return {"ok": False, "error": "只有视频轨和文本轨可以切换可见性"}
        m = self._track_meta(track_type, track_index, ensure=True)
        m["hidden"] = not m.get("hidden", False)
        save_state(self.state)
        return {"ok": True, "hidden": m["hidden"]}

    def remove_segment(self, track_type, track_index, index):
        """删除指定轨道里的第 index 段，并重排该轨道后续片段的 start 时间。

        track_type: video / audio / text；track_index: 该类型内的轨道序号（0=主轨/第一条）；
        index: 段序号，从 0 开始。
        返回 {"ok": True, "removed": {...}, "track_type": ..., "track_index": ..., "count": 剩余段数}
        或 {"ok": False, "error": 原因}。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        removed = segs.pop(index)
        # 不做重排：保留其余片段的绝对 start（与 move_segment 的自由拖动手感一致，删除不抹掉曾移动留下的空档）
        _collapse_empty_tracks(self.draft)  # 片段移走后留下的空轨自动消失
        save_state(self.state)
        return {
            "ok": True, "removed": removed,
            "track_type": track_type, "track_index": track_index, "count": len(segs),
        }

    def remove_segments(self, keys, ripple=False):
        """批量删除（Ctrl+A 全选后 Delete）。keys 为 ["type:ti:idx", ...]。

        先解析并按 (track_type, track_index, index) 从大到小排序，避免删前段导致同轨后段 index 偏移。
        整批作为一次 undo 记录（save_state 自动入栈），一次 Ctrl+Z 回退全体。
        ripple=True 时（波纹删除）：删除后把后续片段整体左移收拢空隙（对齐 OpenCut ripple delete）。
        """
        self._reload()
        self._push_undo()
        before = copy.deepcopy(self.draft)  # 波纹 diff 的「编辑前」快照
        parsed = []
        for k in (keys or []):
            try:
                t, ti, idx = k.split(":")
                parsed.append((t, int(ti), int(idx)))
            except Exception:
                continue
        # 同轨内 index 从大到小删，保证删前段不影响后段索引
        parsed.sort(key=lambda x: (x[0], x[1], -x[2]))
        removed = 0
        for t, ti, idx in parsed:
            if t not in self.draft:
                continue
            tracks = self.draft[t]
            if ti < 0 or ti >= len(tracks):
                continue
            segs = tracks[ti]
            if idx < 0 or idx >= len(segs):
                continue
            segs.pop(idx)
            removed += 1
        # 波纹必须在折叠空轨之前算：折叠会改变轨道索引，导致 before/after 轨道配对错乱
        if ripple:
            apply_ripple_adjustments(self.draft, compute_ripple_adjustments(before, self.draft))
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        return {"ok": True, "removed": removed}

    def duplicate_segment(self, track_type, track_index, index):
        """复制单段到同轨紧接其后（前端 Ctrl+D / 工具栏「复制」触发，对齐 OpenCut duplicate-selected）。

        - 深拷贝原段，新段 start = 原段 end（紧贴右侧），src_start/src_end 与原段一致（同一素材、内容相同）
        - 插入到 index+1；一次 undo 记录（save_state 自动入栈），一次 Ctrl+Z 回退
        返回 {"ok": True, "new": {...}} 供前端确认。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        seg = segs[index]
        if "src_start" not in seg:
            seg["src_start"] = 0
        if "src_end" not in seg or not seg.get("src_end"):
            real = get_media_duration(seg.get("path")) if seg.get("type") in ("video", "audio") else None
            seg["src_end"] = int(real * 1_000_000) if real else seg["duration"]
        new_seg = copy.deepcopy(seg)
        new_seg["id"] = uuid.uuid4().hex  # 复制出的新段必须重发 id，否则与原段共享 id
        new_seg["start"] = seg["start"] + seg["duration"]   # 紧贴原段右端
        segs.insert(index + 1, new_seg)
        save_state(self.state)
        return {
            "ok": True, "track_type": track_type, "track_index": track_index, "index": index + 1,
            "new": {"start": new_seg["start"], "duration": new_seg["duration"],
                    "src_start": new_seg["src_start"], "src_end": new_seg["src_end"]},
        }

    def copy_to_buffer(self, keys):
        """复制选中段到内存剪贴板（前端 Ctrl+C 触发，对齐 OpenCut copy-selected）。

        不修改草稿、不进撤销栈（只存 Api.copy_buffer 类属性）。
        keys 为 ["type:ti:idx", ...]；每段深拷贝并保留 track_type / original_start，
        以便粘贴时按类型落轨、并保持多段相对间距。返回 {"ok": True, "count": n}。
        """
        parsed = []
        for k in (keys or []):
            try:
                t, ti, idx = k.split(":")
                parsed.append((t, int(ti), int(idx)))
            except Exception:
                continue
        items = []
        for t, ti, idx in parsed:
            if t not in self.draft:
                continue
            tracks = self.draft[t]
            if ti < 0 or ti >= len(tracks):
                continue
            segs = tracks[ti]
            if idx < 0 or idx >= len(segs):
                continue
            seg = segs[idx]
            items.append({"track_type": t, "original_start": seg["start"], "seg": copy.deepcopy(seg)})
        Api.copy_buffer = items
        return {"ok": True, "count": len(items)}

    def paste_from_buffer(self, at_time_us):
        """从内存剪贴板粘贴到播放头位置（前端 Ctrl+V 触发，对齐 OpenCut paste-copied）。

        - 每段按 track_type 落到该类型第一条现有轨；若该类型无轨则新建一条空轨
        - 多段保持相对间距：start = at_time_us + (original_start - min_original_start)
        - 一次 undo 记录（save_state 自动入栈），一次 Ctrl+Z 回退全体
        返回 {"ok": True, "pasted": [新 keys], "count": n}。
        """
        self._reload()
        self._push_undo()
        if not Api.copy_buffer:
            return {"ok": False, "error": "剪贴板为空，先按 Ctrl+C 复制"}
        items = Api.copy_buffer
        min_start = min(it["original_start"] for it in items)
        at = int(at_time_us)
        pasted = []
        for it in items:
            t = it["track_type"]
            if t not in self.draft or not self.draft[t]:
                self.draft.setdefault(t, [])
                self.draft[t].append([])
            tracks = self.draft[t]
            ti = 0  # v1：粘到该类型第一条轨（OpenCut 按 trackType 匹配同类型轨，我们无 trackId 概念故取首轨）
            new_seg = copy.deepcopy(it["seg"])
            new_seg["id"] = uuid.uuid4().hex  # 粘贴出的新段必须重发 id，否则与原段共享 id
            new_seg["start"] = at + (it["original_start"] - min_start)
            tracks[ti].append(new_seg)
            pasted.append(f"{t}:{ti}:{len(tracks[ti]) - 1}")
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        return {"ok": True, "pasted": pasted, "count": len(pasted)}

    def move_segment(self, track_type, track_index, index, new_start_us, ripple=False):
        """把指定轨道第 index 段移动到新的起始时间（微秒）。

        鼠标在时间轴拖动片段后调用。只改该段的 start，不重排后续片段
        （允许片段之间留空档或重叠，符合 PR 的自由拖动手感，后续用吸附处理对齐）。
        track_type: video/audio/text；track_index: 该类型内轨道序号；index: 段序号。
        ripple=True 时（同轨左移波纹）：该段左移后，其右侧空出来的区间让后续片段整体左移收拢。
        返回 {"ok": True, "track_type": ..., "track_index": ..., "index": ..., "start": new_start}。
        """
        self._reload()
        self._push_undo()
        before = copy.deepcopy(self.draft)
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        new_start = max(0, int(new_start_us))
        # 同轨重叠自动避让：拖动到被占位置自动推到最近空位（跳过自身）
        new_start = _free_start_on_track(segs, new_start, segs[index]["duration"], exclude_index=index)
        segs[index]["start"] = new_start
        if ripple:
            apply_ripple_adjustments(self.draft, compute_ripple_adjustments(before, self.draft))
        save_state(self.state)
        return {
            "ok": True, "track_type": track_type, "track_index": track_index,
            "index": index, "start": new_start,
        }

    def _trim_core(self, seg, edge, new_edge_us):
        """片段裁剪的纯计算（不碰 undo/存档），供 trim_segment 与 trim_group 复用。

        edge='left' 往右裁开头（start/src_start 增大、duration 缩短）；edge='right' 拉长/缩短尾
        （duration/src_end 变化）。约束：duration≥0.2s、src_start≥0、不超出素材末尾。
        关键帧随时长变化裁剪（对齐 OpenCut clampAnimationsToDuration）。
        """
        if "src_start" not in seg:
            seg["src_start"] = 0
        if "src_end" not in seg or not seg.get("src_end"):
            real = get_media_duration(seg.get("path")) if seg.get("type") in ("video", "audio") else None
            seg["src_end"] = int(real * 1_000_000) if real else seg["duration"]
        MIN = 200_000
        start = seg["start"]; dur = seg["duration"]; ss = seg["src_start"]; se_ = seg["src_end"]
        speed = _seg_speed(seg)
        new_edge = int(new_edge_us)
        if edge == "left":
            delta = max(int(-ss / speed), min(new_edge - start, dur - MIN))
            seg["start"] = start + delta
            seg["src_start"] = ss + int(round(delta * speed))
            seg["duration"] = dur - delta
        elif edge == "right":
            max_dur = int((se_ - ss) / speed)
            delta = max(MIN - dur, min(new_edge - (start + dur), max_dur - dur))
            seg["duration"] = dur + delta
            seg["src_end"] = se_ + int(round(delta * speed))
        else:
            raise ValueError("edge 必须是 left 或 right")
        seg["animations"] = _clamp_animations_to_duration(_seg_anims(seg), seg["duration"])

    def trim_segment(self, track_type, track_index, index, edge, new_edge_us, ripple=False):
        """片段双向裁剪：edge='left' 拖左把手（裁/拉开头），edge='right' 拖右把手（缩/拉尾）。

        new_edge_us 是片段新的左边界（left）或右边界（right）时间轴位置（微秒）。
        - 左把手往右拖 = 裁掉开头：start 增大、src_start 增大、duration 缩短；往左拖回 src_start 减小到 0。
        - 右把手往左拖 = 缩短：duration 减小；往右拖拉长，但不超过素材末尾(src_end - src_start)。
        约束：duration 最小 0.2 秒；左把手 src_start 不能<0；右把手不超出素材真实长度。
        ripple=True 时（右边界裁短波纹）：裁短后其右侧空出来的区间让后续片段整体左移收拢。
        返回裁剪后的 start/duration/src_start/src_end，供前端确认落盘结果。
        """
        self._reload()
        self._push_undo()
        before = copy.deepcopy(self.draft)
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        seg = segs[index]
        # 裁剪的纯计算（含旧片段 src 兼容、关键帧裁剪）抽到 _trim_core，trim_group 复用同逻辑
        try:
            self._trim_core(seg, edge, new_edge_us)
        except ValueError:
            return {"ok": False, "error": "edge 必须是 left 或 right"}
        if ripple:
            apply_ripple_adjustments(self.draft, compute_ripple_adjustments(before, self.draft))
        save_state(self.state)
        return {
            "ok": True, "track_type": track_type, "track_index": track_index, "index": index,
            "start": seg["start"], "duration": seg["duration"],
            "src_start": seg["src_start"], "src_end": seg["src_end"],
        }

    def move_group(self, members):
        """原子地移动一组片段，保持相对时间/轨道布局（对齐 OpenCut resolveGroupMove）。

        members: [{track_type, track_index, index, to_track, at_time_us}]
          - to_track 为已有同类型轨道序号；-1 表示在该类型末尾新建一条轨接住。
          - at_time_us 为目标起始时间（微秒）。
        所有片段一次性按对象引用取出、再依次放置，单次 undo。相对间距由调用方（前端）
        在传入的 at_time_us / to_track 里保证，后端只做落点避让（_free_start_on_track）。
        返回 {"ok": True, "moved":[{track_type,track_index,index,start}...]}。
        """
        self._reload()
        self._push_undo()
        collected = []
        for m in members:
            t = m["track_type"]; ti = int(m["track_index"]); idx = int(m["index"])
            if t not in self.draft:
                return {"ok": False, "error": f"未知轨道类型：{t}"}
            segs = self.draft[t]
            if ti < 0 or ti >= len(segs) or idx < 0 or idx >= len(segs[ti]):
                return {"ok": False, "error": f"{t}[{ti}] 没有第 {idx} 段"}
            collected.append((t, ti, idx, segs[ti][idx], m))
        # 1) 一次性取出（按对象引用移除，避免索引错位）
        for (t, ti, idx, seg, m) in collected:
            self.draft[t][ti].remove(seg)
        # 2) 依次放置：同一目标轨的片段沿用 _free_start_on_track 保持不重叠
        #    to_track==-1（新建轨接住）在整组语义下只建【一条】新轨，整组落入其中（按类型分组）
        shared_new = {}
        finals = []
        for (t, ti, idx, seg, m) in collected:
            to_track = m.get("to_track")
            if to_track is not None and to_track != -1:
                to_idx = _ensure_track(self.draft, t, to_track)
            else:
                if shared_new.get(t) is None:
                    shared_new[t] = _ensure_track(self.draft, t, -1)
                to_idx = shared_new[t]
            to_segs = self.draft[t][to_idx]
            desired = max(0, int(m.get("at_time_us") or 0))
            start = _free_start_on_track(to_segs, desired, seg["duration"])
            seg["start"] = start
            to_segs.append(seg)
            _clear_persistent_if_needed(self.draft, t, to_idx)
            finals.append({"track_type": t, "track_index": to_idx, "index": len(to_segs) - 1, "start": start})
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        return {"ok": True, "moved": finals}

    def scale_group(self, members):
        """原子地整组时间缩放（对齐 OpenCut group-resize 的「缩放」语义，非裁剪）。

        拖拽整组右/左把手 → 整组时间跨度按 factor 拉伸/压缩；每个成员：
          new_duration = duration * factor（最小 0.2s）
          new_speed    = speed / factor（剪辑变速：展示同一段源内容、时间拉伸；clamp 到 [0.01,5]）
          new_start    = 调用方按组锚点算好的新起始（保持相对布局）
        关键帧的局部时间 t 同步乘 factor（段内时间轴缩放）。单次 undo。
        返回 {"ok": True, "scaled":[{track_type,track_index,index,start,duration,speed}...]}。
        """
        self._reload()
        self._push_undo()
        scaled = []
        for m in members:
            t = m["track_type"]; ti = int(m["track_index"]); idx = int(m["index"])
            factor = float(m["factor"]); new_start = int(m["new_start_us"])
            if t not in self.draft:
                return {"ok": False, "error": f"未知轨道类型：{t}"}
            segs = self.draft[t]
            if ti < 0 or ti >= len(segs) or idx < 0 or idx >= len(segs[ti]):
                return {"ok": False, "error": f"{t}[{ti}] 没有第 {idx} 段"}
            seg = segs[ti][idx]
            MIN = 200_000
            new_dur = max(MIN, int(round(seg["duration"] * factor)))
            # 关键帧局部时间随段时长缩放（对齐 OpenCut 时间轴缩放影响动画）
            anims = _seg_anims(seg)
            for path, ch in anims.items():
                for k in ch.get("keys", []):
                    k["t"] = max(0, int(round(k["t"] * factor)))
            seg["animations"] = _clamp_animations_to_duration(anims, new_dur)
            seg["duration"] = new_dur
            seg["start"] = max(0, new_start)
            sp = _seg_speed(seg) / factor   # 反向变速：时长拉伸→变慢
            sp = max(0.01, min(5.0, sp))
            seg["speed"] = sp
            scaled.append({"track_type": t, "track_index": ti, "index": idx,
                           "start": seg["start"], "duration": seg["duration"], "speed": sp})
        save_state(self.state)
        return {"ok": True, "scaled": scaled}

    # ---------- 遮罩 masks（对齐 OpenCut masks 数据模型；导出走 pyJianYingDraft.add_mask） ----------
    # 单遮罩模型：每个片段 seg["masks"] = [Mask]，贴合剪映草稿「每段仅一个 mask」的限制。
    # Mask = {id, type, params}；params 字段对齐 OpenCut（归一化 0..1 元素空间）：
    #   centerX/centerY 为中心相对元素中心的偏移（占整元素宽/高比例，边缘在 ±0.5）
    #   width/height    为遮罩形状占整元素宽/高的比例
    #   rotation(度)/scale(倍率)/feather(0..100)/inverted(bool) + stroke*(描边，预览用)
    _MASK_TYPES = ("rectangle", "ellipse", "star", "heart", "diamond", "split", "cinematic-bars")

    def _seg_ref(self, track_type, track_index, index):
        if track_type not in self.draft:
            return None
        segs = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(segs):
            return None
        if not isinstance(index, int) or index < 0 or index >= len(segs[track_index]):
            return None
        return segs[track_index][index]

    def _default_mask_params(self, mask_type, params):
        base = {
            "centerX": 0.0, "centerY": 0.0, "width": 0.6, "height": 0.6,
            "rotation": 0.0, "scale": 1.0, "feather": 0, "inverted": False,
            "strokeColor": "#ffffff", "strokeWidth": 0, "strokeAlign": "center",
        }
        # split / cinematic-bars 只用部分字段，多传的会被前端忽略
        base.update(params or {})
        return base

    def set_mask(self, track_type, track_index, index, mask_type, params):
        """给选中段设置/替换一个遮罩（覆盖式单遮罩）。返回 {"ok": True, "mask": {...}}。"""
        if mask_type not in self._MASK_TYPES:
            return {"ok": False, "error": f"未知遮罩类型：{mask_type}"}
        self._reload()
        seg = self._seg_ref(track_type, track_index, index)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        mask = {
            "id": uuid.uuid4().hex,
            "type": mask_type,
            "params": self._default_mask_params(mask_type, params or {}),
        }
        seg["masks"] = [mask]
        save_state(self.state)
        return {"ok": True, "mask": mask}

    def remove_mask(self, track_type, track_index, index, mask_id):
        self._reload()
        seg = self._seg_ref(track_type, track_index, index)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        seg["masks"] = [m for m in seg.get("masks", []) if m.get("id") != mask_id]
        save_state(self.state)
        return {"ok": True}

    def toggle_mask_inverted(self, track_type, track_index, index, mask_id):
        self._reload()
        seg = self._seg_ref(track_type, track_index, index)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        for m in seg.get("masks", []):
            if m.get("id") == mask_id:
                m["params"]["inverted"] = not bool(m["params"].get("inverted", False))
        save_state(self.state)
        return {"ok": True}

    def update_mask_param(self, track_type, track_index, index, mask_id, key, value):
        self._reload()
        seg = self._seg_ref(track_type, track_index, index)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        for m in seg.get("masks", []):
            if m.get("id") == mask_id:
                m["params"][key] = value
        save_state(self.state)
        return {"ok": True}

    def update_mask(self, track_type, track_index, index, mask_id, params):
        """批量合并遮罩参数（拖拽把手时一次性提交，单次 undo）。"""
        self._reload()
        seg = self._seg_ref(track_type, track_index, index)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        for m in seg.get("masks", []):
            if m.get("id") == mask_id:
                m["params"].update(params or {})
        save_state(self.state)
        return {"ok": True}

    def _split_segment_core(self, track_type, track_index, index, at_time_us):
        """公共分割逻辑：切点检查、修改左段、生成右段并插入 index+1。
        不调用 save_state，供 split_segment / split_left / split_right 复用。
        成功返回 {"ok": True, "seg": 左段, "right": 右段, "at": 切点, "index": 原index}。
        失败返回 {"ok": False, "error": ...}。
        """
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        tracks = self.draft[track_type]
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        segs = tracks[track_index]
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        seg = segs[index]
        # 兼容旧片段缺 src 字段
        if "src_start" not in seg:
            seg["src_start"] = 0
        if "src_end" not in seg or not seg.get("src_end"):
            real = get_media_duration(seg.get("path")) if seg.get("type") in ("video", "audio") else None
            seg["src_end"] = int(real * 1_000_000) if real else seg["duration"]
        MIN = 200_000  # 切点距两端最小 0.2 秒
        start = seg["start"]; dur = seg["duration"]; ss = seg["src_start"]; se_ = seg["src_end"]
        speed = _seg_speed(seg)
        at = int(at_time_us)
        if at <= start or at >= start + dur:
            return {"ok": False, "error": "分割点不在该片段内部"}
        local = at - start
        if local < MIN or (dur - local) < MIN:
            return {"ok": False, "error": "分割点离片段两端太近（需 >0.2 秒）"}
        # 切点对应的源位置：src_delta = local * speed
        split_src = ss + int(round(local * speed))
        # 前段：原地缩短
        seg["duration"] = local
        seg["src_end"] = split_src
        # 关键帧随分割点拆分（对齐 OpenCut splitAnimationsAtTime）：左段保留 <=local 的键，
        # 右段保留 >=local 的键并减 local，两段边界处自然各持一个键保持连续性。
        left_anims, right_anims = _split_animations(_seg_anims(seg), local)
        seg["animations"] = left_anims
        # 后段：深拷贝基础字段（防未来加嵌套参数如特效/关键帧时左右段共享子对象互相污染），重设 start / duration / src_start / src_end，插到 index+1
        right = copy.deepcopy(seg)
        right["animations"] = right_anims
        right["id"] = uuid.uuid4().hex  # 右段是新段，必须重发 id（否则与左段共享 id，波纹 diff 错配）
        right["start"] = at
        right["duration"] = dur - local
        right["src_start"] = split_src
        right["src_end"] = se_
        segs.insert(index + 1, right)
        return {"ok": True, "seg": seg, "right": right, "at": at, "index": index}

    def split_segment(self, track_type, track_index, index, at_time_us):
        """在指定位置把一段素材切成两段（前端 S / Ctrl+B / 工具栏「分割」触发）。保留左右两段。

        at_time_us 是时间轴位置（微秒），必须落在该段内部（start, start+duration）。
        - 前段（原地）：start 不变，duration = at - start，src_end = src_start + 新duration
        - 后段（插入 index+1）：start = at，duration = 原duration - (at-start)，src_start = src_start + (at-start)
        约束：切点距两端都需 >0.2 秒，否则返回错误（避免切出极小片段）。
        返回 {"ok": True, "left": {...}, "right": {...}} 供前端确认。
        """
        self._reload()
        self._push_undo()
        result = self._split_segment_core(track_type, track_index, index, at_time_us)
        if "error" in result:
            return result
        save_state(self.state)
        left = result["seg"]
        right = result["right"]
        at = result["at"]
        ss = left["src_start"]
        return {
            "ok": True, "track_type": track_type, "track_index": track_index, "index": index, "at": at,
            "left":  {"start": left["start"], "duration": left["duration"], "src_start": ss, "src_end": left["src_end"]},
            "right": {"start": right["start"], "duration": right["duration"], "src_start": right["src_start"], "src_end": right["src_end"]},
        }

    def split_segment_left(self, track_type, track_index, index, at_time_us, ripple=False):
        """在指定位置分割，保留左段，删除右段（OpenCut split-left，快捷键 Q / 工具栏 ◀✂）。

        ripple=True 时（波纹删右半）：删掉右段后，其右侧空出来的区间让后续片段整体左移收拢；
        播放头应 seek 到切点 at（前端在 ripple 开启时据此跳转，对齐 OpenCut split-left 的 playhead seek）。
        """
        self._reload()
        self._push_undo()
        before = copy.deepcopy(self.draft)
        result = self._split_segment_core(track_type, track_index, index, at_time_us)
        if "error" in result:
            return result
        segs = self.draft[track_type][track_index]
        segs.pop(result["index"] + 1)  # 删除右段
        # 波纹须在折叠空轨前算（轨道索引稳定配对）
        if ripple:
            apply_ripple_adjustments(self.draft, compute_ripple_adjustments(before, self.draft))
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        left = result["seg"]
        return {
            "ok": True, "retained": "left", "track_type": track_type, "track_index": track_index, "index": index, "at": result["at"],
            "left": {"start": left["start"], "duration": left["duration"], "src_start": left["src_start"], "src_end": left["src_end"]},
        }

    def split_segment_right(self, track_type, track_index, index, at_time_us):
        """在指定位置分割，保留右段，删除左段（OpenCut split-right，快捷键 W / 工具栏 ✂▶）。"""
        self._reload()
        self._push_undo()
        result = self._split_segment_core(track_type, track_index, index, at_time_us)
        if "error" in result:
            return result
        segs = self.draft[track_type][track_index]
        segs.pop(result["index"])  # 删除左段
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        right = segs[result["index"]]  # 右段删除左段后左移到原 index
        return {
            "ok": True, "retained": "right", "track_type": track_type, "track_index": track_index, "index": index, "at": result["at"],
            "right": {"start": right["start"], "duration": right["duration"], "src_start": right["src_start"], "src_end": right["src_end"]},
        }


    def relocate_segment(self, track_type, from_track, index, to_track, at_time_us=None, insert_index=None):
        """把一个已存在的片段从 (track_type, from_track, index) 移动到目标轨道。

        to_track 为同类型已有轨道序号；to_track=-1 表示自动新建一条该类型轨道接住。
        落点 at_time_us（微秒）来自拖拽松手横向位置；为 None 则置 0。
        同轨重叠自动避让：落到被占位置会自动推到该轨最近空位。
        源轨道不重排（留空档，PR 式自由）；返回落地后的真实 track_type/track_index/index/start。
        """
        self._reload()
        self._push_undo()
        if track_type not in self.draft:
            return {"ok": False, "error": f"未知轨道类型：{track_type}"}
        from_tracks = self.draft[track_type]
        if not isinstance(from_track, int) or from_track < 0 or from_track >= len(from_tracks):
            return {"ok": False, "error": f"{track_type} 没有第 {from_track} 条轨道"}
        from_segs = from_tracks[from_track]
        if not isinstance(index, int) or index < 0 or index >= len(from_segs):
            return {"ok": False, "error": f"{track_type}[{from_track}] 没有第 {index} 段"}
        seg = from_segs.pop(index)  # 从源轨取出（不重排源轨，留空档）
        # 目标轨道：to_track 为已有轨道序号；to_track 为 None/-1（前端传 null）表示「新建一条该类型轨道接住」，
        # 此时若给了 insert_index 则在指定位置插入（拖到两条轨道中间的空隙），否则追加到末尾。
        if to_track is not None and to_track != -1:
            to_idx = _ensure_track(self.draft, track_type, to_track)
        elif insert_index is not None:
            to_idx = _insert_track(self.draft, track_type, insert_index)
        else:
            to_idx = _ensure_track(self.draft, track_type, -1)
        to_segs = self.draft[track_type][to_idx]
        desired = max(0, int(at_time_us)) if at_time_us is not None else 0
        # 同轨重叠自动避让（目标轨里此刻没有这个片段，无需 exclude）
        start = _free_start_on_track(to_segs, desired, seg["duration"])
        seg["start"] = start
        to_segs.append(seg)
        # 目标轨道被放入片段，取消 persistent_empty 标记
        _clear_persistent_if_needed(self.draft, track_type, to_idx)
        # 片段移动后，源轨可能变空；空轨按「有素材保留、没素材消失」自动折叠。
        # 新轨已有素材，不会被折叠，因此新建轨场景也安全。
        _collapse_empty_tracks(self.draft)
        # 定位被移动片段的真实位置（折叠可能改变了轨道索引）
        tracks = self.draft[track_type]
        final_ti, final_idx = to_idx, len(to_segs) - 1
        for ti in range(len(tracks)):
            if seg in tracks[ti]:
                final_ti = ti
                final_idx = tracks[ti].index(seg)
                break
        save_state(self.state)
        return {
            "ok": True, "track_type": track_type, "track_index": final_ti,
            "index": final_idx, "start": start,
        }

    def add_video_track(self, insert_index=None):
        """新增一条视频覆盖轨。insert_index=None 时追加到最上（主轨之上）；否则插入到指定位置。

        通过「＋轨」按钮显式创建的空轨会标记 persistent_empty，避免立刻被折叠消失。
        """
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("video", [[]])
        if insert_index is None:
            tracks.append([])
            idx = len(tracks) - 1
        else:
            idx = _insert_track(self.draft, "video", insert_index)
        _set_track_persistent(self.draft, "video", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "video", "track_index": idx, "count": len(tracks)}

    def delete_video_track(self, track_index):
        """删除一条视频覆盖轨。主视频轨（index=0）不可删除。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("video", [[]])
        if track_index == 0:
            return {"ok": False, "error": "主视频轨不可删除"}
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"video 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        tracks.pop(track_index)
        _remove_track_meta(self.draft, "video", track_index)
        save_state(self.state)
        return {"ok": True, "track_type": "video", "track_index": track_index, "count": len(tracks)}

    def add_audio_track(self, insert_index=None):
        """新增一条音频轨。insert_index=None 时追加到最下；否则插入到指定位置。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("audio", [[]])
        if insert_index is None:
            tracks.append([])
            idx = len(tracks) - 1
        else:
            idx = _insert_track(self.draft, "audio", insert_index)
        _set_track_persistent(self.draft, "audio", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "audio", "track_index": idx, "count": len(tracks)}

    def delete_audio_track(self, track_index):
        """删除一条音频轨。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("audio", [[]])
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"audio 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        tracks.pop(track_index)
        _remove_track_meta(self.draft, "audio", track_index)
        save_state(self.state)
        return {"ok": True, "track_type": "audio", "track_index": track_index, "count": len(tracks)}

    def add_text_track(self, insert_index=None):
        """新增一条文本轨（字幕/贴纸/画中画文字多用，支持多轨堆叠）。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("text", [[]])
        if insert_index is None:
            tracks.append([])
            idx = len(tracks) - 1
        else:
            idx = _insert_track(self.draft, "text", insert_index)
        _set_track_persistent(self.draft, "text", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "text", "track_index": idx, "count": len(tracks)}

    def delete_text_track(self, track_index):
        """删除一条文本轨。文本无主锚点，任意轨可删；删空则保留 [[]] 维持不变量。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("text", [[]])
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"text 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        tracks.pop(track_index)
        _remove_track_meta(self.draft, "text", track_index)
        if len(tracks) == 0:
            tracks.append([])  # 保持 list-of-list 不变量，避免后续渲染/导出崩溃
        save_state(self.state)
        return {"ok": True, "track_type": "text", "track_index": track_index, "count": len(tracks)}

    # ---- 贴纸轨（本地透明 PNG/WebP 叠加；离线可用，不依赖网络贴纸库）----

    def _ensure_sticker_track(self, track_index):
        """确保 sticker 轨存在并返回 (tracks, idx)。track_index=None 用 sticker[0]。"""
        tracks = self.draft.setdefault("sticker", [[]])
        if not tracks:
            tracks.append([])
        if track_index is None:
            idx = 0
        else:
            while len(tracks) <= track_index:
                tracks.append([])
            idx = track_index
        return tracks, idx

    def add_sticker_track(self, insert_index=None):
        """新增一条贴纸轨（叠加在最上层，盖住视频/文本之下）。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("sticker", [[]])
        if insert_index is None:
            # 若只有初始化占位的空轨，则复用它作为第一条真实贴纸轨（index 0），否则追加新轨
            if len(tracks) == 1 and not tracks[0]:
                idx = 0
            else:
                tracks.append([])
                idx = len(tracks) - 1
        else:
            idx = _insert_track(self.draft, "sticker", insert_index)
        _set_track_persistent(self.draft, "sticker", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "sticker", "track_index": idx, "count": len(tracks)}

    def delete_sticker_track(self, track_index):
        """删除一条贴纸轨。删空则保留 [[]] 维持不变量。"""
        self._reload()
        self._push_undo()
        tracks = self.draft.setdefault("sticker", [[]])
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(tracks):
            return {"ok": False, "error": f"sticker 没有第 {track_index} 条轨道（共 {len(tracks)} 条）"}
        tracks.pop(track_index)
        _remove_track_meta(self.draft, "sticker", track_index)
        if len(tracks) == 0:
            tracks.append([])
        save_state(self.state)
        return {"ok": True, "track_type": "sticker", "track_index": track_index, "count": len(tracks)}

    def add_sticker(self, track_index, path, start_us, duration_us, transform=None, name=None):
        """把一张本地透明图片（PNG/WebP 等）作为贴纸段加到贴纸轨。

        path: 原始图片绝对路径（会复制进 assets/，离线可用）；start_us/duration_us：微秒。
        transform: 可选 {x,y,scale,rotation,opacity,flipH,flipV}（归一化 -1~1 偏移 / 倍率 / 角度 / 0~1）。
        导出剪映时用 VideoSegment(path, clip_settings=ClipSettings(...)) 放在叠加轨，位置/缩放/旋转/透明度/翻转全部还原。
        返回 {ok, track_index, index} 或 {ok:False, error}。
        """
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": f"贴纸图片不存在：{path}"}
        if classify(path) not in ("image", "sticker"):
            return {"ok": False, "error": f"不是图片文件（贴纸需 PNG/WebP 等）：{os.path.basename(path)}"}
        try:
            start_us = int(start_us)
            duration_us = int(duration_us)
        except Exception:
            return {"ok": False, "error": "start/duration 必须是整数微秒"}
        if duration_us <= 0:
            return {"ok": False, "error": "贴纸时长必须 > 0"}
        self._reload()
        self._push_undo()
        dst = copy_to_assets(path)
        if not dst:
            return {"ok": False, "error": "贴纸图片复制进项目失败"}
        # 读取原始宽高（导出剪映时把「画布占比」换算成 ClipSettings 的真实缩放）
        natural_w = natural_h = None
        try:
            from PIL import Image
            with Image.open(dst) as im:
                natural_w, natural_h = im.size
        except Exception:
            pass
        tracks, idx = self._ensure_sticker_track(track_index)
        tf = dict(DEFAULT_STICKER_TRANSFORM)
        if isinstance(transform, dict):
            for k in ("x", "y", "scale", "rotation", "opacity", "flipH", "flipV"):
                if k in transform:
                    tf[k] = transform[k]
        seg = {
            "name": name or os.path.basename(dst),
            "path": dst,
            "type": "sticker",
            "start": start_us,
            "duration": duration_us,
            "src_start": 0,
            "src_end": duration_us,
            "speed": 1.0,
            "change_pitch": False,
            "natural_w": natural_w,
            "natural_h": natural_h,
            "transform": tf,
            "animations": {},
            "masks": [],
        }
        tracks[idx].append(seg)
        _ensure_seg_ids(self.draft)
        save_state(self.state)
        return {"ok": True, "track_index": idx, "index": len(tracks[idx]) - 1}

    def update_sticker(self, track_type, track_index, index, patch):
        """更新贴纸段：patch 可含 name，或 transform 子字段（x/y/scale/rotation/opacity/flipH/flipV），
        或直接平铺这些字段。单次 undo。"""
        if track_type not in ("sticker",):
            return {"ok": False, "error": f"update_sticker 仅支持 sticker，收到 {track_type}"}
        self._reload()
        seg = self._seg_ref(track_type, track_index, index)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        if not isinstance(patch, dict):
            return {"ok": False, "error": "patch 必须是字典"}
        if "name" in patch:
            seg["name"] = patch["name"]
        tf = seg.setdefault("transform", dict(DEFAULT_STICKER_TRANSFORM))
        if "transform" in patch and isinstance(patch["transform"], dict):
            tf.update({k: v for k, v in patch["transform"].items()
                       if k in ("x", "y", "scale", "rotation", "opacity", "flipH", "flipV")})
        for k in ("x", "y", "scale", "rotation", "opacity", "flipH", "flipV"):
            if k in patch:
                tf[k] = patch[k]
        save_state(self.state)
        return {"ok": True}

    # ---- 字幕（ASR / SRT 导入）----

    # 字幕默认样式（对齐 OpenCut：底部居中、白字粗体、自动换行、可选黑底）
    DEFAULT_SUB_STYLE = {
        "font_size": 10.0, "bold": True, "color": "#ffffff",
        "align": 1, "bg": False, "bg_color": "#000000",
    }

    def _ensure_text_track(self, track_index):
        """确保 text 轨存在并返回 (tracks, idx)。track_index=None 用 text[0]。"""
        tracks = self.draft.setdefault("text", [[]])
        if not tracks:
            tracks.append([])
        if track_index is None:
            idx = 0
        else:
            while len(tracks) <= track_index:
                tracks.append([])
            idx = track_index
        return tracks, idx

    def _build_sub_seg(self, cue, style):
        """把一个 cue（秒为单位）转成 text 段。"""
        start = float(cue.get("start", 0) or 0)
        dur = float(cue.get("duration", 0) or 0)
        if dur <= 0 and "end" in cue and cue["end"] is not None:
            dur = float(cue["end"]) - start
        start_us = int(start * 1_000_000)
        dur_us = max(200_000, int(dur * 1_000_000))  # 至少 0.2s，避免零长段
        text = (cue.get("text") or "").strip()
        merged = dict(self.DEFAULT_SUB_STYLE)
        if isinstance(style, dict):
            merged.update(style)
        return {
            "name": (text[:18] + "…") if len(text) > 18 else (text or "字幕"),
            "path": "",            # 文本段无素材文件
            "type": "text",
            "text": text,
            "start": start_us,
            "duration": dur_us,
            "src_start": 0,
            "src_end": dur_us,
            "speed": 1.0,
            "change_pitch": False,
            "animations": {},
            "sub_style": merged,
        }

    def add_subtitles(self, track_index, cues, style=None):
        """批量把 [{text,start,duration}]（秒）插成 text 轨字幕段。

        每段带字幕默认样式（底部居中/白字粗体/自动换行/可选黑底），导出剪映时
        由 _seg_text_segment 读取 seg.sub_style 还原。返回插入段数。
        """
        if not isinstance(cues, list) or not cues:
            return {"ok": False, "error": "cues 必须是非空列表"}
        self._reload()
        self._push_undo()
        tracks, idx = self._ensure_text_track(track_index)
        segs = []
        for c in cues:
            if not (c.get("text") or "").strip():
                continue
            segs.append(self._build_sub_seg(c, style))
        if not segs:
            return {"ok": False, "error": "没有有效字幕文本"}
        tracks[idx].extend(segs)
        _ensure_seg_ids(self.draft)
        save_state(self.state)
        return {"ok": True, "track_index": idx, "count": len(segs)}

    def import_srt(self, track_index, srt_text, style=None):
        """解析 SRT 文本 → 字幕段插入 text 轨。复用标准 SRT 时间戳解析（自实现）。"""
        cues = _parse_srt(srt_text)
        if not cues:
            return {"ok": False, "error": "未能从 SRT 解析出任何字幕"}
        return self.add_subtitles(track_index, cues, style)

    def transcribe_media(self, path, language="auto", model_size="small", style=None):
        """本地 Whisper 识别（faster-whisper）：抽音频 → 识别 → 生成字幕段。

        language: auto/zh/en/ja/ko/fr/de/es/ru；model_size: tiny/small/base（越小越快）。
        返回 {"ok":True,"count":N,"language":...,"track_index":...} 或 {"ok":False,"error":...}。
        注意：模型首次需联网下载（~几十~几百 MB），CPU 推理长视频偏慢，前端应显示「识别中」。
        """
        if not path or not os.path.isfile(path):
            return {"ok": False, "error": f"媒体文件不存在：{path}"}
        try:
            import faster_whisper
        except Exception:
            return {"ok": False, "error": "未安装 faster-whisper，请先 pip install faster-whisper"}
        wlang = None if language in ("auto", None, "") else str(language)
        model_size = model_size or "small"
        try:
            model = _get_whisper_model(model_size)
        except Exception as e:
            return {"ok": False, "error": f"Whisper 模型加载失败（首次需联网下载）：{e}"}
        fd, wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            ok = _extract_audio_wav(path, wav)
            if not ok:
                return {"ok": False, "error": "ffmpeg 抽取音频失败"}
            segments, info = model.transcribe(
                wav, language=wlang, beam_size=5,
                vad_filter=True, condition_on_previous_text=False,
            )
            cues = []
            for s in segments:
                if not s.text or not s.text.strip():
                    continue
                cues.append({
                    "text": s.text.strip(),
                    "start": float(s.start or 0),
                    "duration": max(0.2, float(s.end or 0) - float(s.start or 0)),
                })
        except Exception as e:
            return {"ok": False, "error": f"识别失败：{e}"}
        finally:
            try:
                os.remove(wav)
            except Exception:
                pass
        if not cues:
            return {"ok": True, "count": 0, "language": wlang or "auto", "track_index": None}
        res = self.add_subtitles(0, cues, style)
        if not res.get("ok"):
            return res
        return {
            "ok": True, "count": res["count"], "track_index": res["track_index"],
            "language": getattr(info, "language", wlang or "auto"),
        }

    def set_track_meta(self, track_type, track_index, field, value):
        """设置某条轨道的显示/声音/尺寸元数据（前端轨道开关 & 高度用）。

        field 取值：
          'hidden'（隐藏画面，bool）、'muted'（静音声音，bool）、
          'height'（轨道高度像素，int，28~240 钳制）。
        该元数据仅前端预览用，不参与剪映草稿导出，也不影响 AI agent 的剪辑语义。
        """
        if track_type not in ("video", "audio", "text", "sticker"):
            return {"ok": False, "error": f"未知轨道类型 {track_type}"}
        self._reload()
        meta = _ensure_track_meta(self.draft, track_type)
        while len(meta) <= track_index:
            meta.append({})
        if field in ("hidden", "muted"):
            meta[track_index][field] = bool(value)
        elif field == "height":
            try:
                h = int(value)
            except Exception:
                return {"ok": False, "error": "height 必须为整数"}
            h = max(28, min(240, h))   # 合理范围：太矮拖不动、太高撑爆布局
            meta[track_index]["height"] = h
        else:
            return {"ok": False, "error": f"未知字段 {field}"}
        save_state(self.state)
        return {"ok": True, "track_type": track_type, "track_index": track_index,
                "field": field, "value": meta[track_index][field]}

    def set_canvas(self, ratio):
        """设置画布（画幅）比例，例如 '16:9' / '9:16' / '4:3' / '3:4' / '1:1'。

        属于用户手动选择，会锁定画布（locked=True），此后拖入素材不再自动改比例。
        返回新画布状态。
        """
        if ratio not in CANVAS_PRESETS:
            return {"ok": False, "error": f"不支持的画布比例：{ratio}",
                    "supported": list(CANVAS_PRESETS.keys())}
        self._reload()
        self._push_undo()
        canvas = self.draft.setdefault("canvas", {"ratio": DEFAULT_CANVAS, "locked": False})
        canvas["ratio"] = ratio
        canvas["locked"] = True  # 手动选择即锁定，不再被素材自动覆盖
        save_state(self.state)
        return {"ok": True, "canvas": canvas}

    def reset_canvas_lock(self):
        """解除画布锁定：回到「由主轨第一段素材自动决定比例」的模式。"""
        self._reload()
        self._push_undo()
        canvas = self.draft.setdefault("canvas", {"ratio": DEFAULT_CANVAS, "locked": False})
        canvas["locked"] = False
        save_state(self.state)
        return {"ok": True, "canvas": canvas}

    def select_folder(self):
        """弹系统文件夹选择框，返回选中的文件夹路径（字符串）或 None。"""
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        if result and isinstance(result, (list, tuple)) and len(result) > 0:
            return result[0]
        return None

    def get_default_export_folder(self):
        """返回用户上次记住的默认导出路径（或 None）。"""
        return get_setting("default_export_folder", None)

    def set_default_export_folder(self, folder):
        """记住默认导出路径。"""
        if folder and os.path.isdir(folder):
            return set_setting("default_export_folder", folder)
        return False

    def export_draft(self, name, folder):
        """把内存里的草稿状态（self.draft）落盘成标准剪映草稿文件夹。

        name: 草稿名（即子文件夹名）；folder: 用户选的保存目录（任意路径，选哪存哪）。
        多轨导出：按 video[0..N] 顺序 append_track，append 越晚越靠上，因此 video[-1] 会盖住 video[0]。
        同一条 pyJianYingDraft 轨道内不允许片段重叠；若我们某条轨内仍有重叠，会跳过并报到 skipped。
        返回 {"ok": True, "path": 草稿文件夹, "segments": 成功段数, "skipped": [...]}
        或 {"ok": False, "error": 原因}。
        """
        self._reload()
        has_any = any(
            seg for k in ("video", "audio", "text", "sticker")
            for track in self.draft.get(k, [])
            for seg in track
        )
        if not has_any:
            return {"ok": False, "error": "草稿还是空的，先双击素材进轨"}
        folder = folder or ""
        if not folder:
            # 未指定目录时，默认导出到项目内 exports/（自动创建），符合「记住默认导出路径」设计
            folder = os.path.join(HERE, "exports")
        if not os.path.isdir(folder):
            try:
                os.makedirs(folder, exist_ok=True)
            except OSError:
                return {"ok": False, "error": f"无法创建导出目录：{folder}"}
        name = (name or "").strip()
        if not name:
            return {"ok": False, "error": "请填写草稿名称"}

        try:
            # 画布（画幅）比例：按所选预设计算导出分辨率（较长边 = CANVAS_BASE，剪映 1080 级）。
            canvas = self.draft.get("canvas", {"ratio": DEFAULT_CANVAS})
            preset = CANVAS_PRESETS.get(canvas.get("ratio", DEFAULT_CANVAS), CANVAS_PRESETS[DEFAULT_CANVAS])
            if preset["w"] >= preset["h"]:
                W = CANVAS_BASE
                H = int(round(CANVAS_BASE * preset["h"] / preset["w"]))
            else:
                H = CANVAS_BASE
                W = int(round(CANVAS_BASE * preset["w"] / preset["h"]))
            df = DraftFolder(folder)
            script = df.create_draft(name, W, H, 30, allow_replace=True)

            ok_count = 0
            skipped = []
            # 视频轨：按 our_video[0]（主/底）→ our_video[-1]（最上）顺序 append，
            # pyJianYingDraft 每次 append 都加在当前最上层，因此顺序正确。
            video_track_names = []
            for i, _ in enumerate(self.draft.get("video", [])):
                tname = f"video_{i}"
                script.append_track(TrackSpec(TrackType.video, name=tname))
                video_track_names.append(tname)
            # 音频轨：同理，多条音轨混音
            audio_track_names = []
            for i, _ in enumerate(self.draft.get("audio", [])):
                tname = f"audio_{i}"
                script.append_track(TrackSpec(TrackType.audio, name=tname))
                audio_track_names.append(tname)
            # 贴纸轨：分两类导出（对齐我们离线贴纸模型）
            #  - 本地图片贴纸（有 path）：放叠加 video 轨，用 VideoSegment + ClipSettings 还原位置/缩放/旋转/透明度/翻转
            #  - 导入的剪映贴纸（有 resource_id，无 path）：放 sticker 轨，用 StickerSegment
            # 两类各自建轨，互不干扰；放在音频之后、文本之前 → 预览 z 序一致（文本在最上）。
            for ti, segs in enumerate(self.draft.get("sticker", [])):
                path_segs = [s for s in segs if s.get("path") and os.path.isfile(s["path"])]
                res_segs = [s for s in segs if not s.get("path") and s.get("resource_id")]
                if path_segs:
                    tname = f"sticker_img_{ti}"
                    script.append_track(TrackSpec(TrackType.video, name=tname))
                    for seg in path_segs:
                        try:
                            t = Timerange(seg["start"], seg["duration"])
                            cs = _seg_clip_settings(seg, W, H)
                            vseg = VideoSegment(seg["path"], t, clip_settings=cs)
                            if _seg_masks(seg):
                                try:
                                    _apply_mask_to_segment(vseg, _seg_masks(seg)[0])
                                except Exception as e:
                                    skipped.append({"name": seg["name"], "reason": "贴纸遮罩导出跳过：" + str(e)})
                            script.add_segment(vseg, tname)
                            ok_count += 1
                        except SegmentOverlap as e:
                            skipped.append({"name": seg["name"], "reason": "同轨贴纸重叠：" + str(e)})
                        except Exception as e:
                            skipped.append({"name": seg["name"], "reason": str(e)})
                if res_segs:
                    tname = f"sticker_res_{ti}"
                    script.append_track(TrackSpec(TrackType.sticker, name=tname))
                    for seg in res_segs:
                        try:
                            t = Timerange(seg["start"], seg["duration"])
                            cs = _seg_clip_settings(seg, W, H)
                            sseg = StickerSegment(seg["resource_id"], t, clip_settings=cs)
                            script.add_segment(sseg, tname)
                            ok_count += 1
                        except Exception as e:
                            skipped.append({"name": seg["name"], "reason": str(e)})
            # 文本轨：按实际轨道数建轨（多轨字幕/花字）
            text_track_names = []
            for i, _ in enumerate(self.draft.get("text", [])):
                tname = f"text_{i}"
                script.append_track(TrackSpec(TrackType.text, name=tname))
                text_track_names.append(tname)

            # 视频 + 图片
            for ti, segs in enumerate(self.draft.get("video", [])):
                tname = video_track_names[ti]
                v_meta = self._track_meta("video", ti, ensure=False)
                if v_meta.get("hidden"):
                    continue  # 隐藏的视频轨：预览和导出都不渲染
                track_muted = v_meta.get("muted", False)
                for seg in segs:
                    try:
                        t = Timerange(seg["start"], seg["duration"])
                        # source_timerange 必须传真实源跨度（src_end - src_start），
                        # 原代码传 seg["duration"] 只在 speed=1 时碰巧正确；变速后必须用源跨度。
                        ss = int(seg.get("src_start", 0))
                        se_ = int(seg.get("src_end", ss + seg["duration"]))
                        src = Timerange(ss, max(1, se_ - ss))
                        # 提取原声后视频自身静音（muted → volume=0），避免与独立音轨音频翻倍
                        # 轨道级静音同样让整轨视频的内嵌音频静音
                        vol = 0.0 if (track_muted or seg.get("muted")) else float(seg.get("volume", 1.0))
                        kwargs = {"source_timerange": src, "volume": vol}
                        speed = _seg_speed(seg)
                        if abs(speed - 1.0) > 1e-6:
                            kwargs["speed"] = speed
                            kwargs["change_pitch"] = bool(seg.get("change_pitch", False))
                        vseg = VideoSegment(seg["path"], t, **kwargs)
                        # 关键帧：段级动画曲线映射到剪映关键帧（对齐 OpenCut 导出）
                        if _seg_anims(seg):
                            _apply_keyframes_to_segment(vseg, _seg_anims(seg), W, H)
                        # 遮罩：导出到剪映原生 mask（rectangle/ellipse/star/heart/split 可导出）
                        if _seg_masks(seg):
                            try:
                                _apply_mask_to_segment(vseg, _seg_masks(seg)[0])
                            except Exception as e:
                                skipped.append({"name": seg["name"], "reason": "遮罩导出跳过：" + str(e)})
                        script.add_segment(vseg, tname)
                        ok_count += 1
                    except SegmentOverlap as e:
                        skipped.append({"name": seg["name"], "reason": "同轨片段重叠，请拖到其它轨：" + str(e)})
                    except Exception as e:
                        skipped.append({"name": seg["name"], "reason": str(e)})
            # 音频
            for ti, segs in enumerate(self.draft.get("audio", [])):
                tname = audio_track_names[ti]
                a_meta = self._track_meta("audio", ti, ensure=False)
                if a_meta.get("muted"):
                    continue  # 静音的音频轨：整轨不导出
                for seg in segs:
                    try:
                        t = Timerange(seg["start"], seg["duration"])
                        ss = int(seg.get("src_start", 0))
                        se_ = int(seg.get("src_end", ss + seg["duration"]))
                        src = Timerange(ss, max(1, se_ - ss))
                        vol = 0.0 if seg.get("muted") else float(seg.get("volume", 1.0))
                        kwargs = {"source_timerange": src, "volume": vol}
                        speed = _seg_speed(seg)
                        if abs(speed - 1.0) > 1e-6:
                            kwargs["speed"] = speed
                            kwargs["change_pitch"] = bool(seg.get("change_pitch", False))
                        aseg = AudioSegment(seg["path"], t, **kwargs)
                        # 关键帧：音频段理论上仅音量可关键帧，统一走同一映射（无动画则无操作）
                        if _seg_anims(seg):
                            _apply_keyframes_to_segment(aseg, _seg_anims(seg), W, H)
                        script.add_segment(aseg, tname)
                        ok_count += 1
                    except SegmentOverlap as e:
                        skipped.append({"name": seg["name"], "reason": "同轨音频重叠，请拖到其它轨：" + str(e)})
                    except Exception as e:
                        skipped.append({"name": seg["name"], "reason": str(e)})
            # 文本
            for ti, segs in enumerate(self.draft.get("text", [])):
                if ti >= len(text_track_names):
                    continue  # 防御：轨比实际列表少
                tname = text_track_names[ti]
                tx_meta = self._track_meta("text", ti, ensure=False)
                if tx_meta.get("hidden"):
                    continue  # 隐藏的文本轨：预览和导出都不渲染
                for seg in segs:
                    try:
                        # 导入的 .srt 素材：走 pyJianYingDraft 原生 import_srt
                        if seg.get("path", "").lower().endswith(".srt"):
                            script.import_srt(seg["path"], tname, time_offset=seg["start"])
                        else:
                            t = Timerange(seg["start"], seg["duration"])
                            script.add_segment(_seg_text_segment(seg, t), tname)
                        ok_count += 1
                    except SegmentOverlap as e:
                        skipped.append({"name": seg["name"], "reason": "同轨文本重叠：" + str(e)})
                    except Exception as e:
                        skipped.append({"name": seg["name"], "reason": str(e)})

            script.save()
            self.set_default_export_folder(folder)
            return {
                "ok": True,
                "path": os.path.join(folder, name),
                "segments": ok_count,
                "skipped": skipped,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def import_media_by_paths(self, paths):
        """底层：给路径列表直接复制入库（AI/MCP 用，无需弹框）。

        你只要把桌面素材路径告诉我，我调这个就能直接放进去——和手动点「导入素材」走的是同一套逻辑。
        """
        self._reload()
        items = []
        # 去重：按 (原名, 大小) 判断，避免反复调用复制出 name_时间戳 副本、materials 无限膨胀
        existing_keys = {(m.get("name"), m.get("size")) for m in self.state.get("materials", []) if isinstance(m, dict)}
        for src in (paths or []):
            if not os.path.isfile(src):
                continue
            name = os.path.basename(src)
            try:
                size = os.path.getsize(src)
            except OSError:
                continue
            if (name, size) in existing_keys:
                continue
            dst = copy_to_assets(src)
            if not dst:
                continue
            item = {
                "name": os.path.basename(dst),
                "path": dst,
                "type": classify(dst),
                "size": os.path.getsize(dst),
                "uid": uuid.uuid4().hex,
            }
            # 视频抽中段帧缩略图（时间轴片段帧平铺用）；图片无需抽，直接用原图当缩略图
            if item["type"] == "video":
                thumb = _make_thumbnail(dst)
                if thumb:
                    item["thumbnail"] = thumb
            elif item["type"] == "audio":
                # 音频抽峰值数组（时间轴片段画真实波形用，对齐 OpenCut）
                peaks = _extract_audio_peaks(dst)
                if peaks:
                    item["peaks"] = peaks
            items.append(item)
            existing_keys.add((name, size))
        if items:
            if not isinstance(self.state["materials"], list):
                self.state["materials"] = []
            self.state["materials"].extend(items)
            save_state(self.state)
        return items

    def add_clip(self, path):
        """一步到位：把外部文件导入素材库并直接进轨（AI/MCP 常用入口）。

        例：你告诉我桌面某 mp4 路径，我一条命令完成「入库 + 进轨」，不用弹任何框。
        """
        items = self.import_media_by_paths([path])
        if not items:
            return {"ok": False, "error": f"文件不存在或无法导入：{path}"}
        it = items[0]
        return self.add_to_timeline(it["name"], it["path"], it["type"])

    def import_jianying_project(self, json_path):
        """导入剪映草稿 draft_content.json：解析视频/图片/音频/文字/贴纸/特效轨，
        生成可渲染的 draft_state 替换当前工程。

        媒体素材：本地有文件的，MOV/HEVC 等浏览器播不了的格式会在导入时转成 H.264 MP4 供预览
        （转码存于 preview_cache/，按源路径缓存复用；已是 MP4 的跳过不重复转）。转码仅用于本端
        预览，导出剪映仍引用原始素材。

        返回各轨统计；素材缺失的段仍保留（path 为空），播放器对缺失段显示黑底，不阻断整体导入。
        """
        import re
        self._reload()
        json_path = (json_path or "").strip()
        if not json_path or not os.path.isfile(json_path):
            return {"ok": False, "error": f"草稿文件不存在：{json_path}"}
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                src = json.load(f)
        except Exception as e:
            return {"ok": False, "error": f"读取草稿失败：{e}"}
        project_dir = os.path.dirname(os.path.abspath(json_path))
        mats = src.get("materials", {})
        # material_id → 素材（视频/图片/音频/文字/贴纸/特效）
        # 注意：剪映素材同时有 id 与 material_id 两个字段，且二者常不同；
        # 段引用的 material_id 实际等于素材的 id。两个键都登记，避免漏解析。
        mat_by_id = {}
        for cat in ("videos", "images", "audios", "texts", "stickers", "effects"):
            for m in (mats.get(cat) or []):
                for key in (m.get("id"), m.get("material_id")):
                    if key:
                        mat_by_id[key] = m

        def real_path(p):
            if not p:
                return None
            m = re.search(r"##_draftpath_placeholder_[0-9A-Fa-f-]+_##", p)
            if m:
                p = p.replace(m.group(0), project_dir)
            return os.path.normpath(p) if p else None

        # 复制媒体素材入库
        id_to_asset = {}
        new_materials = []
        existing = {(x.get("name"), x.get("size")) for x in self.state.get("materials", []) if isinstance(x, dict)}
        # mat_by_id 同一素材可能挂了 id 和 material_id 两个键，先按素材 id 去重
        _seen_ids = set()
        unique_mats = []
        for m in mat_by_id.values():
            mid_of_m = m.get("id")
            if mid_of_m in _seen_ids:
                continue
            _seen_ids.add(mid_of_m)
            unique_mats.append(m)
        for m in unique_mats:
            mtype = m.get("type")
            # 剪映把「音乐」标成 music、「AI 配音」标成 text_to_audio，统一归到音频处理
            if mtype in ("music", "text_to_audio"):
                mtype = "audio"
            if mtype not in ("video", "image", "audio"):
                continue
            rp = _resolve_media_file(real_path(m.get("path")))
            if not rp:
                continue
            name = os.path.basename(rp)
            try:
                size = os.path.getsize(rp)
            except OSError:
                continue
            # 浏览器友好格式路由：剪映在线素材先做 XOR 解密，HEVC/MOV 等 WebView2 播不了的
            # 再转成 H.264 MP4 供预览（解密/转码只用于本端预览；导出剪映仍引用原始素材，
            # 不破坏"导出零复制"）。
            asset_path = rp
            if mtype in ("video", "audio", "image"):
                asset_path = _prepare_preview_media(rp, mtype)
            item = {"name": os.path.basename(rp), "path": asset_path, "type": mtype,
                    "size": size, "uid": uuid.uuid4().hex}
            if mtype == "video":
                th = _make_thumbnail(asset_path)
                if th: item["thumbnail"] = th
            elif mtype == "audio":
                pk = _extract_audio_peaks(asset_path)
                if pk: item["peaks"] = pk
            elif mtype == "image":
                item["thumbnail"] = asset_path
            new_materials.append(item)
            # 用素材自身 id 当映射键：段引用的 material_id 实际等于素材 id
            id_to_asset[m.get("id") or mid] = asset_path

        # 转换 tracks → draft[type][ti]
        out = {"video": [], "audio": [], "text": [], "image": [], "sticker": [], "effect": [],
               "canvas": {"ratio": DEFAULT_CANVAS, "locked": False}}
        for tr in src.get("tracks", []):
            ttype = tr.get("type")
            segs = tr.get("segments", [])
            if not segs:
                continue
            if ttype == "video":
                our = "video"
            elif ttype == "audio":
                our = "audio"
            elif ttype == "text":
                our = "text"
            elif ttype == "sticker":
                our = "sticker"
            elif ttype == "effect":
                our = "effect"
            else:
                continue
            # 每条源轨道 → 独立目标轨道（保留剪映的上下叠层顺序），绝不摊平到单轨
            ti = len(out[our])
            out[our].append([])
            for s in segs:
                mid = s.get("material_id")
                tt = s.get("target_timerange") or {}
                start = int(tt.get("start", 0) or 0)
                duration = int(tt.get("duration", 0) or 0)
                if duration <= 0:
                    continue
                seg = {"start": start, "duration": duration, "src_start": 0, "src_end": duration,
                       "material_id": mid}
                mat = mat_by_id.get(mid, {})
                if our == "text":
                    txt = _extract_text_content(mat)
                    seg["name"] = txt
                    seg["text"] = txt
                    seg["type"] = "text"
                elif our == "video":
                    # 剪映 video 轨可能承载 image 素材；seg.type 区分，前端分别渲染
                    asset = id_to_asset.get(mid, "")
                    seg["path"] = asset
                    seg["type"] = mat.get("type") or "video"
                    seg["name"] = mat.get("material_name") or (os.path.basename(asset) if asset else "素材")
                elif our == "audio":
                    asset = id_to_asset.get(mid, "")
                    seg["path"] = asset
                    seg["type"] = "audio"
                    seg["name"] = mat.get("material_name") or (os.path.basename(asset) if asset else "音频")
                elif our == "sticker":
                    seg["type"] = "sticker"
                    seg["name"] = mat.get("name") or "贴纸"
                    seg["resource_id"] = mat.get("resource_id")
                elif our == "effect":
                    seg["type"] = "effect"
                    seg["name"] = mat.get("name") or "特效"
                out[our][ti].append(seg)
        for k in ("video", "audio", "text", "image", "sticker", "effect"):
            out[k] = [t for t in out[k] if t]
        cc = src.get("canvas_config") or {}
        if cc.get("width") and cc.get("height"):
            out["canvas"] = {"ratio": match_canvas_ratio(cc["width"] / cc["height"]) or DEFAULT_CANVAS,
                             "locked": False}
        # 写状态（替换当前工程：draft 整体覆盖，素材箱只保留本次导入的剪映媒体）
        self.state["draft"] = out
        self.state["materials"] = new_materials
        save_state(self.state)
        self.draft = self.state["draft"]
        return {"ok": True, "video_tracks": len(out["video"]), "audio_tracks": len(out["audio"]),
                "text_tracks": len(out["text"]), "sticker_tracks": len(out["sticker"]),
                "effect_tracks": len(out["effect"]),
                "assets_copied": len(new_materials),
                "materials_total": len(self.state.get("materials", []))}

    def get_server_url(self):
        """返回本地 HTTP 服务器基地址，前端用它把本地素材路径转成 http://127.0.0.1:PORT/assets/...

        为什么需要这个：WebView2 不允许 file:// 页面里的 <video>/<audio> 直接加载本地文件
        （安全上下文限制）。我们在启动时起了 localhost HTTP server，素材走 http 后才能正常
        播放、seek、画波形。
        """
        return LOCAL_BASE_URL

    def get_state(self):
        """返回当前完整状态（materials + draft + version）。

        前端每 0.5 秒轮询它来实现「人和 AI 实时互相看到改动」；AI/MCP 也读它确认当前草稿。

        注意：        AI/MCP 可能是另一个独立进程（通过 mcp_server.py 启动），它们会写同一个
        draft_state.json 文件。所以 get_state 每次都从文件重新加载，而不是返回内存缓存，
        否则桌面窗口永远看不到 AI 后台做的改动。

        同时把 MCP 连接状态（左上角灰/绿 + agent 名）一并带出来；状态变化时会触发前端刷新。
        """
        self.state = load_state()
        self.draft = self.state["draft"]  # 同步更新草稿引用，避免后续操作改到旧内存
        mcp_state = load_mcp_state()
        self.state["meta"] = {"mcp": mcp_state}
        # 注意：version 只反映草稿真实变化（save_state 打的时间戳），不要并入 MCP 心跳时间戳，
        # 否则心跳每 3s 更新 updated_at 会让 version 常变，前端每 3s 强重渲染整条时间轴（卡顿/打断）。
        # MCP 灰/绿点由前端每次轮询单独调 renderMcpStatus 更新，不靠 version 变化触发。
        return self.state

    def import_media(self):
        """弹系统文件选择框，把选中的文件复制进 assets/，返回素材信息列表。"""
        # 原生文件对话框，返回的是完整本地路径（剪映导出时需要真路径）
        result = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=True,
            file_types=(
                "All Supported Files (*.mp4;*.mov;*.avi;*.mkv;*.flv;*.wmv;*.webm;*.mp3;*.wav;*.aac;*.m4a;*.flac;*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.srt;*.ass;*.vtt)",
                "Video Files (*.mp4;*.mov;*.avi;*.mkv;*.flv;*.wmv;*.webm)",
                "Audio Files (*.mp3;*.wav;*.aac;*.m4a;*.flac)",
                "Image Files (*.png;*.jpg;*.jpeg;*.webp;*.bmp)",
                "Subtitle Files (*.srt;*.ass;*.vtt)",
                "All Files (*.*)",
            ),
        )
        if not result:
            return []  # 用户取消选择
        # 复用底层：给路径直接复制入库（AI/MCP 也是走这一层，人和 AI 同一逻辑不分叉）
        return self.import_media_by_paths(list(result))

    def pick_sticker_file(self):
        """弹系统文件选择框，仅选图片（PNG/WebP/JPG 等），返回选中路径或 None。

        贴纸面板「选择图片」按钮走这个原生对话框——比网页 <input type=file> 更可靠
        （PyWebView 里网页拿不到真实本地路径），且能拿到绝对路径供离线导出剪映。
        """
        try:
            result = webview.windows[0].create_file_dialog(
                webview.OPEN_DIALOG,
                file_types=(
                    "Image Files (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif)",
                    "PNG (*.png)",
                    "WebP (*.webp)",
                    "JPEG (*.jpg;*.jpeg)",
                    "All Files (*.*)",
                ),
            )
        except Exception:
            return None
        if result and isinstance(result, (list, tuple)) and len(result) > 0:
            return result[0]
        return None

    def drop_files(self, files):
        """接收网页层拖入的文件（base64 编码），解码写入 assets/，返回素材列表。

        为什么用 base64：PyWebView 的网页层（HTML ondrop）拿不到外部文件真实路径，
        只能拿到文件内容；base64 把内容传过来，Python 解码写盘即可，无需原生拖放层。
        大文件（视频等）不建议拖，前端会过滤并提示用“导入素材”按钮。
        """
        self._reload()
        if not files:
            return []
        os.makedirs(ASSETS_DIR, exist_ok=True)
        items = []
        for f in files:
            name = f.get("name", "file")
            data = f.get("data", "")
            # data 形如 "data:image/png;base64,xxxxxx"，取逗号后部分
            if "," in data:
                b64 = data.split(",", 1)[1]
            else:
                b64 = data
            try:
                raw = base64.b64decode(b64)
            except Exception:
                continue  # base64 解码失败跳过
            dst = os.path.join(ASSETS_DIR, name)
            if os.path.exists(dst):
                base, ext = os.path.splitext(name)
                dst = os.path.join(ASSETS_DIR, f"{base}_{int(time.time())}{ext}")
            try:
                with open(dst, "wb") as fp:
                    fp.write(raw)
            except Exception:
                continue
            typ = classify(dst)
            item = {
                "name": os.path.basename(dst),
                "path": dst,
                "type": typ,
                "size": os.path.getsize(dst),
                "uid": uuid.uuid4().hex,
            }
            if typ == "video":
                th = _make_thumbnail(dst)
                if th:
                    item["thumbnail"] = th
            elif typ == "audio":
                pk = _extract_audio_peaks(dst)
                if pk:
                    item["peaks"] = pk
            items.append(item)
        if items:
            if not isinstance(self.state["materials"], list):
                self.state["materials"] = []
            self.state["materials"].extend(items)
            save_state(self.state)
        return items

    def delete_material(self, uid):
        """删除素材库中的某个素材（按 uid；旧素材无 uid 时用 path 兜底匹配）。

        若时间轴上仍有片段引用该素材的 path，则只移除素材条目、保留 assets 文件，
        避免导出草稿时缺文件；若无人引用则连文件一起删，省空间。
        """
        self._reload()
        mats = self.state.get("materials", []) or []
        target = None
        for m in mats:
            if isinstance(m, dict) and (m.get("uid") == uid or m.get("path") == uid):
                target = m
                break
        if not target:
            return {"ok": False, "error": "未找到素材"}
        path = target.get("path")
        referenced = False
        for t in ("video", "audio", "text"):
            for segs in (self.state.get("draft", {}).get(t) or []):
                for s in segs:
                    if isinstance(s, dict) and s.get("path") == path:
                        referenced = True
                        break
                if referenced:
                    break
            if referenced:
                break
        self.state["materials"] = [
            m for m in mats
            if not (m.get("uid") == uid or m.get("path") == uid)
        ]
        save_state(self.state)
        removed = False
        if not referenced and path and os.path.isfile(path):
            try:
                os.remove(path)
                removed = True
            except OSError:
                pass
        return {"ok": True, "deleted_path": path, "file_removed": removed}

    def _ensure_uids(self):
        """启动时为旧素材补齐 uid（新导入已自带 uid）。只跑一次，不进轮询循环。"""
        try:
            self.state = load_state()
        except Exception:
            return
        changed = False
        for m in (self.state.get("materials") or []):
            if isinstance(m, dict) and not m.get("uid"):
                m["uid"] = uuid.uuid4().hex
                changed = True
        if changed:
            save_state(self.state)

    def _ensure_video_thumbnails(self):
        """启动时补全缺失的视频缩略图。只跑一次，避免轮询卡顿。

        历史原因：_make_thumbnail 曾有缩进 bug，ffmpeg 已生成 jpg 但函数返回 None，
        导致 state.materials.thumbnail 为空。本函数先尝试复用已生成的 .jpg；没有的再
        现场抽一帧。补完后 save_state，前端素材箱和时间轴立刻有图。
        """
        try:
            self.state = load_state()
        except Exception:
            return
        changed = False
        for m in (self.state.get("materials") or []):
            if not (isinstance(m, dict) and m.get("type") == "video" and m.get("path") and not m.get("thumbnail")):
                continue
            # 先找已经生成但没记录的 jpg
            base = os.path.splitext(os.path.basename(m["path"]))[0]
            thumb = os.path.join(ASSETS_DIR, "thumbnails", base + ".jpg")
            if os.path.exists(thumb):
                m["thumbnail"] = thumb
                changed = True
                continue
            # 没有则现场抽一帧
            generated = _make_thumbnail(m["path"])
            if generated:
                m["thumbnail"] = generated
                changed = True
        if changed:
            save_state(self.state)


def main():
    api = Api()
    api._ensure_uids()                 # 启动时为旧素材补齐 uid（新导入已自带）
    api._ensure_video_thumbnails()     # 启动时补全旧视频素材缺失的缩略图
    # create_window：开一个桌面窗口，里面加载我们的 HTML 界面
    webview.create_window(
        title="AI剪辑工作台 v0.9",
        url=HTTP_URL,        # 走 localhost HTTP，WebView2 才能正常播本地视频/音频
        width=1280,
        height=800,
        resizable=True,
        js_api=api,          # 把 Python 能力（Api）暴露给前端调用
    )
    # start：进入窗口事件循环（窗口会一直显示，直到用户关闭）
    # [诊断] debug=True 临时开启 F12 开发者工具（排查 MP3 无声用，测完改回 webview.start()）
    webview.start(debug=True)


if __name__ == "__main__":
    main()
