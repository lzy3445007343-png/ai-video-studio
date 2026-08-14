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

## 已知问题 / 当前重点

当前正在把**播放器地基**打稳：多段（含空白 gap）的时间轴连续播放时，偶发"跳过空白""跨段后没声""暂停再播没声"等现象。

这些问题不是某个函数写错，而是"媒体生命周期归属"没定清楚导致的结构性问题。修复方向是：**播放头永远由时间轴驱动，媒体只被动跟随**——禁止任何媒体时钟反向决定播放头位置。

想深入技术细节或看重构路线，请参阅：

- `docs/architecture/player-ownership.md` —— 媒体控制权收口方案
- `docs/audits/playback-state-analysis.md` —— 播放状态机诊断

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
