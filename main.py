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
import functools
import types
from doc_protocol.schema import validate_document, load_document as _load_document_proto
from plugin.plugin import PluginManager, builtin_effects_manifest
from presets.preset import load_presets as _load_presets, get_presets as _get_presets, plan_preset as _plan_preset
from intent.intent import validate_intents as _validate_intents, plan_intents as _plan_intents
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
# 日志 fd 级别重定向（2026-08-24 验收准备 v2）：所有 print 落 logs/app.log ——
# 用 os.dup2 重定向 fd 1/2 到文件，**不依赖 sys.stdout**（pywebview 启动后劫持 sys.stdout
# 会让 v1 tee 失效，logs/app.log 变 0 字节——本次修复）。fd 级别 C 层 print 强制落文件。
# 验收/排查：直接看 logs/app.log，不依赖 cmd 黑窗口。失败静默不影响启动。
# ---------------------------------------------------------------------------
LOG_DIR = os.path.join(HERE, "logs")
try:
    os.makedirs(LOG_DIR, exist_ok=True)
    _LOG_FD = os.open(os.path.join(LOG_DIR, "app.log"),
                      os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(_LOG_FD, 1)   # stdout
    os.dup2(_LOG_FD, 2)   # stderr
    import sys as _sys_mod
    try:
        _sys_mod.stdout.reconfigure(line_buffering=True)
        _sys_mod.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
except Exception:
    pass

# ---------------------------------------------------------------------------
# 本地 HTTP 服务器：把项目目录（含 assets 素材）通过 http://127.0.0.1:PORT 暴露。
# WebView2 不允许 file:// 文档里的 <video>/<audio> 加载本地文件（安全上下文限制），
# 走 localhost HTTP 后视频/音频/图片都能正常加载，且支持 seek（Range 请求）。
# ---------------------------------------------------------------------------
ALLOWED_LOCAL_EXT = (".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".aac",
                     ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".json", ".srt")

class _SilentHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # 支持 Range 持久连接，避免视频缓冲中途断流卡顿
    # ⚠️ 关键：Python 标准库 SimpleHTTPRequestHandler 不支持 Range（永远 200 全量）。
    # WebView2/Chromium 在无 Range 的服务器上无法 seek 到当前缓冲范围外——跨段播放
    # seek(5s/10s) 全被吞、从素材 0 秒起播、MediaSlot prepare 预加载卡 STUCK 无限循环。
    # 因此 /local/ 代理路径由 _serve_file 完全接管，手动实现 206 Partial Content。
    _RANGE_RE = re.compile(r"bytes[= ](\d*)-(\d*)\Z")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)
    def log_message(self, format, *args):
        pass  # 关闭访问日志，保持控制台干净

    def end_headers(self):
        # 2026-08-19：HTML/JS/CSS 文档禁止缓存，确保改完代码重开 start.bat 立即生效。
        # 否则 WebView2 按 Last-Modified 走 304 磁盘缓存，复用旧 HTML/JS → “改了代码没生效”。
        p = self.path.split("?")[0].split("#")[0].lower()
        if p.endswith((".html", ".htm", ".js", ".css")):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    # ---- Range 支持（206 Partial Content）----
    def _parse_range(self, file_len):
        """解析 Range 头。返回 (start, end) 闭区间；None=全量；'error'=416。"""
        h = self.headers.get("Range")
        if not h:
            return None
        m = self._RANGE_RE.match(h.strip())
        if not m:
            return None  # 非单段 bytes 范围（如 multipart/byteranges），忽略按全量返回
        g1, g2 = m.group(1), m.group(2)
        if g1 == "" and g2 == "":
            return None
        if g1 == "":
            start = max(file_len - int(g2), 0)   # 后缀范围 bytes=-N
            end = file_len - 1
        else:
            start = int(g1)
            end = int(g2) if g2 else file_len - 1   # HTTP Range 含结束偏移：bytes=0-1023 → 0..1023 共 1024 字节
        if start >= file_len:
            return "error"
        end = min(end, file_len - 1)
        if end < start:
            end = start
        return (start, end)

    def _serve_file(self, abs_path, head_only=False):
        """按 Range 服务单个文件；不带 Range 时等价全量 200（行为与父类一致）。"""
        try:
            f = open(abs_path, "rb")
        except OSError:
            # 2026-08-19：404 打真实路径（用户日志"Failed to load resource: 404"一直看不到是哪个文件）
            print("[HTTP-404]", self.command, repr(abs_path)[:160])
            self.send_error(404, "File not found")
            return
        try:
            fs = os.fstat(f.fileno())
            file_len = fs.st_size
            rng = self._parse_range(file_len)
            if rng == "error":
                f.close()
                self.send_error(416, "Requested Range Not Satisfiable")
                return
            self.send_response(206 if rng else 200)
            self.send_header("Content-type", self.guess_type(abs_path))
            self.send_header("Accept-Ranges", "bytes")
            if rng:
                start, end = rng
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_len}")
                self.send_header("Content-Length", str(end - start + 1))
            else:
                self.send_header("Content-Length", str(file_len))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            if head_only:
                f.close()
                return
            if rng:
                start, end = rng
                f.seek(start)
                remaining = end - start + 1
                buf = 64 * 1024
                while remaining > 0:
                    chunk = f.read(min(buf, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        break  # 客户端 seek 中断响应属正常（Chromium 高频 Range 行为）
                    remaining -= len(chunk)
            else:
                try:
                    shutil.copyfileobj(f, self.wfile)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            f.close()
        except Exception:
            f.close()
            raise

    def _local_abs_path(self):
        import urllib.parse
        abs_path = urllib.parse.unquote(self.path[len("/local/"):])
        abs_path = os.path.normpath(abs_path)
        if os.path.isfile(abs_path) and abs_path.lower().endswith(ALLOWED_LOCAL_EXT):
            return abs_path
        return None

    def do_GET(self):
        # /local/ 前缀：代理任意本地绝对路径（导入剪映工程时引用原素材，避免大文件复制占空间）
        if self.path.startswith("/local/"):
            abs_path = self._local_abs_path()
            if abs_path:
                self._serve_file(abs_path)
            else:
                self.send_error(403, "Forbidden path")
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/local/"):
            abs_path = self._local_abs_path()
            if abs_path:
                self._serve_file(abs_path, head_only=True)
            else:
                self.send_error(403, "Forbidden path")
            return
        super().do_HEAD()

def _start_local_server(preferred=(8080, 8081, 8082, 8083, 8084, 8085, 8090, 8091, 8092, 0)):
    """绑定本地媒体服务器。

    ⚠️ 2026-08-19 关键修复：allow_reuse_port=False。
    之前为 True，Windows 上允许多个 python 进程同绑 8080，OS 随机把连接分给某个进程——
    只要有一个旧 main.py 进程还占着 8080，新窗口就可能被旧进程接走、发旧 HTML，
    表现为“重启还旧构建 / 改了代码没生效”。关闭后：旧进程占着的端口新进程绝不再共享，
    自动顺延到下一个空闲端口；末尾 port=0 让 OS 分配一个绝对空闲的随机端口，
    保证新窗口永远连到“本次启动的新进程”服务的最新 HTML（与 ?v=时间戳 + no-cache 头三重保险）。
    """
    class _ReusableTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        allow_reuse_port = False
    for port in preferred:
        try:
            srv = _ReusableTCPServer(("127.0.0.1", port), _SilentHTTPRequestHandler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            return srv, srv.server_address[1]
        except OSError:
            continue
    raise RuntimeError("无法为本地媒体服务器找到可用端口")

_local_httpd, _LOCAL_PORT = _start_local_server()
LOCAL_BASE_URL = f"http://127.0.0.1:{_LOCAL_PORT}"
# 2026-08-19：URL 带 ?v=<启动时间戳> 版本戳。每次重开 start.bat 时间戳必变→URL 必变→
# WebView2 缓存键必变→必拉最新文件（与响应头 no-cache 双保险，彻底杜绝“改了没生效/重启还旧构建”）。
# ⚠️ 之前用文件 mtime 做戳，但 mtime 只在“改 HTML”时变；两次重启间没改 HTML→戳不变→缓存命中旧构建。
# 改用 time.time() 后，每次启动都强制刷新，与“我有没有改文件”无关。
import time as _time
_HTML_V = int(_time.time())
HTTP_URL = f"{LOCAL_BASE_URL}/工作台v0.8时间轴.html?v={_HTML_V}"

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


def _overlay_index(draft, track_type, ti):
    """type+ti（该类型第几条）→ overlay 数组下标；找不到返回 -1。
    video 的 ti 语义：ti=0 = 主场景（main）；ti>=1 = overlay 里第 (ti-1) 条 video 覆盖轨。"""
    if track_type == "video":
        if ti == 0:
            return -2   # -2 = 主场景（main）
        ti = ti - 1
    cnt = 0
    for i, tr in enumerate(draft.get("overlay", [])):
        if tr.get("type") == track_type:
            if cnt == ti:
                return i
            cnt += 1
    return -1


def _new_tid(prefix):
    """生成轨道稳定 id（A1，对齐 OpenCut trackId）。前缀区分类型：ov_=overlay / main_=主场景 / au_=音轨。"""
    import uuid
    return prefix + "_" + uuid.uuid4().hex[:12]


def _ensure_track_tids(draft):
    """给所有轨道补稳定 tid（A1）。overlay[i]/main/audio[i] 各轨 dict 加 tid。
    tid 一旦生成保持不变（折叠/重排/新建都不改已有 tid），AI/MCP 可用 tid 稳定引用轨道——
    这是 A 方案「轨道也引入稳定 id」的地基（段 id 已在 b9a9206 完成）。"""
    for tr in draft.get("overlay", []):
        if isinstance(tr, dict) and not tr.get("tid"):
            tr["tid"] = _new_tid("ov")
    main = draft.get("main")
    if isinstance(main, dict) and not main.get("tid"):
        main["tid"] = _new_tid("main")
    for a in draft.get("audio", []):
        if isinstance(a, dict) and not a.get("tid"):
            a["tid"] = _new_tid("au")


def _track_by_tid(draft, tid):
    """按轨道稳定 id 定位（A2）。返回 (track_type, ti, segs) 或 None。
    ti = 该类型内序号（video 覆盖轨从 1 起，0=主场景；其他类型 0 起）——与外部命令 (type,ti) 语义一致。"""
    if not tid:
        return None
    main = draft.get("main")
    if isinstance(main, dict) and main.get("tid") == tid:
        return ("video", 0, main.get("segs", []))
    counters = {}
    for tr in draft.get("overlay", []):
        if not isinstance(tr, dict):
            continue
        t = tr.get("type") or "video"
        n = counters.get(t, 0) + 1
        counters[t] = n
        if tr.get("tid") == tid:
            ti = n if t == "video" else n - 1   # video 覆盖轨从 1 起，其他从 0 起
            return (t, ti, tr.get("segs", []))
    for i, a in enumerate(draft.get("audio", [])):
        if isinstance(a, dict) and a.get("tid") == tid:
            return ("audio", i, a.get("segs", []))
    return None


def _track_segs(draft, track_type, ti, ensure=False):
    """统一取轨段列表（X 模型访问层）。返回 None 表示轨不存在（ensure=False 时）。"""
    if track_type == "audio":
        audio = draft.setdefault("audio", [{"segs": []}])
        if ti < 0:
            ti = len(audio) - 1
        while len(audio) <= ti:
            audio.append({"segs": []})
        if not isinstance(audio[ti], dict):
            audio[ti] = {"segs": []}
        audio[ti].setdefault("segs", [])
        return audio[ti]["segs"]
    oi = _overlay_index(draft, track_type, ti)
    if oi == -2:   # 主场景
        main = draft.setdefault("main", {"segs": []})
        if not isinstance(main, dict):
            main = {"segs": []}
            draft["main"] = main
        main.setdefault("segs", [])
        return main["segs"]
    if oi >= 0:
        tr = draft["overlay"][oi]
        tr.setdefault("segs", [])
        return tr["segs"]
    if ensure:
        # 自动新建该类型第 ti 条轨（保持类型内序号连续）
        if track_type == "audio":
            audio = draft.setdefault("audio", [{"segs": []}])
            while len(audio) <= ti:
                audio.append({"segs": []})
            if not isinstance(audio[ti], dict):
                audio[ti] = {"segs": []}
            audio[ti].setdefault("segs", [])
            return audio[ti]["segs"]
        overlay = draft.setdefault("overlay", [])
        if track_type == "video":
            ti = ti - 1
        insert_at = len(overlay)
        new_tr = {"type": track_type, "segs": []}
        overlay.append(new_tr)
        # 保持类型内序号：该类型已有 ti 条 → append 正好是第 ti 条（0-based）
        return new_tr["segs"]
    return None


def _ensure_track(draft, track_type, index):
    """确保 draft 里 track_type 类型存在第 index 条轨道；不存在则补空轨。

    index == -1 表示「自动新建一条该类型轨道」，返回新建后的索引。
    同步维护 _track_meta，保证每个轨道都有元数据槽位。返回最终可用的轨道索引。
    video 的 ti 语义：0=主场景(main)，1..N=第 N 条覆盖轨。
    """
    if index == -1:
        if track_type == "audio":
            audio = draft.setdefault("audio", [{"segs": []}])
            audio.append({"segs": [], "tid": _new_tid("au")})
            return len(audio) - 1
        overlay = draft.setdefault("overlay", [])
        overlay.append({"type": track_type, "segs": [], "tid": _new_tid("ov")})
        if track_type == "video":
            return sum(1 for tr in overlay if tr.get("type") == "video")   # 第 N 条覆盖轨 ti=N
        return sum(1 for tr in overlay if tr.get("type") == track_type) - 1  # 0-based
    if track_type == "audio":
        _track_segs(draft, track_type, index, ensure=True)
        return index
    if track_type == "video" and index == 0:
        return 0
    _track_segs(draft, track_type, index, ensure=True)
    return index


def _insert_track(draft, track_type, insert_index):
    """在 overlay/audio 数组的第 insert_index 个位置插入一条空轨道（拖到两条轨中间新建轨用）。

    X 模型：insert_index = overlay 数组下标（0=最顶），数组顺序即 z 序——插入中间 = z 序天然正确，
    不再需要 layer_order/dataInsertIndex 换算。video 覆盖轨也插 overlay（主场景 main 恒定不受影响）。
    返回新轨索引。
    """
    if track_type == "audio":
        audio = draft.setdefault("audio", [{"segs": []}])
        ins = max(0, min(int(insert_index), len(audio)))
        audio.insert(ins, {"segs": [], "tid": _new_tid("au")})
        return ins
    overlay = draft.setdefault("overlay", [])
    ins = max(0, min(int(insert_index), len(overlay)))
    overlay.insert(ins, {"type": track_type, "segs": [], "tid": _new_tid("ov")})
    return ins


def _ensure_track_meta(draft, track_type):
    """确保 draft 中存在 _track_meta 且对应 track_type 有列表（X 模型：overlay 数组对齐）。"""
    meta = draft.setdefault("_track_meta", {})
    meta.setdefault("overlay", [])
    meta.setdefault("main", {})
    meta.setdefault("audio", [])
    return meta


def _meta_of(draft, track_type, index):
    """X 模型 meta 定位：返回 (track_type, index) 对应的轨道 meta dict（不存在返回 None）。"""
    meta = draft.setdefault("_track_meta", {})
    if track_type == "audio":
        arr = meta.setdefault("audio", [])
        while len(arr) <= index:
            arr.append({})
        return arr[index]
    if track_type == "video" and index == 0:
        m = meta.setdefault("main", {})
        return m
    oi = _overlay_index(draft, track_type, index)
    if oi >= 0:
        arr = meta.setdefault("overlay", [])
        while len(arr) <= oi:
            arr.append({})
        return arr[oi]
    return None


def _set_track_persistent(draft, track_type, index, persistent=True):
    """标记/取消标记某条轨道为「显式创建的空轨」（即使为空也不自动折叠）。"""
    m = _meta_of(draft, track_type, index)
    if m is None:
        return
    if persistent:
        m["persistent_empty"] = True
    elif "persistent_empty" in m:
        del m["persistent_empty"]


def _clear_persistent_if_needed(draft, track_type, index):
    """当某条轨道被放入片段时，取消它的 persistent_empty 标记（有素材自然保留）。"""
    m = _meta_of(draft, track_type, index)
    if m is not None and m.get("persistent_empty"):
        del m["persistent_empty"]


def _remove_track_meta(draft, track_type, index):
    """删除 draft._track_meta 中指定轨道的元数据，并保持与轨道列表长度一致。"""
    meta = draft.get("_track_meta", {})
    if track_type == "audio":
        arr = meta.get("audio", [])
        if 0 <= index < len(arr):
            arr.pop(index)
        return
    if track_type == "video" and index == 0:
        return  # main 恒定，不删
    oi = _overlay_index(draft, track_type, index)
    if oi >= 0:
        arr = meta.get("overlay", [])
        if 0 <= oi < len(arr):
            arr.pop(oi)


def _collapse_empty_tracks(draft):
    """移除空轨道（保持 list-of-list 不变量）。

    规则：有素材的轨保留，没素材的轨自动消失。用户不需要手动删轨。
    - overlay：保留有素材的轨，空轨移除（数组顺序即 z 序，折叠不改变相对顺序）。
    - main：主场景恒定保留（即使空）。
    - audio：移除为空的轨；若全空，保留一条空轨以免破坏结构。
    这样「片段被移走后留下的空轨会自动消失」，轨道数量始终由素材决定。
    """
    meta = draft.setdefault("_track_meta", {})
    meta.setdefault("overlay", [])
    meta.setdefault("main", {})
    meta.setdefault("audio", [])

    # overlay：保留有素材的轨（数组顺序 = z 序，折叠只删空轨不改相对顺序）
    overlay = draft.setdefault("overlay", [])
    o_meta = meta["overlay"]
    new_overlay = []
    new_o_meta = []
    for i, tr in enumerate(overlay):
        if not isinstance(tr, dict):
            continue
        tr.setdefault("segs", [])
        if len(tr["segs"]) > 0:
            new_overlay.append(tr)
            new_o_meta.append(o_meta[i] if i < len(o_meta) else {})
    draft["overlay"] = new_overlay
    meta["overlay"] = new_o_meta

    # main：恒定保留
    if not isinstance(draft.get("main"), dict):
        draft["main"] = {"segs": []}
    draft["main"].setdefault("segs", [])

    # audio：保留有素材的轨；全空保一条
    audio = draft.setdefault("audio", [{"segs": []}])
    a_meta = meta["audio"]
    new_audio = []
    new_a_meta = []
    for i, a in enumerate(audio):
        if not isinstance(a, dict):
            continue
        a.setdefault("segs", [])
        if len(a["segs"]) > 0:
            new_audio.append(a)
            new_a_meta.append(a_meta[i] if i < len(a_meta) else {})
    if not new_audio:
        new_audio = [{"segs": []}]
        new_a_meta = [{}]
    draft["audio"] = new_audio
    meta["audio"] = new_a_meta


def _seg_by_id(draft, segid):
    """按稳定段 id 在 X 模型中定位段（main/overlay/audio 全查）。找不到返回 None。
    A 方案核心（2026-08-18）：段 id 是稳定引用，不受折叠/新建轨导致的 ti 漂移影响——
    拖动/选中/提交只要带 segid，结构怎么变都能定位到正确的段。"""
    if not segid:
        return None
    main = draft.get("main")
    if isinstance(main, dict):
        for seg in main.get("segs", []):
            if isinstance(seg, dict) and seg.get("id") == segid:
                return seg
    for tr in draft.get("overlay", []):
        if isinstance(tr, dict):
            for seg in tr.get("segs", []):
                if isinstance(seg, dict) and seg.get("id") == segid:
                    return seg
    for a in draft.get("audio", []):
        if isinstance(a, dict):
            for seg in a.get("segs", []):
                if isinstance(seg, dict) and seg.get("id") == segid:
                    return seg
    return None


def _pop_seg_by_ref(draft, seg):
    """按对象引用从所在轨移除段（main/overlay/audio 全查）。成功返回 True。"""
    main = draft.get("main")
    if isinstance(main, dict):
        for i, s in enumerate(main.get("segs", [])):
            if s is seg:
                main["segs"].pop(i)
                return True
    for tr in draft.get("overlay", []):
        if isinstance(tr, dict):
            for i, s in enumerate(tr.get("segs", [])):
                if s is seg:
                    tr["segs"].pop(i)
                    return True
    for a in draft.get("audio", []):
        if isinstance(a, dict):
            for i, s in enumerate(a.get("segs", [])):
                if s is seg:
                    a["segs"].pop(i)
                    return True
    return False


def _locate_seg(draft, seg):
    """在 X 模型中定位一个段对象 → (track_type, type_ti, index) 或 None。
    video 覆盖轨的 ti 从 1 起（0=主场景）；text/sticker/effect/audio 从 0 起。"""
    main = draft.get("main", {"segs": []})
    if isinstance(main, dict) and seg in main.get("segs", []):
        return ("video", 0, main["segs"].index(seg))
    for i, a in enumerate(draft.get("audio", [])):
        if isinstance(a, dict) and seg in a.get("segs", []):
            return ("audio", i, a["segs"].index(seg))
    overlay = draft.get("overlay", [])
    for oi, tr in enumerate(overlay):
        if not isinstance(tr, dict):
            continue
        if seg in tr.get("segs", []):
            cnt = sum(1 for t in overlay[:oi] if isinstance(t, dict) and t.get("type") == tr.get("type"))
            ti = cnt if tr.get("type") != "video" else cnt + 1
            return (tr.get("type"), ti, tr["segs"].index(seg))
    return None


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


def _migrate_old_to_x(old):
    """旧结构草稿（video/audio/text/effect/sticker 分类型数组 + layer_order）→ X 结构（overlay/main/audio）。

    2026-08-19 关键修复：多进程竞争（窗口程序旧版 vs MCP 新版）时，新代码读到旧结构草稿
    若直接返回空，save_state 会把空草稿覆盖写盘 = 「草稿清道夫」（用户素材莫名消失/放不进的根因）。
    改为静默迁移：数据全部保留，结构升级，任何版本的进程读写都不丢数据。

    顺序：text→sticker→effect→video 覆盖(倒序)→main→audio（旧 buildTracks 默认序）；
    有 layer_order 则按它重排 overlay（保留用户重排过的 z 序）。
    """
    out = {
        "overlay": [], "main": {"segs": []}, "audio": [],
        "canvas": old.get("canvas", {"ratio": DEFAULT_CANVAS, "locked": False}),
        "_track_meta": {"overlay": [], "main": {}, "audio": []},
    }
    om = old.get("_track_meta", {}) or {}
    # 1) 收集有素材的 overlay 轨（默认序）
    order_keys = []
    for t in ("text", "sticker", "effect"):
        for i, segs in enumerate(old.get(t, []) or []):
            if segs:
                order_keys.append((t, i))
    v = old.get("video", [[]]) or [[]]
    for i in range(len(v) - 1, 0, -1):
        if v[i]:
            order_keys.append(("video", i))
    # 2) 有 layer_order 则按它重排（保用户 z 序）
    lo = old.get("layer_order") or []
    if lo:
        by_key = {"%s:%d" % (t, i): (t, i) for t, i in order_keys}
        ordered, seen = [], set()
        for k in lo:
            if k in by_key and k not in seen:
                ordered.append(by_key[k]); seen.add(k)
        for t, i in order_keys:
            k = "%s:%d" % (t, i)
            if k not in seen:
                ordered.append((t, i)); seen.add(k)
        order_keys = ordered
    # 3) 建 overlay + meta
    o_meta = []
    for t, i in order_keys:
        segs = (old.get(t, [[]]) or [[]])[i] if t != "video" else v[i]
        out["overlay"].append({"type": t, "segs": segs})
        tmeta = om.get(t, []) or []
        o_meta.append(tmeta[i] if i < len(tmeta) else {})
    out["_track_meta"]["overlay"] = o_meta
    # 4) main（video[0]）
    main_segs = v[0] if v else []
    out["main"] = {"segs": main_segs}
    vmeta = om.get("video", []) or []
    out["_track_meta"]["main"] = vmeta[0] if vmeta else {}
    # 5) audio
    a_meta = []
    for i, segs in enumerate(old.get("audio", []) or []):
        out["audio"].append({"segs": segs})
        ameta = om.get("audio", []) or []
        a_meta.append(ameta[i] if i < len(ameta) else {})
    if not out["audio"]:
        out["audio"] = [{"segs": []}]; a_meta = [{}]
    out["_track_meta"]["audio"] = a_meta
    return out


# 1f（M1 收尾，2026-08-23）：数据模型 schemaVersion 种子。
# 记录草稿「数据模型」的格式版本，供 M3 迁移管线识别旧格式并迁移。
# 注意：与 save_state 里的 version（时间戳，前端轮询判变用）是两回事，勿混淆。
DOCUMENT_SCHEMA_VERSION = 1


def migrate(draft, from_version, to_version):
    """M3-3a 迁移器管线：把任意旧格式草稿收敛到 to_version 的数据模型。

    幂等：重复调用无副作用；每一步都是 setdefault / 结构升级，绝不丢数据（避免「草稿清道夫」）。
    由 load_state 按 schemaVersion 驱动（from = 草稿自带 schemaVersion，to = DOCUMENT_SCHEMA_VERSION）。

    步骤（版本门控）：
      1) 结构迁移：from_version < 1 且草稿仍是旧模型（无 overlay/main）→ _migrate_old_to_x（数据全保留）。
      2) 轨道规范化：overlay/main/audio 默认值 + _track_meta 对齐 + muted/hidden 默认。
      3) 字段确保：_ensure_track_tids / _ensure_seg_ids / _ensure_seg_speeds / _ensure_seg_animations。
    注：_ensure_seg_src_full 不在本管线——它有 record=False 落盘副作用且归属 3b 热路径清理。
    """
    # 1) 结构迁移（旧模型 → X 模型，原地替换以保住 s["draft"] 引用）
    if from_version < 1 and ("overlay" not in draft or "main" not in draft):
        migrated = _migrate_old_to_x(draft)
        draft.clear()
        draft.update(migrated)
    # 2) 轨道规范化
    draft.setdefault("overlay", [])
    draft.setdefault("main", {"segs": []})
    draft.setdefault("audio", [{"segs": []}])
    draft.setdefault("canvas", {"ratio": DEFAULT_CANVAS, "locked": False})
    for i, tr in enumerate(draft["overlay"]):
        if not isinstance(tr, dict):
            draft["overlay"][i] = {"type": "video", "segs": []}
        else:
            tr.setdefault("type", "video")
            tr.setdefault("segs", [])
    if not isinstance(draft["main"], dict):
        draft["main"] = {"segs": []}
    draft["main"].setdefault("segs", [])
    for i, a in enumerate(draft["audio"]):
        if not isinstance(a, dict):
            draft["audio"][i] = {"segs": []}
        else:
            a.setdefault("segs", [])
    if not draft["audio"]:
        draft["audio"] = [{"segs": []}]
    draft.setdefault("_track_meta", {"overlay": [], "main": {}, "audio": [{}]})
    meta = draft["_track_meta"]
    meta.setdefault("overlay", [])
    while len(meta["overlay"]) < len(draft["overlay"]):
        meta["overlay"].append({})
    meta.setdefault("main", {})
    meta.setdefault("audio", [])
    while len(meta["audio"]) < len(draft["audio"]):
        meta["audio"].append({})
    for m in meta["overlay"]:
        m.setdefault("muted", False)
        m.setdefault("hidden", False)
    for m in meta["audio"]:
        m.setdefault("muted", False)
        m.setdefault("hidden", False)
    meta["main"].setdefault("muted", False)
    meta["main"].setdefault("hidden", False)
    # 3) 字段确保（幂等）
    _ensure_track_tids(draft)
    _ensure_seg_ids(draft)
    _ensure_seg_speeds(draft)
    _ensure_seg_animations(draft)
    return draft


def load_state():
    """读取 draft_state.json。不存在/损坏返回空草稿。

    X 模型（2026-08-18 用户拍板，对齐 OpenCut SceneTracks）：
      draft = {
        "overlay": [{"type": "text"|"sticker"|"effect"|"video", "segs": [...]}, ...],  # 混排池，0=最顶，数组顺序=z 序
        "main":    {"segs": [...]},        # 主场景（恒定，只装 video/image）
        "audio":   [{"segs": [...]}, ...], # 音轨
        "canvas":  {...}, "_track_meta": {...},
      }
    旧结构（video/audio/text/effect 分类型数组 + layer_order）已废弃，检测到旧草稿直接返回空（用户拍板全删）。
    """
    empty = {
        "materials": [],
        "draft": {
            "overlay": [], "main": {"segs": []}, "audio": [{"segs": []}],
            "canvas": {"ratio": DEFAULT_CANVAS, "locked": False},
            "_track_meta": {"overlay": [], "main": {}, "audio": [{}]},
        },
        "version": 0,
        "schemaVersion": DOCUMENT_SCHEMA_VERSION,
    }
    if not os.path.exists(STATE_PATH):
        _ensure_track_tids(empty["draft"])   # A1：空草稿也要有 tid（统一不变量）
        return empty
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            s = json.load(f)
        s.setdefault("materials", [])
        s.setdefault("draft", {})
        draft = s["draft"]
        from_v = s.get("schemaVersion", 0)
        s.setdefault("version", 0)
        s.setdefault("domain_version", 0)   # 2c（M2）：领域改动计数（仅 record=True 时 +1），version 门控用
        s.setdefault("schemaVersion", DOCUMENT_SCHEMA_VERSION)
        # M6-6a：协议层校验审计（只读不改行为；repaired 由下方 setdefault/migrate 兜底覆盖）。
        # 非法草稿 → [DOCUMENT-INVALID] 打日志，供统一验证阶段排查「脏数据进导出」。
        s.setdefault("metadata", {})
        try:
            _vres = validate_document(s)
            if _vres["errors"]:
                print("[DOCUMENT-INVALID] " + "; ".join(_vres["errors"][:5]))
            if _vres["warnings"]:
                print("[DOCUMENT-WARN] " + "; ".join(_vres["warnings"][:3]))
        except Exception:
            pass
        if isinstance(s["materials"], dict):
            s["materials"] = list(s["materials"].values()) if s["materials"] else []
        if not isinstance(s["materials"], list):
            s["materials"] = []
        # M3-3a：按 schemaVersion 驱动迁移管线（结构迁移 + 轨道规范化 + 字段确保，幂等、零丢失）
        if from_v != DOCUMENT_SCHEMA_VERSION:
            print("[MIGRATE] from=%s to=%s" % (from_v, DOCUMENT_SCHEMA_VERSION))
        migrate(draft, from_v, DOCUMENT_SCHEMA_VERSION)
        return s
    except Exception:
        return empty


# =====================================================================
# Step 5 Command 层：可审计、可回退的操作语义层（参考 OpenCut commands/）
# ---------------------------------------------------------------------
# 设计（用户 2026-08-15 拍板方案 X）：
#   - 撤销栈从「裸快照」升级为「Command 栈」：每个操作一个 Command 对象，
#     saved_state = 操作前草稿深拷贝（undo 还原，对齐 OpenCut SplitElementsCommand）。
#   - undo/redo = 快照恢复（还原机制与旧快照栈一致，语义升级）。
#   - meta = operation_context {actor, reason, confidence, source, reversible}：
#     Agent 可审计"谁改了什么、为什么改"（护城河）。
#   - 5a：save_state 自动压"快照 Command"兜底（未包壳操作照常可撤销）；
#     5b 起写操作走 CommandManager.execute（带 cmd_id/meta 语义）。
# =====================================================================
class Command:
    """一次可审计、可回退的操作。"""
    __slots__ = ("cmd_id", "label", "meta", "saved_state", "post_state", "changed_paths", "count", "args", "source",
                 "dv_before", "dv_after", "selection_before", "selection_after")

    def __init__(self, cmd_id, label, meta=None):
        self.cmd_id = cmd_id
        self.label = label
        self.meta = meta or {}
        self.saved_state = None   # execute 前草稿深拷贝（undo 还原）
        self.post_state = None    # undo 时记录 execute 后状态（redo 恢复）
        self.changed_paths = []   # C3 v2：本次操作改动的属性 path（属性历史/Agent 审计/增量保存用）
        self.count = 1            # 事务合并条数（普通命令=1，事务命令=N）
        self.args = None          # 2a（M2）：本次操作的入参深拷贝，审计/回放/调试用
        self.source = None        # 2b（M2）：命令来源 "execute"=语义包壳 / "snapshot"=save_state 兜底快照
        self.dv_before = 0        # 2c（M2）：操作前 domain_version（version 门控基线）
        self.dv_after = 0         # 2c（M2）：操作后 domain_version（undo 冲突检测：≠磁盘→外部已改）
        self.selection_before = None  # 2c（M2）：操作前选中快照，undo 还原到此
        self.selection_after = None   # 2c（M2）：操作后选中快照，redo 还原到此

    def __repr__(self):
        return "<Command %s actor=%s>" % (self.cmd_id, self.meta.get("actor", "-"))


class CommandManager:
    """撤销/重做/审计统一入口。类级共享（桌面窗口与 MCP 进程共用同一份历史）。"""

    def __init__(self, cap=2000):
        self.history = []       # undo 栈：Command 对象
        self.redo_stack = []    # redo 栈
        self._cap = cap
        self._tx = None         # C3：事务状态 {label, meta, saved_state, count, changed_paths, created_at}
        self._TX_TIMEOUT_S = 30 # C3 v2：事务超时保护（begin 成功但后续失败/卡住 → 超时自动 abort）

    def push_snapshot(self, saved_state, dv=None):
        """save_state 自动快照入口（5a 兜底）：草稿变化时压一个无语义快照 Command。
        5b 包壳后，写操作改走 execute()，此入口仅服务未包壳操作。

        2c-fix2（2026-08-24）：必须记录 dv。原实现不设 dv → snapshot 命令 dv_after 恒为 0，
        一旦撤销栈混入 snapshot 兜底命令，undo 门控 disk_dv(N) != cmd_dv(0) 永久判"外部已改动"
        → 纯手动操作撤销十几步后卡死（用户真机撞到，与外部 agent 无关）。
        dv = 本次变化前 domain_version（save_state record=True 时传 state 现值，+1 得变化后）。
        """
        cmd = Command("snapshot", "自动快照")
        cmd.saved_state = saved_state
        cmd.source = "snapshot"
        if dv is not None:
            cmd.dv_before = dv
            cmd.dv_after = dv + 1   # 变化后 dv（undo 门控比对基准）
        self.history.append(cmd)
        if len(self.history) > self._cap:
            self.history.pop(0)
        self.redo_stack.clear()
        _append_audit({
            "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "cmd_id": "snapshot", "label": "自动快照",
            "actor": None, "args": None, "meta": {}, "source": "snapshot",
        })

    def execute(self, api, cmd_id, args=None, meta=None):
        """写操作统一入口（5b 起）。构造 Command → 执行现有方法 → 成功入栈 + 审计。
        2b 双轨收敛：经 Api._in_execute 标志，方法内部 save_state 在 execute 期间不再自动压
        snapshot（避免「2 次 save_state → 2 个快照 → 撤销双步」），改由本方法统一压一条带语义的
        Command；仅当草稿「真实变更」(Api._op_changed) 时才入栈，无操作不留撤销步。
        参数适配：list/tuple 走位置（前端 store.js call 传数组），dict 走关键字（Agent/MCP 传 dict）。"""
        fn = getattr(api, cmd_id, None)
        if not callable(fn):
            return {"ok": False, "error": "未知命令 %s" % cmd_id}
        # 参数适配：位置数组 vs 关键字 dict
        if isinstance(args, (list, tuple)):
            call_args, call_kwargs = args, {}
        else:
            call_args, call_kwargs = (), dict(args or {})
        Api._in_execute = True
        Api._op_changed = False
        try:
            cmd = Command(cmd_id, cmd_id, meta)
            cmd.source = "execute"
            cmd.args = copy.deepcopy(args)
            cmd.saved_state = _clone_draft_share_peaks(api.draft)   # 3c：共享 peaks 引用降快照内存
            cmd.dv_before = api.state.get("domain_version", 0)   # 2c：操作前领域版本
            cmd.selection_before = (meta or {}).get("selection")  # 2c：操作前选中，undo 还原
            before_seg_map = {s.get("id"): copy.deepcopy(s) for s in _iter_all_segs_full(api.draft)}   # 2d：执行前段快照（深拷贝！否则 fn 内改动会污染 before，diff 误判"没变"）
            before = len(self.history)
            result = fn(*call_args, **call_kwargs)
            cmd.dv_after = api.state.get("domain_version", 0)    # 2c：操作后领域版本（save_state(record=True) 已 +1）
            after_seg_map = {s.get("id"): copy.deepcopy(s) for s in _iter_all_segs_full(api.draft)}    # 2d：执行后段快照
        finally:
            Api._in_execute = False
        # 防御：result 可能不是 dict（部分方法返回列表/True）→ 安全取 ok，避免 AttributeError
        ok = isinstance(result, dict) and bool(result.get("ok"))
        # 2d：事务内续期——**任一步**（含无改动步）都刷新 created_at，长事务/AI 批量不误 abort。
        # 必须在 op_changed 判断之外，否则无改动的步骤不续期。
        if self._tx is not None:
            self._tx["created_at"] = time.time()
        if ok and Api._op_changed:
            if self._tx is not None:
                # 事务内：只累计，不入栈（合并为一条事务 Command，undo 一次=回 begin 前）
                self._tx["count"] += 1
                self._tx["args"].append(copy.deepcopy(args))
                # 2d：本事务影响的段 = 精确 diff（新增 ∪ 删除 ∪ 内容变化），绝不把「存在但没改」的段算进来，
                # 否则 abort 会误把外部进程对同一批段的改动一起覆盖（R6 修复关键）。
                bi, ai_ = set(before_seg_map), set(after_seg_map)
                affected = (bi - ai_) | (ai_ - bi) | {i for i in (bi & ai_) if before_seg_map[i] != after_seg_map[i]}
                self._tx["affected_seg_ids"] |= affected
                if meta and meta.get("paths"):
                    for p in meta["paths"]:
                        if p not in self._tx["changed_paths"]:
                            self._tx["changed_paths"].append(p)
            else:
                if len(self.history) > before:
                    self.history.pop()   # 双录防护：弹掉方法内 save_state 可能残留的 snapshot
                self.history.append(cmd)
                if len(self.history) > self._cap:
                    self.history.pop(0)
                self.redo_stack.clear()
                _append_audit({
                    "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
                    "cmd_id": cmd_id, "label": cmd_id,
                    "actor": (meta or {}).get("actor"),
                    "args": copy.deepcopy(args),
                    "meta": meta or {},
                    "source": "execute",
                })
        return result

    # ---------- C3 事务（快照合并策略：一次事务 = 一条含 begin 前快照的 Command） ----------
    def begin_transaction(self, api, label="batch", meta=None):
        """开启事务：事务内 execute 只执行不入栈。超时遗留事务自动放弃后重开。"""
        if self._tx is not None:
            if self._tx_expired():
                self._abort_tx(api)      # 超时遗留事务自动放弃（v2：防 begin 成功→后续失败→commit 卡住）
            else:
                return {"ok": False, "error": "已有进行中的事务"}
        self._tx = {
            "label": label, "meta": meta or {},
            "saved_state": _clone_draft_share_peaks(api.draft),   # 3c：共享 peaks 引用降快照内存
            "count": 0, "changed_paths": [], "args": [], "created_at": time.time(),
            "affected_seg_ids": set(),   # 2d：本事务真正改过的段 id 集合（abort 段级 diff 用）
        }
        return {"ok": True, "tx": True}

    def commit_transaction(self, api):
        """事务结束：合并成一条快照 Command 入栈（undo 一次=回 begin 前）。空事务不压栈。"""
        if self._tx is None:
            return {"ok": False, "error": "没有进行中的事务"}
        tx = self._tx; self._tx = None
        if tx["count"] == 0:
            return {"ok": True, "tx": False, "count": 0}
        cmd = Command("tx:" + tx["label"], tx["label"], tx["meta"])
        cmd.saved_state = tx["saved_state"]
        cmd.count = tx["count"]
        cmd.changed_paths = tx["changed_paths"]
        cmd.args = tx["args"]
        self.history.append(cmd)
        if len(self.history) > self._cap:
            self.history.pop(0)
        self.redo_stack.clear()
        _append_audit({
            "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "cmd_id": "tx:" + tx["label"], "label": tx["label"],
            "actor": (tx["meta"] or {}).get("actor"),
            "args": tx["args"], "meta": tx["meta"] or {}, "source": "execute",
        })
        return {"ok": True, "tx": True, "count": tx["count"], "paths": tx["changed_paths"]}

    def abort_transaction(self, api):
        """回滚事务内全部改动（恢复 begin 前快照，不入栈）。幂等：无事务时直接报错。"""
        if self._tx is None:
            return {"ok": False, "error": "没有进行中的事务"}
        return self._abort_tx(api)

    def _tx_expired(self):
        return self._tx is not None and (time.time() - self._tx["created_at"]) > self._TX_TIMEOUT_S

    def _abort_tx(self, api):
        tx = self._tx; self._tx = None
        base = tx["saved_state"]                    # 内层 draft（begin 快照）
        disk = load_state()                        # 完整 state
        disk_draft = disk.get("draft", {})         # 2d：abort 时磁盘最新「内层 draft」= base + 本事务中间态 + 可能的外部(另一进程)改动
        affected = set(tx.get("affected_seg_ids", []))
        # 2d：段级 diff 回滚——只撤本事务真正改过的段，保留外部改动（R6 修复：
        # 原整轨覆盖写盘会把 begin 后、abort 前外部进程的改动也清掉）。
        result = copy.deepcopy(disk_draft)
        base_by_id = {s.get("id"): s for s in _iter_all_segs_full(base) if isinstance(s, dict)}
        for sid in affected:
            if sid not in base_by_id:
                _remove_seg_by_id(result, sid)                   # 本事务新增的段 → 移除
            else:
                _replace_seg_by_id(result, sid, copy.deepcopy(base_by_id[sid]))  # 修改/删除的段 → 覆盖回 base 态
        api.draft = result
        api.state["draft"] = result
        Api.last_committed = copy.deepcopy(result)
        save_state(api.state, record=False)
        return {"ok": True, "count": tx["count"]}

    def undo(self, api, selection=None):
        """撤销：弹 Command → 恢复其 saved_state（操作前状态）。
        C3：若存在未完成事务，先放弃事务（不撤销事务前的历史步），用户再按一次才撤销上一步。
        2c：version 门控——若磁盘 domain_version 已 ≠ 本命令 applied 版本，说明外部进程（MCP/另一窗口）
        在本命令应用后又改过草稿，此时撤销会丢失他人改动 → 拒绝并提示冲突（R14 防护，不误吞他人工作）。
        选中恢复——返回执行前选中快照，前端据此还原焦点；selection 参数（本次撤销前的前端选中）记为
        本命令的「操作后选中」，供后续 redo 还原。"""
        if self._tx is not None:
            # 拖动/操作进行中按 Ctrl+Z → 语义=放弃未完成动作（拖一半撤销=回到拖动前）
            self._abort_tx(api)
            return {"ok": True, "aborted_tx": True, "remaining": len(self.history)}
        if not self.history:
            return {"ok": False, "error": "没有可撤销的操作"}
        cmd = self.history[-1]
        # 2c version 门控：外部改动检测（仅 record=True 的真实领域改动会 bump domain_version；
        # 自身 undo/redo 走 record=False 不 bump → 不匹配一定是外部写入）。
        disk_dv = api.state.get("domain_version", 0)
        if disk_dv != cmd.dv_after:
            print("[UNDO-CONFLICT] disk_dv=%s cmd_dv_after=%s cmd=%s source=%s hist=%d" %
                  (disk_dv, cmd.dv_after, cmd.cmd_id, getattr(cmd, "source", "?"), len(self.history)))
            return {"ok": False, "conflict": True,
                    "error": "外部已改动草稿，撤销会丢失他人修改（先同步/另存再撤销）",
                    "disk_dv": disk_dv, "cmd_dv": cmd.dv_after}
        cmd = self.history.pop()
        if selection is not None:
            cmd.selection_after = selection   # 撤销前那一刻的选中（=本命令执行后的选中），redo 用
        cmd.post_state = copy.deepcopy(api.draft)   # undo 前 = 该命令执行后状态，redo 用
        api.draft = copy.deepcopy(cmd.saved_state)
        api.state["draft"] = api.draft
        api.state["domain_version"] = cmd.dv_before   # 2c 修复：undo 把领域版本回退到操作前；否则磁盘 dv 停在最后操作后，
                                                      # 越往回的 cmd.dv_after 越小 → 第2次起永久判冲突（撤销死循环，撤销被卡死）
        save_state(api.state, record=False)   # record=False → 不 bump domain_version，门控基线不被自身 undo 破坏
        self.redo_stack.append(cmd)
        return {"ok": True, "remaining": len(self.history), "selection": cmd.selection_before}

    def redo(self, api, selection=None):
        """重做：弹 redo 栈 → 恢复其 post_state（该命令执行后状态）。
        2c：version 门控同样适用（外部在撤销后改过 → 拒绝）；返回操作后选中供前端还原。"""
        if not self.redo_stack:
            return {"ok": False, "error": "没有可重做的操作"}
        cmd = self.redo_stack[-1]
        disk_dv = api.state.get("domain_version", 0)
        # 2c 修复：redo 前状态 = 本命令执行前（dv_before），检测基准用 dv_before 而非 dv_after，
        # 否则与 undo 回退后的 domain_version 永远不匹配 → redo 第一次就永久冲突。
        if disk_dv != cmd.dv_before:
            print("[REDO-CONFLICT] disk_dv=%s cmd_dv_before=%s cmd=%s source=%s redo=%d" %
                  (disk_dv, cmd.dv_before, cmd.cmd_id, getattr(cmd, "source", "?"), len(self.redo_stack)))
            return {"ok": False, "conflict": True,
                    "error": "外部已改动草稿，重做会丢失他人修改（先同步/另存再重做）",
                    "disk_dv": disk_dv, "cmd_dv": cmd.dv_before}
        cmd = self.redo_stack.pop()
        if selection is not None:
            cmd.selection_before = selection  # 重做前那一刻的选中（=撤销后的选中），下次 undo 还原
        api.draft = copy.deepcopy(cmd.post_state)
        api.state["draft"] = api.draft
        api.state["domain_version"] = cmd.dv_after   # 2c 修复：redo 把领域版本恢复到操作后
        save_state(api.state, record=False)
        self.history.append(cmd)
        if len(self.history) > self._cap:
            self.history.pop(0)
        return {"ok": True, "remaining": len(self.redo_stack), "selection": cmd.selection_after}

    def audit_log(self, limit=100, actor=None):
        """审计查询：谁做过什么（Agent 可审计）。"""
        rows = self.history[-limit:] if not actor else [r for r in self.history if r.meta.get("actor") == actor][-limit:]
        return [{"cmd_id": r.cmd_id, "label": r.label, "meta": r.meta, "args": r.args, "source": r.source} for r in rows]


# 1d（M1 收尾，2026-08-23）：写失败可见化用的「粘性」标志。
# save_state 失败时置 True（成功不清除，保证一次调用内多次 save_state 只要有一次失败就标记）；
# 方法级 wrapper 在返回后检测并翻转 ok。模块级全局，方法入口由 wrapper 每次调用重置为 False。
FAILED_SAVE = False
# 2e：乐观锁冲突透传——save_state 检测到跨进程 version 冲突时存入此处，
# 由 _wrap_save_failure 在 Api 方法返回后注入 conflict 错误，使桌面/MCP 两路径都能看到冲突码。
SAVE_LAST_CONFLICT = None


# 3c（M3，2026-08-23）：撤销快照深拷贝降内存——结构递归克隆但「共享 peaks 引用」。
# 草稿里真正占内存的是音频段 peaks 波形数组（最长 60000 浮点）；快照只需完整、自洽的
# 草稿副本供 undo 还原，peaks 在多个快照间共享同一份引用即可，无需每份复制一份 60000 浮点
# → 单次操作的内存峰值约降 50%。
# 安全性（牵连处核查）：全局 grep 确认 peaks 只在新建/导入时 `item["peaks"]=peaks`【整体赋值】，
# 从无原地 mutate（无 .append/[i]=/.extend on 已有 peaks）→ 复用引用不会让「活草稿」与
# 「历史快照」的 peaks 互相污染。另：undo/redo 还原仍走 copy.deepcopy(saved_state)，
# 还原产物是独立深拷贝、不把共享 peaks 引用泄露进活草稿，零别名风险（见 3c 设计说明）。
def _clone_draft_share_peaks(obj):
    """递归克隆草稿结构，但 key=="peaks" 的值按引用共享（不复制波形大数组）。"""
    if isinstance(obj, dict):
        return {k: (v if k == "peaks" else _clone_draft_share_peaks(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clone_draft_share_peaks(x) for x in obj]
    return obj


# 3d（M3，2026-08-23）：读回验证抽样化——整树 JSON 深比较 → version + 字节长度 + 可解析性抽样。
# 原 `back["draft"] != state["draft"]` 对整棵草稿递归深比较（段多/关键帧多时极重，CPU 放大 3-4×）；
# 抽样三个恒定成本信号即可抓到「假成功」：① 能解析为合法 JSON（头/结构完好）
# ② 字节长度与本次写出一致（抓截断/被另一进程部分覆盖）③ version 时间戳一致
# （抓被另一进程整体覆盖/未落盘）。生产路径传入已序列化的字符串（serialized），避免二次全树序列化；
# 单测可不传（内部自算）。written_bytes 用 encode 算字节数（含中文素材名时字符数≠字节数）。
def _verify_saved(state, path, serialized=None):
    """返回 (ok, detail)。抽样验证写盘内容是否与内存一致。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
        back = json.loads(raw)
    except Exception as e:
        return False, "读回失败: %r" % (e,)
    if serialized is None:
        serialized = json.dumps(state, ensure_ascii=False, indent=2)
    written_bytes = len(serialized.encode("utf-8"))
    if back.get("version") != state.get("version"):
        return False, "version 不一致 期望=%s 实际=%s" % (state.get("version"), back.get("version"))
    if len(raw.encode("utf-8")) != written_bytes:
        return False, "字节长度不一致 期望=%s 实际=%s" % (written_bytes, len(raw.encode("utf-8")))
    return True, None


# 4a（M4，2026-08-23）：document-changed 事件载荷。
# save_state 成功写盘后对比「写前/写后」草稿，产出紧凑变更描述，两种消费通道共用：
#   ① 桌面即时推：同进程 save_state 成功后 evaluate_js 调 window.__onDocumentChanged（<100ms），
#      仅用于桌面进程内、且非 execute 调用链中的「带外」保存（execute 链由前端 API 返回后自行重绘，
#      走 evaluate_js 反有重入风险，故跳过）；
#   ② 富化轮询：get_state 在全量分支用「上次轮询草稿」diff 当前草稿，把 payload 挂 meta.documentChanged
#      返回（MCP 经 2s version 门控轮询即见；桌面前端也靠它做差量渲染，覆盖 MCP/另一窗口的跨进程改动）。
# 重型派生字段 peaks/src_full 一律排除——非语义编辑且体积巨大，既避假阳性也避 payload 爆炸。
_CHANGE_EXCLUDE_FIELDS = ("peaks", "src_full")
_CHANGE_CONTAINER_KEYS = ("main", "overlay", "audio", "text", "materials")


def _seg_light(seg):
    """段的最小比较体：去掉重型派生字段，其余语义字段全留（位置/时长/变换/关键帧/速度/音量/文本）。"""
    if not isinstance(seg, dict):
        return seg
    return {k: v for k, v in seg.items() if k not in _CHANGE_EXCLUDE_FIELDS}


def _iter_seg_index(draft):
    """{seg_id: (light_seg, track_type)} 覆盖 main/overlay/audio/text 全部轨道。"""
    idx = {}
    if not isinstance(draft, dict):
        return idx
    main = draft.get("main")
    if isinstance(main, dict):
        for s in (main.get("segs") or []):
            if isinstance(s, dict) and s.get("id") is not None:
                idx[s["id"]] = (_seg_light(s), "main")
    for tr in (draft.get("overlay") or []):
        if isinstance(tr, dict):
            ttype = tr.get("type") or "overlay"
            for s in (tr.get("segs") or []):
                if isinstance(s, dict) and s.get("id") is not None:
                    idx[s["id"]] = (_seg_light(s), ttype)
    for tr in (draft.get("audio") or []):
        if isinstance(tr, dict):
            for s in (tr.get("segs") or []):
                if isinstance(s, dict) and s.get("id") is not None:
                    idx[s["id"]] = (_seg_light(s), "audio")
    for tr in (draft.get("text") or []):
        if isinstance(tr, dict):
            for s in (tr.get("segs") or []):
                if isinstance(s, dict) and s.get("id") is not None:
                    idx[s["id"]] = (_seg_light(s), "text")
    return idx


def _mat_id(m):
    return m.get("uid") or m.get("id")


def _compute_change_payload(before_draft, after_draft, actor="system", version=None):
    """返回变更载荷 dict；无变化则 {"empty": True}（供调用方跳过发布，防爆炸）。
    payload = {version, changedSegIds, changedSegOps, changedMaterials, changedKeys, actor, ts}"""
    bi = _iter_seg_index(before_draft)
    ai = _iter_seg_index(after_draft)
    changed_seg_ids, changed_seg_ops, changed_keys = [], {}, set()
    for sid, (seg, ttype) in ai.items():
        if sid not in bi:
            changed_seg_ids.append(sid); changed_seg_ops[sid] = "added"; changed_keys.add(ttype)
        elif bi[sid][0] != seg:
            changed_seg_ids.append(sid); changed_seg_ops[sid] = "modified"; changed_keys.add(ttype)
    for sid, (seg, ttype) in bi.items():
        if sid not in ai:
            changed_seg_ids.append(sid); changed_seg_ops[sid] = "removed"; changed_keys.add(ttype)
    bm = {_mat_id(m) for m in (before_draft or {}).get("materials", []) if _mat_id(m)}
    am = {_mat_id(m) for m in (after_draft or {}).get("materials", []) if _mat_id(m)}
    changed_materials = sorted((am - bm) | (bm - am))
    for k in set((before_draft or {})) | set((after_draft or {})):
        if k in _CHANGE_CONTAINER_KEYS:
            continue
        if (before_draft or {}).get(k) != (after_draft or {}).get(k):
            changed_keys.add(k)
    if not (changed_seg_ids or changed_materials or changed_keys):
        return {"empty": True}
    return {
        "version": version if version is not None else (after_draft or {}).get("version"),
        "changedSegIds": changed_seg_ids,
        "changedSegOps": changed_seg_ops,
        "changedMaterials": changed_materials,
        "changedKeys": sorted(changed_keys),
        "actor": actor,
        "ts": int(time.time() * 1000),
    }


# 同进程内「上次发布的变更载荷」缓存（evaluate_js 推 + 兜底读取）。跨进程不可见，真消费以 get_state 轮询为准。
LAST_DOCUMENT_CHANGE = None
# save_state 发布时的 actor：execute/undo/redo 写入，区分「桌面用户 / 外部 Agent / 系统」三类来源。
DOCUMENT_CHANGE_ACTOR = "system"


def _publish_document_change(before_draft, state):
    """4a：写盘成功后发布变更载荷（仅同进程生效；跨进程靠 get_state 轮询 diff）。

    - 缓存到模块级 LAST_DOCUMENT_CHANGE（同一进程内后续 get_state 可直接复用其 actor）；
    - 桌面进程内、且非 execute 调用链中（避免重入死锁）时，evaluate_js 即时推 window.__onDocumentChanged。
    """
    payload = _compute_change_payload(before_draft, state["draft"], DOCUMENT_CHANGE_ACTOR, state.get("version"))
    if payload.get("empty"):
        return
    global LAST_DOCUMENT_CHANGE
    LAST_DOCUMENT_CHANGE = payload
    if webview is not None and getattr(webview, "windows", None):
        # 仅在「带外」保存时即时推：execute 链由前端 API 返回后自行重绘，重入 evaluate_js 有风险，跳过。
        if not Api._in_execute:
            try:
                js = "(window.__onDocumentChanged||function(){})(%s)" % json.dumps(payload, ensure_ascii=False)
                webview.windows[0].evaluate_js(js)
            except Exception:
                pass


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
    global FAILED_SAVE, SAVE_LAST_CONFLICT
    # 4a：捕获「写前」已提交草稿（仅引用，不复制；行 1238 会把它整体深拷贝成新基线，此处引用不受影响）。
    # 用于成功后 diff 产出变更载荷。
    before_committed = Api.last_committed
    if record and Api.last_committed is not None and state["draft"] != Api.last_committed:
        # 2b 双轨收敛：标记本次操作真实变更；仅当「未走 execute」(直接调用)时才压兜底快照，
        # 走 execute 的路径由 CommandManager.execute 统一压带语义的 Command（避免双步 / 无 cmd_id）。
        Api._op_changed = True
        if (not Api._in_execute) and Api.cmd_mgr is not None:
            Api.cmd_mgr.push_snapshot(_clone_draft_share_peaks(Api.last_committed),
                                      state.get("domain_version", 0))   # 2c-fix2：传变化前 dv，undo 门控不误判
    # A1（2026-08-19）：写盘前统一确保轨道 tid——任何途径新建的轨（_track_segs ensure /
    # _ensure_*_track / add_* 系列）落盘前自动带 tid，不依赖每个建轨点手动加。
    if isinstance(state.get("draft"), dict):
        _ensure_track_tids(state["draft"])
    Api.last_committed = copy.deepcopy(state["draft"])
    expected_version = state.get("version")   # 本进程期望磁盘当前的 version（乐观锁比较值）
    try:
        state.setdefault("schemaVersion", DOCUMENT_SCHEMA_VERSION)
        if record:
            # 2c（M2）：domain_version 仅在「真实领域改动」(record=True) 时单调 +1。
            # undo/redo/_reload 回填均走 record=False → 不 bump → 可作为「是否被外部进程改动」的判据，
            # 供 undo/redo 的 version 门控区分「自身历史回放」与「MCP/另一窗口的外部写入」。
            state["domain_version"] = state.get("domain_version", 0) + 1
        # 2e：乐观锁——用 r+（不截断）在文件锁内「先读盘比对，再决定写不写」。
        # 原 open("w") 先截断再上锁会在加锁前清空磁盘，等于把乐观锁的读盘时机让给竞态窗口；
        # 改用 r+ 在读盘比对通过后才 seek(0)+truncate 写回，保证「读-比-写」原子于锁内。
        if not os.path.exists(STATE_PATH):
            with open(STATE_PATH, "w", encoding="utf-8") as _f0:
                json.dump({}, _f0)
        with open(STATE_PATH, "r+", encoding="utf-8") as f:
            if _HAS_LOCK:
                portalocker.lock(f, portalocker.LOCK_EX)
            # 读盘当前 version
            ondisk_version = None
            try:
                f.seek(0)
                _ondisk = json.load(f)
                ondisk_version = _ondisk.get("version")
            except Exception:
                ondisk_version = None   # 读不到（首存/损坏）按无冲突处理
            # 乐观锁比对：期望版本与磁盘不一致 → 被另一进程（桌面/MCP）改过 → 拒绝覆盖
            if expected_version is not None and ondisk_version is not None and ondisk_version != expected_version:
                print("[SAVE-CONFLICT] 乐观锁冲突：期望磁盘version=%s，实际=%s（record=%s）" % (expected_version, ondisk_version, record))
                if record:
                    SAVE_LAST_CONFLICT = {"expected": expected_version, "actual": ondisk_version}
                return {"ok": False, "conflict": True, "expected": expected_version, "actual": ondisk_version}
            # 通过：写回（seek 0 覆盖，不再先清空再上锁）
            # 3d：序列化一次，复用字符串做「字节长度抽样」（避免写后再全树序列化）
            f.seek(0); f.truncate()
            state["version"] = int(time.time() * 1000)
            serialized = json.dumps(state, ensure_ascii=False, indent=2)
            f.write(serialized)
            f.flush(); os.fsync(f.fileno())
        # 3d 读回验证抽样化（2026-08-23，取代 2026-08-19 整树深比较）：
        # 堵死「假成功」——写盘没抛异常但内容不对（磁盘缓存/另一个进程抢写）；
        # 返回 True 但段没落盘 = "动一下但没素材"的另一条路。抽样验证不一致 → 明确 [SAVE-VERIFY-FAIL]。
        ok, detail = _verify_saved(state, STATE_PATH, serialized)
        if not ok:
            print("[SAVE-VERIFY-FAIL] " + detail)
            FAILED_SAVE = True
            return False
        # 4a：成功写盘 → 计算并发布 document-changed 载荷（同进程 evaluate_js 推 + 轮询 diff 两通道）。
        _publish_document_change(before_committed, state)
        return True
    except Exception as e:
        # 2026-08-19：写盘失败必须可见（之前静默 return False → add 照常 ok=true → 段在内存但没落盘
        # → 下一个操作 _reload 读旧盘 → 段全丢 = "拖进去了又消失"的元凶）。打后端控制台 + 返回 False。
        import traceback
        print("[SAVE-FAIL] 写盘失败:", repr(e))
        traceback.print_exc()
        FAILED_SAVE = True
        return False


# 2a（M2，2026-08-23）：append-only 审计落盘。每次领域修改（execute / 自动快照 / 事务 commit）
# 向 audit_log.jsonl 追加一行 JSON {ts,cmd_id,label,actor,args,meta}，供 Agent 离线审计"谁在何时改了什么"。
AUDIT_PATH = os.path.join(HERE, "audit_log.jsonl")

def _append_audit(entry):
    """向 audit_log.jsonl 追加一行审计记录（append-only；失败仅打日志，不阻塞主流程）。"""
    try:
        with open(AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        print("[AUDIT-FAIL] 审计落盘失败:", repr(e))


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

def _iter_all_segs(draft):
    """X 模型：遍历草稿所有段（main / overlay / audio），供兼容/补默认值类函数使用。"""
    main = draft.get("main")
    if isinstance(main, dict):
        for seg in main.get("segs", []):
            yield seg
    for tr in draft.get("overlay", []):
        if isinstance(tr, dict):
            for seg in tr.get("segs", []):
                yield seg
    for a in draft.get("audio", []):
        if isinstance(a, dict):
            for seg in a.get("segs", []):
                yield seg


def _ensure_seg_ids(draft):
    """给草稿里所有缺 id 的段补一个 uuid（浅改 self.draft，首次 save_state 落盘）。"""
    for seg in _iter_all_segs(draft):
        if isinstance(seg, dict) and "id" not in seg:
            seg["id"] = uuid.uuid4().hex


# 2d（M2）：事务 abort 段级 diff 用的遍历 / 索引 / 改段 helper。
# 覆盖 main / overlay / audio / text 全部轨道（_iter_all_segs 仅含 main/overlay/audio，
# 故这里单独实现完整版，保证 abort 不漏 text 段）。
def _collect_seg_tracks(draft):
    """返回草稿中所有「段列表」的可原地修改引用（main.segs / overlay[].segs / audio[].segs / text[].segs）。"""
    tracks = []
    main = draft.get("main")
    if isinstance(main, dict) and isinstance(main.get("segs"), list):
        tracks.append(main["segs"])
    for key in ("overlay", "audio", "text"):
        col = draft.get(key)
        if isinstance(col, list):
            for tr in col:
                if isinstance(tr, dict) and isinstance(tr.get("segs"), list):
                    tracks.append(tr["segs"])
    return tracks

def _iter_all_segs_full(draft):
    """同 _iter_all_segs 但含 text 轨道（2d abort diff 用）。"""
    for tr in _collect_seg_tracks(draft):
        for seg in tr:
            yield seg

def _all_seg_id_set(draft):
    """草稿中所有段 id 集合。"""
    return {s.get("id") for s in _iter_all_segs_full(draft) if isinstance(s, dict)}

def _remove_seg_by_id(draft, seg_id):
    """原地删除指定 id 的段（不存在则 no-op）。"""
    for tr in _collect_seg_tracks(draft):
        i = 0
        while i < len(tr):
            if tr[i].get("id") == seg_id:
                tr.pop(i)
            else:
                i += 1

def _replace_seg_by_id(draft, seg_id, new_seg):
    """原地用 new_seg 替换指定 id 的段（找到第一个即返回）。"""
    for tr in _collect_seg_tracks(draft):
        for i, s in enumerate(tr):
            if s.get("id") == seg_id:
                tr[i] = new_seg
                return


def _track_exists(draft, track_type):
    """M6-6c Preset ensure_track 辅助：该类型轨道是否已存在。
    video/main 主视频轨恒定存在；text/sticker/effect 查 overlay 池；audio 查 audio 数组。"""
    if track_type in ("video", "main"):
        return True
    if track_type == "audio":
        return bool(draft.get("audio") or [])
    if track_type in ("text", "sticker", "effect"):
        return any(t.get("type") == track_type for t in (draft.get("overlay") or []) if isinstance(t, dict))
    return False


# ---------- M7-7b D5 最小任务队列（threading + task_id + 状态登记） ----------
# 长任务（转写/导入/peaks）后台线程执行，js_api 只提交返回 task_id，前端轮询 get_task_status。
# 不阻塞 UI 与 MCP 通道；失败状态登记 error，由调用方决定重试/回退同步。
_TASKS = {}
_TASK_LOCK = threading.Lock()
_TASK_SEQ = [0]


def _submit_task(fn, *args, **kwargs):
    """提交后台任务，立即返回 task_id。fn 在 daemon 线程执行，状态登记 _TASKS。"""
    with _TASK_LOCK:
        _TASK_SEQ[0] += 1
        task_id = "task_%d" % _TASK_SEQ[0]
        _TASKS[task_id] = {"status": "running", "created_at": time.time(),
                           "result": None, "error": None}

    def _runner():
        try:
            result = fn(*args, **kwargs)
            with _TASK_LOCK:
                t = _TASKS.get(task_id)
                if t:
                    t["status"] = "done"
                    t["result"] = result
        except Exception as e:
            with _TASK_LOCK:
                t = _TASKS.get(task_id)
                if t:
                    t["status"] = "error"
                    t["error"] = repr(e)

    threading.Thread(target=_runner, daemon=True).start()
    return task_id


# ---- Effect Registry（Effect DSL 双 adapter：预览 css + 导出 ffmpeg，读同一份 params 规格）----
# 单一真源：项目根目录 effects.json。main.py 启动时加载，生成 EFFECT_REGISTRY（函数）和 EFFECT_META（自描述）。
# 新增/修改特效只需改 effects.json；预览 css 适配器仍需在 effects.js 同步镜像（下一阶段可也 JSON 化）。
# 无操作（默认参数）返回 ""，避免叠加无效滤镜——renderer/export 跳过空串即可。

def _build_effect_filter(filter_spec):
    """根据 effects.json 里的 filter 模板生成一个 params -> filter_string 函数。"""
    expr = filter_spec.get("expr", "")
    when = filter_spec.get("when", "True")
    def _fn(p):
        try:
            if not eval(when, {"__builtins__": {}}, dict(p or {})):
                return ""
        except Exception:
            return ""
        try:
            return expr.format(**(p or {}))
        except Exception:
            return ""
    return _fn

def _load_effects():
    """从 effects.json 加载注册表。文件缺失/损坏则返回空注册表（启动会异常明显，便于排查）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "effects.json")
    if not os.path.exists(path):
        return {}, {}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    registry = {}
    meta = {}
    for key, spec in (data.get("effects") or {}).items():
        # M6-6b：meta 增加 css_expr/css_when —— 前端 Effects.compile 现场编译 css adapter 的数据源
        # （消灭 effects.js 人工镜像：新增特效只改 effects.json，预览/面板/导出三处自动生效）。
        css = (spec.get("filters") or {}).get("css") or {}
        meta[key] = {
            "label": spec.get("label", key),
            "params": spec.get("params", {}),
            "css_expr": css.get("expr", ""),
            "css_when": css.get("when", "True"),
        }
        filters = spec.get("filters", {})
        registry[key] = {
            "css": _build_effect_filter(filters.get("css", {})),
            "ffmpeg": _build_effect_filter(filters.get("ffmpeg", {})),
        }
    return registry, meta

EFFECT_REGISTRY, EFFECT_META = _load_effects()

# M6-6b Plugin v0：把 effects 注册表包装成内置 effects 插件，注册进类级 PluginManager。
# masks/commands/exporters 为空位，为 M7 Intent exporters 与第三方特效包留注册点。
PLUGIN_MANAGER = PluginManager()
PLUGIN_MANAGER.register(builtin_effects_manifest(EFFECT_REGISTRY, EFFECT_META))

def _effect_keyframes_to_anims(keyframes):
    """5c（R18 并入统一 channel）：把扁平特效关键帧 [{param,time(us),value,easing}]
    转成统一通道 seg['animations']['effect.{param}'] = {keys:[{t,v,seg}]}（与 transform 同源）。"""
    anims = {}
    for kf in (keyframes or []):
        if not isinstance(kf, dict) or kf.get("param") is None:
            continue
        path = "effect." + str(kf["param"])
        ch = anims.setdefault(path, {"keys": []})
        ch["keys"].append({
            "t": int(kf.get("time", 0)),
            "v": float(kf.get("value", 0)),
            "seg": kf.get("easing") or "linear",
        })
    return anims

EFFECT_META_NOTE = (
    "所有特效支持 keyframes=[{param,time(us,相对段起点),value,easing}] 做时间曲线；"
    "target 省略=调整层(盖整栈预览+导出)，{type:'clip',track,ti,si}=绑素材段，{type:'track',ti}=整轨特效（v1.x）。"
)


def _ensure_seg_speeds(draft):
    """给草稿里所有 video/audio 段补 speed/change_pitch 默认值（兼容旧项目）。"""
    for seg in _iter_all_segs(draft):
        if isinstance(seg, dict) and seg.get("type") in ("video", "audio"):
            seg.setdefault("speed", DEFAULT_SPEED)
            seg.setdefault("change_pitch", False)


def _ensure_seg_src_full(draft):
    """给 video/audio 段补 src_full（源素材真实全长，微秒）= 右拖恢复被裁帧的上限。

    缺失时按媒体文件实时探测（duration_for），与 _trim_core 的 real_us 同源。
    图片/文本无源素材，不参与（前端按 isMedia 单独处理）。
    返回是否发生了回填（供调用方决定是否落盘）。
    """
    changed = False
    for seg in _iter_all_segs(draft):
        if not isinstance(seg, dict):
            continue
        if seg.get("src_full"):
            continue
        p = seg.get("path")
        mtype = seg.get("type")
        if p and mtype in ("video", "audio"):
            d = duration_for(p, mtype)
            if d:
                seg["src_full"] = int(d)
                changed = True
    return changed


def _seg_speed(seg):
    """返回段的实际变速倍率（clamp 到合法范围）。"""
    if not isinstance(seg, dict):
        return DEFAULT_SPEED
    rate = seg.get("speed", DEFAULT_SPEED)
    if not isinstance(rate, (int, float)) or rate <= 0 or not (rate == rate):
        return DEFAULT_SPEED
    return max(MIN_SPEED, min(MAX_SPEED, float(rate)))


# ---------- 5b（R9 双真源收敛）：path-addressed 属性真相源辅助 ----------
# 对齐 OpenCut baseTransform + animations[path] 的 path 命名空间；让 seg['params'][path]
# 成为唯一真相源，旧字段 seg.transform/speed/volume 仅作 legacy 兜底/序列化镜像。
def _write_param(seg, path, value):
    """把属性写进 seg['params'][path]（唯一真相源）。"""
    if not isinstance(seg, dict):
        return
    seg.setdefault("params", {})
    if isinstance(seg.get("params"), dict):
        seg["params"][path] = value


def _seg_param(seg, path, default=None):
    """从 seg['params'][path] 读属性；旧草稿无 params 时返回 default（legacy 兜底在外层做）。"""
    if not isinstance(seg, dict):
        return default
    p = seg.get("params")
    if isinstance(p, dict) and path in p and p[path] is not None:
        return p[path]
    return default


# update_segment_transform 旧字段名 → params path 映射
_FIELD_TO_PARAM = {
    "x": "transform.positionX", "y": "transform.positionY",
    "scaleX": "transform.scaleX", "scaleY": "transform.scaleY",
    "rotation": "transform.rotate", "opacity": "transform.opacity",
}


# ===================== Playback Graph 语义层（Phase A，与 playback-graph.js 逐字段对拍） =====================
# 规范见 docs/architecture/playback-rootfix-bundled.md §3。
# 对拍保险丝：tools/graph_consistency.py 同一 draft 跑两端，平铺结果必须逐字段一致。
# 浏览器端实现：playback-graph.js buildPlaybackGraph() —— 两端实现必须逐行对齐！


def _seg_num(v, dflt):
    """数值兜底：非数值 / NaN → 返回 dflt（与 playback-graph.js _num 对齐）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return dflt
    return v if v == v else dflt


def _graph_clamp_speed(v):
    """变速 clamp：与 playback-graph.js _clampSpeed 对齐。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v <= 0 or not (v == v):
        return DEFAULT_SPEED
    return max(MIN_SPEED, min(MAX_SPEED, float(v)))


def _graph_volume(v):
    """音量兜底：能转数值就转，否则 1（与 playback-graph.js _graphVolume 对齐）。"""
    if v is None or v == "":
        return 1
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 1
    return f if f == f else 1


def _resolve_seg_path(seg, materials):
    """素材解析：material_id → materials[].uid 查 path；失败 fallback seg.path（与 store.js resolveSegPath / playback-graph.js _resolvePath 同构）。"""
    if not isinstance(seg, dict):
        return None
    mid = seg.get("material_id")
    if mid:
        for m in (materials or []):
            if isinstance(m, dict) and m.get("uid") == mid and m.get("path"):
                return m["path"]
    return seg.get("path") or None


def _graph_resolve_gain(track_muted, seg_muted, seg_volume):
    """§3.4 第一层：两端共享（播放 + 导出都用）—— 不含 previewMuted。"""
    if track_muted:
        return 0
    if seg_muted:
        return 0
    return _graph_volume(seg_volume)


def _flatten_video(seg, ti, idx, track_muted, track_hidden, materials):
    """video 轨段 → VideoNode（含内嵌声），字段与 playback-graph.js _flattenVideo 一致。"""
    if not isinstance(seg, dict):
        return None
    start_us = _seg_num(seg.get("start"), 0)
    duration_us = _seg_num(seg.get("duration"), 0)
    src_start_us = _seg_num(seg.get("src_start"), 0)
    # 2026-08-17 根治：源终点推导（与 playback-graph.js deriveSrcEndUs 一致）——
    # (src_end - src_start) / speed == duration 不变量，杜绝 trim 累加失同步脏数据
    speed_v = _graph_clamp_speed(_seg_param(seg, "speed.rate", seg.get("speed")))
    src_end_us = src_start_us + max(0, duration_us) * speed_v
    return {
        "key": "video:%d:%d" % (ti, idx),
        "trackKey": "video:%d" % ti,
        "startUs": start_us,
        "durationUs": duration_us,
        "srcStartUs": src_start_us,
        "srcEndUs": src_end_us,
        "speed": speed_v,
        "gain": _graph_resolve_gain(track_muted, bool(seg.get("muted")), _seg_param(seg, "audio.volume", seg.get("volume"))),
        "muted": bool(seg.get("muted")),
        "path": _resolve_seg_path(seg, materials),
        "hidden": bool(track_hidden) or bool(seg.get("hidden")),
    }


def _flatten_audio(seg, ti, idx, track_muted, materials):
    """audio 轨段 → AudioClip，字段与 playback-graph.js _flattenAudio 一致。"""
    if not isinstance(seg, dict):
        return None
    start_us = _seg_num(seg.get("start"), 0)
    duration_us = _seg_num(seg.get("duration"), 0)
    src_start_us = _seg_num(seg.get("src_start"), 0)
    # 2026-08-17 根治：源终点推导（与 playback-graph.js deriveSrcEndUs 一致）
    speed_v = _graph_clamp_speed(_seg_param(seg, "speed.rate", seg.get("speed")))
    src_end_us = src_start_us + max(0, duration_us) * speed_v
    return {
        "key": "audio:%d:%d" % (ti, idx),
        "trackKey": "audio:%d" % ti,
        "startUs": start_us,
        "durationUs": duration_us,
        "srcStartUs": src_start_us,
        "srcEndUs": src_end_us,
        "speed": speed_v,
        "gain": _graph_resolve_gain(track_muted, bool(seg.get("muted")), _seg_param(seg, "audio.volume", seg.get("volume"))),
        "path": _resolve_seg_path(seg, materials),
    }


def _playback_graph(draft, materials=None):
    """Python 版语义层：输出 audioClips / videoNodes，字段与 §3.2 完全一致。

    与 playback-graph.js buildPlaybackGraph 逐字段对拍（tools/graph_consistency.py）。
    内建：兼容兜底（§3.3）+ resolveGain（§3.4，不含 previewMuted）+ 素材解析。
    """
    materials = materials or []
    draft = draft or {}
    meta = draft.get("_track_meta") or {}
    audio_clips = []
    video_nodes = []

    # main 主场景（video ti=0）
    main = draft.get("main", {"segs": []})
    if isinstance(main, dict):
        tmeta = meta.get("main") or {}
        track_muted = bool(tmeta.get("muted"))
        track_hidden = bool(tmeta.get("hidden"))
        for idx, seg in enumerate(main.get("segs", [])):
            node = _flatten_video(seg, 0, idx, track_muted, track_hidden, materials)
            if node is not None:
                video_nodes.append(node)
    # overlay 视频覆盖轨（ti 从 1 起）
    v_cnt = 0
    overlay = draft.get("overlay") or []
    for oi, tr in enumerate(overlay):
        if not isinstance(tr, dict) or tr.get("type") != "video":
            continue
        v_cnt += 1
        ti = v_cnt
        tmeta = (meta.get("overlay") or [])[oi] if oi < len(meta.get("overlay") or []) else {}
        track_muted = bool(tmeta.get("muted"))
        track_hidden = bool(tmeta.get("hidden"))
        for idx, seg in enumerate(tr.get("segs", [])):
            node = _flatten_video(seg, ti, idx, track_muted, track_hidden, materials)
            if node is not None:
                video_nodes.append(node)

    for ti, a in enumerate(draft.get("audio") or []):
        if not isinstance(a, dict):
            continue
        tmeta = (meta.get("audio") or [])[ti] if ti < len(meta.get("audio") or []) else {}
        track_muted = bool(tmeta.get("muted"))
        for idx, seg in enumerate(a.get("segs", [])):
            clip = _flatten_audio(seg, ti, idx, track_muted, materials)
            if clip is not None:
                audio_clips.append(clip)

    return {"audioClips": audio_clips, "videoNodes": video_nodes}


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
    # 音量关键帧（OpenCut AudioTab ◆ 按钮）：value 存音量倍率(0~2)，与 seg["volume"] 同单位；
    # 预览/导出时若有该通道则按播放头插值覆盖 base（对齐 OpenCut 动画通道覆盖 base 语义）
    "volume":              {"label": "音量", "default": 1.0, "export": "volume", "coord": None},
}
KF_KEYFRAMEABLE = tuple(KF_PROPS.keys())


def _ensure_seg_animations(draft):
    """给草稿里所有段补 animations 默认值（兼容旧项目）。"""
    for seg in _iter_all_segs(draft):
        if isinstance(seg, dict):
            seg.setdefault("animations", {})


def _seg_anims(seg):
    if not isinstance(seg, dict):
        return {}
    a = seg.get("animations")
    return a if isinstance(a, dict) else {}


# M7-7c：时间统一收口——所有微秒换算的基准常量（对齐前端 timeline-mapper.js TICKS_PER_SECOND）。
TICKS_PER_SECOND = 1_000_000


def snap_frame(us, fps=30):
    """帧吸附：把微秒时间吸附到 fps 整帧（后端统一入口，与前端 TimelineMapper.snapFrame 同语义）。

    对齐新版 OpenCut `roundFrameTicks`：打点时间统一吸到整帧，保证"同一播放头打的 X/Y 严格同帧"。
    """
    frame_us = int(round(TICKS_PER_SECOND / (fps or 30)))
    return int((int(us) + frame_us // 2) // frame_us) * frame_us


def _frame_snap_us(t):
    """【5d 兼容别名】30fps 帧吸附 = snap_frame(t, 30)。新代码请直接调 snap_frame。"""
    return snap_frame(t, 30)


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


# 素材尺寸缓存（导出时 ffprobe/PIL 探测成本高，同素材多段复用）
_MEDIA_DIM_CACHE = {}


def _media_dims_cached(path):
    """取素材像素宽高 (w, h)，带模块级缓存。失败返回 (None, None)。"""
    if not path:
        return None, None
    if path not in _MEDIA_DIM_CACHE:
        _MEDIA_DIM_CACHE[path] = get_media_dimensions(path)
    return _MEDIA_DIM_CACHE[path]


def _video_clip_settings(seg, W, H):
    """把视频/图片段的静态 transform 换算成 pyJianYingDraft ClipSettings（2026-08-21，B5 登记缺口修复）。

    背景：之前视频/图片段导出不传 clip_settings → 拖了位置/改了缩放（静态 transform，seg.transform）
    但不打关键帧时，导出剪映后位置/缩放/旋转/透明度全丢（素材回画布中心原始大小）。
    本函数与 KF 导出（_apply_keyframes_to_segment）同源换算：
      - transform_x = x/(W/2)、transform_y = -y/(H/2)（中心原点像素 → 半个画布宽/高单位，y 取反）
      - rotation/opacity 直传
      - scale 关键：前端预览 scale=1 = 素材 contain 到画布（renderer.js _applyVisualSize:
        min(cp.W/mw, cp.H/mh)）；剪映 scale=1 = 原始分辨率。所以导出 scale = 用户scale × contain 系数，
        保证剪映里 scale=1 的素材正好铺满画布（与预览一致）。素材尺寸探测失败时 contain=1（退化可接受）。
    """
    tf = seg.get("transform") if isinstance(seg.get("transform"), dict) else {}
    half_w = (W / 2.0) or 1.0
    half_h = (H / 2.0) or 1.0
    mw, mh = _media_dims_cached(seg.get("path"))
    contain = 1.0
    if mw and mh:
        contain = min(W / float(mw), H / float(mh))
    # 5b（R9）：params 优先（前后端统一真相源），旧 seg.transform 仅兜底（旧草稿兼容）。
    return ClipSettings(
        alpha=float(_seg_param(seg, "transform.opacity", tf.get("opacity", 1.0))),
        rotation=float(_seg_param(seg, "transform.rotate", tf.get("rotation", 0.0))),
        scale_x=float(_seg_param(seg, "transform.scaleX", tf.get("scaleX", 1.0))) * contain,
        scale_y=float(_seg_param(seg, "transform.scaleY", tf.get("scaleY", 1.0))) * contain,
        transform_x=float(_seg_param(seg, "transform.positionX", tf.get("x", 0.0))) / half_w,
        transform_y=-(float(_seg_param(seg, "transform.positionY", tf.get("y", 0.0)))) / half_h,
    )


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


_TS_RE = re.compile(r"_(\d{6,})(?=\.[^.]+$)")
def _strip_asset_ts(p):
    """去掉 assets 副本文件名里 import 加的时间戳后缀（5月28日_1786963727.mp4 -> 5月28日.mp4），
    用于把 Agent/脚本传入的「导入前原始路径」归一到 materials 里登记的 canonical 副本路径。"""
    if not p:
        return p
    return _TS_RE.sub("", p.replace("\\", "/"))


class Api:
    """暴露给前端（HTML）调用的 Python 能力。一个方法 = 一个原子能力。"""

    # Step 5 Command 层：撤销/重做/审计统一入口（类级共享，桌面窗口与 MCP 进程共用同一份历史）。
    # 每次会改草稿的操作，由 save_state（5a 快照 Command）或 CommandManager.execute（5b 起）入栈。
    cmd_mgr = None
    # 上次「已提交」的草稿快照；save_state 用它判断本次是否真的发生变化，从而决定是否入撤销栈。
    # 初始化为 None（尚未加载），Api.__init__ 加载后会设为当前草稿的深拷贝。
    last_committed = None
    # 2b 双轨收敛标志（类级，单进程内同步访问，execute 期间置位、finally 复位）：
    #   _in_execute —— execute 执行被调方法期间为 True，save_state 据此跳过自动快照（改由 execute 统一压语义命令）；
    #   _op_changed —— 本次操作是否真实改了草稿，execute 据此决定是否入栈（无操作不留撤销步）。
    _in_execute = False
    _op_changed = False
    copy_buffer = None   # 内存剪贴板：copy_to_buffer 存选中段深拷贝列表，paste_from_buffer 读取

    def __init__(self):
        # 草稿 + 素材状态从共享文件 draft_state.json 加载。
        # 人和 AI/MCP 改的都是同一份文件，前端轮询刷新即可互相看到改动。
        self.state = load_state()
        self.draft = self.state["draft"]  # 直接引用 state 里的草稿字典，改它就改 state
        # 类级 CommandManager 单例：MCP 每次新建 Api 实例也共享同一份撤销历史
        if Api.cmd_mgr is None:
            Api.cmd_mgr = CommandManager()
        # 记录「已提交」基线，供 save_state 判断真实变更（undo 快照自动记录机制依赖此）。
        Api.last_committed = copy.deepcopy(self.draft)
        # 4a：上次轮询时见过的草稿（深拷贝快照），供 get_state 计算 documentChanged 差量。
        self._last_seen_draft = None

    def _reload(self):
        """修改状态前先从文件重载最新状态。

        关键：AI/MCP 可能是另一个独立进程，它们会写同一个 draft_state.json。
        如果窗口进程一直用内存里的旧 state，就会出现「后端提示已登记但时间轴不显示」
        的 bug。所以任何会改状态的操作前，都要先 reload。
        """
        self.state = load_state()
        self.draft = self.state["draft"]
        # 3b（M3）：ids/speeds/animations 已由上方 load_state→migrate 统一补，此处不再重复；
        # 仅保留 src_full 回填（含 record=False 落盘，避免污染撤销栈）。
        # 兼容旧项目：补 src_full（源素材真实全长，微秒）——右拖恢复被裁帧的上限。
        if _ensure_seg_src_full(self.draft):
            save_state(self.state, record=False)
        # 2a（M2，2026-08-23）：R14 修复——_reload 必须刷新「已提交」基线 last_committed，
        # 否则跨进程（MCP）写入后，桌面进程的 last_committed 仍是内存旧值 → 自动快照压过期基线
        # → 撤销吞掉对方进程改动。刷新后 last_committed 始终等于刚从磁盘加载的真实已提交态。
        Api.last_committed = copy.deepcopy(self.draft)

    def _restore_snapshot(self, snapshot):
        """1d 导入回滚：把内存状态整体还原到导入前的快照，保证内存与磁盘（写盘失败那次没落盘）
        一致。self.state / self.draft / Api.last_committed 一并复位——self.draft 只是
        self.state["draft"] 的引用，不单独复位会指向已废弃的旧对象。"""
        self.state = snapshot
        self.draft = self.state["draft"]
        Api.last_committed = copy.deepcopy(self.state["draft"])

    def _push_undo(self):
        """【已废弃】保留为无操作占位。

        撤销快照现由 save_state 在每次「真实变更」时自动记录（仅当草稿相对上次提交状态
        发生变化才入栈，且校验失败提前 return 不调用 save_state，因此不会污染撤销栈）。
        历史 15 个调用点保留此空调用无害。
        """
        return

    def execute(self, cmd_id, args=None, meta=None):
        """Step 5b：写操作统一入口（UI / MCP / Agent 都走这里，自动审计）。
        meta 示例：{"actor": "agent", "reason": "去掉口误", "confidence": 0.9, "source": "skill:口播精剪"}
        返回与直接调用该方法一致。UI 经 store.js call() 调用时未带 meta，此处补默认 user/ui 上下文。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        # 2b：UI 直调未带 meta 时补默认上下文（actor=user / source=ui），Agent/MCP 自带 meta 覆盖。
        if meta is None:
            meta = {"actor": "user", "source": "ui", "reversible": True}
        # 4a：把本次操作 actor 写入模块级，save_state 发布 document-changed 载荷时携带（区分人/AI/系统）。
        global DOCUMENT_CHANGE_ACTOR
        DOCUMENT_CHANGE_ACTOR = (meta or {}).get("actor") or "user"
        # 2d：事务进行中时跳过 _reload——事务内多步在内存态累积，避免每次重载覆盖中间态 /
        # 重复磁盘 IO（大事务 / AI 批量场景）。事务外仍先 reload 保证看到最新磁盘态。
        if Api.cmd_mgr._tx is None:
            self._reload()
        return Api.cmd_mgr.execute(self, cmd_id, args, meta)

    def audit_log(self, limit=100, actor=None):
        """Step 5b：审计查询——谁做过什么（Agent 可审计）。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        return Api.cmd_mgr.audit_log(limit=limit, actor=actor)

    # ---------- M6-6a Document Protocol v1（VideoDocument 协议入口） ----------
    def validate_document(self, raw_json):
        """协议校验：AI 生成 VideoDocument JSON 后先检查（三态 errors/warnings/repaired）。
        只读不落盘；errors 非空表示不可加载，须修正后再 load_document。"""
        try:
            raw = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
        except Exception as e:
            return {"ok": False, "errors": ["JSON 解析失败: %s" % e], "warnings": [], "repaired": {}}
        return validate_document(raw)

    def load_document(self, raw_json):
        """协议加载：把外部 VideoDocument JSON 整体替换为当前工程（导入语义）。
        校验失败 → 返回 {ok:false, errors} 不落盘（09 验收①：非法不静默修复）；
        成功 → 应用 repaired + 落盘 + 发布 document-changed（前端自动刷新）。
        注意：整体替换不可 undo（record=False 不压栈）；undo 栈语义留统一验证阶段确认。"""
        try:
            raw = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
        except Exception as e:
            return {"ok": False, "errors": ["JSON 解析失败: %s" % e]}
        res = _load_document_proto(raw)
        if not res["ok"]:
            return {"ok": False, "errors": res["errors"], "warnings": res.get("warnings", [])}
        doc = res["document"]
        self._reload()   # 拿磁盘 version 基线（乐观锁比对用）+ 刷新 last_committed
        doc["version"] = self.state.get("version", 0)
        now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        doc.setdefault("metadata", {})
        doc["metadata"]["updated_at"] = now
        self.state = doc
        self.draft = doc["draft"]
        Api.last_committed = copy.deepcopy(doc["draft"])
        saved = save_state(doc, record=False)
        ok = (saved is True)
        return {"ok": ok, "warnings": res["warnings"], "repaired": res["repaired"], "saved": ok}

    def save_document(self):
        """协议导出：返回当前工程的 VideoDocument 视图（AI 可读的完整协议 JSON）。"""
        now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        self.state.setdefault("metadata", {})
        self.state["metadata"]["updated_at"] = now
        return self.state

    # ---------- M6-6c Preset v0（模板库：一键排版，事务包批） ----------
    def get_presets(self):
        """模板库目录（前端「模板」弹窗填充用）：[{id, label, desc, categories, kind}]。"""
        return {"ok": True, "presets": _get_presets()}

    def apply_preset(self, preset_id, args=None, meta=None):
        """Preset v0：按模板一键排版，undo 一次=整批回滚。

        preset_id: presets/{id}.json；args: 模板变量 dict（如 cues/subtitle_style/text）。
        事务语义：begin → 逐 step 经 execute（事务内只累计不入栈）→ commit（合并一条事务
        Command）。不走外层 execute 包装（避免嵌套双录）。
        步级保护：ensure_track 步在轨道已存在时跳过；{{var}} 缺失（填充后残留）自动跳过该步。
        """
        presets = _load_presets()
        preset = presets.get(preset_id)
        if not preset:
            return {"ok": False, "error": "未知模板 %s（可用：%s）" % (preset_id, ", ".join(sorted(presets)) or "无")}
        steps = _plan_preset(preset, args)
        if not steps:
            return {"ok": False, "error": "模板 %s 没有可执行步骤" % preset_id}
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        self._reload()
        m = {"actor": (meta or {}).get("actor") or "preset",
             "reason": "preset:" + preset_id, "reversible": True}
        # 外层事务检测（M7-7a submit_intents 包批时复用外层事务，不嵌套 begin/commit；
        # 独立调用时自开事务）。外层事务由调用方统一 commit/abort。
        outer_tx = Api.cmd_mgr._tx is not None
        if not outer_tx:
            r = self.begin_transaction("preset:" + preset_id, m)
            if not r.get("ok"):
                return {"ok": False, "error": r.get("error", "事务开启失败")}
        applied, skipped = [], []
        try:
            for step in steps:
                if step.get("ensure_track") and _track_exists(self.draft, step["ensure_track"]):
                    skipped.append(step["cmd"] + "(轨已存在)")
                    continue
                if "{{" in json.dumps(step["args"], ensure_ascii=False):
                    skipped.append(step["cmd"] + "(缺变量)")
                    continue
                res = self.execute(step["cmd"], step["args"], m)
                if isinstance(res, dict) and res.get("ok") is False:
                    raise Exception("%s: %s" % (step["cmd"], res.get("error")))
                applied.append(step["cmd"])
            if outer_tx:
                return {"ok": True, "plan": steps, "applied": applied,
                        "skipped": skipped, "count": len(applied), "tx": "outer"}
            cr = self.commit_transaction()
            return {"ok": bool(cr.get("ok")), "plan": steps, "applied": applied,
                    "skipped": skipped, "count": len(applied), "tx": cr}
        except Exception as e:
            if not outer_tx:
                try:
                    self.abort_transaction()
                except Exception:
                    pass
                err = "模板执行中断（已整体回滚）: %s" % e
            else:
                err = "模板执行中断（已交由外层事务回滚）: %s" % e
            return {"ok": False, "error": err,
                    "plan": steps, "applied": applied, "skipped": skipped}

    # ---------- M7-7a Intent v0（意图提交：AI 从命令直连升级为意图层） ----------
    def create_project(self, name=None):
        """create-project 意图：重置为全新空工程（materials 清空 + 草稿初始化 + metadata.name）。
        可 undo（经 execute 包装）；旧工程内容被清空（建议先 save_document 备份）。"""
        self._reload()
        empty_draft = {
            "overlay": [], "main": {"segs": []}, "audio": [{"segs": []}],
            "canvas": {"ratio": DEFAULT_CANVAS, "locked": False},
            "_track_meta": {"overlay": [], "main": {}, "audio": [{}]},
        }
        _ensure_track_tids(empty_draft)
        self.state["materials"] = []
        self.state["draft"] = empty_draft
        self.draft = empty_draft
        self.state.setdefault("metadata", {})
        self.state["metadata"]["name"] = name or "未命名工程"
        save_state(self.state)
        return {"ok": True, "name": self.state["metadata"]["name"]}

    def submit_intents(self, intents, meta=None):
        """M7-7a：意图批量提交（事务包批，undo 一次整批回滚）。

        流程：validate（schema + 资源可达性，errors 不执行）→ plan（规则 Planner）→
        begin → 逐计划 execute（事务内只累计）→ commit。plan 记录进审计 meta。
        apply-preset 复用外层事务（6c 已支持 outer_tx）；execute 保留为专家模式双轨并存。
        """
        errors, cleaned = _validate_intents(intents, presets=_load_presets())
        if errors:
            return {"ok": False, "errors": errors}
        plan = _plan_intents(cleaned)
        if not plan:
            return {"ok": False, "error": "没有可执行的意图"}
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        self._reload()
        m = dict(meta or {})
        m.setdefault("actor", "agent")
        m["intents"] = cleaned          # plan 记录进审计 meta（M2 产物，AI 可复盘）
        m["plan"] = [{"type": p["type"], "cmd": p["cmd"]} for p in plan]
        r = self.begin_transaction("intents", m)
        if not r.get("ok"):
            return {"ok": False, "error": r.get("error", "事务开启失败")}
        applied, skipped = [], []
        try:
            for item in plan:
                res = self.execute(item["cmd"], item["args"], m)
                if isinstance(res, dict) and res.get("ok") is False:
                    raise Exception("%s: %s" % (item["cmd"], res.get("error")))
                applied.append(item["type"])
            cr = self.commit_transaction()
            return {"ok": bool(cr.get("ok")), "plan": plan, "applied": applied,
                    "count": len(applied), "tx": cr}
        except Exception as e:
            try:
                self.abort_transaction()
            except Exception:
                pass
            return {"ok": False, "error": "意图执行中断（已整体回滚）: %s" % e,
                    "plan": plan, "applied": applied}

    # ---------- M7-7b D5 最小任务队列（异步入口 + 状态查询） ----------
    def get_task_status(self, task_id):
        """查询后台任务状态：{status: running|done|error, result, error}。前端轮询用。"""
        with _TASK_LOCK:
            t = _TASKS.get(task_id)
            if t is None:
                return {"ok": False, "error": "未知任务 %s" % task_id}
            return {"ok": True, "task_id": task_id, "status": t["status"],
                    "result": t["result"], "error": t["error"]}

    def submit_transcribe(self, path, language="auto", model_size="small", style=None):
        """异步转写：立即返回 task_id（轮询 get_task_status），不阻塞 UI/MCP。
        后台跑 transcribe_media（Whisper CPU 推理慢，10 分钟音频可能几十秒~几分钟）。"""
        if not path or not isinstance(path, str) or not os.path.isfile(path):
            return {"ok": False, "error": "媒体文件不存在：%s" % path}
        task_id = _submit_task(self.transcribe_media, path, language, model_size, style)
        return {"ok": True, "task_id": task_id, "hint": "轮询 get_task_status 查进度"}

    def submit_import_media(self, paths):
        """异步导入素材：立即返回 task_id（复制文件+抽缩略图在后台，不阻塞）。"""
        return {"ok": True, "task_id": _submit_task(self.import_media_by_paths, paths)}

    def undo(self, selection=None):
        """撤销上一步：Command 栈弹栈还原（人与 AI 的编辑都记录在同一份历史里）。
        2c：selection=撤销前前端选中快照，传给 cmd_mgr 记为本命令「操作后选中」，供 redo 还原。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "撤销系统未就绪"}
        global DOCUMENT_CHANGE_ACTOR
        DOCUMENT_CHANGE_ACTOR = "user"
        self._reload()
        return Api.cmd_mgr.undo(self, selection)

    def redo(self, selection=None):
        """重做：重做栈弹栈恢复（撤销的反操作）。
        2c：selection=重做前前端选中快照，传给 cmd_mgr 记为本命令「撤销后选中」，供下次 undo 还原。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "重做系统未就绪"}
        global DOCUMENT_CHANGE_ACTOR
        DOCUMENT_CHANGE_ACTOR = "user"
        self._reload()
        return Api.cmd_mgr.redo(self, selection)

    # ---------- C3 事务桥接（UI/Agent/MCP 统一入口） ----------
    def begin_transaction(self, label="batch", meta=None):
        """开启事务：事务内多条命令合并为一条 undo（一次拖动/一次 Agent 操作 = 一条 undo）。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        return Api.cmd_mgr.begin_transaction(self, label, meta)

    def commit_transaction(self):
        """事务结束：合并入栈（undo 一次 = 回事务开始前）。空事务不压栈。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        return Api.cmd_mgr.commit_transaction(self)

    def abort_transaction(self):
        """回滚事务内全部改动（恢复事务前快照，不入栈）。"""
        if Api.cmd_mgr is None:
            return {"ok": False, "error": "命令系统未就绪"}
        return Api.cmd_mgr.abort_transaction(self)

    def add_to_timeline(self, name, path, mtype, track_index=None, at_time_us=None, insert_index=None, track_tid=None):
        """把素材登记进草稿对应轨道（双击或拖拽都走这里，真实进轨）。

        多轨模型：
        - video / image 默认进主视频轨 video[0]（最底层，不可删）
        - audio 默认进第一条音频轨 audio[0]；text 进 text[0]
        - track_index 指定该类型内轨道序号；track_index=-1 表示「自动新建一条该类型轨道」
        - at_time_us 指定落点时间（微秒，来自拖拽松手横向位置）；为 None 则接到该轨末尾
        同轨重叠自动避让：若落点被占用，自动推到该轨最近空位（不新建轨、不重叠）。
        返回登记结果（track_type/track_index/该轨段数/总段数/时长/start）。
        """
        # 2026-08-19：整体 try/except——静默失败（pywebview 桥 promise 永不返回）是"素材放不进"体感根因，
        # 任何异常都必须变成可见的 {ok:false, error}，让前端 alert/日志能定位。
        try:
            return self._add_to_timeline_impl(name, path, mtype, track_index, at_time_us, insert_index, track_tid)
        except Exception as e:
            import traceback
            traceback.print_exc()
            return {"ok": False, "error": "add_to_timeline 异常: %s" % e}

    def _add_to_timeline_impl(self, name, path, mtype, track_index=None, at_time_us=None, insert_index=None, track_tid=None):
        """add_to_timeline 真实实现（被 try/except 包裹）。"""
        self._reload()
        # 严重坑：path 不存在（AI 传了假路径/文件名）就直接进轨，导出剪映时 VideoSegment(None) 抛异常整段失败。
        # 进轨前必须校验文件真实存在，否则明确报错，避免把脏数据带进导出环节。
        if not path or not isinstance(path, str) or not os.path.isfile(path):
            return {"ok": False, "error": f"素材文件不存在，无法进轨：{path}"}
        self._push_undo()
        if mtype not in TYPE_TRACK:
            return {"ok": False, "error": f"不支持的素材类型：{mtype}"}
        track_type = TYPE_TRACK[mtype]
        # 落点轨道优先级：track_tid（稳定 id，A2）> track_index（-1=新建追加）> insert_index（中间插入新轨）> 默认主轨/第一条
        if track_tid:
            located = _track_by_tid(self.draft, track_tid)
            if located is None:
                return {"ok": False, "error": f"未找到轨道 tid={track_tid}"}
            tt, idx, segs = located
            if tt != track_type:
                return {"ok": False, "error": f"轨道类型不匹配：tid={track_tid} 是 {tt}，素材类型 {mtype} 需要 {track_type}"}
        elif track_index is not None:
            if track_index == -1:
                idx = _ensure_track(self.draft, track_type, -1)
            else:
                idx = _ensure_track(self.draft, track_type, track_index)
            segs = _track_segs(self.draft, track_type, idx)
        elif insert_index is not None:
            idx = _insert_track(self.draft, track_type, insert_index)
            # insert_index 是 overlay/audio 数组下标（不是类型内 ti）——段直接放新建轨
            if track_type == "audio":
                segs = self.draft["audio"][idx]["segs"]
            else:
                segs = self.draft["overlay"][idx]["segs"]
        else:
            idx = 0
            segs = _track_segs(self.draft, track_type, idx)
        duration = duration_for(path, mtype)
        # 落点时间：指定则精确落在拖拽位置；否则接到该轨末尾
        if at_time_us is not None:
            start = max(0, int(at_time_us))
        else:
            start = sum(s["duration"] for s in segs)
        # 同轨不重叠（2026-08-18 用户反馈「素材叠到另一素材上」）：落点被占用 → 自动推到该轨最近空位
        if any(_segments_overlap({"start": start, "duration": duration}, s) for s in segs):
            start = _free_start_on_track(segs, start, duration)
        seg = {
            "id": uuid.uuid4().hex,   # A 方案：新段必须带稳定 id（拖动/选中/提交按 id 定位，不受 ti 漂移影响）
            "name": name,
            "path": path,
            "type": mtype,
            "start": start,
            "duration": duration,
            "src_start": 0,
            "src_end": duration,
            "src_full": duration,   # 源素材真实全长（微秒）= 右拖恢复被裁帧上限
            "speed": DEFAULT_SPEED,
            "change_pitch": False,
            "animations": {},
        }
        # Step 3 Asset 分离：段关联素材 uid。
        # 标准链路（导入素材→拖入时间轴）materials[].path 即 assets 副本（带时间戳后缀），
        # 与拖入时传入的路径一致 → 精确命中。
        # 但 MCP/脚本直接传「导入前的原始路径」时，materials 里是带后缀的副本路径，
        # 精确匹配会 miss → material_id 缺失、thumbMap（按 materials.path 建键）查不到
        # → 视频段降级纯色条、时间轴无胶片帧（2026-08-17 修复）。
        # 兜底：去掉时间戳后缀按 stem 归一比较，命中则关联 material_id，并把 seg.path
        # 改写为 materials 的 canonical 副本路径，保证 thumbMap 命中、渲染出帧且播放走同一文件。
        _matched_material = None
        for _m in self.state.get("materials", []) or []:
            if isinstance(_m, dict) and _m.get("uid"):
                if _m.get("path") == path:
                    _matched_material = _m
                    break
                if _strip_asset_ts(_m.get("path")) == _strip_asset_ts(path):
                    _matched_material = _m  # 后缀归一命中（保留首个）
        if _matched_material:
            seg["material_id"] = _matched_material["uid"]
            if _matched_material.get("path") != path:
                seg["path"] = _matched_material["path"]
        # 视频段记录是否含音轨（提取原声按钮可用性；ffprobe 探测，仅视频类型）
        if mtype == "video":
            seg["has_audio"] = _has_audio_stream(path)
        # —— 画布（画幅）自动匹配：剪映式 ——
        # 在放入前判断「整条视频轨此前是否为空」；若为空、且用户尚未锁定画布比例，
        # 则用该素材真实宽高比自动匹配最接近的预设画布比例（主轨第一段决定画布）。
        canvas = self.draft.setdefault("canvas", {"ratio": DEFAULT_CANVAS, "locked": False})
        main_segs = self.draft.setdefault("main", {"segs": []}).setdefault("segs", [])
        video_was_empty = (track_type == "video"
                           and not canvas.get("locked", False)
                           and len(main_segs) == 0
                           and not any(len(t.get("segs", [])) > 0 for t in self.draft.get("overlay", []) if t.get("type") == "video"))

        segs.append(seg)
        # 轨道一旦被放入片段，就不再是「显式创建的空轨」，取消 persistent_empty 标记
        _clear_persistent_if_needed(self.draft, track_type, idx)

        if video_was_empty:
            ar = media_aspect_ratio(path, mtype)
            matched = match_canvas_ratio(ar)
            if matched:
                canvas["ratio"] = matched

        total = (len(self.draft.setdefault("main", {"segs": []}).get("segs", []))
                 + sum(len(t.get("segs", [])) for t in self.draft.get("overlay", []))
                 + sum(len(a.get("segs", [])) for a in self.draft.get("audio", [])))
        if not save_state(self.state):
            return {"ok": False, "error": "保存草稿失败（写盘异常，看后端控制台 [SAVE-FAIL]）"}
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
        segs = _track_segs(self.draft, track_type, track_index)
        if segs is None:
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
        seg = segs[index]
        if seg.get("type") != "video":
            return {"ok": False, "error": "提取原声只能用于视频片段"}

        # —— 已提取过 → 还原 ——
        if seg.get("source_audio_extracted"):
            vid_id = seg.get("id")
            removed = 0
            for atrack in self.draft.get("audio", []):
                if not isinstance(atrack, dict):
                    continue
                i = 0
                while i < len(atrack.get("segs", [])):
                    if atrack["segs"][i].get("extracted_from") == vid_id:
                        atrack["segs"].pop(i)
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
        _ensure_track(self.draft, "audio", 0)
        atracks = self.draft.setdefault("audio", [{"segs": []}])
        audio_seg = {
            "name": (seg.get("name", "音频") + " 音频"),
            "path": out_path,
            "type": "audio",
            "start": seg.get("start", 0),
            "duration": seg.get("duration", 0),
            "src_start": seg.get("src_start", 0),
            # 2026-08-17 根治：源终点推导（防脏 src_end 传播到提取段）
            "src_end": int(seg.get("src_start", 0)) + int(round(max(0, seg.get("duration", 0)) * _seg_speed(seg))),
            "speed": seg.get("speed", DEFAULT_SPEED),
            "change_pitch": seg.get("change_pitch", False),
            "extracted_from": vid_id,
            "id": uuid.uuid4().hex,
        }
        if not isinstance(atracks[0], dict):
            atracks[0] = {"segs": []}
        atracks[0].setdefault("segs", [])
        atracks[0]["segs"].append(audio_seg)
        # 原视频段：标记已提取 + 静音（导出时 volume=0）
        seg["source_audio_extracted"] = True
        seg["muted"] = True
        save_state(self.state)
        return {"ok": True, "action": "extract", "audio_path": out_path, "audio_track_index": 0}

    def set_segment_speed(self, track_type, track_index, index, speed, change_pitch=None, segid=None):
        """设置片段变速倍率（对齐 OpenCut updateElementRetime）。

        - 仅 video / audio 段可变速；text / image 不可变速。
        - speed 范围 [MIN_SPEED, MAX_SPEED]（0.01x ~ 5x），超出则 clamp。
        - 变速保持 src_start/src_end 不变，按 source_span / speed 重新计算时间轴 duration。
        - change_pitch: True=变调（如 0.5x 慢放时声音也变慢变低），False=保持原调。
          默认维持原调（False），与 OpenCut maintainPitch=true 等价。
        - A 方案（2026-08-19）：传 segid 时按稳定段 id 定位，不传回退 (track_type, track_index, index)。
        返回 {"ok": True, "speed": 实际倍率, "duration": 新时长, ...} 或 {"ok": False, "error": 原因}。
        """
        self._reload()
        self._push_undo()
        if segid:
            seg = _seg_by_id(self.draft, segid)
            if seg is None:
                return {"ok": False, "error": f"未找到段 id={segid}"}
        else:
            segs = _track_segs(self.draft, track_type, track_index)
            if segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
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
        # 2026-08-17 根治：源窗口跨度用推导值（duration × 旧 speed），不读 src_end 脏字段——
        # 变速语义=保持源窗口不变，span 恒等于 duration_old × speed_old
        if "src_start" not in seg:
            seg["src_start"] = 0
        ss = seg["src_start"]
        old_speed = _seg_speed(seg)
        source_span = max(1, int(round(seg.get("duration", 0) * old_speed)))
        new_duration = int(round(source_span / rate))
        seg["speed"] = rate
        seg["change_pitch"] = bool(change_pitch) if change_pitch is not None else seg.get("change_pitch", False)
        # 5b（R9）：同步写 params 真相源，对齐前端 setProperty 的 path-addressed 模型。
        _write_param(seg, "speed.rate", rate)
        _write_param(seg, "speed.pitchCorrection", seg["change_pitch"])
        seg["duration"] = new_duration
        # 源终点同步反算（保持不变量 (se-ss)/speed == duration）
        seg["src_end"] = ss + int(round(new_duration * rate))
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
            "src_end": seg["src_end"],
        }

    def set_segment_volume(self, track_type, track_index, index, volume, segid=None):
        """段级音量（OpenCut: AudioElement volume 参数）。0~2，默认 1。
        预览时 video 内嵌音频/audio 段的 volume 应用；导出剪映映射 volume。
        A 方案（2026-08-19）：传 segid 时按稳定段 id 定位（不受 ti 漂移影响），
        不传则回退 (track_type, track_index, index)。
        """
        self._reload()
        self._push_undo()
        seg = _seg_by_id(self.draft, segid) if segid else None
        if seg is None:
            segs = _track_segs(self.draft, track_type, track_index)
            if segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
            if not isinstance(index, int) or index < 0 or index >= len(segs):
                return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
            seg = segs[index]
        v = max(0.0, min(2.0, float(volume)))
        seg["volume"] = round(v, 2)
        # 5b（R9）：同步写 params 真相源。
        _write_param(seg, "audio.volume", round(v, 2))
        save_state(self.state)
        return {"ok": True, "volume": seg["volume"]}

    def set_segments_props(self, updates):
        """批量设置多个段属性（OpenCut updateElements 语义，一次 undo）。

        updates: [{ "track_type": "video", "track_index": 1, "index": 0, "segid": "...",
                    "props": { "volume": 0.8 | "speed": 1.5 | "change_pitch": true | "muted": false } }]
        - 每项定位：segid 优先（稳定 id，不受 ti 漂移）；缺省回退 (track_type, track_index, index)。
        - speed/change_pitch 走变速逻辑（duration 重算）；volume/muted 直接写。
        - 部分项失败不影响其他项（跳过并记 skipped）。
        返回 {"ok": True, "count": 成功数, "skipped": 失败原因列表}。
        """
        self._reload()
        self._push_undo()
        if not isinstance(updates, list) or not updates:
            return {"ok": False, "error": "updates 必须是非空列表"}
        ok_count = 0
        skipped = []
        for u in updates:
            if not isinstance(u, dict):
                skipped.append("非法项")
                continue
            seg = None
            if u.get("segid"):
                seg = _seg_by_id(self.draft, u["segid"])
                if seg is None:
                    skipped.append(f"未找到段 id={u['segid']}")
                    continue
            else:
                segs = _track_segs(self.draft, u.get("track_type"), u.get("track_index"))
                if segs is None or not isinstance(u.get("index"), int) or u["index"] < 0 or u["index"] >= len(segs):
                    skipped.append(f"{u.get('track_type')}[{u.get('track_index')}] 无第 {u.get('index')} 段")
                    continue
                seg = segs[u["index"]]
            props = u.get("props") or {}
            try:
                if "volume" in props:
                    seg["volume"] = round(max(0.0, min(2.0, float(props["volume"]))), 2)
                    _write_param(seg, "audio.volume", seg["volume"])
                if "muted" in props:
                    seg["muted"] = bool(props["muted"])
                if "speed" in props or "change_pitch" in props:
                    if seg.get("type") not in ("video", "audio"):
                        skipped.append("只有视频/音频段可变速")
                        continue
                    if "src_start" not in seg:
                        seg["src_start"] = 0
                    ss = seg["src_start"]
                    old_speed = _seg_speed(seg)
                    source_span = max(1, int(round(seg.get("duration", 0) * old_speed)))
                    rate = max(MIN_SPEED, min(MAX_SPEED, float(props.get("speed", old_speed))))
                    new_duration = int(round(source_span / rate))
                    seg["speed"] = rate
                    if "change_pitch" in props:
                        seg["change_pitch"] = bool(props["change_pitch"])
                    # 5b（R9）：同步写 params 真相源。
                    _write_param(seg, "speed.rate", rate)
                    _write_param(seg, "speed.pitchCorrection", seg["change_pitch"])
                    seg["duration"] = new_duration
                    seg["src_end"] = ss + int(round(new_duration * rate))
                ok_count += 1
            except Exception as e:
                skipped.append(f"{seg.get('name', '?')}: {e}")
        save_state(self.state)
        return {"ok": True, "count": ok_count, "skipped": skipped}

    def update_segment_transform(self, track_type=None, track_index=None, index=None, segid=None, transform=None):
        """更新段的静态 transform（预览拖动/面板写入，一次 undo）。

        transform: {x, y, scaleX, scaleY, rotation, opacity}（可只传要改的字段，其余保留）。
        segid 优先定位（稳定 id）；缺省回退 (track_type, track_index, index)。
        """
        self._reload()
        self._push_undo()
        seg = None
        if segid:
            seg = _seg_by_id(self.draft, segid)
        elif track_type is not None and track_index is not None and isinstance(index, int):
            segs = _track_segs(self.draft, track_type, track_index)
            if segs and 0 <= index < len(segs):
                seg = segs[index]
        if seg is None:
            return {"ok": False, "error": "未定位到段"}
        if not isinstance(transform, dict) or not transform:
            return {"ok": False, "error": "transform 必须是非空 dict"}
        cur = seg.get("transform") if isinstance(seg.get("transform"), dict) else {}
        seg["transform"] = dict(cur)
        for k in ("x", "y", "scaleX", "scaleY", "rotation", "opacity"):
            if k in transform:
                seg["transform"][k] = transform[k]
                # 5b（R9）：同步写 params 真相源，消除「后端只写 transform → 旧 params 漂移」的隐患。
                _write_param(seg, _FIELD_TO_PARAM[k], transform[k])
        save_state(self.state)
        return {"ok": True, "segid": seg.get("id"), "transform": seg["transform"]}

    # ---------- 关键帧 / 动画 CRUD（对齐 OpenCut upsertKeyframe / removeKeyframe / retimeKeyframe） ----------
    def _kf_resolve_seg(self, track_type, track_index, index, seg_id=None):
        """取关键帧编辑目标段，返回 (seg, None) 或 (None, error)。

        传 seg_id（稳定段 id）时优先按 id 定位（不受 ti 漂移影响，对齐 remove_segment 的 A 方案）；
        不传则回退 (track_type, track_index, index)。"""
        if seg_id:
            seg = _seg_by_id(self.draft, seg_id)
            if seg is None:
                return None, f"未找到段 id={seg_id}"
            return seg, None
        segs = _track_segs(self.draft, track_type, track_index)
        if segs is None:
            return None, f"{track_type} 没有第 {track_index} 条轨道"
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return None, f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"
        return segs[index], None

    def add_keyframe(self, track_type, track_index, index, path, time_us, value, seg_mode="linear", seg_id=None):
        """在段内局部时间 time_us（微秒）为属性 path 添加一个关键帧。

        - path 必须是 KF_KEYFRAMEABLE 之一。
        - 若该时间已有关键帧（±1ms 内）则更新其值与插值方式；否则新增。
        - seg_mode: linear（线性）或 hold（台阶/保持）。
        返回 {ok, path, keyframes}（keyframes 为该 path 下全部键，供前端重绘）。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index, seg_id)
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
        # ★ A2（2026-08-22 对齐新版 OpenCut roundFrameTicks）：打点时间吸附到整帧。
        #   保证同一播放头打的 X/Y 严格同帧 → A1 严格相等合并才可靠，绝不误改 v。
        t = max(0, min(_frame_snap_us(t), dur))
        anims = _seg_anims(seg)
        # ── KF-AUDIT（2026-08-22，GPT 评审要求的时间链路审计）──────────────
        # 打印"后端实际收到的时间"：time_us（前端发送）→ t（clamp 后）→ dur。
        # 用途：判断 X/Y 两个 add_keyframe 到底收到的是不是同一个 t。
        import os as _os
        _audit = _os.environ.get("KF_AUDIT", "0") == "1"
        if _audit:
            print(f"[KF-AUDIT] add_keyframe received: path={path} time_us={time_us} t_clamped={t} dur={dur} seg_start={seg.get('start')}")
        # ── 跨通道打点对齐（B3.4）────────────────────────────────────────
        # ★ 2026-08-22 GPT 评审：此逻辑可能掩盖真实根因，默认【禁用】。
        #   开启方式：环境变量 KF_ALIGN_CROSS_CHANNEL=1（仅审计/诊断用）。
        #   原逻辑：若其他通道 ±1帧(33333us) 内已有 KF → 本次 t 对齐到该 KF 时间。
        #   风险（GPT 原话）："一个通道的关键帧时间，不应该偷偷决定另一个通道的时间"；
        #   且 X=100/Y=666760 这种真实错位会被对齐掩盖，无法暴露"时间基准被复用"的根因。
        _align = _os.environ.get("KF_ALIGN_CROSS_CHANNEL", "0") == "1"
        if _align:
            align_t = None
            for _op, _och in anims.items():
                if _op == path or not isinstance(_och, dict):
                    continue
                for _ok in (_och.get("keys") or []):
                    if abs(_ok["t"] - t) <= 33333:
                        if align_t is None or abs(_ok["t"] - t) < abs(align_t - t):
                            align_t = _ok["t"]
            if align_t is not None:
                if _audit:
                    print(f"[KF-AUDIT] add_keyframe ALIGN: path={path} t={t} → aligned_to={align_t}")
                t = align_t
        ch = anims.get(path) if isinstance(anims.get(path), dict) else {"keys": []}
        keys = list(ch.get("keys", []))
        # ★ A1（2026-08-22 对齐新版 isNearlySameTime）：existing 匹配从 ±1ms 改【严格相等】。
        #   旧行为：±1ms 内任意打点都合并 → 拖素材/打点落在已有 KF 附近会误改 v（用户反馈"拖的时候改数值"）。
        #   新行为：只有精确同帧才更新 v——配合 A2 帧吸附，同一点的 X/Y 严格同帧 → 正确合并；
        #   不同帧的 KF 绝不互相覆盖（对齐新版 `leftTime === rightTime` 哲学：时间精确，绝不猜测）。
        existing = next((k for k in keys if k["t"] == t), None)
        if _audit:
            print(f"[KF-AUDIT] add_keyframe store: path={path} t={t} mode={'UPDATE' if existing else 'NEW'}")
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
                        value=None, time_us=None, seg_mode=None, seg_id=None):
        """更新某关键帧的 value / 时间(time_us) / 插值方式。未传的字段保持不变。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index, seg_id)
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
        import os as _os2
        if _os2.environ.get("KF_AUDIT", "1") == "1":
            print(f"[KF-AUDIT] update_keyframe received: path={path} id={keyframe_id} value={value} time_us={time_us} seg_mode={seg_mode} | before: t={target.get('t')} v={target.get('v')}")
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
        if _os2.environ.get("KF_AUDIT", "1") == "1":
            print(f"[KF-AUDIT] update_keyframe stored: path={path} id={keyframe_id} | after: t={target.get('t')} v={target.get('v')} seg={target.get('seg')}")
        keys.sort(key=lambda k: k["t"])
        anims[path] = {"keys": keys}
        seg["animations"] = anims
        save_state(self.state)
        return {"ok": True, "path": path, "keyframes": keys}

    def remove_keyframe(self, track_type, track_index, index, path, keyframe_id, seg_id=None):
        """删除一个关键帧；若该属性键被删空，则移除整条通道。"""
        self._reload()
        self._push_undo()
        seg, err = self._kf_resolve_seg(track_type, track_index, index, seg_id)
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
        """返回指定轨道的元数据 dict（X 模型：overlay/main/audio 分区存储，与轨数组对齐）。"""
        meta = self.draft.setdefault("_track_meta", {})
        meta.setdefault("overlay", [])
        meta.setdefault("main", {})
        meta.setdefault("audio", [])
        if track_type == "audio":
            arr = meta["audio"]
            if ensure:
                while len(arr) <= track_index:
                    arr.append({})
            return arr[track_index] if 0 <= track_index < len(arr) else {}
        if track_type == "video" and track_index == 0:
            m = meta["main"]
            m.setdefault("muted", False)
            m.setdefault("hidden", False)
            return m
        oi = _overlay_index(self.draft, track_type, track_index)
        if oi >= 0:
            arr = meta["overlay"]
            if ensure:
                while len(arr) <= oi:
                    arr.append({})
            m = arr[oi]
            m.setdefault("muted", False)
            m.setdefault("hidden", False)
            return m
        if ensure:
            # 轨不存在：先建轨再定位 meta 槽
            _track_segs(self.draft, track_type, track_index, ensure=True)
            oi = _overlay_index(self.draft, track_type, track_index)
            if oi >= 0:
                arr = meta["overlay"]
                while len(arr) <= oi:
                    arr.append({})
                return arr[oi]
            if track_type == "audio":
                arr = meta["audio"]
                while len(arr) <= track_index:
                    arr.append({})
                return arr[track_index]
        return {}

    def toggle_track_mute(self, track_type, track_index):
        """切换轨道静音（OpenCut: toggleTrackMute）。

        影响：该轨道内所有片段在预览/导出时静音（视频段的内嵌音频也静音）。
        """
        self._reload()
        self._push_undo()
        m = self._track_meta(track_type, track_index, ensure=True)
        m["muted"] = not m.get("muted", False)
        save_state(self.state)
        return {"ok": True, "muted": m["muted"]}

    def set_segment_flag(self, track_type, track_index, index, flag, value, seg_id=None):
        """段级静音/隐藏（OpenCut: toggle-elements-muted-selected / visibility-selected）。

        flag ∈ muted（静音：视频内嵌音频/音频段不出声）/ hidden（隐藏：画面不渲染）。
        value 为布尔。影响预览（renderer 过滤）+ 导出（muted→音量 0、hidden→跳过画面）。
        """
        if flag not in ("muted", "hidden"):
            return {"ok": False, "error": "flag 必须是 muted 或 hidden"}
        self._reload()
        self._push_undo()
        if seg_id:
            seg = _seg_by_id(self.draft, seg_id)
            if seg is None:
                return {"ok": False, "error": f"未找到段 id={seg_id}"}
        else:
            segs = _track_segs(self.draft, track_type, track_index)
            if segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
            if not isinstance(index, int) or index < 0 or index >= len(segs):
                return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
            seg = segs[index]
        seg[flag] = bool(value)
        save_state(self.state)
        return {"ok": True, "track_type": track_type, "track_index": track_index, "index": index,
                "flag": flag, "value": bool(value)}

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
        if track_type not in ("video", "text"):
            return {"ok": False, "error": "只有视频轨和文本轨可以切换可见性"}
        m = self._track_meta(track_type, track_index, ensure=True)
        m["hidden"] = not m.get("hidden", False)
        save_state(self.state)
        return {"ok": True, "hidden": m["hidden"]}

    def remove_segment(self, track_type, track_index, index, segid=None, track_tid=None):
        """删除指定段。

        A 方案（2026-08-18）：传 segid（稳定段 id）时按 segid 定位（不受 ti 漂移影响）；
        不传则回退 (track_type, track_index, index)。A2（2026-08-19）：track_tid（源轨稳定 id）优先。
        不做重排：保留其余片段的绝对 start。返回 {"ok": True, "removed": {...}}。
        """
        self._reload()
        self._push_undo()
        if track_tid:
            located = _track_by_tid(self.draft, track_tid)
            if located is None:
                return {"ok": False, "error": f"未找到轨道 tid={track_tid}"}
            tt, track_index, segs = located
            if tt != track_type:
                return {"ok": False, "error": f"轨道类型不匹配：tid={track_tid} 是 {tt}，段是 {track_type}"}
            if not isinstance(index, int) or index < 0 or index >= len(segs):
                return {"ok": False, "error": f"tid={track_tid} 轨没有第 {index} 段（共 {len(segs)} 段）"}
            removed = segs.pop(index)
        elif segid:
            seg = _seg_by_id(self.draft, segid)
            if seg is None:
                return {"ok": False, "error": f"未找到段 id={segid}"}
            removed = _pop_seg_by_ref(self.draft, seg)
            if not removed:
                return {"ok": False, "error": f"段 id={segid} 定位失败"}
        else:
            segs = _track_segs(self.draft, track_type, track_index)
            if segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
            if not isinstance(index, int) or index < 0 or index >= len(segs):
                return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
            removed = segs.pop(index)
        # 不做重排：保留其余片段的绝对 start（与 move_segment 的自由拖动手感一致，删除不抹掉曾移动留下的空档）
        _collapse_empty_tracks(self.draft)  # 片段移走后留下的空轨自动消失
        save_state(self.state)
        return {
            "ok": True, "removed": removed,
            "track_type": track_type, "track_index": track_index, "count": -1,
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
            if _track_segs(self.draft, t, ti) is None:
                continue
            segs = _track_segs(self.draft, t, ti)
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

    def duplicate_segment(self, track_type, track_index, index, seg_id=None):
        """复制单段到同轨紧接其后（前端 Ctrl+D / 工具栏「复制」触发，对齐 OpenCut duplicate-selected）。

        - 深拷贝原段，新段 start = 原段 end（紧贴右侧），src_start/src_end 与原段一致（同一素材、内容相同）
        - 插入到 index+1；一次 undo 记录（save_state 自动入栈），一次 Ctrl+Z 回退
        返回 {"ok": True, "new": {...}} 供前端确认。
        传 seg_id 时优先按稳定段 id 定位（对齐 remove_segment 的 A 方案）。
        """
        self._reload()
        self._push_undo()
        if seg_id:
            seg = _seg_by_id(self.draft, seg_id)
            if seg is None:
                return {"ok": False, "error": f"未找到段 id={seg_id}"}
            # 反查段所在 segs 列表与位置，供紧贴其后插入
            segs = None
            for cand in ([self.draft.get("main", {}).get("segs", [])]
                        + [tr.get("segs", []) for tr in self.draft.get("overlay", []) if isinstance(tr, dict)]
                        + [a.get("segs", []) for a in self.draft.get("audio", []) if isinstance(a, dict)]):
                if seg in cand:
                    segs = cand
                    break
            if segs is None:
                return {"ok": False, "error": f"段 id={seg_id} 未挂载到任何轨道"}
            index = segs.index(seg)
        else:
            segs = _track_segs(self.draft, track_type, track_index)
            if segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
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
            segs = _track_segs(self.draft, t, ti)
            if segs is None:
                continue
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
            segs = _track_segs(self.draft, t, 0, ensure=True)
            new_seg = copy.deepcopy(it["seg"])
            new_seg["id"] = uuid.uuid4().hex  # 粘贴出的新段必须重发 id，否则与原段共享 id
            new_seg["start"] = at + (it["original_start"] - min_start)
            segs.append(new_seg)
            pasted.append(f"{t}:0:{len(segs) - 1}")
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        return {"ok": True, "pasted": pasted, "count": len(pasted)}

    def move_segment(self, track_type, track_index, index, new_start_us, ripple=False, segid=None, track_tid=None):
        """把指定段移动到新的起始时间（微秒）。

        鼠标在时间轴拖动片段后调用。只改该段的 start，不重排后续片段
        （允许片段之间留空档或重叠，符合 PR 的自由拖动手感，后续用吸附处理对齐）。
        A 方案（2026-08-18）：传 segid（稳定段 id）时按 segid 定位（不受 ti 漂移影响）；
        不传则回退 (track_type, track_index, index)。A2（2026-08-19）：track_tid（源轨稳定 id）优先。
        ripple=True 时（同轨左移波纹）：该段左移后，其右侧空出来的区间让后续片段整体左移收拢。
        返回 {"ok": True, "track_type": ..., "track_index": ..., "index": ..., "start": new_start}。
        """
        self._reload()
        self._push_undo()
        before = copy.deepcopy(self.draft)
        if track_tid:
            located = _track_by_tid(self.draft, track_tid)
            if located is None:
                return {"ok": False, "error": f"未找到轨道 tid={track_tid}"}
            tt, track_index, segs = located
            if tt != track_type:
                return {"ok": False, "error": f"轨道类型不匹配：tid={track_tid} 是 {tt}，段是 {track_type}"}
            if not isinstance(index, int) or index < 0 or index >= len(segs):
                return {"ok": False, "error": f"tid={track_tid} 轨没有第 {index} 段（共 {len(segs)} 段）"}
            seg = segs[index]
        elif segid:
            seg = _seg_by_id(self.draft, segid)
            if seg is None:
                return {"ok": False, "error": f"未找到段 id={segid}"}
            segs = None
            main = self.draft.get("main")
            if isinstance(main, dict) and seg in main.get("segs", []):
                segs = main["segs"]
            if segs is None:
                for tr in self.draft.get("overlay", []):
                    if isinstance(tr, dict) and seg in tr.get("segs", []):
                        segs = tr["segs"]
                        break
            if segs is None:
                for a in self.draft.get("audio", []):
                    if isinstance(a, dict) and seg in a.get("segs", []):
                        segs = a["segs"]
                        break
            if segs is None:
                return {"ok": False, "error": f"段 id={segid} 定位失败"}
            index = segs.index(seg)
        else:
            segs = _track_segs(self.draft, track_type, track_index)
            if segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
            if not isinstance(index, int) or index < 0 or index >= len(segs):
                return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段（共 {len(segs)} 段）"}
            seg = segs[index]
        new_start = max(0, int(new_start_us))
        # 同轨不重叠（2026-08-18）：落点被占用 → 自动推到该轨最近空位（跳过自身）
        dur = int(seg.get("duration") or 0)
        if any(_segments_overlap({"start": new_start, "duration": dur}, s) for i2, s in enumerate(segs) if i2 != index):
            new_start = _free_start_on_track(segs, new_start, dur, exclude_index=index)
        seg["start"] = new_start
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
        is_media = seg.get("type") in ("video", "audio")
        new_edge = int(new_edge_us)
        new_start, new_dur, new_ss, new_se = start, dur, ss, se_
        if edge == "left":
            # 2026-08-17 真机修复 v2：双向公式改成"反算"——任何 trim 操作后必须严格保持
            # `(se_ - ss) / speed == dur`（源窗口精确匹配时间长度）。
            # 旧公式 ss += delta*speed 是累加，多次裁剪再拉长后会失同步（用户实测音频段
            # dur=36.69s 但 se=6.19s）——左右都改，杜绝同步漂移。
            # 2026-08-17 路线B：无源覆盖层（text/sticker/image）无源窗口概念，
            # 裁开头只改 start/duration，src_start/src_end 保持构造值（渲染/导出不消费）。
            if is_media:
                left_limit = max(int(-ss / speed), -start)
            else:
                left_limit = max(0, -start)   # 无源：src_start 恒 0，仅防止 start 越过时间轴 0
            delta = max(left_limit, min(new_edge - start, dur - MIN))
            new_start = start + delta
            new_dur = dur - delta
            if is_media:
                new_ss = ss + int(round(delta * speed))
                new_se = new_ss + int(round(new_dur * speed))
        elif edge == "right":
            if is_media:
                # 2026-08-17 修复 v3（根治"拉长恢复被裁片段"+"src 窗口不漂移"）：
                # ① 上限用素材真实全长（FableCut 语义：maxDur = (media.duration - in) / speed）
                # ② 反算公式 new_se = new_ss + new_dur * speed（保证 (se-ss)/speed == dur 永不漂移）
                # ③ se 上限兜底 clamp 到素材边界（防旧脏数据越界）
                real = get_media_duration(seg.get("path"))
                real_us = int(real * 1_000_000) if real else None
                if real_us is not None and se_ > real_us:
                    se_ = real_us
                max_dur = int(((real_us if real_us is not None else se_) - ss) / speed)
                delta = max(MIN - dur, min(new_edge - (start + dur), max_dur - dur))
                new_dur = dur + delta
                new_se = ss + int(round(new_dur * speed))
                if real_us is not None:
                    new_se = min(new_se, real_us)
                    # 同步缩 dur（极端边界：delta 把 new_se 顶到素材边界，dur 要对应收缩）
                    new_dur = int((new_se - ss) / speed)
                    if new_dur < MIN:
                        new_dur = MIN
                        new_se = ss + int(round(new_dur * speed))
            else:
                # 无源覆盖层（text/sticker/image）：拉长/缩短=纯时长，不受素材边界约束
                # 对齐 OpenCut/FableCut：无源段直接改 duration，无 src 窗口概念。
                delta = max(MIN - dur, new_edge - (start + dur))
                new_dur = dur + delta
        else:
            raise ValueError("edge 必须是 left 或 right")
        seg["start"] = new_start
        seg["duration"] = new_dur
        if is_media:
            seg["src_start"] = new_ss
            seg["src_end"] = new_se
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
        segs = _track_segs(self.draft, track_type, track_index)
        if segs is None:
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
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
            segs = _track_segs(self.draft, t, ti)
            if segs is None:
                return {"ok": False, "error": f"未知轨道类型：{t}"}
            if idx < 0 or idx >= len(segs):
                return {"ok": False, "error": f"{t}[{ti}] 没有第 {idx} 段"}
            collected.append((t, ti, idx, segs[idx], m))
        # 1) 一次性取出（按对象引用移除，避免索引错位）
        for (t, ti, idx, seg, m) in collected:
            _track_segs(self.draft, t, ti).remove(seg)
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
            to_segs = _track_segs(self.draft, t, to_idx)
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
            segs = _track_segs(self.draft, t, ti)
            if segs is None:
                return {"ok": False, "error": f"未知轨道类型：{t}"}
            if idx < 0 or idx >= len(segs):
                return {"ok": False, "error": f"{t}[{ti}] 没有第 {idx} 段"}
            seg = segs[idx]
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
            # 5b（R9）：同步写 params 真相源。
            _write_param(seg, "speed.rate", sp)
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

    def _seg_ref(self, track_type, track_index, index, seg_id=None):
        """取段引用（稳定段 id 优先定位，对齐 remove_segment 的 A 方案）。"""
        if seg_id:
            return _seg_by_id(self.draft, seg_id)
        segs = _track_segs(self.draft, track_type, track_index)
        if segs is None:
            return None
        if not isinstance(index, int) or index < 0 or index >= len(segs):
            return None
        return segs[index]

    def _default_mask_params(self, mask_type, params):
        base = {
            "centerX": 0.0, "centerY": 0.0, "width": 0.6, "height": 0.6,
            "rotation": 0.0, "scale": 1.0, "feather": 0, "inverted": False,
            "strokeColor": "#ffffff", "strokeWidth": 0, "strokeAlign": "center",
        }
        # split / cinematic-bars 只用部分字段，多传的会被前端忽略
        base.update(params or {})
        return base

    def set_mask(self, track_type, track_index, index, mask_type, params, seg_id=None):
        """给选中段设置/替换一个遮罩（覆盖式单遮罩）。返回 {"ok": True, "mask": {...}}。"""
        if mask_type not in self._MASK_TYPES:
            return {"ok": False, "error": f"未知遮罩类型：{mask_type}"}
        self._reload()
        seg = self._seg_ref(track_type, track_index, index, seg_id)
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

    def remove_mask(self, track_type, track_index, index, mask_id, seg_id=None):
        self._reload()
        seg = self._seg_ref(track_type, track_index, index, seg_id)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        seg["masks"] = [m for m in seg.get("masks", []) if m.get("id") != mask_id]
        save_state(self.state)
        return {"ok": True}

    def toggle_mask_inverted(self, track_type, track_index, index, mask_id, seg_id=None):
        self._reload()
        seg = self._seg_ref(track_type, track_index, index, seg_id)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        for m in seg.get("masks", []):
            if m.get("id") == mask_id:
                m["params"]["inverted"] = not bool(m["params"].get("inverted", False))
        save_state(self.state)
        return {"ok": True}

    def update_mask_param(self, track_type, track_index, index, mask_id, key, value, seg_id=None):
        self._reload()
        seg = self._seg_ref(track_type, track_index, index, seg_id)
        if seg is None:
            return {"ok": False, "error": f"{track_type}[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        for m in seg.get("masks", []):
            if m.get("id") == mask_id:
                m["params"][key] = value
        save_state(self.state)
        return {"ok": True}

    def update_mask(self, track_type, track_index, index, mask_id, params, seg_id=None):
        """批量合并遮罩参数（拖拽把手时一次性提交，单次 undo）。"""
        self._reload()
        seg = self._seg_ref(track_type, track_index, index, seg_id)
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
        segs = _track_segs(self.draft, track_type, track_index)
        if segs is None:
            return {"ok": False, "error": f"{track_type} 没有第 {track_index} 条轨道"}
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
        segs = _track_segs(self.draft, track_type, track_index)
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
        segs = _track_segs(self.draft, track_type, track_index)
        segs.pop(result["index"])  # 删除左段
        _collapse_empty_tracks(self.draft)
        save_state(self.state)
        right = segs[result["index"]]  # 右段删除左段后左移到原 index
        return {
            "ok": True, "retained": "right", "track_type": track_type, "track_index": track_index, "index": index, "at": result["at"],
            "right": {"start": right["start"], "duration": right["duration"], "src_start": right["src_start"], "src_end": right["src_end"]},
        }


    def relocate_segment(self, track_type, from_track, index, to_track, at_time_us=None, insert_index=None, segid=None, to_track_tid=None):
        """把一个已存在的片段移动到目标轨道。

        A 方案（2026-08-18）：传 segid（稳定段 id）时**优先按 segid 定位源段**（不受 ti 漂移影响）；
        不传则回退 (track_type, from_track, index) 定位。
        A2（2026-08-19）：to_track_tid（目标轨稳定 id）优先于 to_track/insert_index——AI/MCP 可用 tid 换轨。
        to_track 为同类型已有轨道序号；to_track=-1 表示自动新建一条该类型轨道接住。
        落点 at_time_us（微秒）来自拖拽松手横向位置；为 None 则置 0。
        同轨重叠自动避让：落到被占位置会自动推到该轨最近空位。
        源轨道不重排（留空档，PR 式自由）；返回落地后的真实 track_type/track_index/index/start。
        """
        self._reload()
        self._push_undo()
        if segid:
            seg = _seg_by_id(self.draft, segid)
            if seg is None:
                return {"ok": False, "error": f"未找到段 id={segid}"}
            # 从段所在轨移除（_seg_by_id 不返回位置，这里用对象引用逐个找）
            removed = False
            main = self.draft.get("main")
            if isinstance(main, dict):
                for i, s in enumerate(main.get("segs", [])):
                    if s is seg:
                        main["segs"].pop(i)
                        removed = True
                        break
            if not removed:
                for tr in self.draft.get("overlay", []):
                    if not isinstance(tr, dict):
                        continue
                    for i, s in enumerate(tr.get("segs", [])):
                        if s is seg:
                            tr["segs"].pop(i)
                            removed = True
                            break
                    if removed:
                        break
            if not removed:
                for a in self.draft.get("audio", []):
                    if not isinstance(a, dict):
                        continue
                    for i, s in enumerate(a.get("segs", [])):
                        if s is seg:
                            a["segs"].pop(i)
                            removed = True
                            break
                    if removed:
                        break
            if not removed:
                return {"ok": False, "error": f"段 id={segid} 定位失败"}
        else:
            from_segs = _track_segs(self.draft, track_type, from_track)
            if from_segs is None:
                return {"ok": False, "error": f"{track_type} 没有第 {from_track} 条轨道"}
            if not isinstance(index, int) or index < 0 or index >= len(from_segs):
                return {"ok": False, "error": f"{track_type}[{from_track}] 没有第 {index} 段"}
            seg = from_segs.pop(index)  # 从源轨取出（不重排源轨，留空档）
        # 目标轨道：to_track_tid（稳定 id，A2）> to_track 已有轨道序号；to_track 为 None/-1（前端传 null）表示「新建一条该类型轨道接住」，
        # 此时若给了 insert_index 则在指定位置插入（拖到两条轨道中间的空隙），否则追加到末尾。
        if to_track_tid:
            located = _track_by_tid(self.draft, to_track_tid)
            if located is None:
                return {"ok": False, "error": f"未找到轨道 tid={to_track_tid}"}
            tt, to_idx, to_segs = located
            if tt != track_type:
                return {"ok": False, "error": f"轨道类型不匹配：tid={to_track_tid} 是 {tt}，段是 {track_type}"}
        elif to_track is not None and to_track != -1:
            to_idx = _ensure_track(self.draft, track_type, to_track)
            to_segs = _track_segs(self.draft, track_type, to_idx)
        elif insert_index is not None:
            to_idx = _insert_track(self.draft, track_type, insert_index)
            # insert_index 是 overlay/audio 数组下标（不是类型内 ti）——直接定位新建轨
            if track_type == "audio":
                to_segs = self.draft["audio"][to_idx]["segs"]
            else:
                to_segs = self.draft["overlay"][to_idx]["segs"]
        else:
            to_idx = _ensure_track(self.draft, track_type, -1)
            to_segs = _track_segs(self.draft, track_type, to_idx)
        # 精确落点：拖到哪就落在哪；与预览/落点线同源
        start = max(0, int(at_time_us)) if at_time_us is not None else 0
        # 同轨不重叠（2026-08-18）：落点被占用 → 自动推到该轨最近空位（to_segs 不含自身，已从源轨 pop）
        dur = int(seg.get("duration") or 0)
        if any(_segments_overlap({"start": start, "duration": dur}, s) for s in to_segs):
            start = _free_start_on_track(to_segs, start, dur)
        seg["start"] = start
        to_segs.append(seg)
        # 目标轨道被放入片段，取消 persistent_empty 标记
        _clear_persistent_if_needed(self.draft, track_type, to_idx)
        # 片段移动后，源轨可能变空；空轨按「有素材保留、没素材消失」自动折叠。
        # 新轨已有素材，不会被折叠，因此新建轨场景也安全。
        _collapse_empty_tracks(self.draft)
        # 定位被移动片段的真实位置（折叠可能改变了轨道索引）
        located = _locate_seg(self.draft, seg)
        final_ti, final_idx = (located[1], located[2]) if located else (to_idx, len(to_segs) - 1)
        if not save_state(self.state):
            return {"ok": False, "error": "保存草稿失败（写盘异常，看后端控制台 [SAVE-FAIL]）"}
        return {
            "ok": True, "track_type": track_type, "track_index": final_ti,
            "index": final_idx, "start": start,
        }

    def reorder_overlay(self, layer_key, to_display_index):
        """X 模型下 overlay 数组顺序即 z 序——直接移动轨在数组中的位置。
        layer_key: "type:ti"（text/sticker/effect/video>=1 之一）；to_display_index: overlay 数组目标位。
        返回 {ok, overlay_count}。"""
        self._reload()
        self._push_undo()
        draft = self.draft
        overlay = draft.setdefault("overlay", [])
        target_oi = None
        if layer_key == "main":
            return {"ok": False, "error": "主场景不可重排"}
        parts = layer_key.split(":")
        if len(parts) != 2:
            return {"ok": False, "error": f"未知 layer_key：{layer_key}"}
        ttype, tti = parts[0], int(parts[1])
        for oi, tr in enumerate(overlay):
            if tr.get("type") == ttype:
                tti -= 1
                if tti < 0:
                    target_oi = oi
                    break
        if target_oi is None:
            return {"ok": False, "error": f"未知 overlay 轨：{layer_key}"}
        tr = overlay.pop(target_oi)
        ins = max(0, min(int(to_display_index or 0), len(overlay)))
        overlay.insert(ins, tr)
        save_state(self.state)
        return {"ok": True, "overlay_count": len(overlay)}

    def add_video_track(self, insert_index=None):
        """新增一条视频覆盖轨。insert_index=None 时插入到最顶（主轨之上）；否则插入到指定位置。

        通过「＋轨」按钮显式创建的空轨会标记 persistent_empty，避免立刻被折叠消失。
        """
        self._reload()
        self._push_undo()
        if insert_index is None:
            idx = _insert_track(self.draft, "video", 0)
        else:
            idx = _insert_track(self.draft, "video", insert_index)
        # 返回 video 类型 ti（覆盖轨 ti = overlay video 条数）
        v_ti = sum(1 for tr in self.draft.get("overlay", []) if tr.get("type") == "video")
        _set_track_persistent(self.draft, "video", v_ti, True)
        save_state(self.state)
        return {"ok": True, "track_type": "video", "track_index": v_ti, "count": v_ti}

    def delete_video_track(self, track_index):
        """删除一条视频覆盖轨。主视频轨（index=0）不可删除。"""
        self._reload()
        self._push_undo()
        if track_index == 0:
            return {"ok": False, "error": "主视频轨不可删除"}
        overlay = self.draft.setdefault("overlay", [])
        v_ti = int(track_index) - 1  # video ti → overlay video 第 (ti-1) 条
        cnt = 0
        for oi, tr in enumerate(overlay):
            if tr.get("type") == "video":
                if cnt == v_ti:
                    overlay.pop(oi)
                    _remove_track_meta(self.draft, "video", track_index)
                    save_state(self.state)
                    return {"ok": True, "track_type": "video", "track_index": track_index, "count": len(overlay)}
                cnt += 1
        return {"ok": False, "error": f"video 没有第 {track_index} 条覆盖轨"}

    def add_audio_track(self, insert_index=None):
        """新增一条音频轨。insert_index=None 时追加到最下；否则插入到指定位置。"""
        self._reload()
        self._push_undo()
        audio = self.draft.setdefault("audio", [{"segs": []}])
        if insert_index is None:
            audio.append({"segs": []})
            idx = len(audio) - 1
        else:
            idx = _insert_track(self.draft, "audio", insert_index)
        _set_track_persistent(self.draft, "audio", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "audio", "track_index": idx, "count": len(audio)}

    def delete_audio_track(self, track_index):
        """删除一条音频轨。"""
        self._reload()
        self._push_undo()
        audio = self.draft.setdefault("audio", [{"segs": []}])
        if not isinstance(track_index, int) or track_index < 0 or track_index >= len(audio):
            return {"ok": False, "error": f"audio 没有第 {track_index} 条轨道（共 {len(audio)} 条）"}
        audio.pop(track_index)
        _remove_track_meta(self.draft, "audio", track_index)
        save_state(self.state)
        return {"ok": True, "track_type": "audio", "track_index": track_index, "count": len(audio)}

    def add_text_track(self, insert_index=None):
        """新增一条文本轨（字幕/贴纸/画中画文字多用，支持多轨堆叠）。默认插到 overlay 最顶。"""
        self._reload()
        self._push_undo()
        if insert_index is None:
            idx = _insert_track(self.draft, "text", 0)
        else:
            idx = _insert_track(self.draft, "text", insert_index)
        _set_track_persistent(self.draft, "text", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "text", "track_index": idx, "count": len(self.draft.get("overlay", []))}

    def delete_text_track(self, track_index):
        """删除一条文本轨。文本无主锚点，任意轨可删。"""
        self._reload()
        self._push_undo()
        overlay = self.draft.setdefault("overlay", [])
        cnt = 0
        for oi, tr in enumerate(overlay):
            if tr.get("type") == "text":
                if cnt == track_index:
                    overlay.pop(oi)
                    _remove_track_meta(self.draft, "text", track_index)
                    save_state(self.state)
                    return {"ok": True, "track_type": "text", "track_index": track_index, "count": len(overlay)}
                cnt += 1
        return {"ok": False, "error": f"text 没有第 {track_index} 条轨道"}

    # ---- 贴纸轨（本地透明 PNG/WebP 叠加；离线可用，不依赖网络贴纸库）----

    def _ensure_sticker_track(self, track_index):
        """确保 sticker 轨存在并返回 (segs, idx)。track_index=None 用第 0 条。"""
        if track_index is None:
            track_index = 0
        segs = _track_segs(self.draft, "sticker", track_index, ensure=True)
        return segs, track_index

    def add_sticker_track(self, insert_index=None):
        """新增一条贴纸轨（叠加在最上层，盖住视频/文本之下）。默认插到 overlay 最顶。"""
        self._reload()
        self._push_undo()
        if insert_index is None:
            idx = _insert_track(self.draft, "sticker", 0)
        else:
            idx = _insert_track(self.draft, "sticker", insert_index)
        _set_track_persistent(self.draft, "sticker", idx, True)
        save_state(self.state)
        return {"ok": True, "track_type": "sticker", "track_index": idx, "count": len(self.draft.get("overlay", []))}

    def delete_sticker_track(self, track_index):
        """删除一条贴纸轨。"""
        self._reload()
        self._push_undo()
        overlay = self.draft.setdefault("overlay", [])
        cnt = 0
        for oi, tr in enumerate(overlay):
            if tr.get("type") == "sticker":
                if cnt == track_index:
                    overlay.pop(oi)
                    _remove_track_meta(self.draft, "sticker", track_index)
                    save_state(self.state)
                    return {"ok": True, "track_type": "sticker", "track_index": track_index, "count": len(overlay)}
                cnt += 1
        return {"ok": False, "error": f"sticker 没有第 {track_index} 条轨道"}

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
        segs, idx = self._ensure_sticker_track(track_index)
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
        segs.append(seg)
        _ensure_seg_ids(self.draft)
        save_state(self.state)
        return {"ok": True, "track_index": idx, "index": len(segs) - 1}

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

    # ---- 特效轨（Effect Track：Effect DSL 节点，预览=导出同源）----

    def _ensure_effect_track(self, track_index):
        """确保 effect 轨存在并返回 (segs, idx)。track_index=None 用第 0 条。"""
        if track_index is None:
            track_index = 0
        segs = _track_segs(self.draft, "effect", track_index, ensure=True)
        return segs, track_index

    def get_effect_registry(self):
        """返回特效注册表（EFFECT_META）供前端渲染特效库与参数面板。

        单一真源：前端不硬编码特效列表/参数，避免与 EFFECT_REGISTRY/EFFECT_META 漂移。
        前端在 init 时拉一次存入 Store.state.effects；特效库卡片与参数面板滑块均由它自动生成。"""
        return {"ok": True, "meta": EFFECT_META}

    def add_effect(self, track_index, effect_type, target=None, start_us=0, duration_us=2_000_000,
                   params=None, keyframes=None, name=None, insert_index=None, seg_id=None):
        """新增一个特效段到特效轨（Effect DSL 节点）。

        effect_type: 注册表 key（blur/brightness/contrast/saturate/hue_rotate/grayscale/sepia/invert/opacity；
                     预留 transition/mask/text_anim）。
        target: {"type":"clip","track":int,"ti":int,"si":int} 绑素材段；默认 {"type":"adjustment"}（调整层，盖整栈）。
        start_us/duration_us: 微秒（段在特效轨上的时间区间，即 range.startUs/endUs）。
        params: 该 effect_type 的原语参数 dict（见 docs/architecture/effect-track-design.md §2.3）。
        keyframes: 参数时间曲线 [{param,time(us,相对段起点),value,easing}]；默认空=静态。
        返回 {ok, track_index, index, id} 或 {ok:False, error}。"""
        if not effect_type or effect_type not in EFFECT_REGISTRY:
            return {"ok": False, "error": f"未知 effect_type：{effect_type}（合法值见 EFFECT_REGISTRY）"}
        try:
            start_us = int(start_us) if start_us is not None else 0
            duration_us = int(duration_us) if duration_us is not None else 2_000_000
        except Exception:
            return {"ok": False, "error": "start/duration 必须是整数微秒"}
        if duration_us <= 0:
            return {"ok": False, "error": "特效时长必须 > 0"}
        if target is None:
            target = {"type": "adjustment"}
        if not isinstance(target, dict) or "type" not in target:
            return {"ok": False, "error": "target 必须是 {type:'clip'|'adjustment'|'track', ...}"}
        # 09 方案 M1-1b：把稳定段 id 并入 target（clip 绑定时随 target 一起存，供未来按 id 解析绑定）
        if seg_id and isinstance(target, dict):
            target = dict(target); target["seg_id"] = seg_id
        if target["type"] == "clip":
            # 09 方案 M1-1b：target 支持按稳定段 id 绑定（seg_id），同时保留 track/ti/si 兼容
            has_tisi = all(k in target for k in ("track", "ti", "si"))
            has_segid = "seg_id" in target
            if not has_tisi and not has_segid:
                return {"ok": False, "error": "target.type='clip' 需要 track/ti/si 字段或 seg_id"}
        self._reload()
        self._push_undo()
        if insert_index is not None:
            # 拖到空白：在指定显示位插入一条新特效轨接住（与前端 computeDrop/insertIndex 同源）
            idx = _insert_track(self.draft, "effect", insert_index)
            idx = sum(1 for tr in self.draft.get("overlay", []) if tr.get("type") == "effect") - 1
            segs = _track_segs(self.draft, "effect", idx)
        else:
            segs, idx = self._ensure_effect_track(track_index)
        seg = {
            "id": "effect_" + uuid.uuid4().hex[:12],
            "type": "effect",
            "effect_type": effect_type,
            "target": target,
            "start": start_us,
            "duration": duration_us,
            "src_start": 0,
            "src_end": duration_us,
            "params": dict(params) if isinstance(params, dict) else {},
            "animations": _effect_keyframes_to_anims(keyframes),   # 5c（R18）：统一通道，不再用扁平 seg.keyframes
            "hidden": False,
            "name": name or effect_type,
        }
        segs.append(seg)
        _ensure_seg_ids(self.draft)
        save_state(self.state)
        return {"ok": True, "track_index": idx, "index": len(segs) - 1, "id": seg["id"]}

    def update_effect(self, track_index, index, patch=None, seg_id=None, **kw):
        """更新特效段：patch 或 kwargs 可含 effect_type/target/params(合并)/keyframes/
        range{startUs,endUs}/start/duration/name/hidden。单次 undo。"""
        self._reload()
        seg = self._seg_ref("effect", track_index, index, seg_id)
        if seg is None:
            return {"ok": False, "error": f"effect[{track_index}] 没有第 {index} 段"}
        self._push_undo()
        if not isinstance(patch, dict):
            patch = {}
        patch = dict(patch)
        patch.update(kw)
        if "effect_type" in patch:
            if patch["effect_type"] not in EFFECT_REGISTRY:
                return {"ok": False, "error": f"未知 effect_type：{patch['effect_type']}"}
            seg["effect_type"] = patch["effect_type"]
        if "target" in patch and isinstance(patch["target"], dict):
            seg["target"] = patch["target"]
        if "name" in patch:
            seg["name"] = patch["name"]
        if "hidden" in patch:
            seg["hidden"] = bool(patch["hidden"])
        if "params" in patch and isinstance(patch["params"], dict):
            seg.setdefault("params", {})
            seg["params"].update(patch["params"])
        if "keyframes" in patch:
            # 5c（R18）：扁平 keyframes → 统一 animations 通道（effect.{param}），移除旧扁平字段避免双真源
            if patch["keyframes"]:
                seg.setdefault("animations", {})
                seg["animations"].update(_effect_keyframes_to_anims(patch["keyframes"]))
            else:
                if isinstance(seg.get("animations"), dict):
                    for _p in list(seg["animations"].keys()):
                        if _p.startswith("effect."):
                            del seg["animations"][_p]
            seg.pop("keyframes", None)
        # range 优先；否则 start/duration
        if "range" in patch and isinstance(patch["range"], dict):
            if "startUs" in patch["range"]:
                seg["start"] = int(patch["range"]["startUs"])
            if "endUs" in patch["range"]:
                seg["duration"] = max(0, int(patch["range"]["endUs"]) - seg["start"])
        else:
            if "start" in patch:
                seg["start"] = int(patch["start"])
            if "duration" in patch:
                seg["duration"] = int(patch["duration"])
        save_state(self.state)
        return {"ok": True}

    def remove_effect(self, track_index, index, seg_id=None):
        """删除特效轨第 index 段。seg_id：09 M1-1b 稳定段 id，优先于 (track_index,index) 定位。"""
        return self.remove_segment("effect", track_index, index, seg_id)

    def duplicate_effect(self, track_index, index, seg_id=None):
        """复制特效段到同轨紧接其后（重发 effect_ 前缀 id）。"""
        r = self.duplicate_segment("effect", track_index, index, seg_id)
        if r.get("ok"):
            ni = r["index"]
            seg = self._seg_ref("effect", track_index, ni)
            if seg is not None:
                seg["id"] = "effect_" + uuid.uuid4().hex[:12]
                save_state(self.state)
        return r

    # ---- 字幕（ASR / SRT 导入）----

    # 字幕默认样式（对齐 OpenCut：底部居中、白字粗体、自动换行、可选黑底）
    DEFAULT_SUB_STYLE = {
        "font_size": 10.0, "bold": True, "color": "#ffffff",
        "align": 1, "bg": False, "bg_color": "#000000",
    }

    def _ensure_text_track(self, track_index):
        """确保 text 轨存在并返回 (segs, idx)。track_index=None 用第 0 条。"""
        if track_index is None:
            track_index = 0
        segs = _track_segs(self.draft, "text", track_index, ensure=True)
        return segs, track_index

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
        tracks.extend(segs)
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
        if field in ("hidden", "muted", "locked"):
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

    def select_folder(self, initial=None):
        """弹系统文件夹选择框，返回选中的文件夹路径（字符串）或 None。
        initial: 初始目录（用于定位到上次导出路径）；为空则用记住的默认导出路径。"""
        directory = initial or get_setting("default_export_folder", None) or ""
        try:
            result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG, directory=directory)
        except TypeError:
            # 老版本 pywebview 可能不接受 directory 参数，降级为无初始目录
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
        has_any = any(True for _ in _iter_all_segs(self.draft))
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
            overlay = self.draft.get("overlay", [])
            main_tr = self.draft.get("main")
            main_segs = main_tr.get("segs", []) if isinstance(main_tr, dict) else []
            # 视频轨：main（video_0，最底）→ overlay video 覆盖轨按 overlay 顺序 append（越晚越靠上）
            video_track_names = ["video_0"]
            script.append_track(TrackSpec(TrackType.video, name="video_0"))
            v_cnt = 0
            video_overlay_idx = {}   # overlay 下标 → tname
            for oi, tr in enumerate(overlay):
                if tr.get("type") == "video":
                    v_cnt += 1
                    tname = f"video_{v_cnt}"
                    script.append_track(TrackSpec(TrackType.video, name=tname))
                    video_track_names.append(tname)
                    video_overlay_idx[oi] = tname
            # 音频轨：多条音轨混音
            audio_track_names = []
            for i, _ in enumerate(self.draft.get("audio", [])):
                tname = f"audio_{i}"
                script.append_track(TrackSpec(TrackType.audio, name=tname))
                audio_track_names.append(tname)
            # 贴纸轨（overlay sticker）：分两类导出（本地图片→叠加 video 轨；剪映贴纸→sticker 轨）
            sticker_ov = [(oi, tr.get("segs", [])) for oi, tr in enumerate(overlay) if tr.get("type") == "sticker"]
            for si, (oi, segs) in enumerate(sticker_ov):
                path_segs = [s for s in segs if s.get("path") and os.path.isfile(s["path"])]
                res_segs = [s for s in segs if not s.get("path") and s.get("resource_id")]
                if path_segs:
                    tname = f"sticker_img_{si}"
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
                    tname = f"sticker_res_{si}"
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
            # 文本轨（overlay text）
            text_track_names = {}
            for oi, tr in enumerate(overlay):
                if tr.get("type") == "text":
                    tname = f"text_{oi}"
                    script.append_track(TrackSpec(TrackType.text, name=tname))
                    text_track_names[oi] = tname

            # 视频 + 图片：main → video_0；overlay video → 各自 tname
            for tname, segs in [("video_0", main_segs)] + [(video_overlay_idx[oi], tr.get("segs", []))
                                                            for oi, tr in enumerate(overlay) if oi in video_overlay_idx]:
                ti = video_track_names.index(tname)
                v_meta = self._track_meta("video", ti, ensure=False)
                if v_meta.get("hidden"):
                    continue  # 隐藏的视频轨：预览和导出都不渲染
                track_muted = v_meta.get("muted", False)
                for seg in segs:
                    try:
                        t = Timerange(seg["start"], seg["duration"])
                        # source_timerange 必须传真实源跨度（src_end - src_start），
                        # 原代码传 seg["duration"] 只在 speed=1 时碰巧正确；变速后必须用源跨度。
                        # 2026-08-17 根治：源终点推导（(se-ss)/speed == duration 不变量，防脏 src_end）
                        ss = int(seg.get("src_start", 0))
                        speed_exp = _seg_speed(seg)
                        se_ = ss + int(round(max(0, seg.get("duration", 0)) * speed_exp))
                        src = Timerange(ss, max(1, se_ - ss))
                        # 提取原声后视频自身静音（muted → volume=0），避免与独立音轨音频翻倍
                        # 轨道级静音同样让整轨视频的内嵌音频静音
                        vol = 0.0 if (track_muted or seg.get("muted")) else float(seg.get("volume", 1.0))
                        kwargs = {"source_timerange": src, "volume": vol}
                        speed = _seg_speed(seg)
                        if abs(speed - 1.0) > 1e-6:
                            kwargs["speed"] = speed
                            kwargs["change_pitch"] = bool(seg.get("change_pitch", False))
                        vseg = VideoSegment(seg["path"], t, clip_settings=_video_clip_settings(seg, W, H), **kwargs)
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
            # 音频（dict 列表）
            for ti, a in enumerate(self.draft.get("audio", [])):
                if not isinstance(a, dict):
                    continue
                segs = a.get("segs", [])
                tname = audio_track_names[ti]
                a_meta = self._track_meta("audio", ti, ensure=False)
                if a_meta.get("muted"):
                    continue  # 静音的音频轨：整轨不导出
                for seg in segs:
                    try:
                        t = Timerange(seg["start"], seg["duration"])
                        # 2026-08-17 根治：源终点推导（防脏 src_end 导出错窗）
                        ss = int(seg.get("src_start", 0))
                        speed_exp = _seg_speed(seg)
                        se_ = ss + int(round(max(0, seg.get("duration", 0)) * speed_exp))
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
            # 文本（overlay text）
            for oi, tr in enumerate(overlay):
                if tr.get("type") != "text":
                    continue
                if oi not in text_track_names:
                    continue
                tname = text_track_names[oi]
                segs = tr.get("segs", [])
                tx_meta = self._track_meta("text", oi, ensure=False)
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

            # 特效段：剪映草稿不支持任意 CSS 滤镜，特效为预览专用；明确记入 skipped（不静默丢）
            eff_count = 0
            for tr in overlay:
                if tr.get("type") != "effect":
                    continue
                for seg in tr.get("segs", []):
                    if not seg.get("hidden"):
                        eff_count += 1
            if eff_count:
                skipped.append({
                    "name": f"特效×{eff_count}",
                    "reason": "特效为预览专用滤镜（剪映草稿不支持 CSS 滤镜），已跳过导出（不影响成片结构）",
                })

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
        _snapshot = copy.deepcopy(self.state)   # 1d 导入回滚：导入前拍完整快照，写盘失败整体还原
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
            if not save_state(self.state):
                self._restore_snapshot(_snapshot)
                return []
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
        _snapshot = copy.deepcopy(self.state)   # 1d 导入回滚：导入剪映草稿前拍完整快照，写盘失败整体还原
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
        if not save_state(self.state):
            self._restore_snapshot(_snapshot)
            return {"ok": False, "error": "导入剪映草稿失败（写盘异常，看后端控制台 [SAVE-FAIL]/[SAVE-VERIFY-FAIL]）"}
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

    def get_state(self, since_version=None):
        """返回当前完整状态（materials + draft + version）。

        前端每 2 秒轮询它（2f version 门控后无感知）来实现「人和 AI 实时互相看到改动」；AI/MCP 也读它确认当前草稿。

        注意：        AI/MCP 可能是另一个独立进程（通过 mcp_server.py 启动），它们会写同一个
        draft_state.json 文件。所以 get_state 每次都从文件重新加载，而不是返回内存缓存，
        否则桌面窗口永远看不到 AI 后台做的改动。

        同时把 MCP 连接状态（左上角灰/绿 + agent 名）一并带出来；状态变化时会触发前端刷新。

        2f version 门控：调用方若已持有 since_version 且磁盘 version 未变，直接返回轻量
        {"unchanged":True,"version":...}，跳过 src_full 重算 / mcp 读盘 / 整树序列化 ——
        轮询开销从「每次全量」降到「仅他人改动时全量」，轮询间隔可放宽到 2s 无感知。
        """
        self.state = load_state()
        self.draft = self.state["draft"]  # 同步更新草稿引用，避免后续操作改到旧内存
        ondisk_version = self.state.get("version")
        # 2f：版本未变则短路返回，避免每轮询都重算 src_full / 读 mcp / 序列化整树草稿
        if since_version is not None and ondisk_version is not None and str(since_version) == str(ondisk_version):
            return {"unchanged": True, "version": ondisk_version}
        # 3b（M3）：src_full 回填已移出轮询路径（修 R13，避免每次轮询 ffprobe 阻塞）。
        # 它改由 _reload（所有写操作/导入前统一调用）补并落盘(record=False)，
        # 新素材建段即带 src_full；纯读轮询不再触发探测。get_state 只负责读最新磁盘态。
        mcp_state = load_mcp_state()
        self.state["meta"] = {"mcp": mcp_state}
        # 4a：富化轮询——diff「上次轮询草稿」与当前草稿，把变更载荷挂 meta.documentChanged 返回。
        # 覆盖 MCP/另一窗口的跨进程改动（save_state 的 evaluate_js 推仅同进程）。首次轮询(_last_seen_draft
        # 为 None)不挂——前端本就全量渲染。若同进程刚发布过且版本一致，复用其 actor（更准）。
        if self._last_seen_draft is not None:
            actor = "system"
            if LAST_DOCUMENT_CHANGE is not None and LAST_DOCUMENT_CHANGE.get("version") == ondisk_version:
                actor = LAST_DOCUMENT_CHANGE.get("actor", "system")
            dc = _compute_change_payload(self._last_seen_draft, self.draft, actor, ondisk_version)
            self.state["meta"]["documentChanged"] = None if dc.get("empty") else dc
        else:
            self.state["meta"]["documentChanged"] = None
        self._last_seen_draft = copy.deepcopy(self.draft)
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
        _snapshot = copy.deepcopy(self.state)   # 1d 导入回滚：拖入导入前拍完整快照，写盘失败整体还原
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
            if not save_state(self.state):
                self._restore_snapshot(_snapshot)
                return []
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
        # M1-1a 修复 R2/R12：旧结构遍历（video/audio/text）在 X 模型下永不命中，
        # 改用 _iter_all_segs 遍历 main/overlay/audio 全部段；按 material_id（同时
        # 兼容素材 uid 与 id 两种键名）或 path 匹配，避免误删仍被引用的 assets 文件。
        target_ids = {target.get("uid"), target.get("id")} - {None}
        for seg in _iter_all_segs(self.state.get("draft", {})):
            if isinstance(seg, dict) and (
                seg.get("material_id") in target_ids
                or seg.get("path") == path
            ):
                referenced = True
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
    webview.start()


if __name__ == "__main__":
    main()


# =====================================================================
# 1d（M1 收尾，2026-08-23）：写失败可见化（单点收口，零逐站改动）
# ---------------------------------------------------------------------
# 背景：save_state 在写盘失败（[SAVE-FAIL]）或写回校验不一致（[SAVE-VERIFY-FAIL]）
# 时返回 False，但约 68 处写方法忽略该返回值，仍向 JS/MCP 返回 {"ok": True}，
# 导致前端误判成功、实际段只在内存没落盘 → 下一操作 _reload 读旧盘 → 段全丢
# （"拖进去了又消失"的元凶之一）。
# 做法：save_state 失败时置模块级「粘性」标志 FAILED_SAVE=True（成功不清除，保证
# 一次调用内多次 save_state 只要有一次失败就标记）；统一 wrapper 在【每个 Api 方法】
# 返回后检测——若结果仍是 {"ok": True} 则翻转为 {"ok": False, "error": ...}。
# 覆盖 Web（pywebview 直调）与 MCP（CommandManager.execute 经 getattr 取到 wrapper）
# 两条路径，不需要改 68 处调用点。wrapper 在模块导入时作用于 Api 类，运行时创建的
# 实例自动继承。仅包裹「公开方法」（不以 _ 开头、且是普通函数），读类/属性/类方法不受影响。
# =====================================================================
def _wrap_save_failure(fn):
    @functools.wraps(fn)
    def _w(*args, **kwargs):
        global FAILED_SAVE, SAVE_LAST_CONFLICT
        FAILED_SAVE = False  # 每次调用重置，保证「粘性」只在同一调用内累积
        SAVE_LAST_CONFLICT = None  # 每次调用重置，避免上一轮的冲突码泄漏到本轮
        res = fn(*args, **kwargs)
        # 2e：乐观锁冲突透传——save_state 若在本次调用内检测到跨进程 version 冲突，
        # 把冲突码注入返回值，使桌面 UI / MCP 都能看到「未保存，请重新加载」而非静默成功。
        if SAVE_LAST_CONFLICT is not None and isinstance(res, dict) and res.get("ok"):
            res = dict(res)
            res["ok"] = False
            res["conflict"] = True
            res["error"] = "乐观锁冲突：草稿已被其他进程(桌面/MCP)改动，本操作未保存。请重新加载草稿后再试。"
            res["expected"] = SAVE_LAST_CONFLICT["expected"]
            res["actual"] = SAVE_LAST_CONFLICT["actual"]
        SAVE_LAST_CONFLICT = None
        if FAILED_SAVE and isinstance(res, dict) and res.get("ok"):
            res = dict(res)
            res["ok"] = False
            res["error"] = "保存草稿失败（写盘异常，看后端控制台 [SAVE-FAIL]/[SAVE-VERIFY-FAIL]）"
        return res
    return _w


for _name, _attr in list(Api.__dict__.items()):
    if not _name.startswith("_") and isinstance(_attr, types.FunctionType):
        setattr(Api, _name, _wrap_save_failure(_attr))
