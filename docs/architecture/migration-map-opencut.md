# OpenCut ↔ 我们 · 结构迁移地图（给执行的施工依据）

> 状态：**v0.9-freeze 已打 tag（可回退锚点），本文是下一步的施工依据**。
> 日期：2026-08-15
> 依据：`docs/audits/opencut-vs-ours-architecture.md`（全面对比）+ GPT 拍板顺序（冻结→验收基线→播放器收口→Asset 分离→Command 最后）+ 用户授权全权执行。
> 纪律：**不允许推倒重做。基于 v0.9 功能做架构收口，先冻结+验收基线，再逐步替换危险耦合点。**

---

## 1. 模块映射表（OpenCut ↔ 我们）

| OpenCut 模块 | 我们对应（函数/文件） | 差距 | 迁移成本 |
|--------------|----------------------|------|---------|
| **EditorCore**（聚合根，组装 12 Manager） | 无独立对象；PlayerManager 部分承担 | 缺聚合根，依赖关系靠"记得" | 中 |
| **CommandManager**（一切修改唯一入口） | `Api._push_undo()`（快照式 deepcopy）+ 各写操作直接改 draft | 缺 Command 对象层（execute/undo/redo） | **高（后置）** |
| **TimelineManager** | main.py 的 Api 写操作（split/trim/move）+ `draft` 结构 | 数据模型 OK，缺操作封装层 | 中 |
| **MediaManager**（Asset 独立持久化+缓存） | `materials` 列表（main.py）+ segment 直接带 `path` | **缺 Asset 独立管理；segment 与素材耦合** | 中（先做） |
| **PlaybackManager**（纯墙钟，不碰媒体） | `playTick`（墙钟✅）+ `PlayerManager.play/pause/seek` | 墙钟思路对，但媒体 seek 散落各调用点 | 低-中（先做） |
| **AudioManager**（Web Audio 调度） | 无；用 `<audio>` 元素 | 缺 Web Audio 层（跨段问题的最终解） | **高（后置）** |
| **RendererManager**（canvas/导出） | `renderPreview` + `<video>` 元素 + pyJianYingDraft 导出 | 预览 canvas 后置，导出已 OK | 高（后置） |
| **ScenesManager** | `draft.video/audio/text/...` 列表 | 缺 scene 概念（单场景够用） | 低（可不做） |
| **SelectionManager** | 前端 `selectedKey` 等散落状态 | 缺统一选择管理 | 低 |
| **ClipboardManager** | 前端 Ctrl+C/V 实现 | 缺独立层（不痛，后置） | 低 |
| **SaveManager** | `draft_state.json` 读写 | 缺项目级组织（单文件够 V1） | 低（可后置） |
| **DiagnosticsManager** | 我们这两天的 `[MUTE]/[seek]/[playBEFORE]` 日志 | 有雏形，可独立成层 | 低 |

---

## 2. 我们已有资产（不用重做，别丢）

- ✅ **数据模型方向对**：segment 有 `start/duration/src_start/src_end/material_id`（SCHEMA.md §2 实锤）
- ✅ **墙钟 master**（playTick 时间轴唯一 master）
- ✅ **多轨/波纹/吸附/分组/变速/关键帧/蒙版/贴纸/书签**（B 系列已完成）
- ✅ **MCP 工具层**（mcp_server.py，Agent 入口）
- ✅ **pyJianYingDraft 导出**（剪映草稿）
- ✅ **muted 单一写者 setMediaMute**、**src 单一写者 setMediaSrc**（B.5.4 收口成果）

---

## 3. 执行顺序（GPT 拍板 + 我按风险排序）

### Step 0：✅ 已做
- `v0.9-freeze` tag + push（可回退锚点）

### Step 1：拆 JS（收益最高，先做）
**目标**：把 3988 行单 HTML 拆成 5 个同 runtime 的 JS，不引入 React/打包器：
```
store.js      —— draft 状态 + 订阅（纯数据，无 DOM）
timeline.js   —— 时间轴渲染/交互（轨道/片段/播放头/吸附）
player.js     —— 播放器收口（PlayerManager + playTick + seek/drift，独立文件）
media.js      —— 素材/元素管理（materials + <audio>/<video> 元素池）
renderer.js   —— 预览合成（renderPreview + 图层）
```
**方法**：HTML 里 `<script src="store.js">...<script src="player.js">` 顺序加载（同一 window 共享全局），每拆一个文件 → `node --check` → 重开 start.bat 验证 → commit。**拆的过程不改任何逻辑**（纯搬移），风险低、可回退。

### Step 2：播放状态隔离（Playback Contract）
把播放状态与编辑状态分开：
```
编辑状态：selectedKey / draft / 时间轴数据
播放状态：isPlaying / mediaClockReady / currentSession（PlaySession）
```
现在混在一起（改播放影响时间轴渲染）。抽 `player.js` 时同步隔离。

### Step 3：Asset 分离
- `materials` 独立管理（路径/时长/缩略图/缓存），segment 只存 `material_id`，**去 path 化**（或 path 只作缓存键）
- 验证 split 的 snap-once 不变量（`左源窗口+右源窗口==总源窗口`）——"拉长切开异常"疑似即此

### Step 4：回归验收基线
写一份 `REGRESSION.md`：时间轴 5 项（导入/split/trim/移动/多轨）+ 播放 6 项（MP3 单段/MP4 单段/MP3 split/MP4 split/暂停恢复/seek）——**每步改动后跑一遍，明确"通过/未过"**，不再凭感觉。

### Step 5：Command 层（最后做）
写操作封装 `{apply, undo}`，undo/redo 由统一 Manager 管。**等 split/trim 定义清楚再包**，否则是空转。

### 后置（不进 V1）
AudioEngine（Web Audio）、canvas 渲染、Rust、scene 多场景。

---

## 4. 风险与回退

- 每 Step 独立 commit，坏了 `git checkout v0.9-freeze` 或 `git revert <commit>` 回退
- 拆 JS 不改逻辑 → 行为零变化 → 回退成本最低
- 播放器跨段无声（已知未修）**不进 Step 1-4 范围**，丢后置（AudioEngine 或单独收口）

---

## 5. 一句话

**先冻结（✅ tag 已打）→ 拆 JS（纯搬移零风险）→ 播放状态隔离 → Asset 分离 → 回归基线 → 最后才 Command。播放器跨段无声丢后置，不再打补丁。**
