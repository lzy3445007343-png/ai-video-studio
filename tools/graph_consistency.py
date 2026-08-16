#!/usr/bin/env python3
"""tools/graph_consistency.py —— Playback Graph 对拍脚本（保险丝）

方案 §2 / §9.2：同一 draft 分别跑两端实现，平铺结果必须逐字段一致。
  - JS 端：playback-graph.js buildPlaybackGraph()（node 执行）
  - Python 端：main.py _playback_graph()
不一致 = 必然有「预览≠导出」的缝，当场暴露。

用法：
  python tools/graph_consistency.py [draft_state.json]
  （默认取项目根 draft_state.json）

退出码：0 = 两端一致；1 = 有不一致；2 = 执行出错。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_STATE = os.path.join(ROOT, "draft_state.json")

# 对拍时忽略的字段（两端实现细节差异，非语义差异）
IGNORE_FIELDS = {"version"}


def load_state(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_js(state, state_path):
    """用 node 跑 playback-graph.js 的 buildPlaybackGraph。"""
    runner = os.path.join(HERE, "_graph_js_runner.js")
    # 通过 stdin 把 draft/materials 喂给 node，避免命令行长度限制
    proc = subprocess.run(
        ["node", runner],
        input=json.dumps({"draft": state.get("draft", {}), "materials": state.get("materials", [])}),
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError("node 执行失败：\n" + proc.stderr)
    return json.loads(proc.stdout)


def run_py(state):
    """调用 main.py 的 _playback_graph。"""
    sys.path.insert(0, ROOT)
    from main import _playback_graph  # noqa: E402  (模块级会启动本地 HTTP server，daemon 线程，脚本退出即消失)
    return _playback_graph(state.get("draft", {}), state.get("materials", []))


def diff(a, b, path=""):
    """递归比较两个平铺结果，返回差异列表。数值按容差 1e-6 比较。"""
    errors = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in IGNORE_FIELDS:
                continue
            if k not in a:
                errors.append(f"{path}.{k}：JS 缺字段")
            elif k not in b:
                errors.append(f"{path}.{k}：Python 缺字段")
            else:
                errors.extend(diff(a[k], b[k], f"{path}.{k}"))
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            errors.append(f"{path}：长度不一致 JS={len(a)} Python={len(b)}")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                errors.extend(diff(x, y, f"{path}[{i}]"))
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(float(a) - float(b)) > 1e-6:
            errors.append(f"{path}：值不一致 JS={a} Python={b}")
    else:
        if a != b:
            errors.append(f"{path}：值不一致 JS={a!r} Python={b!r}")
    return errors


def main():
    state_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_STATE
    if not os.path.isfile(state_path):
        print(f"[FAIL] 找不到状态文件：{state_path}", file=sys.stderr)
        return 2
    state = load_state(state_path)

    try:
        js = run_js(state, state_path)
        py = run_py(state)
    except Exception as e:
        print(f"[ERROR] 对拍执行失败：{e}", file=sys.stderr)
        return 2

    errors = diff(js, py)
    if errors:
        print(f"[FAIL] Playback Graph 两端不一致，共 {len(errors)} 处：")
        for e in errors[:50]:
            print("  " + e)
        if len(errors) > 50:
            print(f"  ... 还有 {len(errors) - 50} 处（已截断）")
        return 1

    js_audio = len(js.get("audioClips", []))
    js_video = len(js.get("videoNodes", []))
    py_audio = len(py.get("audioClips", []))
    py_video = len(py.get("videoNodes", []))
    print(f"[OK] Playback Graph 两端一致：audioClips={js_audio}/{py_audio} videoNodes={js_video}/{py_video}")
    print(f"     状态源：{os.path.basename(state_path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
