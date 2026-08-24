# -*- coding: utf-8 -*-
"""
M7-7a Intent v0 —— 意图校验 + 规则计划（AI 从「命令直连」升级为「意图提交」）。

设计（对齐 09 方案 M7 7a / 08 施工图 §2.2.4）：
- submit_intents(intents) 接受**结构化意图列表**（不接受自由文本）：
      [{"type": "create-project", "args": {...}},
       {"type": "apply-preset",   "args": {"preset_id": "koubo", ...}},
       {"type": "import-media",   "args": {"paths": [...]}},
       {"type": "add-subtitles",  "args": {"cues": [...], "style": {...}}}]
- 流程：validate（schema + 资源可达性）→ plan（规则 Planner 映射为命令计划 CommandPlan）→
  由 Api.submit_intents begin/commit_transaction 包批执行（undo 一次整批回滚）。
- plan 记录进 audit_log 的 meta（M2 产物）：AI 可复盘「这次到底执行了什么」。
- execute 保留为「专家模式」，submit_intents 与 execute 双轨并存，Intent 层可整体关闭。

纯函数模块：validate/plan 不读写草稿、不依赖 main.py（执行/事务由 Api.submit_intents 集成）。
"""

import os

# 首批 IntentType（09 方案）
INTENT_TYPES = {"create-project", "apply-preset", "import-media", "add-subtitles"}


def validate_intents(intents, presets=None):
    """schema + 资源可达性校验。返回 (errors, cleaned)。

    errors 非空 → 调用方不得执行（不静默修复，对齐 6a 三态语义）。
    cleaned 为合法意图列表（未知多余字段丢弃，args 缺省补 {}）。
    """
    errors = []
    if not isinstance(intents, list) or not intents:
        return ["intents 必须是非空数组"], []
    cleaned = []
    for i, intent in enumerate(intents):
        if not isinstance(intent, dict):
            errors.append("意图[%d] 必须是对象" % i)
            continue
        itype = intent.get("type")
        if itype not in INTENT_TYPES:
            errors.append("意图[%d] 未知类型 %r（合法：%s）" % (i, itype, ", ".join(sorted(INTENT_TYPES))))
            continue
        args = intent.get("args") or {}
        if not isinstance(args, dict):
            errors.append("意图[%d] %s 的 args 必须是对象" % (i, itype))
            continue
        if itype == "create-project":
            name = args.get("name")
            if name is not None and not isinstance(name, str):
                errors.append("create-project: name 必须是字符串")
        elif itype == "apply-preset":
            pid = args.get("preset_id")
            if not pid or not isinstance(pid, str):
                errors.append("apply-preset: 缺少 preset_id")
            elif presets is not None and pid not in presets:
                errors.append("apply-preset: 未知模板 %r（可用：%s）" % (pid, ", ".join(sorted(presets)) or "无"))
        elif itype == "import-media":
            paths = args.get("paths")
            if not isinstance(paths, list) or not paths:
                errors.append("import-media: paths 必须是非空数组")
            else:
                for p in paths:
                    if not isinstance(p, str) or not os.path.isfile(p):
                        errors.append("import-media: 文件不存在 %r" % p)
        elif itype == "add-subtitles":
            cues = args.get("cues")
            if not isinstance(cues, list) or not cues:
                errors.append("add-subtitles: cues 必须是非空数组（[{text,start,duration}]，秒）")
            elif not any(isinstance(c, dict) and c.get("text") for c in cues):
                errors.append("add-subtitles: cues 里没有有效字幕文本")
        cleaned.append({"type": itype, "args": args})
    return errors, cleaned


def plan_intents(intents):
    """规则 Planner：意图列表 → CommandPlan（[{type, cmd, args, desc}]）。

    cmd 为 Api 方法名（经 execute 执行）；apply-preset 内部会展开模板 steps 并复用外层事务。
    """
    plan = []
    for intent in intents:
        itype = intent["type"]
        args = intent.get("args") or {}
        if itype == "create-project":
            plan.append({"type": itype, "cmd": "create_project",
                         "args": {"name": args.get("name")}, "desc": "新建空工程"})
        elif itype == "apply-preset":
            plan.append({"type": itype, "cmd": "apply_preset",
                         "args": {"preset_id": args.get("preset_id"), "args": {k: v for k, v in args.items() if k != "preset_id"}},
                         "desc": "套用模板 %s" % args.get("preset_id")})
        elif itype == "import-media":
            plan.append({"type": itype, "cmd": "import_media_by_paths",
                         "args": {"paths": args.get("paths")}, "desc": "导入 %d 个素材" % len(args.get("paths") or [])})
        elif itype == "add-subtitles":
            plan.append({"type": itype, "cmd": "add_subtitles",
                         "args": {"track_index": args.get("track_index", 0),
                                  "cues": args.get("cues"),
                                  "style": args.get("style")},
                         "desc": "插入 %d 条字幕" % len(args.get("cues") or [])})
    return plan
