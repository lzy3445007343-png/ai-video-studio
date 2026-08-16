# FableCut 架构对照报告（2026-08-16，B 步）

> 目的：拉 `github.com/ronak-create/FableCut`（563★，MIT，零依赖）源码做架构对照，给我们的 Timeline Schema / Command-MCP 层 / 关键帧·蒙版·特效差异化定稿当参考。
> 结论先行：**FableCut 是我们所有对照项目里理念最像的**（AI 经 MCP 操作 JSON 时间轴 + 单一真相 + UI 热加载），但渲染路线完全不同（它 canvas 逐帧、我们 DOM 元素 + 剪映草稿导出）。**值得抄的是它的 MCP patch 模型和 props/keyframes 统一动画模型**；不抄的是 canvas drawFrame 渲染路线和时间单位。

---

## 1. FableCut 事实核查

- **定位**：浏览器视频编辑器，**主要用户是 AI agent**（Claude Code 等）——"The project file is the interface"。
- **技术栈**：零依赖原生 JS + Node 标准库（无 npm 依赖）。文件：`app.js`（6018 行，编辑器全量：timeline/compositor/keyframes/text engine/SVG 光栅化/chroma key/导出）、`mcp-server.js`（496 行，stdio MCP）、`server.js`（433 行，静态+ REST + SSE + ffmpeg 导出管线）、`CLAUDE.md`（552 行，给 agent 的完整手册）、`project.json`（时间轴真相）。
- **控制面三件套**：MCP（agent 首选）· 直改 project.json（文件监听）· REST API（GET/PUT /api/project + SSE /api/events 热加载）。

## 2. 架构对照总表

| 维度 | FableCut | 我们（ai-video-studio） | 判定 |
|------|----------|------------------------|------|
| 时间真相 | `project.json`（磁盘文件，UI 监听热加载） | `draft_state.json` + 前端轮询 get_state | 同构（文件轮询 vs SSE，都是单一真相） |
| 时间单位 | **seconds (float)**（`start:0, in:2.5, duration:5`） | **微秒整数 us**（`start:0, src_start:0`） | **我们更优**（us 整数无浮点误差；媒体 API 边界换算秒） |
| 时钟 | `state.time` 全局秒（loop 里 RAF 推进），`drawFrame(t)` 单一合成路径 | 播放头墙钟（playTick 每帧 `us=wallUs`），video/audio/animation 三层同源 | 同构（都是单一时钟），我们已写入内核文档 |
| 渲染路线 | **canvas 逐帧合成**（drawClip → ctx2d.drawImage；导出逐帧调 drawFrame + ffmpeg 编码） | **DOM video/audio 元素**（WebView2 硬件加速预览）+ 导出走 pyJianYingDraft 写剪映草稿 | **根本不同**（见 §3.1，特效一致性风险点） |
| clip 模型 | `{id, mediaId, kind, track, start, in, duration, props, keyframes, transitionIn/Out, linkGroup}` | `{material_id, path, start, src_start, src_end, duration, volume, muted, speed}` | FableCut 的 props+keyframes 统一模型更干净（见 §3.4） |
| 素材引用 | `mediaId → media[].src`（相对路径，导入即复制进 ./media 自包含） | `material_id → materials[].path`（**绝对路径 + /local/ 代理零复制**）+ seg.path 兜底 | 我们零复制（空间省），但缺素材缺失检测（见待办） |
| AI 操作入口 | 7 个 MCP 工具（status/docs/get_project/patch_project/set_project/analyze_reference/import_media） | 14 个细粒度写工具（add_clip/remove_segment/move_segment/…）+ execute/audit_log | 互补：他们粗粒度省 token，我们细粒度带审计（见 §3.3） |
| 关键帧 | `keyframes: {prop: [{t, v, ease}]}`，t 相对 clip 起点，ease 在目标帧；**20+ 可动画属性清单** | PropertiesPanel 有关键帧 tab + applyKfLiveAll 雏形，**模型未定稿** | **FableCut 模型可直接借鉴**（差异化关键帧） |
| 蒙版/抠像 | `chromaKey`（绿幕）+ `bgRemove`（MediaPipe AI 人像抠图） | **未做** | **差异化刚需，借鉴实现思路** |
| 特效 | filter 预设 14 种 + motion fx（shake/rgbSplit/grain）+ transition 11 种 + **adjustment layer（调整层）** | 未做（特效原语引擎规划中） | adjustment layer 是特效宿主，值得抄 |
| 字幕 | text 轨 24 个 prop + **12 种 textAnim**（typewriter/karaoke/word-pop/wave…）+ 9 种 title style | 文本轨基础（无动画） | **字幕差异化直接抄** |
| 变速 | `speed` 可关键帧（时间重映射 `in + ∫speed dt`） | 段级固定 speed | 进阶项，后置 |
| 导出 | 浏览器渲染每帧 + ffmpeg 编码 MP4 | pyJianYingDraft 写剪映草稿 | 路线不同（见 §3.5） |
| 素材缺失 | 导入即复制自包含（无缺失问题）；有 `relinkClips()`（分割后 AV 关联继承） | 绝对路径零复制 → 文件移动即 404，**无检测无提示** | **我们要补素材校验**（KubeezCut 也有 relinking） |

