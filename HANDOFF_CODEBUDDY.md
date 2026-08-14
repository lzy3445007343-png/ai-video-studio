# AI 剪辑工作台 · 对接文档（交接给 codebuddy 接手）

> 这是一份"无上下文包袱"的规格交接。读完即可接手，不需要看之前的工作记录。
> 最后更新：2026-08-11 19:xx
>
> ⚠️ **状态变更（重要）**：v0.1 的"打补丁"路线已终止。时间轴面板已由 workbuddy 基于 OpenCut（opencut.app，MIT）的交互逻辑**从头重写为纯原生 JS**：`工作台v0.2时间轴.html`，`main.py` 的 `HTML_PATH` 已指向它（旧 `工作台v0.1预览.html` 保留作回滚）。
> - v0.2 是 **active 前端**，逻辑对标 OpenCut 但为原生 JS 重写（非 React 代码，不要搬 React 源码）。
> - 若后续要补 OpenCut 的工具层（音量/变速/转场/特效面板等），**照 v0.2 的「独立 Controller 状态机 + 共享吸附引擎 + 预览不落盘松手 commit」模式继续加**，不要混回 v0.1 那种"DOM/后端/MCP 三套状态各写各"的写法（那是补丁地狱根因）。
> - 后端 `Api` 方法（`get_state`/`move_segment`/`trim_segment`/`relocate_segment`/`add_to_timeline`/`split_segment`/`remove_segment`/`undo`/`redo`/`export_draft`/`import_media`）与 MCP 18 tool 契约**保持不变**，v0.2 直接复用。

## 0. 一句话定位
自有桌面 AI 剪辑工作站（对标剪映的交互），卖给郴州本地老板（有剪辑岗）。当前阶段目标：**把"剪辑这一块"做到接近剪映**。商业化 / Skill / 内容生意由另一端（workbuddy 侧）负责，本端不碰。

## 1. 你的负责边界
- ✅ 负责：桌面剪辑软件的剪辑交互、时间线、轨道、拖拽、预览播放、分割/裁剪、吸附、时间标尺、波形、撤销重做、导出剪映草稿。
- ❌ 不负责：Skill 研究、内容生意、定价、商业化（那些在另一端）。
- 硬约束（用户习惯，务必遵守）：
  - 用户**不会写代码**，只定方向 + 验收。你改完，用户会**关窗口 → 重开 `start.bat` → 逐步截图反馈**。
  - 改动纪律："一个按钮一个按钮接"，不要一次大改一堆；改完必须能在本机 `start.bat` 跑起来。

## 2. 技术栈与文件（已核实存在）
| 文件 | 作用 |
|------|------|
| `main.py` | Python 后端。状态机 + `Api` 类（所有剪辑操作）。 |
| `工作台v0.1预览.html` | 前端单文件（PyWebView 加载）。剪映式三栏：左素材 / 中预览 / 右+底时间线。 |
| `mcp_server.py` | FastMCP server：**18 个 tool + 1 个 resource**，是 AI(Agent) 驱动编辑器的通道。 |
| `draft_state.json` | 共享状态文件。人和 AI 都读写；前端每 0.5s 轮询同步。 |
| `mcp_state.json` | MCP 侧状态（心跳/updated_at）。 |
| `settings.json` | 默认导出路径等。 |
| `start.bat` | 启动脚本，用 `.venv\Scripts\python.exe`。 |
| `.venv/` | 已装 `pyJianYingDraft`、`portalocker` 等。**不要删、不要改用系统 python**。 |

启动方式：双击 `start.bat`。依赖已验证：`.venv` 存在、pyJianYingDraft 可 import、ffprobe 在 PATH。

## 3. 数据模型（改代码时务必保持）
- `draft.video / audio / text` = **轨道列表的列表**（list-of-list），这是和 OpenCut / Timeline Studio / OpenTimelineIO 一致的专业多轨模型。
- `video[0]` = 主视频轨（锚点，**不可删**）；`video[1:]` = 覆盖轨（反转渲染，高索引在上）。
- `audio[0:]` = 多条音频轨，混音（正向）。
- `text[0:]` = 多条文本轨（字幕/贴纸/画中画），正向。
- 渲染顺序（从上层到下）：文本 → 视频（反转）→ 音频。
- **空轨规则**：有素材则有轨，无素材则自动折叠消失（见 `main.py` 的 `_collapse_empty_tracks`）。主视频轨恒存。
- 任何编辑操作最终落到 `draft_state.json`，前端轮询可见。

## 4. 已完成并验收过的功能（不要再重做）
- 多轨：视频 / 音频 / 文本都支持多轨。
- 空轨自动折叠：删光片段的覆盖轨/音频轨/文本轨自动消失，只剩主视频轨。
- 拖到两轨中间的缝：显示"淡虚线撑开空隙"预览（不是橙色框），松手落盘、拖走消失。
- 落位模型统一：片段拖动 与 素材库拖入 都走"左边缘对齐鼠标"（之前是"抓取点跟随"，手感飘，已改）。
- 播放流畅：播放时只 `play()` 不每帧 `seek`；图片 `dataset.cur` 防重复加载；不跳帧不闪。
- 中文路径预览：`fileUrl` 已 `encodeURI`。
- 素材去重入库：`import_media_by_paths` 按 (文件名, 大小) 去重。
- `add_to_timeline` 进轨前 `os.path.isfile` 校验，假路径直接报错（防止脏数据进剪映导出崩）。
- MCP 心跳不再强重渲染：`version` 不再并入心跳时间戳，前端只轻量更新灰/绿状态点。

