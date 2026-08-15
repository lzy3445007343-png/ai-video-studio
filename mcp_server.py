"""
AI剪辑工作台 —— MCP server（stdio 本地进程）
把工作台已有的原子能力暴露给外部 Agent（WorkBuddy）驱动，实现"AI 后台剪、用户桌面实时看"。

设计原则：
- 复用 main.py 的 Api 类（人和 AI 同一套逻辑，不分叉，不返工）。
- MCP tool = AI 能做的"动作"；MCP resource = AI 能读的"数据"（共享草稿文件 draft_state.json）。
- 共享文件机制：AI 经 MCP 调 add_clip / add_to_timeline → 写 draft_state.json → 用户桌面窗口每 0.5 秒轮询刷新，实现实时同步。

运行：由 WorkBuddy 的 mcp.json 以 stdio 方式拉起（见 mcp.json 的 ai-video-studio 条目）。
"""
import sys
import os
import json
import time
import atexit
import threading

# 让本文件能 import 同目录的 main.py
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from mcp.server.fastmcp import FastMCP
import main
import studio_read as sr  # 细粒度读取：按需抽小数据，避免把 103KB 草稿甩给 agent（黑盒）

# Step 5b：MCP 写操作统一走 Command 审计（actor=agent，可回退可追责）。
# Agent 调任何写工具都自动带 meta，无需显式传。
_MCP_META = {"actor": "agent", "source": "mcp"}


def _exec(cmd_id, args):
    """以 Command 语义执行写操作并自动审计。cmd_id = Api 方法名，args = 关键字参数 dict。"""
    api = main.Api()
    r = api.execute(cmd_id, args, _MCP_META)
    return json.dumps(r, ensure_ascii=False, indent=2)

mcp = FastMCP("ai-video-studio")


@mcp.tool()
def get_state() -> str:
    """读取当前草稿状态（素材库 materials + 时间轴轨道 draft），返回 JSON 字符串。
    AI 用它"看"用户当前素材库和时间轴排了什么。"""
    api = main.Api()
    return json.dumps(api.get_state(), ensure_ascii=False, indent=2)


@mcp.tool()
def import_media_by_paths(paths: list) -> str:
    """按文件路径直接把素材复制进工具素材库（无需弹窗，AI 专用）。
    paths: 本地文件绝对路径列表。已存在的素材会自动跳过。返回入库的素材列表 JSON。"""
    api = main.Api()
    items = api.import_media_by_paths(paths)
    return json.dumps(items, ensure_ascii=False, indent=2)


@mcp.tool()
def add_clip(path: str) -> str:
    """一步到位：把指定路径的素材入库并直接进轨（视频/图片→视频轨，音频→音频轨）。
    用户给一个桌面路径，AI 全自动办完。返回进轨结果 JSON（含轨道/段数/时长）。"""
    return _exec("add_clip", {"path": path})


@mcp.tool()
def add_to_timeline(name: str, path: str, mtype: str, track_index: int = 0, at_time_us: int = None, insert_index: int = None) -> str:
    """把已入库的素材登记进对应时间轴轨道（真实进轨，非假显示）。
    mtype 取值：video/audio/image/text；track_index 是该类型内的轨道序号（0=主视频轨/第一条音频轨）。
    track_index=-1 表示自动新建一条该类型轨道（拖到空白处用）；insert_index 为在两条轨道中间的空隙新建轨的位置（拖到空隙用，优先级高于 track_index=-1）；at_time_us 为落点时间（微秒），省略则接到轨尾。
    同轨重叠会自动避让（推到最近空位）。返回结果 JSON（track_type/track_index/第几段/总段数/时长微秒）。"""
    return _exec("add_to_timeline", {"name": name, "path": path, "mtype": mtype, "track_index": track_index, "at_time_us": at_time_us, "insert_index": insert_index})


@mcp.tool()
def export_draft(name: str, folder: str) -> str:
    """把当前草稿导出成标准剪映草稿文件夹（draft_content.json + draft_meta_info.json）。
    name: 草稿名（会在 folder 下建同名子文件夹）；folder: 保存目录绝对路径。
    导出成功后自动记住 folder 作为默认导出路径。返回结果 JSON（成功/路径/段落数/跳过数）。"""
    api = main.Api()
    r = api.export_draft(name, folder)
    return json.dumps(r, ensure_ascii=False, indent=2)


