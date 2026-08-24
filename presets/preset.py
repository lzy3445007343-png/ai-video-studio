# -*- coding: utf-8 -*-
"""
M6-6c Preset v0 —— 模板库（排版模板 = 可复用的动作序列）。

设计（对齐 09 方案 M6 6c + 用户补充的「模板库要看得见、能换」）：
- 单一真源：presets/*.json，一个模板一个文件（对齐 effects.json 模式，可增删换）。
- PresetDefinition：
    {
      "id": "koubo", "label": "口播精剪", "kind": "layout",
      "categories": ["vlog"], "desc": "一句话说明",
      "defaults": {"变量默认值": ...},          # 模板变量默认值
      "steps": [                                  # 展开的命令序列（apply 顺序执行，包一个事务）
        {"cmd": "set_canvas", "args": {"ratio": "16:9"}},
        {"cmd": "add_text_track", "args": {}, "ensure_track": "text"},   # 该类型轨已存在则跳过
        {"cmd": "add_subtitles", "args": {"cues": "{{cues}}", ...}}      # {{var}} 由 apply args 填充；缺变量自动跳过该步
      ]
    }
- plan_preset(preset, args) → 展开为命令计划（模板填充 + ensure_track 标记保留）。
- 执行（main.py Api.apply_preset）：begin_transaction → 逐 step 经 execute 执行（事务内只累计）→
  commit_transaction（undo 一次=回 begin 前，整批回滚）。
- 与 Skill 的关系（用户 8/24 澄清）：Preset 是软件内「动作库」，Skill 是 WorkBuddy 外部「教练」；
  将来 Skill 调 preset.apply 执行排版，名字可重但职责不同层。

纯函数模块：不读写草稿、不依赖 main.py（事务/落盘由 Api.apply_preset 集成）。
"""

import json
import os
import re

PRESETS_DIR = os.path.dirname(os.path.abspath(__file__))


def load_presets():
    """从 presets/*.json 加载全部模板（单一真源）。文件缺失/损坏跳过。"""
    out = {}
    if not os.path.isdir(PRESETS_DIR):
        return out
    for fn in sorted(os.listdir(PRESETS_DIR)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(PRESETS_DIR, fn), encoding="utf-8") as f:
                p = json.load(f)
            if isinstance(p, dict) and p.get("id") and isinstance(p.get("steps"), list):
                out[p["id"]] = p
        except Exception:
            continue
    return out


def get_presets():
    """返回模板目录（前端弹窗填充用）：[{id, label, desc, categories, kind}]。"""
    out = []
    for p in load_presets().values():
        out.append({
            "id": p.get("id"),
            "label": p.get("label") or p.get("id"),
            "desc": p.get("desc") or "",
            "categories": p.get("categories") or [],
            "kind": p.get("kind") or "layout",
        })
    return out


def _fill_template(value, variables):
    """递归把 {{var}} 占位符替换为 variables 里的值。

    整串 = 单个 {{var}} 且变量是 dict/list/数字 → 原样嵌入对象（cues 是 list 不能 str() 化）；
    混排文本（如 "a{{x}}b"）→ 字符串化替换；变量缺失 → 保留 {{var}}（供 apply 跳过检测）。
    """
    if isinstance(value, str):
        m = re.fullmatch(r"\{\{(\w+)\}\}", value)
        if m:
            # 整串单占位符：变量是 dict/list/数字/字符串都原样嵌入；缺失保留 {{var}} 供跳过检测
            return variables.get(m.group(1), value)
        return re.sub(r"\{\{(\w+)\}\}",
                      lambda mm: str(variables.get(mm.group(1), "{{%s}}" % mm.group(1))), value)
    if isinstance(value, list):
        return [_fill_template(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: _fill_template(v, variables) for k, v in value.items()}
    return value


def plan_preset(preset, args=None):
    """展开 preset 为命令计划（{{var}} 填充）：返回 [{cmd, args, ensure_track?}]。

    变量缺失（填充后仍含 {{var}}）由调用方跳过该步（apply_preset 里按 json 残留检测）。
    """
    variables = dict(preset.get("defaults") or {})
    if isinstance(args, dict):
        variables.update(args)
    steps = []
    for s in preset.get("steps") or []:
        if not isinstance(s, dict) or not s.get("cmd"):
            continue
        step = {"cmd": s["cmd"], "args": _fill_template(s.get("args") or {}, variables)}
        if s.get("ensure_track"):
            step["ensure_track"] = s["ensure_track"]
        steps.append(step)
    return steps
