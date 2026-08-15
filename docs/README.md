# docs/ 索引

本目录收项目架构与审计文档。**仓库根目录只放运行必需文件**（`main.py` / `mcp_server.py` / `start.bat` / `工作台v0.8时间轴.html` / `README.md` / `SCHEMA.md` / `.gitignore`）。所有设计、审计、决策文档一律放这里，避免和代码混在一起，也避免多份互相矛盾的设计文档污染上下文。

## architecture/（设计类：描述“怎么做”）
- `player-ownership.md`：Player 媒体控制权收口方案（facade-first 迁移，**当前生效方案**）。
- `roadmap.md`：架构收口路线 briefing（Phase0→Phase3，含验收基线与明确不做项）。
- `player-session-v2-design.md`：PlaySession 状态层设计（v2.2）。
- `player-session-stepB-continueStart.md`：Step B 冻结稿（v2.3，continueStart 契约 + 4 钉子）。
- `implementation-manual-stepB-D.md`：实施手册（**自包含，给 GPT 参谋审阅**）——Step B 行号级改动清单 + B.5 草案（Media Activation Gate，待审）+ C/D 方向；含给 GPT 的待审问题汇总。
- `operation-schema-sketch.md`：Operation Schema v1 草图（**概念模型，不锁字段**，ADR-001 §9 要求）。

## audits/（审计 / 核查类：描述“现状是什么”）
- `opencut-analysis.md`：与 OpenCut 开源项目的架构对照诊断。
- `media-control-audit.md`：HTML 内所有直接碰 `video`/`audio` 的代码点核查（含行号）。
- `playback-state-analysis.md`：播放状态机只读审计（`isPlaying` + 标志位）。

## decisions/（重大决策，以 `ADR-XXX` 命名）
- `ADR-001-ai-video-os-route.md`：**项目定位与路线决策**——从剪辑软件到 AI 可调用视频操作系统；播放器争论终结；两层 Schema（Operation↔Timeline）；护城河=Video DSL；路线冻结 B-D→Operation→Timeline→Command→MCP→Skill→Agent。

## 约定（强制）
1. 任何根目录新增诊断 / 方案 / 临时分析 → 一律进 `docs/` 对应子目录，**禁止在仓库根目录新建 markdown**。
2. 已废弃方案必须在该文档顶部标记 `> deprecated` 并注明替代方案；本仓库不保留历史废弃方案（旧方案在本地另行归档，不进 git）。
3. 代码与架构决策分离：动业务代码前，先更新这里对应的设计文档。
4. 不要因为一次 bug 就新建一个 markdown。
