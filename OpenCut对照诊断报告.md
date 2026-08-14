# OpenCut 对照诊断报告

> 日期：2026-08-12 ｜ 范围：OpenCut classic 源码 ↔ 我们 v0.8 前端 + main.py 后端
> 目的：按用户工作流（看 OpenCut 功能 → 读其源码理清「触发到结束」完整数据流 → 翻译我们的代码），先做一次全局对照，输出：功能缺口 / 未完善处 / bug 隐患。

---

## 一、对照方法论：两条数据流怎么走

**OpenCut classic（Next.js + TS + Rust/WASM）**
```
用户操作(控制器 layer)
  → Command 命令对象
      execute(): savedState = 整份 SceneTracks 快照
                 计算变更 → editor.timeline.updateTracks(新状态)  ← 不可变替换模型
      undo():   editor.timeline.updateTracks(savedState)         ← 整份状态回滚
  → update-pipeline.ts：派生规则(retime→duration) + 强制规则(startTime→主轨起点=0, duration→夹紧动画)
  → snapping/：build(收集吸附点) → resolve(最近点解析, 阈值内吸附)
  → placement/：resolveTrackPlacement(多策略落轨) + overlap(重叠检测) + main-track(主轨起点强制)
```

**我们（Python + PyWebView + MCP + draft_state.json）**
```
前端拖拽/按钮 → call(后端方法名)
  → _reload()             ← 从文件重读最新状态（解多进程脏读）
  → _push_undo()          ← copy.deepcopy(self.draft) 压栈
  → 改 self.draft
  → save_state()          ← 落盘 draft_state.json
前端每 0.5s get_state() 轮询回填 Store → 自动重绘（人和 AI/MCP 互相可见）
```

**结论**：宏观架构对等（命令/操作 → 状态快照 → 持久化 → 轮询同步）。差异在**能力与一致性细节**，下面逐项展开。

---

## 二、功能覆盖对照表

