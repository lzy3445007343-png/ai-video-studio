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
- `player-kernel-architecture.md`：**播放器内核架构（2026-08-16 根治收官·冻结基线）**——MasterClock 职责、媒体数据通道（HTTP Range 为什么必须）、MediaSlot A/B 双槽、AudioEngine 实时锚定、生命周期纪律、未来元素（关键帧/蒙版/特效/文本）扩展点。**播放器任何改动先读这份 + 跑 V1-V6 回归**。
- `fablecut-comparison.md`：**FableCut 架构对照（2026-08-16，B 步）**——开源"AI 经 MCP 操作 JSON 时间轴"项目源码对照：patch 批量 op + conflict-safe（P0 借鉴）、props/keyframes 统一动画模型（P0，关键帧/特效地基）、textAnim/chromaKey/adjustment layer（P1 差异化）、渲染路线差异与特效一致性风险（§3.1）。
- `effect-track-design.md`：**特效轨设计稿（路线 B #290，待 sign-off）**——独立轨模型（不学 FableCut 属性式）+ CSS filter 原语（亮度/对比/饱和/模糊/灰度/色差/反相/不透明度）+ 5 步接入铁律（Schema/buildPlaybackGraph/renderer/导出/MCP）+ 预览=导出同源 + 顺带补 A1 一致性（text/sticker 平铺 effectNodes/textNodes/stickerNodes）。
- `timeline-drag-unified-design.md`：**时间轴拖拽与轨道管理统一设计稿（2026-08-18）**——对比 OpenCut 落点/新建轨/预览/空轨折叠行为，提出 displayIndex + direction 统一模型，覆盖用户反馈的 7 项拖拽问题（覆盖轨预览方向、特效拖不进/新建方向/空轨不删、音频向上拖、媒体落位乱）。待 sign-off 后落码。

## audits/（审计 / 核查类：描述“现状是什么”）
- `opencut-analysis.md`：与 OpenCut 开源项目的架构对照诊断。
- `media-control-audit.md`：HTML 内所有直接碰 `video`/`audio` 的代码点核查（含行号）。
- `playback-state-analysis.md`：播放状态机只读审计（`isPlaying` + 标志位）。
- `opencut-vs-ours-playback.md`：**播放路径对比审计（2026-08-15）**——OpenCut 音频走 Web Audio 调度（BufferSourceNode 精确时间戳）、画面走 canvas 逐帧、播放头纯墙钟，完全不用 HTMLMediaElement 播放状态机；我们的所有播放问题根因=元素模式在 WebView2 不可靠。方向选项：音频迁 Web Audio 根治 / 视频保持元素模式兜底。
- `opencut-vs-ours-architecture.md`：**全面架构对比审计（2026-08-15，19:55）**——OpenCut 分层（12 Manager 单向依赖）+ 一切修改走 Command（execute/undo/redo/ripple）+ Asset/Element 分离 + 播放与数据解耦；我们单文件 3988 行平铺 + 快照式 undo + 元素模式播放。**答案"为什么我们一直修 bug"：缺的是分层纪律本身，不是单个功能**。止损建议：冻结播放器 → Command 层 → Asset 分离。

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
