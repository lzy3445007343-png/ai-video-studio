# OpenCut vs 我们 · 逐功能数据流对比（Feature-Level Dataflow Audit）

> 日期：2026-08-15
> 方法：OpenCut 源码（apps/web/src）+ 我们全部源码逐功能对比，从「前端显示 → 监听 → 触发 → IPC/Command → 后端 → 反馈刷新」全链路核对。
> 结论先放：**核心编辑覆盖率 ~85%**；关键帧是完整落地的（前后端都通）；真正的大缺口是**特效系统**；人操作细节缺 6 项。

---

## 1. OpenCut 功能面（源码盘点）

### 1.1 快捷键动作（actions/definitions.ts，27 个）
播放：toggle-play / stop-playback / seek±1s / frame-step± / jump±5s / goto-start / goto-end
编辑：split-left / split-right / delete-selected / copy-selected / paste-copied / toggle-snapping / toggle-ripple-editing / toggle-source-audio / select-all / deselect-all / cancel-interaction / duplicate-selected / toggle-elements-muted-selected / toggle-elements-visibility-selected / toggle-bookmark / remove-media-asset / remove-media-assets

### 1.2 Command 命令（commands/，40+ 文件）
媒体：add-media-asset / remove-media-asset(s)
场景：create/delete/rename-scene / move/remove/toggle/update-bookmark / update-project-settings
时间轴：insert-element / split-elements / move-elements / delete-elements / duplicate-elements / update-elements / update-element-trim / update-element-retime / toggle-source-audio-separation
轨道：add-track / remove-track / toggle-track-mute / toggle-track-visibility
**特效：add-effect / remove-effect / update-effect-params / toggle-effect / reorder-effect**
关键帧：upsert-keyframe / remove-keyframe / retime-keyframe / update-keyframe-curve（曲线）/ upsert-effect-param-keyframe / remove-effect-param-keyframe
遮罩：remove-mask / toggle-mask-inverted / insert-custom-mask-point（自由路径点）/ delete-custom-mask-points
剪贴板：paste / paste-keyframes

### 1.3 Manager 方法（timeline-manager 核心 30+）
trim/retime/move/split/delete/insert/track 增删/轨道静音隐藏/**特效增删改排序**/关键帧增删曲线/遮罩自由路径/音频分离

### 1.4 UI 层
- 右键菜单：有（preview/components/context-menu.tsx + ui/context-menu.tsx）
- 工具栏：Split/Split-left/right/Duplicate/Delete/Freeze(coming soon)/Source-audio + Snapping/Ripple/Zoom + 轨道头部（静音/隐藏/锁定）
- 属性面板 PropertiesPanel：参数编辑（含特效/关键帧/遮罩参数）

## 2. 我们功能面（源码盘点）

- UI 按钮 17 个：split/splitLeft/splitRight/dup/del/srcAudio/snap/ripple/undo/redo/play/mute/speed/skill/import/importJy/export
- 前端调用后端方法 45 个（关键帧/贴纸/遮罩/书签/变速/分组/ASR/波纹/复制粘贴全接）
- Api 方法 ~60 个 + MCP 工具 27 个 + Command 审计层（execute/audit_log，今日新做）
- 状态流：UI 事件 → `call("method")` → pywebview IPC → Api 方法 → 改 draft + save_state（写文件+压 Command 栈）→ 前端 0.5s 轮询 get_state → Store.set → renderAll

## 3. 逐功能对比矩阵

| OpenCut 功能 | 我们 | 说明 |
|---|---|---|
| toggle-play (Space/K) | ✅ | 同 |
| stop-playback | ⚠️ | 只有暂停，无"停止并回播放头" |
| seek±1s / frame-step / jump±5s / goto | ✅ | J/L / ←→ / Shift+←→ / Home·End |
| split / split-left / split-right | ✅ | S / Q / W |
| delete / copy / paste / duplicate | ✅ | Del / Ctrl+C·V / Ctrl+D |
| snapping / ripple | ✅ | N / R |
| toggle-source-audio | ✅ | 提取原声（ffmpeg 抽 m4a） |
| select-all / deselect | ✅ | Ctrl+A / Esc |
| **toggle-elements-muted-selected（段静音）** | ❌ | 只有轨级静音，无段级 |
| **toggle-elements-visibility-selected（段隐藏）** | ❌ | 只有轨级隐藏，无段级 |
| toggle-bookmark | ✅ | B 键 |
| add/remove-track | ✅ | 视频/音频/文本轨 |
| toggle-track-mute / visibility | ✅ | 🔊👁 |
| **轨道锁定 lock** | ❌ | 占位未做 |
| trim / retime / move / split / delete / insert | ✅ | 核心编辑全有 |
| **特效 add/remove/update/toggle/reorder** | ❌ | **完全缺失**（effect 轨空占位） |
| 关键帧 upsert/remove | ✅ | add/update/remove/clear_keyframe 前后端都通（**已落地，非只有面板**） |
| **关键帧曲线 GraphEditor** | ❌ | 只有线性，无曲线编辑 |
| **retime-keyframe（变速关键帧）** | ❌ | 只有整段变速 |
| **effect-param 关键帧** | ❌ | 特效都没有 |
| 遮罩预设形状+反转 | ✅ | rectangle/ellipse/star/heart 等 |
| **遮罩自由路径/贝塞尔点** | ❌ | 只有预设形状 |
| add/remove-media-asset | ✅ | import_media / delete_material |
| 多场景 scenes | ⚠️ | 我们单项目（当前够用） |
| 自动保存 | ✅ | save_state 文件持久化 |
| **右键菜单** | ❌ | 缺失（待办 P1） |
| Freeze frame | - | OpenCut 自己也 coming soon |
| **MCP/Skill 生态** | ✅ 独有 | OpenCut 无（我们的护城河） |

