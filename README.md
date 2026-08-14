# AI 剪辑工作台 (ai-video-studio)

本地桌面 AI 视频剪辑工作站。技术栈：**PyWebView + 原生 JS（不依赖 React/TS）+ Python 后端**。

当前阶段重心：**把播放器地基打稳**——多段（含空白 gap 的）时间轴连续播放时，播放头要平滑穿过空白、不卡、不跳、不双播、跨段时播放头位置与媒体时钟不脱节。

## 运行必需文件

| 文件 | 作用 |
|---|---|
| `main.py` | Python 后端：PyWebView 窗口 + 本地 HTTP 代理（注入 `window.MEDIA_BASE`）+ 草稿读写 |
| `start.bat` | Windows 启动脚本 |
| `工作台v0.8时间轴.html` | 前端单文件：时间轴 + 播放器 + 渲染，~3000 行原生 JS |
| `mcp_server.py` | 给 Agent 调用的 MCP 工具（增删 clip / 导出剪映草稿等） |
| `settings.json` | 本机配置（已被 `.gitignore`，运行时需自行创建，含导出路径等绝对路径） |

依赖：`pywebview` + `pyJianYingDraft`（本地 `.venv`，不进 git，需 `pip install`）。
运行：`start.bat`（必须先起，否则前端拿不到 `MEDIA_BASE`，媒体会被兜底成 `file://` 并被 WebView2 拒绝加载）。

## 当前播放 bug（重点给 Codex 看）

**症状**：多段（中间有空白 gap）时间轴连续播放时——① 播放头视觉跳过空白；② 第二段被提前播放（听到"播两次"观感）；③ 跨段时播放头位置与媒体时钟脱节。

**根因（已层层缩小到一处结构性缺陷）**：

1. 播放头位置被"正在播放的媒体"反推：`playTick` 每帧用 `_dominantMediaUs()` 把 video/audio 的 `currentTime` 反推成时间轴位置。
2. 跨段处理触发太早：`_handleCrossSegment()` 在 `us` 到达 **gap 入口（上一段末尾）** 就被 `playTick` 触发，立刻把下一段 `seek` 到 `src_start` 并 `playAllMedia()`。于是下一段音频在空白区就被提前播放。
3. dominant clock 把它映射回段起点：提前播放的下一段 `currentTime≈0` 被 `_dominantMediaUs` 映射成 `clip2.start`，播放头瞬间跳到下一段起点 → 空白被视觉跳过。

**已做的小范围修复（未触及架构）**：

- **Round D**：seek 屏障 `_waitSeekSettled`（用 `addEventListener` 一次性监听 `seeked`，避免抢占 `onseeked` 单归属属性；防 seek/play 竞态死锁）。
- **Round D.1**：删除 `playTick` 连续播放期的 gap 瞬移（`playStartUs/playStartWall/us` 三连重置）。
- **Round D.2 / D.2b**：`_dominantMediaUs` 源范围 validity guard——媒体 `currentTime` 跑出 `rec.seg` 源范围时返回 `null`（治"卡死"，但没治"提前播/跳过"）。
- **Round D.4**：`_waitSeekSettled` 加 700ms 超时兜底，防后端未连时永久死锁。

**核心未解（需要重构的方向，用户已立架构红线）**：

> **媒体元素只能执行播放，不能决定时间轴位置。**
> 当前 `_dominantMediaUs` 仍"谁在播谁是老大"。应引入 ClockManager：先选权威轨（用户操作轨 / 主视频轨 / 音频轨 / wall fallback），只信任其 `seg` 时间轴区间**包含当前 `us`** 的媒体。这也解决多轨场景（如 bgm 0-60 跨空白时不能篡夺视频轨时钟权）。

## 关键代码位置（`工作台v0.8时间轴.html`）

- `playTick()`：每帧时钟仲裁 + 跨段检测 + 收尾（约 L1670-1740）
- `_dominantMediaUs()`：媒体时钟→时间轴映射（约 L1552-1585）
- `_handleCrossSegment(us)`：跨段 seek+play（约 L1647-1666）
- `startPlay()`：起播 + seek 屏障 `await`（约 L1416-1440）
- `seekActiveMediaToPlayhead()`：把播放头位置 seek 到命中媒体（约 L1618-1640）
- `_waitSeekSettled(el)`：seek 完成屏障（约 L1189-1210）

> ⚠️ **调试探针提醒**：当前 `工作台v0.8时间轴.html` 内含诊断代码——`console.log` 标记的 `TICK` / `PLAY` / `SEEK` / `CROSS` / `STARTPLAY`，以及页面右上角「PROBE LOG」面板。这些是定位播放 bug 用的，**不是业务逻辑**，可忽略或删除。

## 数据模型

clip 段字段：`start` / `duration` / `src_start` / `src_end`（**均微秒**），`material_id`。草稿共享状态落盘 `draft_state.json`（运行时生成，不进 git）。详见 `SCHEMA.md`。

## 提交约定

仓库根目录只放**运行必需文件**（`main.py` / `mcp_server.py` / `start.bat` / `工作台v0.8时间轴.html` / `README.md` / `SCHEMA.md` / `.gitignore`）。所有架构设计、审计、决策文档统一放 `docs/`（`architecture/` 设计、`audits/` 核查、`decisions/` 重大决策），**禁止在根目录新建诊断 / 方案 markdown**。

所有 `*_backup.html` / `Step1_*` 历史原型 / `_*.py` 调试脚本 / `reference/`（OpenCut 第三方源码）/ `.venv` / 运行时生成物 等均由 `.gitignore` 排除。