## 3. 深度分析（5 个关键差异）

### 3.1 渲染路线：canvas 逐帧 vs DOM 元素（最大差异，特效一致性的风险点）

FableCut：预览和导出**共用同一段 drawFrame(t) 代码**——所有元素画进 canvas，导出时逐帧调 drawFrame 截帧 + ffmpeg 编码。**"预览所见 = 导出所得"由"同一份渲染代码"天然保证**。

我们：预览 = DOM video 元素（WebView2 硬件解码，性能好）；导出 = pyJianYingDraft 写剪映草稿（剪映专业渲染）。**预览/导出共享的是数据语义（Playback Graph + graph_consistency.py 对拍保险丝），不是渲染代码**。

**风险点（做关键帧/蒙版/特效时必须面对）**：transform/opacity/基础 filter 这类"两端都有精确表达"的属性，对拍能保证一致；但 chromaKey/bgRemove/glitch 这类**预览用 CSS/JS 实现、剪映草稿未必有对应字段**的特效，只能"预览≈导出"近似或降级。落地原则：
- 特效原语只选**两端都能精确表达**的（transform 类、基础 filter 类）进 v1；
- 预览特有特效（如 rgbSplit）标注"导出降级"；
- graph_consistency.py 保险丝扩展到特效参数对拍。

### 3.2 时间系统：其实都是单一时钟，我们的单位更优

FableCut：`state.time`（秒）唯一时间源，`loop(ts)` RAF 推进，`drawFrame(t = state.time)`。视频元素 follower（`el.currentTime = mt`）。

我们：播放头墙钟 us 唯一时间源（playTick），三层（video seek / audio setPlayhead / applyKfLiveAll）同源。**架构同构，但单位不同**：
- FableCut 秒浮点（单文件小项目够用）；
- 我们 us 整数（剪辑工作台，避免 `5004799.9999998` 这类浮点噪音）。
- **保持 us，不采纳"统一 seconds"**。若未来对接 FableCut 生态（读它的 project.json），边界换算即可。

### 3.3 MCP 工具面：patch 模型最值得抄

FableCut 7 工具，设计亮点：
1. **`fablecut_patch_project`（增量编辑）**：`[{op:'addClip', clip}, {op:'updateClip', id, set}, {op:'removeClip', id}, ...]`——不整文档往返，**merge-safe**（重读磁盘最新→按序应用→revision 原子保存→冲突放弃），官方称省 **10-100x token**。updateClip merge 规则明确（顶层替换、props 键级合并、null 删除）。
2. **`fablecut_set_project`（整包替换）带 conflict-safe**：磁盘自上次读取后变了就报错，防 agent 覆盖用户 UI 改动。
3. **`fablecut_get_project` 支持 compact**：一行一段摘要（ids/tracks/timings/非默认 props），**不把整个文档丢给 agent**——与我们"绝不整份草稿丢 agent"纪律完全一致，它落地成了参数。
4. **`fablecut_docs` 按 section 取文档**：agent 按需读 schema，不灌整本手册。

对照我们：14 个细粒度写工具（add_clip/remove_segment/…）+ execute/audit_log。**细粒度有审计优势（Audit Log 逐条），但 agent 批量剪辑要发十几个调用，token 贵**。

**建议（进 Command 层 v2）**：新增 `patch_project` 批量工具——op 数组 + 事务（全成或全败）+ 逐条 audit_log + revision 冲突检测（读 draft_state 时记录 revision，写时校验，变了报错重读）。细粒度工具保留（精确操作/单步调试），patch 给 agent 批量用。