@mcp.tool()
def remove_segment(track_type: str, track_index: int, index: int) -> str:
    """删除指定轨道里的第 index 段，并自动重排该轨道后续片段时间。
    track_type: video / audio / text；track_index: 该类型内轨道序号（0=主视频轨/第一条音频轨）；index: 段序号。
    返回结果 JSON（被删除段信息 + 剩余段数）。"""
    return _exec("remove_segment", {"track_type": track_type, "track_index": track_index, "index": index})


@mcp.tool()
def move_segment(track_type: str, track_index: int, index: int, new_start_us: int) -> str:
    """把指定轨道第 index 段移动到新起始时间（微秒，1秒=1000000）。
    track_type: video / audio / text；track_index: 该类型内轨道序号；index: 段序号。
    鼠标拖动片段后调用，AI 也能经此驱动。同一轨道内移动，重叠会自动避让。返回结果 JSON。"""
    return _exec("move_segment", {"track_type": track_type, "track_index": track_index, "index": index, "new_start_us": new_start_us})


@mcp.tool()
def relocate_segment(track_type: str, from_track: int, index: int, to_track: int, at_time_us: int = None, insert_index: int = None) -> str:
    """把一个已有片段从 (track_type, from_track, index) 跨轨移动到目标轨道（拖拽跨轨用）。
    to_track 为同类型已有轨道序号；to_track=-1 表示自动新建一条该类型轨道接住；insert_index 为在两条轨道中间空隙新建轨的位置（拖到空隙用，优先级高于 to_track=-1）。
    at_time_us 为落点时间（微秒），省略则置 0；同轨重叠会自动避让。返回落地真实位置 JSON。"""
    return _exec("relocate_segment", {"track_type": track_type, "from_track": from_track, "index": index, "to_track": to_track, "at_time_us": at_time_us, "insert_index": insert_index})


@mcp.tool()
def trim_segment(track_type: str, track_index: int, index: int, edge: str, new_edge_us: int) -> str:
    """片段双向裁剪。edge='left' 拖左把手裁/拉开头，edge='right' 拖右把手缩/拉尾。
    track_type: video/audio/text；track_index: 该类型内轨道序号；index: 段序号；edge: left/right；new_edge_us: 新边界时间轴位置（微秒）。
    约束：最短 0.2 秒；左把手拉回到 src_start=0；右把手最多拉到素材末尾。返回结果 JSON。"""
    return _exec("trim_segment", {"track_type": track_type, "track_index": track_index, "index": index, "edge": edge, "new_edge_us": new_edge_us})


@mcp.tool()
def split_segment(track_type: str, track_index: int, index: int, at_time_us: int) -> str:
    """在指定位置把一段素材切成两段（对应前端 Ctrl+B / 工具栏「分割」）。
    track_type: video/audio/text；track_index: 该类型内轨道序号；index: 段序号；at_time_us: 切割点时间轴位置（微秒）。
    约束：切点距片段两端均须 >0.2 秒。返回结果 JSON（含 left/right 两段新参数）。"""
    return _exec("split_segment", {"track_type": track_type, "track_index": track_index, "index": index, "at_time_us": at_time_us})


@mcp.tool()
def add_video_track(insert_index: int = None) -> str:
    """新增一条视频覆盖轨（位于主视频轨之上）。insert_index 指定插入位置（省略则追加到最上）。返回新轨道索引。"""
    return _exec("add_video_track", {"insert_index": insert_index})


@mcp.tool()
def delete_video_track(track_index: int) -> str:
    """删除一条视频覆盖轨。主视频轨（track_index=0）不可删除。"""
    return _exec("delete_video_track", {"track_index": track_index})


@mcp.tool()
def add_audio_track(insert_index: int = None) -> str:
    """新增一条音频轨。insert_index 指定插入位置（省略则追加到最下）。返回新轨道索引。"""
    return _exec("add_audio_track", {"insert_index": insert_index})


