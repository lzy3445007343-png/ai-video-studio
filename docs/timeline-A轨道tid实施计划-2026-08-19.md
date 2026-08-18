# A 方案：轨道 tid 全链路实施计划（对齐 OpenCut trackId）

> 2026-08-19 01:25 落盘（防上下文压缩丢失）
> 背景：2026-08-18 晚用户拍板"直接 A，一步到位"（不做半吊子 B）。
> **段 id 已做**（commit b9a9206：`seg.id` + `_seg_by_id` + 前端 segId 全链路）——那是 A 的核心一半。
> **轨道 tid 未做**——本文件是 A1-A5 完整手册。
> 触发时机：**D1-D5（时间轴交互收尾）跑稳后**再开 A1。用户已确认排进下一轮（2026-08-19 01:20）。

---

## 为什么做 A（用户拍板过的理由）

1. 半吊子改造最后都会回到 OpenCut（播放器教训）——与其改一半再改，不如一次到位
2. B 做完前端交互和 OpenCut 同构，但**后端命令还用 (type,ti) 提交**——AI/MCP 操作层上马时 ti 漂移立刻暴露
3. **OpenCut 模型已整个读透**（SceneTracks / tid+elementId / 命令模式 / computeDropTarget / MoveElementCommand）——照图施工，不是摸索

## 目标形态（完全 OpenCut）

```
轨道: { tid: uuid, type, segs }      ← 轨道稳定 id（新增）
段:   { id: uuid, ... }               ← 已有（b9a9206）
全链路（拖动/命令/选中/undo/AI操作）用 tid + seg.id 定位；位置序号只用于显示
```

---

## A1：数据模型——轨道加 tid + 迁移

**改 `main.py`**：

1. **轨道结构**：
   - `overlay[i]` 加 `tid`（uuid）
   - `main` 加 `tid`
   - `audio[i]` 加 `tid`
2. **迁移**（`load_state` / `_migrate_old_to_x`）：
   - 新结构草稿：每条轨缺 tid → 补 uuid（`_ensure_track_tids(draft)`）
   - 旧结构→X 迁移：迁移时同时生成 tid
3. **新建轨**（`_insert_track`/`_ensure_track(-1)`/`_sync_new_layer`）→ 建轨时生成 tid
4. **后端访问层**：`_track_by_tid(draft, tid)` → 返回 (track_type, ti, segs) 或轨 dict

**验收**：
- [ ] 启动后草稿每条轨有 tid
- [ ] 旧草稿迁移后自动补 tid
- [ ] 新建轨（拖空白/加轨按钮）自动带 tid

---

## A2：后端命令签名升级（按命令分批）

**原则**：外部命令支持 **tid 优先定位**，`(type,ti)` 保留为兼容回退（同 b9a9206 segid 的做法）。

| 命令 | 加的参数 | 说明 |
|---|---|---|
| `add_to_timeline` | `track_tid` | 有则落到该轨（不依赖 ti 准确） |
| `relocate_segment` | `to_track_tid` | 目标轨用 tid；已有 segid |
| `move_segment` | `track_tid` | 源轨用 tid |
| `remove_segment` | `track_tid` | 源轨用 tid |
| `add_effect` / `add_sticker` / `add_subtitles` | `track_tid` | 同 |
| `add_*_track` / `delete_*_track` | 返回 tid | 返回新轨 tid 供前端引用 |
| `split_segment` / `trim_segment` / `duplicate` | `track_tid` | 同 |

**实现**：`_track_by_tid` 找到轨后取其 (type, ti) 走现有逻辑——**改动集中在每个命令开头 2-3 行**。

**验收**：
- [ ] 每条命令 tid 路径与 (type,ti) 路径结果一致
- [ ] 折叠/新建轨后 tid 定位仍准（E2E：建 3 轨 → 折叠 → tid 换轨成功）

---

## A3：前端 key 改 `tid:segid`

**改前端（timeline.js + 工作台 HTML）**：

1. **key 格式**：`type:ti:idx` → 改用 `tid:segid`（选中/拖动/渲染匹配/undo 恢复）
2. **buildTracks 输出带 tid**（轨的 tid + 段 id）
3. **makeSeg**：`data-key = tid:segid`，`data-segid` 保留
4. **selectedKey 语义**：`tid:segid`；`selectedSeg()` 用 segid 定位
5. **computeDrop/onPointerMove/onPointerUp**：拖动引用改 segid（部分已做）；跨轨提交带 `to_track_tid`
6. **渲染匹配**（renderTimeline 被拖段/选中态）用 segid（已做）

**验收**：
- [ ] 选中/拖动/删除/特效绑定在折叠后仍指向正确段
- [ ] 换轨提交带 tid，后端按 tid 落轨

---

## A4：播放器/导出适配 tid

- `player.js resolveHits` / `renderer.js`：hit 带 tid（z 序仍按 overlay 顺序）
- `playback-graph.js`：轨 tid 透传（可选，不阻塞）
- `export_draft`：按 tid 排序导出（或不依赖 tid，按数组顺序——X 模型数组顺序即 z 序，可能不需要）

**验收**：
- [ ] 播放器段切换/选中不受 key 格式变化影响
- [ ] 导出结果与改动前一致

---

## A5：全功能回归

回归清单：
- [ ] 素材库拖入（主场景/已有轨/空白/间隙/不兼容轨）
- [ ] 时间轴拖段（同轨/跨轨/主场景/新建轨/组移动）
- [ ] 裁剪/分割/删除/复制/粘贴/撤销/重做
- [ ] 特效/贴纸/文本/字幕面板
- [ ] 播放器（播放/seek/跨段/静音/轨道静音/隐藏）
- [ ] 导出剪映草稿（pyJianYingDraft）

---

## 实施节奏建议

| 步骤 | 内容 | 预计 |
|---|---|---|
| A1 | 数据模型 tid + 迁移 | 1-2 小时 |
| A2 | 后端命令分批升级（先 add/relocate/move/remove） | 2-3 小时 |
| A3 | 前端 key 全换 | 2-3 小时 |
| A4 | 播放器/导出适配 | 1 小时 |
| A5 | 回归 | 半天 |

**注意**：A 是大工程，**凌晨不做**（用户自己说凌晨容易做错误决策）。安排在白天精力好时整块做，每步可运行可回滚（git 提交点清晰）。

---

## 相关文档

- `docs/OpenCut对齐对照-2026-08-19.md`（26 项对比，A 的差距在 #23 轨道引用）
- `docs/timeline-D1-D5实施计划-2026-08-19.md`（先做，A 的前置）
- OpenCut 源码参照：`opencut-classic-src/apps/web/src/timeline/`（SceneTracks / move-elements.ts / timeline-store.ts）
