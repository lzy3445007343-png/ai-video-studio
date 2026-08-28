# AI 剪辑工作台 (ai-video-studio)

本地桌面 AI 视频剪辑工作站。技术栈：**PyWebView + 原生 JS（不依赖 React/TS）+ Python 后端**。

当前阶段重心：**R3 编辑器体验层收尾**——参考 OpenCut 补齐时间轴 / 播放器 / 参数面板的 UI/UX 细节，同时保持数据模型与后端契约不变。

## 仓库目录约定

根目录只放**运行必需文件**，其他内容按用途分档到 `docs/` 子目录。

### 根目录白名单

| 文件 | 作用 |
|---|---|
| `main.py` | Python 后端：PyWebView 窗口 + 本地 HTTP 代理（注入 `window.MEDIA_BASE`）+ 草稿读写 |
| `mcp_server.py` | 给 Agent 调用的 MCP 工具（增删 clip / 导出剪映草稿等） |
| `start.bat` | Windows 启动脚本 |
| `工作台v0.8时间轴.html` | 前端单文件：时间轴 + 播放器 + 渲染，原生 JS |
| `README.md` | 项目介绍与仓库约定（本文件） |
| `SCHEMA.md` | 数据契约与字段说明 |
| `.gitignore` | 排除规则 |
| `docs/` | 架构设计 / 审计核查 / 重大决策 / 接口契约 |

### `docs/` 子目录

| 目录 | 用途 |
|---|---|
| `docs/architecture/` | 架构设计与方案文档（OpenCut 对照、timeline/画布/property 方案、架构圣经/差距对照等） |
| `docs/audits/` | 核查、审计、验收与 Bug 清单（R3 验收报告、数据流审计、真机验收清单、改动说明等） |
| `docs/decisions/` | 重大决策记录（ADR、重构实施计划等） |
| `docs/contracts/` | 接口契约文档（MCP tools、数据模型约定等） |

**禁止在仓库根目录新建诊断 / 方案 markdown**。新建设计、核查、决策类文档时，先确认应归入 `docs/architecture/`、`docs/audits/`、`docs/decisions/` 还是 `docs/contracts/`，再落盘。

## 运行方式

依赖：`pywebview` + `pyJianYingDraft`（本地 `.venv`，不进 git，需 `pip install`）。

直接双击 `start.bat` 启动。必须先起 `start.bat`，否则前端拿不到 `window.MEDIA_BASE`，媒体会被兜底成 `file://` 并被 WebView2 拒绝加载。

> `settings.json` 为本机配置（导出路径等绝对路径），已被 `.gitignore` 排除，首次运行时自行创建。

## 数据模型

clip 段字段：`start` / `duration` / `src_start` / `src_end`（**均微秒**），`material_id`。草稿共享状态落盘 `draft_state.json`（运行时生成，不进 git）。详见 `SCHEMA.md`。

## 关键代码位置（`工作台v0.8时间轴.html`）

- `playTick()`：每帧时钟仲裁 + 跨段检测 + 收尾
- `_dominantMediaUs()`：媒体时钟→时间轴映射
- `_handleCrossSegment(us)`：跨段 seek+play
- `startPlay()`：起播 + seek 屏障 `await`
- `seekActiveMediaToPlayhead()`：把播放头位置 seek 到命中媒体
- `_waitSeekSettled(el)`：seek 完成屏障

> ⚠️ 当前 `工作台v0.8时间轴.html` 内含部分诊断代码（`console.log` 标记、`PROBE LOG` 面板），仅用于定位播放 bug，**不是业务逻辑**，可忽略或删除。

## 提交约定与排除项

- 仓库根目录只放运行必需文件（见上表）。
- 所有 `*_backup.html`、`Step1_*` 历史原型文件、`_*.py` 调试脚本均不进入 git。
- `reference/`（OpenCut 等第三方源码对照）、`.venv/`、`node_modules/`、`legacy/`、`logs/`、`exports/` 等本地研究或运行时目录均不进入 git。
- 运行时生成物：`draft_state.json`、`audit_log.jsonl`、`undo_stack.json.gz`、临时图片等不进入 git。

以上排除规则统一维护在 `.gitignore` 中。