| 能力 | OpenCut | 我们 | 状态 |
|---|---|---|---|
| 多轨（视频/音频/文本） | ✓ | ✓ | 已覆盖 |
| 拖拽移动片段 | ✓ | ✓ `move_segment` | 已覆盖 |
| 跨轨移动 | ✓ | ✓ `relocate_segment` | 已覆盖 |
| 左/右双向裁剪 | ✓ | ✓ `trim_segment` | 已覆盖 |
| 分割 | ✓ | ✓ `split_segment`（但 1:1 无变速映射） | 已覆盖(简版) |
| 撤销/重做 | ✓ | ✓ `deepcopy(draft)` | 已覆盖 |
| 同轨重叠自动避让 | ✓ | ✓ `_free_start_on_track` | 已覆盖 |
| 音频波形 | ✓ canvas 真实波形 | ✓ canvas 同款(对齐 OpenCut) | 已覆盖 |
| 画布自动匹配 | ✓ | ✓ | 已覆盖 |
| 缩放/seek 控制器 | ✓ | ✓ 前端有 | 已覆盖 |
| **吸附对齐** | ✓ 完整引擎(build/resolve/threshold) | ✗ 按钮在、`snapOn:true` 但**逻辑空转** | **缺口** |
| **删除 vs 移动 逻辑自洽** | ✓ 删留空 / 涟漪另算 | ✗ 删=强制涟漪(见 bug#1) | **不自洽** |
| 分组多选移动/缩放 | ✓ group-move/resize | ✗ | **缺口** |
| 变速/重定时(retime) | ✓ | ✗ | **缺口** |
| 关键帧/动画 | ✓ graph-editor | ✗ | **缺口** |
| 特效及参数 | ✓ effects/* | ✗ | **缺口**（用户此前点名"特效工具缺失"） |
| 遮罩(自定义点+反转) | ✓ masks/* | ✗ | **缺口** |
| 字幕 ASR 转录 | ✓ transcription | △ 仅 SRT 导入 | **缺口(半)** |
| 贴纸/图形轨 | ✓ graphic/sticker | ✗ 数据模型无 | **缺口** |
| 书签/播放头吸附 | ✓ bookmarks/playhead | ✗ | **缺口** |

---

## 三、功能缺口清单（按优先级）

### P0 — 编辑手感底线（对比 OpenCut 明显缺失，且是我们 PR 第一层的核心）
1. **吸附对齐**：`snapBtn` 已就位、`snapOn:true` 已设，但前端没有吸附计算（不吸附到片段端点/播放头/其他片段）。拖拽落点是任意微秒值，对齐全靠手感。
2. **删除=误触式涟漪**：`remove_segment` 把同轨剩余片段重排到 0 连续（见 bug#1），与我们"自由移动留空档"的 PR 式手感自相矛盾。

### P1 — 垂直 skill 真正用得到的差异化能力（按用户业务优先级排）
3. **变速/重定时**：口播/跳剪 skill 必备（加速铺垫、慢动作强调）。
4. **关键帧/动画**：画面思维·反推提示词核心——运镜（推拉摇移）、缩放、透明度都要关键帧。OpenCut 有完整 graph-editor。
5. **特效及参数**：用户此前明确"特效工具缺失"项。
6. **分组多选**：多个片段整体拖拽/缩放（跳剪常需多段一起挪）。

### P2 — 高级/锦上添花
7. 遮罩、字幕 ASR 转录、贴纸/图形轨、书签吸附、播放头吸附。

> 注：按用户定的工作流——**这些不自己凭空补**，等用户对标 OpenCut 指定某功能 → 我读其源码 → 翻译实现。上面是"还缺什么"的清单，不是立即开工令。

---

## 四、Bug 隐患清单（代码位置 + 复现 + 修法）

### bug#1 `remove_segment` 误触式涟漪（main.py:1114-1119）
- **现象**：删除某轨中段片段后，该轨剩余片段被 `new_start=0; new_start+=duration` 重排成连续，把自由移动留下的空档抹掉。
- **复现**：主轨放 A(0-2s)、B(4-6s) 留 2-4s 空档 → 删 A → B 被推到 0-2s，空档消失。
- **根因**：OpenCut `DeleteElementsCommand` 只 `filter` 掉元素，**不重排**；涟漪是独立操作。我们把它写成了"删即重排"。
- **修法**：删掉 1116-1119 的 `new_start` 重排循环，仅 `segs.pop(index)` 保留空档，与 `move_segment` 的留空逻辑一致。

### bug#2 `_push_undo` 在参数校验前调用（main.py:1031 / 1105 / 1136 / 1165 / 1214 / 1264 等同模式）
- **现象**：非法输入（越界 index、不支持的 mtype）会先压一帧"空操作"撤销快照，再返回错误。结果：撤销栈里多一个无变化的历史槽，用户按撤销"什么都没发生"却消耗一步。
- **复现**：前端拖一个后端已不存在的 stale index 片段 → 后端 bounds 校验失败返回 error，但已 `_push_undo()`。
- **修法**：把 `_push_undo()` 移到所有校验**通过之后**；或在 `return {"ok":False}` 分支里 `Api.undo_stack.pop()` 撤销刚才压的帧。

### bug#3 `split_segment` 浅拷贝潜伏 bug（main.py:1242 `right = dict(seg)`）
- **现状安全**：当前片段字段全为标量（start/duration/src_start/src_end/name/path/type），`dict()` 浅拷贝无碍。
- **潜伏风险**：一旦给片段加 `effects`/`keyframes`/`params`（嵌套可变 dict，正是 OpenCut 的强项、也是我们 P1 要做的），`dict(seg)` 会让左右两段**共享同一子对象**——改左段特效参数会污染右段。
- **修法**：split 时改用字段级复制或 `copy.deepcopy(seg)` 后再改左右各自字段。现在就改成本最低（避免将来踩坑忘了）。

### bug#4 多进程撤销互相覆盖（架构层，非单文件 bug）
- **现象**：MCP server 是独立进程，写同一个 `draft_state.json`。窗口进程 A 持 A 操作前的快照做 undo，会把 MCP 进程 B 之后做的改动**整份冲掉**。
- **当前影响**：单人单窗口可用；一旦接多个 agent 并发编辑同一草稿会丢改动。
- **修法（未来）**：撤销栈改为基于文件版本号/操作日志，或把所有写操作集中到单一后端进程（MCP 经同一进程转发），避免双进程各持一份历史。

### bug#5 导出只建模 video/audio/text（main.py:1530-1571）
- **现象**：`export_draft` 只遍历 `video/audio/text` 三类轨。未来若加 graphic/sticker/effect/mask 轨（P2），导出层不会落这些轨，剪映里看不到。
- **修法**：等引入新轨类型时，在 export 里补对应 `append_track` + `add_segment` 分支（pyJianYingDraft 支持）。

### bug#6 主轨起点不强制（对比 OpenCut `enforceMainTrackStart`）
- **说明**：OpenCut 强制主轨最早元素从 0 开始（不留头空档）。我们允许主轨开头留空档——这是"更自由"而非 bug，但 skill 脚本若假设主轨恒从 0 起，需留意。
- **建议**：保持自由，但在 skill 调用约定里写明"主轨起点可能非 0"。

---

## 五、结论 & 下一步

- **已根治项**：8-10 记录的"状态多引用幽灵 bug"（改的是旧内存引用、落盘文件不变）已被 `_reload()` + 重绑 `self.draft = self.state["draft"]` 模式根治——**每个改状态的方法开头都先 `_reload()`，`get_state` 每次也重绑**。可明确告知用户这条已修。
- **最该先补的两件事（P0，编辑手感底线）**：① 接吸附（前端已有按钮和标志位，只差吸附计算）；② 修 `remove_segment` 不自洽（删掉重排循环即可，5 行改动）。
- **其余缺口**：按用户工作流，等用户对标 OpenCut 指定某功能 → 我读对应源码 → 翻译实现。本次已把 OpenCut 目录结构摸清（`commands/timeline/`、`timeline/{snapping,placement,group-move,group-resize,controllers}/`），下次指哪读哪即可。

---
*附：本次精读的 OpenCut 关键文件*
- `timeline/update-pipeline.ts`（派生/强制规则）
- `timeline/snapping/{build,resolve,threshold,types}.ts`（吸附引擎）
- `timeline/placement/{resolve,overlap,main-track,insert-index,apply,compatibility}.ts`（落轨策略+重叠+主轨）
- `commands/timeline/element/{move,split,insert,update,delete}-elements.ts`（命令+整份快照 undo）
- `commands/timeline/tracks-snapshot.ts`（快照式 undo 原型）
