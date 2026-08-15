# docs/ 索引

本目录收项目架构与审计文档。**仓库根目录只放运行必需文件**（`main.py` / `mcp_server.py` / `start.bat` / `工作台v0.8时间轴.html` / `README.md` / `SCHEMA.md` / `.gitignore`）。所有设计、审计、决策文档一律放这里，避免和代码混在一起，也避免多份互相矛盾的设计文档污染上下文。

## architecture/（设计类：描述“怎么做”）
- `player-ownership.md`：Player 媒体控制权收口方案（facade-first 迁移，**当前生效方案**）。
- `roadmap.md`：架构收口路线 briefing（Phase0→Phase3，含验收基线与明确不做项）。
- `player-session-v2-design.md`：PlaySession 状态层设计（v2.2）。
- `player-session-stepB-continueStart.md`：Step B 冻结稿（v2.3，continueStart 契约 + 4 钉子）。
- `player-session-stepB5-activationGate.md`：Step B.5 Media Activation Gate 设计（v1.0）。
- `player-session-stepB5-mediaActivation-contract.md`：B.5 Media Activation Contract v1.1（逐元素持久激活契约，HANDOFF/RESUME 事务枚举，已落码）。
- `player-session-stepB5_4-lifecycleOwnership.md`：**B.5.4 Media Lifecycle Ownership 收口**（muted 单一写者 setMediaMute + 手势预热 primeMediaPlayback + resume 复用 PAUSED session + MEDIA_TARGET_STATE 日志化；已落码待真机验收）。
- `player-session-stepB5_5-heartbeatGate.md`：**B.5.5 Media Start Confirmation Gate（v1.2 路线调整）**——STAB 止血（startPlay 撤 await 屏障，commit `fd763ad`）+ B.5 收尾 + C.0 AudioEngine 迁移；三改均在播放路径内。
- `audio-engine-migration.md`：**C.0 AudioEngine 迁移概念稿（v0.1，待 C 启动）**——音频迁 Web Audio（BufferSourceNode 精确调度），视频暂保持 element follower；PlayerManager/时间轴/播放头不变。
- `implementation-manual-stepB-D.md`：实施手册（**自包含，给 GPT 参谋审阅**）——Step B 行号级改动清单 + B.5 草案（Media Activation Gate，待审）+ C/D 方向；含给 GPT 的待审问题汇总。
- `operation-schema-sketch.md`：Operation Schema v1 草图（**概念模型，不锁字段**，ADR-001 §9 要求）。

## audits/（审计 / 核查类：描述“现状是什么”）
- `opencut-analysis.md`：与 OpenCut 开源项目的架构对照诊断。
- `media-control-audit.md`：HTML 内所有直接碰 `video`/`audio` 的代码点核查（含行号）。
- `playback-state-analysis.md`：播放状态机只读审计（`isPlaying` + 标志位）。
- `opencut-vs-ours-playback.md`：**播放路径对比审计（2026-08-15）**——OpenCut 音频走 Web Audio 调度（BufferSourceNode 精确时间戳）、画面走 canvas 逐帧、播放头纯墙钟，完全不用 HTMLMediaElement 播放状态机；我们的所有播放问题根因=元素模式在 WebView2 不可靠。方向选项：音频迁 Web Audio 根治 / 视频保持元素模式兜底。

## decisions/（重大决策，以 `ADR-XXX` 命名）
- `ADR-001-ai-video-os-route.md`：**项目定位与路线决策**——从剪辑软件到 AI 可调用视频操作系统；播放器争论终结；两层 Schema（Operation↔Timeline）；护城河=Video DSL；路线冻结 B-D→Operation→Timeline→Command→MCP→Skill→Agent。

## handoff/（GPT 交接文档，一波次一份）
- `GPT音频问题交接文档.md`：v1.3 交接（已发 GPT 一轮，因额度紧未续）。
- `GPT播放问题v2交接文档.md`：**v2 全面交接**（v1.4.1 现状，截止 2026-08-15 17:10）——迭代时间线 + 每次根因 + 三个残留问题（split 第二段/从头重播/MP4 卡住）+ 源码锚点 + 给 GPT 的 5 个收敛问题 + 验收清单。**GPT 额度快没，最后一次评审就用这份**。

## 约定（强制）
1. 任何根目录新增诊断 / 方案 / 临时分析 → 一律进 `docs/` 对应子目录，**禁止在仓库根目录新建 markdown**。
2. 已废弃方案必须在该文档顶部标记 `> deprecated` 并注明替代方案；本仓库不保留历史废弃方案（旧方案在本地另行归档，不进 git）。
3. 代码与架构决策分离：动业务代码前，先更新这里对应的设计文档。
4. 不要因为一次 bug 就新建一个 markdown。
