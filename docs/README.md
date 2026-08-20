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
- `timeline-drag-vs-opencut-audit.md`：**拖拽交互审计（2026-08-18，75e638e 回归诊断）**——OpenCut/FableCut/我们三端 dragover 渲染方式逐项对比；铁证三个真机问题根因（卡顿=75e638e 在 dragover 引入 `Store._emit()` 全量重建；无高亮=高亮依赖重建存活；特效不能落轨=绑段拦截+高亮缺失）；修复方案= dragover 零整树重建（切 CSS 类 + overlay 预览轨）。待 sign-off。
- `OpenCut对齐对照-2026-08-19.md`：**时间轴操作 OpenCut vs 我们 逐项对照表（26 项）**——21 项已对齐，差异 5 处（D1-D5）；后端数据流已对齐。用户确认按此执行（2026-08-19 01:18）。
- `timeline-D1-D5实施计划-2026-08-19.md`：**D1-D5 实施手册（已确认，待明早执行）**——D1 主场景可入（删 main 禁止分支）/ D2 已有段拖动重叠检测（trackBusyAt 加排除参数）/ D3 删预览轨弹动（previewTrack+ghostTrack）/ D4 落点线=目标轨顶（getDropLineY）/ D5 没动不提交（didMove）。全在前端计算层，后端不动。
- `timeline-A轨道tid实施计划-2026-08-19.md`：**A 方案轨道 tid 全链路手册（D1-D5 后执行）**——A1 数据模型 tid+迁移 / A2 后端 _track_by_tid+命令签名升级 / A3 前端 key 改 tid:segid / A4 播放器导出适配 / A5 回归。段 id 已做（b9a9206），轨道 tid 未做。凌晨不做大重构。
- `property-framework-v1-ADR-2026-08-19.md`：**参数面板 UI 内核设计稿（ADR，待用户 sign-off）**——Property Framework v1：Field 组件体系（NumberField/SliderField/ToggleField/SelectField）+ DraftStore 两阶段 + 容器级事件代理 + 面板生命周期（key→rebuild/update）+ 命名空间化（根治 .seg 类名污染）+ 字幕/贴纸常驻入口（根治白名单死锁）。Phase 0 根因D 修复 → Phase 1 基础设施 → Phase 2 逐面板迁移（audio→speed→mask→effect→kf→sub/sticker）→ Phase 3 订阅切片（渐进，不破坏播放链路）→ Phase 4 收尾。依据：2026-08-19 全天复盘 + ChatGPT 独立评估 + OpenCut classic 真源码对照。
- `phase5-subscription-slice-ADR-2026-08-20.md`：**Phase 5 订阅切片方案（待用户+GPT 审）**——Store 加 subscribePath 切片订阅（向后兼容，兼容期 _emit 兜底）；渲染函数按切片分组（playheadUs/drag/selectedKey/pxPerSec/materials/effects/bookmarks/filter）；迁移分 5 步（5.1 API → 5.2 播放头 → 5.3 选中 → 5.4 拖拽 → 5.5 拆广播），每步独立 commit + jsdom + 真机；护栏=播放内核不动/审计渲染依赖/幂等兜底。前置：kf 实际功能链路先修好（否则验收被污染）。预估 4.5-6.5h。
- `C1-property-kernel-方案-2026-08-20.md`：**C1 Property Kernel 方案（v2，已落码 3/3）**——唯一属性访问协议：PROPERTY_REGISTRY（协议层）+ params（承载层）+ LEGACY_MIRROR（单向 params→旧字段）+ resolveProperty/resolveAnimatedProperty。C1.1 kernel 基础（480265c）/ C1.2 读取迁移（a9adf35）/ C1.3 写入迁移（8311781）。C1.4 KF 读取合一延后 C2。
- `C2-interaction-kernel-方案-2026-08-20.md`：**C2 Interaction Kernel 方案（v2，已落码 7351da9）**——GestureSession 状态机（pending→active→ended）+ InteractionManager（唯一入口防并发 + Refresh Lock 上移）+ OverlayState（通用 path overlay，与 C1 kernel path 打通）+ DragSession 迁移（行为等价，弹回修复 6b06e2b 不回归）。缩放/旋转/框选未来复用同一框架。
- `C3-command-transaction-方案-2026-08-20.md`：**C3 Command Transaction 方案（v2，已落码 904945b + 6c53b7c）**——后端 CommandManager 事务（begin/commit/abort + 30s 超时 + changed_paths + undo 先 abort）+ 前端 CommandService（run→execute 统一入口 + withTx）+ DragSession 事务化。面板写调用迁移（C3.3）Strangler 后续做。
- `C4-subscription-slice-方案-2026-08-20.md`：**C4 Subscription Slice 方案（待评审）**——原 5.3/5.4/5.5 合并（C1-C3 后新现状：预览拖动已不走 Store，切片对象=选中态/时间轴拖拽/低频字段）。C4.1 选中态切片 → C4.2 拖拽临时态切片 → C4.3 低频切片 → C4.4 slice mode 对照（renderAll 保留不删）。
- `画布交互-方案-2026-08-20.md`：**画布交互方案（组1 Zoom/Pan + 组2 缩放手柄/旋转手柄，待评审）**——对齐 OpenCut preview-viewport 模型（geometry/center/scale + screenToCanvas/positionToOverlay 统一换算 + Ctrl+滚轮缩放/滚轮中键平移 + 右下角缩放 UI + ResizeSession/RotateSession 复用 GestureSession）。素材属性保持画布逻辑坐标（viewport 纯显示层，PropertyKernel 不受影响）。
- `kf-complete-plan-2026-08-20.md`：**关键帧完整蓝图（待用户+GPT 评审）**——已做（数据模型 KF_PROPS 7 通道/后端 5 命令/前端 toggleKf·kfVal·renderKfGraph/时间轴菱形 e8e030f+9b28bb6）+ 待做清单（B1 参数实时打点→B2 播放头联动→B3 菱形拖拽→B4 曲线增强→B5 导出验证→B6 音量关键帧→B7 复制粘贴→B8 Bezier）+ B1 具体方案（input 通道开→add_keyframe 实时打点/未开→setProperty 静态）+ 6 个评审问题。

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