## 5. ⭐ Agent 合作能力（重点：这是用户最担心的）
**现状：AI 已经能驱动编辑器。** 通道是 `mcp_server.py` 的 18 个 tool。AI 调用 → 后端改 `draft_state.json` → 前端 0.5s 轮询实时反映。人类在可视化界面验收/微调，AI 做离散编辑（加素材、加轨、移动片段、分割、导出）。这是"AI + 人协作"的合理模式。

**给 codebuddy 的硬要求（接手后必须遵守，否则 Agent 合作会断）：**
1. **MCP tool 是稳定契约**：18 个 tool 的**名称 + 入参语义**不要随意改；若改后端 `Api` 方法签名，必须同步改 `mcp_server.py` 对应 tool。AI 端是按 tool 名/参数调用的，契约一变就失联。
2. **前端(人) 与 MCP(AI) 是同一后端的双接口**：任何剪辑操作都必须经过 `Api` 类落到 `draft_state.json`，不要在前端偷偷写状态、也不要在 MCP 里绕过 `Api`。
3. **可视化同步**：人和 AI 的改动都要能在前端实时看到（轮询机制保留）。

**已知待你修的 Agent 合作短板（交给你）：**
- **#2 跨进程写竞态**：人(桌面进程) 和 AI(MCP 进程) 都先 reload 旧 state 再落盘，后写覆盖先写，中间改动可能丢。建议：写操作加文件锁（`.venv` 已装 `portalocker`）或单写者串行化。
- **#3 undo 跨进程不可靠**：桌面进程和 MCP 进程各有自己的 `undo_stack`，AI 的改动桌面撤销不到，反之亦然。**当前模型下 undo/redo 本质不可靠**。建议：要么把栈落盘进 `draft_state.json` 共享，要么明确"undo 只在桌面侧可用"并在 MCP 文档注明。
- **#7 MCP resource 与 tool 的 meta 不一致**：`aivideo://draft_state` 资源读原始文件不含 `meta.mcp`，而 `get_state` tool 返回含 meta，AI 读两份结果不同。建议 resource 也组装 meta。

## 6. 之前审出的 bug 清单（状态）
| # | 项 | 状态 | 谁处理 |
|---|----|------|--------|
| 1 | add_to_timeline 不校验 path | ✅ 已修 | — |
| 2 | MCP 跨进程竞态 | 🔲 待修（见 §5） | **你** |
| 3 | undo 跨进程独立 | 🔲 待修（见 §5） | **你** |
| 4 | 素材重复入库 | ✅ 已修 | — |
| 5 | 文本轨 insertIndex 错位 | 🟡 当前架构已规避（前后端都用数据索引，折叠后连续一致）；你重构时注意保持一致 | 注意 |
| 6 | split 后 selectedKey 错位 | 🔲 待修（切自己保持、切后面 +1） | **你** |
| 7 | MCP resource 不含 meta | 🔲 待修（见 §5） | **你** |
| 8 | start.bat 无 .venv | ✅ 核实：.venv 存在，不成立 | — |
| 9 | pyJianYingDraft 无容错 | ✅ 核实：.venv 已装，不成立 | — |
| 10 | ffmpeg 缺失 | ✅ 核实：ffprobe 在 PATH，时长准确 | — |
| 11 | MCP 心跳每 3s 强重渲染 | ✅ 已修 | — |
| 12 | 中文路径未 encodeURI | ✅ 已修 | — |

## 7. 下一阶段优先级（你的主线，按用户"对标剪映"）
1. **剪辑手感对标剪映（第一层，前端手搓，不追 PR 丝滑）**：拖拽吸附、时间标尺缩放、波形显示、分割、裁剪、撤销重做。注：用户明确"做到 PR 丝滑就不用我们了"，所以第一层够用即可，不追帧级精准。
2. **修 §5 的两条 Agent 合作短板**（文件锁 + undo 边界），让 AI 真的能稳定合作 —— 这是用户这次交接的核心顾虑。
3. **导出剪映草稿真实可用**：`export_draft` 用 pyJianYingDraft 落盘 + `settings.json` 记住默认导出路径。确保导出后能在剪映打开。

## 7.5 ⭐ 工具层对标 OpenCut（用户 2026-08-11 拍板：抄工具，不抄架构）
用户明确：剪辑面板的**工具层**整体对标 OpenCut（opencut.app，MIT 开源），包括
工具集本身 + 每个工具的逻辑 + 交互方式 + 选中机制 + 素材选中后的状态。