## 4. 数据流对比（全链路）

| 环节 | OpenCut | 我们 |
|------|---------|------|
| 触发 | 点击/快捷键 → action handler | 点击/快捷键 → `call("method")` |
| 通信 | 同进程（React 直接调 manager） | pywebview IPC → Python Api 方法 |
| 执行 | CommandManager.execute(Command) → manager 改 scene.tracks | Api 方法改 draft + save_state（写文件 + 压 Command 栈） |
| 撤销 | Command.undo 恢复 savedState | **同构**：Command 栈 + savedState 快照还原（今日已对齐） |
| 通知 | subscribe 同步响应式（立即重绘） | 0.5s 轮询 get_state → Store.set → renderAll（~0.5s 延迟） |
| 审计 | 无显式审计 | ✅ 独有：execute + meta（actor/reason/confidence） |

**差异点**：
1. 状态传播：OpenCut 同步响应式 vs 我们轮询（延迟 0.5s，但跨进程可靠、Agent 可共享状态）
2. Command：OpenCut 全走 Command ✅ 我们刚对齐（写操作统一 execute）
3. undo：**两者完全同构**（Command + savedState 快照）

## 5. 缺陷清单（按严重度）

### P0（功能缺失，影响 Agent/产品）
| # | 缺陷 | 说明 |
|---|------|------|
| 1 | **特效系统** | add/remove/update/toggle/reorder effect 全无——正是「基础特效原语引擎」要做的（OpenCut 也只实现 blur 1 个，我们自造原语更优） |
| 2 | 播放器冻结项 | 跨段无声/重播不稳（归 C.0 AudioEngine 决策） |
| 3 | trim 补素材手感 | 用户实测：截两段后往前拉应补回被裁素材（后端支持，前端手感未接对）——**非冻结项，可修** |

### P1（人操作体验）
| # | 缺陷 |
|---|------|
| 4 | 段级静音/隐藏（toggle-elements-muted/visibility-selected） |
| 5 | 右键菜单（OpenCut 有：preview/components/context-menu.tsx） |
| 6 | 轨道锁定 |
| 7 | 关键帧曲线编辑器（GraphEditor，OpenCut update-keyframe-curve） |
| 8 | 变速关键帧（retime-keyframe） |
| 9 | 遮罩自由路径/贝塞尔点（OpenCut insert-custom-mask-point） |

### P2（后置/可选）
| # | 缺陷 |
|---|------|
| 10 | stop-playback 独立停止（回播放头） |
| 11 | 多场景（我们单项目，暂够用） |
| 12 | 特效参数关键帧（等特效引擎后） |

## 6. 结论

1. **核心编辑覆盖率 ~85%**：时间轴操作（分割/裁剪/移动/变速/多轨/吸附/波纹/撤销）与 OpenCut 对齐；关键帧**已完整落地**（前后端都通，用户担心的"只有面板没后端"不成立——缺的只是曲线编辑器）。
2. **数据流已同构**：Command 层今日对齐后，我们的写操作链路（触发→execute→Command 栈→撤销）与 OpenCut 完全同构；差异仅在状态传播（轮询 vs 响应式），轮询跨进程更稳。
3. **真正的大缺口只有特效系统**——但 OpenCut 自己也只实现了 blur，我们按「特效原语引擎」自造，反而更适合 Agent（原语可组合、可审计）。
4. **可立刻修的非冻结项**：trim 补素材手感（P0-3）、段级静音/隐藏（P1-4）、右键菜单（P1-5）、轨道锁定（P1-6）。

## 7. 建议优先级

```
1. trim 补素材手感（用户实测痛点，非冻结，半天内）
2. 特效原语引擎设计（唯一大缺口 + 你已拍板战略）
3. P1 细节四件套（段级静音隐藏/右键菜单/轨道锁定/曲线编辑器，按需挑）
4. 播放器冻结项归 C.0（等 AudioEngine 决策）
```
