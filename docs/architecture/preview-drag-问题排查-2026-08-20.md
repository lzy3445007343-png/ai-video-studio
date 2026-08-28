# 预览拖动 · 问题排查文档（2026-08-20，待 GPT 独立评审）

> 背景：已落码"预览拖动 + 关键帧自动打点"（Step0-4，commit 61243af / b31eef4），真机验收发现 4 个问题。
> 状态：**只定位未修复**，本文档供 GPT 独立判断根因与修法。

---

## 一、做了什么（代码现状）

### 1.1 Transform Schema（commit 61243af）
- `seg.transform = {x, y, scaleX, scaleY, rotation, opacity}`（静态态，默认 0/0/1/1/0/1）
- renderer.js 新增 `resolveTransform(seg, localUs)` 三层解析：`kfVal(animations) ?? seg.transform ?? default`
- `applyKfTransform(el, seg, localUs)` 改用 resolveTransform，且**首行跳过 `el.dataset.dragActive`**（拖动中不被轮询覆盖）
- ⚠️ 遗留：贴纸 sticker 仍用旧结构 `seg.transform {x,y,scale,rotation,opacity,flipH,flipV}`（百分比+单 scale），renderer.js:215 独立处理，不经过 resolveTransform

### 1.2 预览拖动（commit b31eef4）
- 新文件 `property/preview-drag.js`：previewStack 上 pointer 事件委托
  - **pointerdown**：hit-test（`e.target.closest("[data-preview-el]")` → `previewState.visualEls.get(wrap.id)`）→ 目标未选中则 `selectKey(rec.key)` 单选 → 记录起始快照（鼠标偏移/起始 transform/localUs）
  - **pointermove**：位移超 3px 进拖动 → **只改 `el.style.transform` + `el.dataset.dragActive="1"`**（interactionDraft：不碰 seg/后端，refresh 替换 seg 也不丢）
  - **pointerup**：删 dragActive → commit：
    - 有动画通道（`seg.animations["transform.positionX"]` 有 key）→ `call("add_keyframe", type, ti, idx, path, localSnap, value, "linear")`
    - 无动画通道 → `call("update_segment_transform", {segid, transform:{x,y,scaleX,scaleY,rotation,opacity}})` 合并写 seg.transform
  - v2 约束：播放中禁止拖动；第一版只拖 video/image；单击（3px 内）= 只选中
- renderer.js：`_makeVisualEl` 加 `data-preview-el` 标记
- main.py 新增 `update_segment_transform`：`_reload()` → `_seg_by_id(draft, segid)` 定位 → 合并写 seg.transform → `save_state`

### 1.3 相关既有机制
- **refresh()**：前端拉后端最新 draft → 整个替换 `Store.state.draft`（对象替换，旧 seg 引用失效）
- **save_state**（main.py:974）：写盘前 `_ensure_track_tids(state["draft"])`（mutate 加轨道 tid）→ 写盘 → **读回验证**：不一致只 print `[SAVE-VERIFY-FAIL]`，不回滚不抛错
- **undo()**（main.py:2372）：先 `_reload()`（磁盘重载）→ `cmd_mgr.undo` 弹 `saved_state`（deepcopy）覆盖 draft → `save_state(record=False)`
- **画布尺寸**：`canvasPxJS()` 9:16 → {W:608, H:1080}；16:9 → {W:1080, H:608}；`applyKfTransform` 用 `sc = previewStack.getBoundingClientRect().width / cp.W` 换算像素
- **preview-stack CSS**（HTML:110）：`position:absolute; left:50%; top:50%; transform:translate(-50%,-50%)`，尺寸由 JS 按画布比例设（line 1510-1511 `stack.style.width=w+"px"; height=h+"px"`）
- **wrap CSS**（HTML:112-114）：`.vis-layer, video, img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000 }`

---

## 二、四个问题

### Bug 3（最严重）：拖动素材 → 时间轴/素材库全空 → ctrl+z 后异常

**用户现象**：预览里拖素材，松手后整个时间轴和素材库的内容都消失；按 ctrl+z 后变成异常状态（截图：素材库/时间轴空了）。