**抄的边界（钉死，避免理解歪）：**
- ✅ 抄：工具的功能定义、行为逻辑、交互手势、选中/高亮/手柄/属性面板等"素材状态"表现。
- ❌ 不抄：OpenCut 的 React/TS 组件代码。我们是 PyWebView 原生 JS，必须**翻译成原生 JS 重写**，不能引入框架。工具逻辑是框架无关的（分割=按时间点切两段、裁剪=改 in/out、吸附=边缘对齐），照抄逻辑即可。
- 🔒 生态不动：MCP server(18 tool) / agent 集成 / 导出剪映草稿(pyJianYingDraft) 全部保留。

**落位铁律（用户 2026-08-11 定死，拖拽必须照此）：**
1. dragGhost 尺寸 = 被拖片段像素级同宽同高，不得写死统一长度。
2. 拖动时原位置不留虚影；原片段 DOM 直接隐藏或 `opacity:.3`，不得复制第二个拷贝杵在原位。
3. 落点 `atTimeUs` = 新片段 `startTimeUs`（即片段**最左边缘/第一帧**时间，不是鼠标位置、不是片段中心）。
4. 吸附：用被拖片段**最左边缘**去吸附相邻片段**最右边缘**（`startTimeUs + durationUs`）；0s 边界只在 `rawLeft >= 0` 时吸，避免拖出左侧卡死。
5. 吸附距离建议按时间（≈80ms）而非固定像素。

**建议先移植的工具清单（基础几项优先，与 OpenCut 对齐）：**
选择/移动、分割(split)、裁剪(trim/in-out 手柄)、吸附(snap)、音量、变速、文字/字幕、转场、特效/滤镜、缩放与位置、选中态高亮+手柄+属性条。
执行：先列 OpenCut 实际工具集 + 各自行为，和用户确认范围，再逐个移植；先把选择/移动/分割/裁剪/吸附/选中态这基础几项做扎实。

## 9. pyJianYingDraft 能力实测（特效/调色/变速/蒙版/转场 均可导出，已验证）

> workbuddy 侧实测结论：**pyJianYingDraft 原生支持变速/蒙版/滤镜(调色)/特效/转场**，导出后在剪辑草稿里写的是**剪映本地特效库的真实 resource_id**，在装有剪映的机器上打开会真实渲染（不是占位符）。

实测导出验证（造 3s 测试视频，逐层叠加后 `script.dump`）：
- 变速 `speed=0.5` → 写入 `materials.speeds`（与真实草稿 `speeds 48` 同类）
- 蒙版 `add_mask(MaskType.圆形)` → `materials.masks` resource_id=`6791700663249146381`（圆形）
- 滤镜 `add_filter(FilterType.冷白, 80)` → `materials.effects` resource_id=`7127614731187178783`（冷白）
- 特效 `add_effect(VideoSceneEffectType._70s)` → `materials.video_effects` resource_id=`6706773500792689165`（70s）
- 转场 `add_transition(TransitionType.叠化)` → `materials.transitions` resource_id=`6724845717472416269`（叠化）

关键实现要点（避免你踩坑）：
1. 枚举里内嵌真实 `resource_id / effect_id / md5`（见 `metadata/filter_meta.py`、`mask_meta.py`、`video_scene_effect.py`），导出直接用这些编号，剪映能解析。
2. 写法：`VideoSegment(mat, Timerange(...), speed=0.5).add_mask(...).add_filter(...).add_effect(...).add_transition(...)`；`ScriptFile(1080,1920,30,True)` + `append_track(TrackSpec(TrackType.video))` 先建轨再 `add_segment`。
3. **精细 HSL 调色层（色温/对比度/饱和度独立滑块）**：对应 `TrackType.adjust` + `materials.hsl`，库注释写明"仅供导入、不要新建此类型轨道"。即：预设滤镜(冷白/亮夏等)可导出；逐参数 HSL 微调从 API 新建暂不支持（但预设滤镜已覆盖绝大多数调色需求）。
4. 用户自定义/商店下载的特效：resource_id 指向本机下载目录，换机器可能解析不到；内置特效不受影响。

→ 这对 §7 第 3 条"导出剪映可用"是直接支撑：在 `export_draft` 里除视频/音频/文字外，可继续叠 speed/filter/mask/effect/transition 层，且能真实生效。sticker/effect 轨道类型也已在库中存在（`StickerSegment` / `EffectSegment`），可参照打通。

## 8. 验收纪律（给用户看，你也照此交付）
每次改动后，用户会：关窗口 → 重开 `start.bat` → 逐步截图反馈。你给的方案必须能在本机 `start.bat` 直接跑。不要依赖"用户去装环境/改配置"。

---
### 附：MCP 18 tool 清单（稳定契约，勿擅改）
`get_state` / `import_media_by_paths` / `add_clip` / `add_to_timeline` / `export_draft` / `remove_segment` / `move_segment` / `relocate_segment` / `trim_segment` / `split_segment` / `add_video_track` / `delete_video_track` / `add_audio_track` / `delete_audio_track` / `add_text_track` / `delete_text_track` / `undo` / `redo`
+ resource: `aivideo://draft_state`