@mcp.tool()
def delete_audio_track(track_index: int) -> str:
    """删除一条音频轨。"""
    return _exec("delete_audio_track", {"track_index": track_index})


@mcp.tool()
def add_text_track(insert_index: int = None) -> str:
    """新增一条文本轨（字幕/贴纸/画中画文字，支持多轨堆叠）。insert_index 指定插入位置（省略则追加到最下）。返回新轨道索引。"""
    return _exec("add_text_track", {"insert_index": insert_index})


@mcp.tool()
def delete_text_track(track_index: int) -> str:
    """删除一条文本轨（字幕轨任意可删，无主锚点）。"""
    return _exec("delete_text_track", {"track_index": track_index})


@mcp.tool()
def set_track_meta(track_type: str, track_index: int, field: str, value: bool) -> str:
    """设置某条轨道的预览元数据（前端轨道上「👁/🔊」开关用）。

    - track_type: 'video' | 'audio' | 'text'
    - field: 'hidden'（隐藏画面，对应 👁 按钮）| 'muted'（静音声音，对应 🔊 按钮）
    - value: true/false

    仅影响前端预览显示，不参与剪映草稿导出，不改变剪辑语义。
    """
    return _exec("set_track_meta", {"track_type": track_type, "track_index": track_index, "field": field, "value": value})


@mcp.tool()
def undo() -> str:
    """撤销上一步编辑（删除/移动/裁剪/分割/进轨），还原草稿到上一步状态。对应前端 Ctrl+Z。返回结果 JSON（剩余可撤销步数）。"""
    api = main.Api()
    r = api.undo()
    return json.dumps(r, ensure_ascii=False, indent=2)


@mcp.tool()
def redo() -> str:
    """重做（撤销的反操作），还原到被撤销前的状态。对应前端 Ctrl+Y / Ctrl+Shift+Z。返回结果 JSON（剩余可重做步数）。"""
    api = main.Api()
    r = api.redo()
    return json.dumps(r, ensure_ascii=False, indent=2)


@mcp.tool()
def execute(cmd_id: str, args: str = "{}", meta: str = "{}") -> str:
    """Step 5b：统一命令入口——以 Command 语义执行任意写操作并自动审计（可回退、可审计）。
    cmd_id：操作名（split_segment / trim_segment / move_segment / remove_segment /
            duplicate_segment / add_to_timeline / set_segment_speed / toggle_track_mute 等，与对应方法同名）。
    args：参数 JSON 字符串（与对应方法同名参数，见各工具签名）。
    meta：审计元信息 JSON——推荐带 actor（谁做的："agent"/"user"）、reason（为什么，如"去掉口误"）、
          confidence（0~1 可信度）、source（来源，如"skill:口播精剪"）。Agent 调用务必填写，可审计可追责。
    示例：execute("split_segment", '{"track_type":"video","track_index":0,"index":0,"at_time_us":5000000}',
                   '{"actor":"agent","reason":"去掉口误","confidence":0.9,"source":"skill:口播精剪"}')
    返回与该操作直接调用一致的 JSON。"""
    api = main.Api()
    r = api.execute(cmd_id, json.loads(args or "{}"), json.loads(meta or "{}"))
    return json.dumps(r, ensure_ascii=False, indent=2)