### 3.4 props + keyframes 统一动画模型（关键帧/蒙版/特效差异化的骨架）

FableCut 把所有可调属性收进 `props`，配一份**明确的可动画属性清单**（x/y/scale/rotation/opacity/volume/speed/brightness/contrast/saturation/hue/blur/grayscale/sepia/invert/temperature/tint/vignette/cornerRadius/shake/rgbSplit/grain/fontSize/letterSpacing/glow），`keyframes: {prop: [{t, v, ease}]}` 统一驱动。

对照我们：段上属性分散（volume/muted/speed 在段级，transform 在 PropertiesPanel 关键帧 tab 内），**没有统一的 props 字典和 animatable 清单**。

**建议（关键帧/特效落地前必做）**：给 Timeline Schema 引入 `props` 字典（FableCut 模型裁剪版）+ 明确 animatable 清单 + keyframes 相对时间（相对 clip 起点）。这是差异化功能的**数据地基**，定了它，关键帧面板/特效原语/导出对拍全部复用同一套。

### 3.5 导出路线：两条路各有利弊

FableCut：canvas 逐帧 + ffmpeg（自包含，但渲染质量受浏览器 canvas 限制，无专业调色/编码）。
我们：pyJianYingDraft 写剪映草稿（导出质量由剪映保证，用户可继续精修；但依赖用户装有剪映）。

**保持我们的路线**（剪映生态是护城河的一部分），FableCut 的 ffmpeg 导出可作"无剪映时的降级导出"远期考虑。

## 4. 可借鉴清单（按优先级）

| 优先级 | 借鉴项 | 落地到我们哪块 |
|--------|--------|---------------|
| 🔴 P0 | `patch_project` 批量 op + conflict-safe + revision | Command 层 v2（MCP execute 增加 patch 工具） |
| 🔴 P0 | `props` 字典 + animatable 清单 + keyframes 相对时间模型 | Timeline Schema v1（关键帧/特效的数据地基） |
| 🟠 P1 | textAnim 12 种 + title style 9 种（字幕动画） | 文本轨升级（差异化字幕） |
| 🟠 P1 | chromaKey + bgRemove（绿幕/人像抠图） | 蒙版功能（差异化刚需，MediaPipe 思路） |
| 🟠 P1 | adjustment layer（调整层：对下方全部内容套滤镜） | 特效原语引擎的宿主 |
| 🟡 P2 | transitionIn/Out 11 种（glitch/whip/pop…） | 特效原语素材库 |
| 🟡 P2 | compact 摘要 / docs 按需取 | MCP get_state 加 compact 参数（省 agent token） |
| 🟡 P2 | markers/beats 节拍标记 | 时间轴标尺（口播卡点） |
| ⚪ P3 | SSE 热加载替代轮询 | 体验优化（轮询 0.5s 够用，后置） |
| ⚪ P3 | speed 关键帧变速（时间重映射） | 变速进阶 |

## 5. 明确不借鉴

- **canvas drawFrame 全量渲染**：我们 WebView2 DOM 路线（硬件加速、免重写）更适合，且导出走剪映；只有特效一致性风险（见 §3.1），用"特效参数对拍 + 近似标注"解决，不换渲染路线。
- **秒时间单位**：保持 us 整数（见 §3.2）。
- **导入即复制素材**：我们零复制（绝对路径 + /local/ 代理）省空间，缺的是"素材缺失检测/重链 UI"，补那个而不是改复制制。
- **零依赖纯 Node 架构**：我们 PyWebView + Python 后端（pyJianYingDraft 依赖），架构已冻结（ADR-001），不迁移。

## 6. 行动建议

1. **近期**：Timeline Schema v1 定稿时引入 props 字典 + animatable 清单 + keyframes 相对时间（借鉴 §3.4），这是关键帧/蒙版/特效的地基。
2. **近期**：Command 层 v2 加 patch_project 批量工具（借鉴 §3.3），agent 剪辑效率直接上一个台阶。
3. **中远期**：字幕动画（textAnim 子集）、蒙版（chromaKey/bgRemove 思路）、特效原语引擎（adjustment layer 宿主 + transition 素材）。
4. **每次借鉴落地**：遵守"预览=导出"纪律——新属性进 graph 平铺（两端一致）+ 对拍脚本更新 + 回归。

---
*对照对象：FableCut commit（克隆日 2026-08-16），本地副本 /tmp/fablecut（AppData\Local\Temp\fablecut）。*