**日志证据**（用户贴的后端控制台）：
- 开头一行 `Failed to load resource: 404 (File not found)`（URL 被截断，未知具体资源）
- 大量 `[seek] VIDEO to=...` 播放正常
- `[MediaSlot] prepare READY` 预加载正常
- **无 `[SAVE-VERIFY-FAIL]`**、无 Python 异常堆栈 → 拖动 commit 写盘通过

**疑点（按概率）**：
1. **A. undo 快照污染（高）**：`undo()` 先 `_reload()` 从磁盘重载，再 `cmd_mgr.undo` 弹 `saved_state` 覆盖。如果 update_segment_transform 的 save_state 压入的快照是"拖动前"状态（合法，含段），undo 不该空——**除非**：快照压入机制有问题（如拖动 commit 前后 last_committed 与磁盘不同步），或用户多按几次 ctrl+z 弹到很早期的空快照。**待确认**：全空是"拖动后立刻"还是"ctrl+z 之后"。
2. **B. refresh 后前端渲染崩溃（中）**：refresh 拉回新 draft → renderAll → 若某素材 path 失效（对应 404）或渲染函数抛异常 → 时间轴/素材库 DOM 未渲染 → 视觉全空。404 可能是 refresh 时某段 path 缺失（拖动后 path 被改/丢了？）。
3. **C. _reload 磁盘回退（低-中）**：update_segment_transform 先 `_reload()` 从磁盘重载——若磁盘 draft 与窗口内存不同步（如上一操作未落盘），reload 会回退 draft → seg 找不到 → 返回 error 不写盘（前端 catch 不 refresh）。但若 seg 恰好找到，会把"旧磁盘 draft + transform"写回 → 前端 refresh 拉回旧数据 → **用户最近的操作丢失**。**待确认**：全空时磁盘 draft_state.json 的段数。

**待验证信息**：
- 全空发生在"拖动后立刻"还是"ctrl+z 后"？
- 404 的完整 URL（F12 Network 面板）
- 拖动后（ctrl+z 前）draft_state.json 的 `draft.main.segs` 段数与内容

### Bug 2：切换 9:16 后素材位置"弹回去"

**用户现象**：把画布比例调成 9:16 后，有时换位置会自己弹回。

**疑点**：
1. **A. dragActive 残留（高）**：若拖动中/拖动后未清 `el.dataset.dragActive`（如 pointercancel 路径、或 refresh 在拖动中触发），`applyKfTransform` 跳过该元素 → 该元素保持旧 el.style.transform（旧比例旧 sc 算的值）→ 切换比例后位置视觉跳变/弹回。
2. **B. 坐标单位跨比例语义（中）**：seg.transform.x 存的是**画布像素**（9:16 时 cp.W=608，16:9 时 cp.W=1080）。同一 x=50 在两种比例下视觉偏移不同——这是**设计预期**（绝对坐标）。但若用户预期"相对位置不变"，需要换百分比/相对单位。
3. **C. 拖动中 refresh 覆盖（低-中）**：拖动中若 500ms 轮询 refresh 拉回后端（无 transform 的旧值），且 dragActive 未及时设，元素被 applyKfTransform 用后端旧值重画 → 弹回。v2 设计 interactionDraft 就是为了防这个，但若"拖动中 refresh 替换 seg 引用"与"旧 rec.seg 引用"不同步，会出问题。

**待验证信息**：
- 切换比例前后 wrap 的 `dataset.dragActive` 是否存在
- 切换比例后 wrap.style.transform 的 px 值 vs stack 新宽度比例

### Bug 1：9:16 画布下拖动后"自己拓展背景"

**用户现象**：素材 9:16，预览里拖动后出现大片黑色背景（看起来画布被拓展）。

**疑点（已定位为布局问题，非拖动逻辑）**：
- `.preview .preview-stack` 尺寸被 JS 设为画布比例（9:16 → 608px×1080px），但 preview 容器高度通常只有 ~400px
- **stack 高度 1080 > 容器高度 → 被 `.stage { overflow:hidden }` 裁切** → 视觉上"黑边区域"异常/拓展
- 这是**预先存在的布局问题**（画幅切换即存在），拖动只是让用户注意到（素材偏移暴露了画布边界被裁）
- 次级疑点：`applyKfTransform` 的 sc 换算只按宽度（`stackRect.width/cp.W`），若容器高度受限导致宽度也不匹配，位移幅度会偏