@mcp.tool()
def audit_log(limit: int = 100, actor: str = None) -> str:
    """Step 5b：审计查询——最近的操作历史（谁做了什么）。actor 可选过滤（如 "agent"/"user"）。
    返回 [{cmd_id, label, meta}]，meta 含 actor/reason/confidence/source。"""
    api = main.Api()
    r = api.audit_log(limit=limit, actor=actor)
    return json.dumps(r, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 细粒度读取工具（让 agent "理解" 草稿，而非吞下全量 JSON 黑盒）
# 对应 8-12「跳切读取铁律」：绝不直接把整份草稿丢给 agent，必须按需抽小数据。
# ---------------------------------------------------------------------------

@mcp.tool()
def list_tracks() -> str:
    """轨道排布主视图：每种类型（video/audio/text/image/sticker/effect）下每条轨道的片段清单
    （位置 start_us、时长 dur_us、素材引用 material_id、字幕文本）。紧凑返回（约几 KB），
    替代全量 get_state，让 agent 一眼看懂"时间轴现在排了什么"。"""
    return json.dumps(sr.list_tracks(), ensure_ascii=False, indent=2)


@mcp.tool()
def get_track_text(track_index: int) -> str:
    """读取某条文本轨的全部字幕：[{idx, start_us, dur_us, text}]。
    字幕/花字/校字类 skill 直接吃这个，不用读全量草稿。track_index 为文本轨序号（0 起）。"""
    return json.dumps(sr.get_track_text(track_index), ensure_ascii=False, indent=2)


@mcp.tool()
def get_segment_detail(track_type: str, track_index: int, index: int) -> str:
    """单段聚焦详情：该片段的时间轴位置、源素材入出点(src_start/end)、关联素材元数据、
    以及挂在它身上的特效。对应"特效怎么放"的查询。
    track_type: video/audio/text；track_index: 该类型内轨道序号；index: 段序号。"""
    return json.dumps(sr.get_segment_detail(track_type, track_index, index), ensure_ascii=False, indent=2)


@mcp.tool()
def get_effects() -> str:
    """列出当前所有已放置的特效（紧凑）。agent 查"现在挂了哪些特效"用这个。"""
    return json.dumps(sr.get_effects(), ensure_ascii=False, indent=2)


@mcp.tool()
def get_material_peaks(path: str, max_points: int = 240) -> str:
    """素材级波形包络（整段），跳切/静音检测 skill 判断"哪里该剪"的输入。
    path 可为视频（取音轨）或音频文件。返回 {peaks:归一化RMS列表, has_audio:是否有音轨, points:点数}。
    无音频（如静音 B-roll）时 peaks=[] 且 has_audio=false，便于 agent 区分。"""
    return json.dumps(sr.get_material_peaks(path, max_points), ensure_ascii=False)


@mcp.tool()
def get_segment_peaks(track_type: str, track_index: int, index: int, max_points: int = 240) -> str:
    """片段级波形包络：抽出该段 src_start~src_start+duration 的音频做包络。
    对应 8-12 铁律的 get_segment_peaks(track_type,ti,idx)。
    返回 {peaks, has_audio, points}，语义同 get_material_peaks。
    track_type: video/audio/text；track_index: 轨道序号；index: 段序号。"""
    return json.dumps(sr.get_segment_peaks(track_type, track_index, index, max_points), ensure_ascii=False)


@mcp.resource("aivideo://draft_state")
def draft_state_resource() -> str:
    """当前共享草稿状态（素材库 + 时间轴 + meta.mcp 连接状态）。
    与 get_state tool 返回同一份数据，确保 AI 无论用 resource 还是 tool 读到的结构一致。"""
    api = main.Api()
    return json.dumps(api.get_state(), ensure_ascii=False, indent=2)


def _announce_mcp():
    """MCP server 被 agent（如 WorkBuddy）启动后，主动告知桌面窗口：我已连接 + 我是谁。

    agent 名字由启动环境变量 AGENT_NAME 注入；没注入时回退显示 "AI Agent"，
    这样以后换别的 agent/平台也能显示自己的名字，而不是写死 "WorkBuddy"。
    """
    agent_name = os.environ.get("AGENT_NAME", "AI Agent")
    state_payload = {
        "connected": True,
        "agent_name": agent_name,
        "connected_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "transport": "stdio",
    }
    main.save_mcp_state(state_payload)

    # 心跳线程：每 3 秒刷新一次 updated_at，让桌面知道 server 还活着。
    # 如果进程被强杀，心跳停止，桌面 10 秒后自动把状态判为断开（TTL）。
    def _heartbeat():
        while True:
            time.sleep(3)
            main.save_mcp_state(state_payload)

    threading.Thread(target=_heartbeat, daemon=True).start()

    # 进程优雅退出时标记断开（被强杀时不保证执行，但 TTL 会自动兜底变灰）
    atexit.register(lambda: main.save_mcp_state({
        "connected": False,
        "agent_name": agent_name,
        "connected_at": None,
        "transport": "stdio",
    }))


_announce_mcp()

if __name__ == "__main__":
    mcp.run()