**待验证信息**：F12 选中 previewStack 看 actual height vs 设定的 1080；preview 容器（.stage）实际高度

### Bug 4：关键帧逻辑"还没做"

**用户现象**：质疑关键帧逻辑没做。

**实情**：
- 面板层：`toggleKf`（◆ 开/关，clear_keyframes / add_keyframe）、`addKfAtPlayhead`（＋ 打点）一直是已有功能
- 拖动→自动打点分支（hasAnimX/hasAnimY → add_keyframe）**已写但 jsdom 未单测**（走现成 add_keyframe），**未真机验证**
- 用户反馈"还没做"= 真机验证缺失，非代码缺失

**待验证**：◆ 开 X/Y → 拖预览 → 是否出菱形 + 面板 ◆ 实心 + 曲线图更新

---

## 三、其他可能影响的因素（未验证）

1. **拖动中 refresh 竞态**：interactionDraft 设计上"只改 DOM 不碰 seg"，但 500ms 轮询 refresh 会**替换 Store.state.draft 整个对象**——如果 renderPreview 重建 rec（旧 rec.seg 引用失效）而 dragActive 标记在新 rec 上丢失，拖动会中断/跳变。
2. **update_segment_transform 的 _reload 语义**：所有写操作都先 `_reload()`（多进程同步设计）——单窗口场景下如果磁盘比内存旧，会回退。这与"内存态拖动 commit"（前端已改 DOM 但后端还没落盘）的组合可能有竞态。
3. **save_state 的 [SAVE-VERIFY-FAIL] 静默**：读回不一致只 print 不回滚 → 写盘"假成功"时前端 refresh 拉回坏数据，无法自动恢复。
4. **undo 栈与拖动事务**：GPT 评审要求的 undo transaction（beginTransaction/commitTransaction）**尚未实现**——update_segment_transform 是"单次 save_state 自动快照"，若多次拖动/多属性操作会压多条快照，undo 粒度乱。
5. **贴纸旧 transform 结构**：与视频/图片新 Schema 不一致，若未来贴纸也走拖动/自动打点会冲突。
6. **缩放/旋转手柄未实现**（第二批）：当前只拖位置。

---

## 四、代码现状地图（供 GPT 对照）

| 文件 | 函数 | 行号 | 说明 |
|---|---|---|---|
| property/preview-drag.js | onPreviewDragDown/Move/Up/Cancel | 全部 | 拖动全链路 |
| renderer.js | resolveTransform | ~665 | 三层解析 |
| renderer.js | applyKfTransform | ~682 | 应用 transform，dragActive 跳过 |
| renderer.js | _makeVisualEl | 10 | wrap 加 data-preview-el |
| main.py | update_segment_transform | 2760 | 写 seg.transform |
| main.py | save_state | 974 | _ensure_track_tids + 写盘 + 读回验证(静默) |
| main.py | undo / _reload | 2372 / 2329 | undo 先磁盘重载 |
| 工作台v0.8时间轴.html | canvasPxJS / 画布框同步 | 1488 / 1509 | 画布尺寸 |
| 工作台v0.8时间轴.html | .preview-stack / .vis-layer CSS | 110-114 | 布局（Bug1 源头） |

---

## 五、给 GPT 评审的问题

1. Bug 3 最可能的根因是哪个？undo 快照 vs refresh 渲染崩溃 vs _reload 回退——哪个最该先查/先修？
2. Bug 2 的 dragActive 残留假设成立吗？还是坐标单位语义问题？
3. Bug 1 是否确认是布局（stack 超出容器被裁），修法是缩放画布适配容器还是限制 stack 尺寸？
4. interactionDraft + 500ms 轮询 refresh 替换 draft 的竞态，正确解法是什么（冻结 refresh？draft 存 Store？）？
5. update_segment_transform 的 _reload 前置在单窗口场景是否必要/有害？
6. undo transaction 是否必须在本轮补（否则拖动会产生多条 undo）？

---

*记录：WorkBuddy · 2026-08-20 15:00 · 待 GPT 评审*
