# 关键帧（KF）完整蓝图 v3 · 2026-08-20

> 状态：**v3 全新重排（v2 已做部分 + 新发现缺口 + 完整重写），待 GPT 评审 + 用户 sign-off**
> 位置：`docs/architecture/kf-complete-plan-v3-2026-08-20.md`（v2 存档：`kf-complete-plan-2026-08-20.md`）
> 背景：用户真机实测 OpenCut 后提出两个**之前方案里完全没有**的点：① 参数面板 ◆ 蓝点是"当前位置是否命中关键帧"的状态机，不是"通道是否激活"；② 参数面板 / 预览拖拽 / 时间轴三处打关键帧必须**实时互通**。本版把已落地的 B0/B1/B2 全部盘点进文档，把新发现的问题放到**重点位置**，并整体重排待做清单。
> 前置：C1 Property Kernel ✅ C2 Interaction Kernel ✅ C3 Command Transaction ✅ C4 Subscription Slice ✅ C5 Canvas Coordinate ✅ R1 Element Bounds ✅

---

## 0. ⚠️ 给 GPT 评审的三个问题（本版重点，请优先回答）

**Q1｜我们的方案还差什么？** 我们刚发现两个之前没写进方案的缺口（详见 §3）：
- ◆ 蓝点是"播放头当前位置是否恰好在 KF 锚点上"的状态机，不是"该参数是否开过关键帧"
- 参数面板 / 预览拖拽 / 时间轴菱形三向实时通信（其中预览拖拽→自动打 KF 的方案已写但未落码）

**除此之外，以"做一个剪映 / PR 级别的关键帧系统"为标准，我们还没注意到的点还有哪些？** 请从这些方向帮我们查漏：
- 关键帧时间基准：段内局部时间（localUs）vs 全局时间轴的换算，跨段/跨素材操作时的边界
- ◆ 按钮的点击语义（我们的 toggleKf 是"开关通道"；OpenCut 是"当前位置有无 KF 的开关"，v3 想对齐，见 §3.3）
- undo 粒度：面板输入（blur 一次事务）与预览拖拽（松手一次事务）双路径并存时，如何保证"一次用户动作 = 一条 undo"不被打穿
- 关键帧与静态 transform 的关系（三层解析 animation→transform→default 是否够）
- 导出剪映映射的完整覆盖（缩放/旋转/透明度/多关键帧时间轴）
- 曲线编辑器（linear/hold/bezier）、音量 KF、跨段复制粘贴等后续项的取舍顺序

**Q2｜◆ 按钮语义对齐 OpenCut，是否正确？**
OpenCut 行为（用户真机确认）：◆ 实心蓝 = **当前播放头位置**在该参数上有关键帧；播放头移开 → ◆ 变灰；点击 ◆ = 在当前位置**添加/删除**关键帧（toggle 单点），不是"清空整条通道"。
我们现状：◆ = `isAnimated`（通道有 key 就永远亮）；点击 = 有 key 清空整条通道 / 无 key 打一个默认值点。
v3 计划按 OpenCut 对齐（◆ 状态 = 当前位置命中；点击 = 该处 toggle 单点）。**请确认这个对齐是否正确，以及"删除单点后通道自动清理"（B0 removeIfEmpty）是否就是 OpenCut 的通道生命周期语义。**

**Q3｜B1 本地打点 + 预览拖拽 draft 双路径的 undo 一致性？**
B1（已落码）：面板 input 期间前端 `upsertLocal` 本地打点（不进后端/undo），blur/Enter 才一次 `CommandService.withTx` 提交 → 一条 undo。
预览拖拽（未落码，方案已审）：拖动期间只写 `draft.interaction`（C2 中间态），松手一次 commit → 一条 undo。
两者并存时：**用户在面板输入改值、又去预览拖拽、又回来改面板**，undo 栈如何保证每次用户动作只有一条记录？有没有需要统一的地方（比如 draft 期间禁止另一个入口，或共用同一个 withTx 上下文）？

---

## 1. 目标（v3 更新）

让关键帧成为**完整可用的参数动画系统**（对齐 OpenCut / 剪映）：

```
面板改值 → 预览跟手 → ◆ 状态实时 → 时间轴菱形跟随
  播放头移动 → 插值应用 → 预览拖拽打点 → 三向同步 → 导出剪映可编辑
```

**范围确认（用户拍板）**：
- ✅ 已做通道：宽度 W / 高度 H / 位置 X / 位置 Y / 旋转 / 不透明度（6 通道）
- ⏳ 待做：音量 KF（B6，走 AudioEngine）
- ❌ **虚化（blur）不在本方案范围内**——用户明确暂时不要

---

## 2. 已做盘点（代码实证，含怎么做的）

### 2.1 数据模型（✅ 已定，与 OpenCut 同构）

```js
seg["animations"] = {
  "transform.positionX": { keys: [ {id, t, v, seg}, ... ] },
  ...
}
// t: 段内局部时间（微秒，0..duration）★ 键名是 t 不是 time（曾踩坑：误读 k.time 导致菱形全在段开头）
// v: 数值（像素/倍数/角度/0~1）；seg: "linear" | "hold"
```

- 后端 7 通道（main.py:1379 KF_PROPS）：positionX/Y、scaleX/Y、rotate、opacity + **volume**
- 前端 6 通道（HTML:1502 KF_PATHS_BY_TYPE）：video/image/sticker 共用（positionX/Y、scaleX/Y、rotate、opacity）；audio/text 无 transform KF

### 2.2 后端命令（✅ 全在，main.py:2882-2981）

| 命令 | 职责 | 状态 |
|---|---|---|
| `add_keyframe` | 打点/更新（±1ms 内同点合并） | ✅ |
| `update_keyframe` | 改 value/时间/插值 | ✅ |
| `remove_keyframe` | 删单个点 | ✅ |
| `get_keyframes` | 查通道 | ✅ |
| `clear_keyframes` | 清通道 | ✅ |
| `_apply_keyframes_to_segment` (1599) | 导出剪映映射（坐标换算/旋转/透明度） | ✅ 代码在，真机未验（B5） |

### 2.3 前端骨架（✅ 在）

| 函数 | 位置 | 职责 |
|---|---|---|
| `toggleKf(path)` | HTML:1664 | ◆ 开/关（现状=通道语义，v3 改单点语义） |
| `addKfAtPlayhead(path, val)` | HTML:1678 | 播放头处打点 |
| `kfVal(anims, path, localUs)` | HTML:1579 | 线性/hold 插值（与后端 _kf_interp 一致） |
| `renderKfGraph` / `renderKfSel` / `onKfDiamondDown` | HTML:1595/1617/1641 | 曲线图/选中帧编辑/曲线菱形拖拽 |
| `property/kf-channel.js`（B0，200 行） | property/ | 通道生命周期统一入口 |
| `property/kf-panel.js`（B1+B2） | property/ | 面板 UI：分组 section、◆、输入框、＋ |
| 时间轴白菱形 `kf-marker` | timeline.js | ✅ 显示（e8e030f）+ 位置修 k.time→k.t（9b28bb6） |

### 2.4 已落地里程碑（B0/B1/B2 怎么做的）

| 里程碑 | commit | 做了什么 |
|---|---|---|
| **B0 KF Channel Manager** | 19d58a2 | `ensure/removeIfEmpty/isAnimated/getCurrentValue/upsertLocal/removeLocal`——通道生命周期统一入口，杜绝"有 channel 没 key"脏状态；upsertLocal ±1ms 合并本地打点 |
| **B1 参数修改 + Preview Draft** | 06689b7 + 1780b54 | input 事件：通道开→`KfChannel.upsertLocal` 本地打点+renderPreview；通道关→`setProperty`（C1 kernel）+renderPreview（**0 次后端 call**）；blur/Enter→`CommandService.withTx` 一次事务（开：add_keyframe / 关：update_segment_transform）；`_kfEditing` 聚焦期间暂停 refresh 轮询覆盖 |
| **B2 播放头联动** | 1780b54 | `Store.subscribeSlice("playheadUs", updateKfPanelValues)`（HTML:3114）——独立订阅者，不挂 renderPlayheadUI；updateKfRowValues 跳过快照覆盖正在编辑的 input |

**已通链路**：面板改值→预览跟手 ✅（B1）；播放头移动→面板值实时变 ✅（B2）；时间轴菱形显示+位置 ✅（B0）。

---

## 3. ⚠️ 刚发现的问题（v3 重点，之前方案没写，GPT 未审）

> 用户真机实测 OpenCut 后提出，以下是复述 + 技术化。

### 3.1 ◆ 蓝点状态机错误（"永远亮"）

**OpenCut 行为**（用户确认）：
- 播放头**恰好落在**某 KF 锚点上 → 该参数 ◆ 实心蓝
- 播放头移开（不在任何 KF 上）→ ◆ 变灰/消失
- 再在预览里拖素材打新点 → ◆ 又亮

**我们现状**：`buildKfRow` 里 `on = KfChannel.isAnimated(seg, path)`（kf-panel.js:155），`kfOnOff` 只看 `keys.length`（kf-panel.js:99）——**只要通道有 key 就永远亮**，与播放头位置无关。

**修正方案（B2.1）**：
```js
// 新增：当前位置是否命中 KF（±1ms，与后端 add_keyframe 合并容差一致）
function kfHitAtPlayhead(anims, path, localUs) {
  const ch = anims && anims[path];
  if (!ch || !ch.keys) return false;
  return ch.keys.some(k => Math.abs((k.t || 0) - localUs) <= 1000);
}
```
- **两个概念拆开**：`channelOn = isAnimated`（通道激活，决定输入框编辑语义：改的是 KF 还是静态值）vs `hitOn = kfHitAtPlayhead`（当前位置命中，决定 ◆ 外观）
- `buildKfRow`：◆ 初始 class 用 `hitOn`
- `updateKfRowValues`（播放头移动时触发）：**同步刷新 ◆ class + 输入框值**（现在只刷值不刷 ◆）
- 结构 key（stateBits）**不变**——◆ 外观变化不 rebuild，走 updateKfRowValues（播放头移动只 update 不 rebuild，已有机制）

### 3.2 三向实时通信缺失

**OpenCut 行为**（用户确认）：预览框里拖素材 → **自动在当前播放头位置打关键帧** → 时间轴菱形 + 面板 ◆ 实心 + 面板值 三处**同时**更新。

**我们现状**：

| 链路 | 状态 |
|---|---|
| 面板改值 → 预览 | ✅ B1 已通 |
| 播放头移动 → 面板值 | ✅ B2 已通 |
| 时间轴菱形显示 | ✅ B0 已通 |
| **预览拖素材 → 自动打 KF** | ❌ **方案已写（preview-drag-keyframe-方案-2026-08-20.md v2，GPT 已审 7 条）但代码一行未落** |
| **拖完 → 面板 ◆ / 值 / 时间轴菱形同步** | ❌ 依赖 B2.1 + 拖拽落码 |

**修正方案（B2.2）**：把 `preview-drag-keyframe-方案-2026-08-20.md`（v2 已审）落码。核心：
- `seg.transform` 静态层 + 三层解析 `animation → transform → default`（renderer.applyKfTransform 已按此实现，2cf1177）
- 预览元素绑 pointer 事件 → hit-test（zIndex 最上层）→ 拖动只写 `draft.interaction`（C2 中间态）→ 松手一次 commit（有 KF 通道→`add_keyframe` / 无→`update_segment_transform`）→ withTx 一条 undo
- 播放中禁止拖拽（编辑/播放分离，剪映/PR 同款）
- 落码顺序：Step 0 transform schema → Step 1 renderer 三层解析 → Step 2 hit-test → Step 3 drag draft → Step 4 commit → Step 5 undo 收口（详见该文档 §6）

### 3.3 ◆ 按钮语义：我们 vs OpenCut（Q2 的问题）

| | 我们现状（toggleKf，HTML:1664） | OpenCut |
|---|---|---|
| ◆ 亮 = | 通道有 key（isAnimated） | **当前位置命中 KF** |
| 点击 = | 有 key → 清空整条通道；无 key → 打一个默认值点 | **当前位置 toggle 单点**：有 KF → 删该点；无 KF → 该处打点 |
| 通道生命周期 | B0 removeIfEmpty 管（删空自动清通道） | ？待 GPT 确认 |

**v3 计划**：◆ 外观 + 点击语义都对齐 OpenCut（B2.1 改外观，点击语义随 B2.1 一起改）。通道生命周期仍由 B0 管（删最后一个点 → 自动清通道 → isAnimated=false）。**此对齐是否正确请 GPT 裁决（Q2）**。

### 3.4 "一个时间点只能有一个关键帧"

用户原话："一条素材上可以有多个关键帧，但一个时间点（一帧）上只能有一个关键帧。"

**现状**：✅ 已是硬约束——前端 upsertLocal（kf-channel.js:64）和后端 add_keyframe（main.py）都是 ±1ms 内同点合并（更新 v 而非新增）。无需再改，写出来让 GPT 确认语义完整（同 t 不同参数 = 各自通道独立，互不干扰）。

---

## 4. 待做清单（v3 重排）

| # | 任务 | 依赖 | 状态 |
|---|---|---|---|
| B0 | KF Channel Manager | 无 | ✅ 已落（19d58a2） |
| B1 | 参数修改 + Preview Draft（本地临时态 + blur 一次事务） | B0 | ✅ 已落（06689b7+1780b54） |
| B2 | 播放头联动（playheadUs 独立订阅者） | B1 | ✅ 已落（1780b54） |
| **B2.1** | **◆ 状态机修复 + 点击语义对齐 OpenCut（3.1+3.3）** | B2 | ⬜ 本轮重点，小补丁 |
| **B2.2** | **预览拖拽→自动打 KF（preview-drag-keyframe v2 落码，3.2）** | B2.1 | ⬜ 本轮重点，方案已审 |
| **B2.3** | **三向同步验收（拖拽→◆/值/菱形全同步，含跨操作 undo 一致性）** | B2.2 | ⬜ 验收项 |
| B3 | 菱形拖拽改时间（对齐 use-keyframe-drag） | B1 | ⬜ 已定 |
| B5 | 导出映射真机验证（1080x608 测试项目对照） | B1-B4 | ⬜ 已定，单独验证 |
| B4 | 曲线图增强（hold 显示 + renderKfSel 完整） | B3 | ⬜ 已定 |
| B6 | 音量 KF（走 AudioEngine，非 OverlayState） | B1 | ⬜ 已定 |
| B7 | 菱形复制粘贴 / 框选多选 | B3 | ⬜ 已定 |
| B8 | Bezier 曲线 / 缓动预设 | B4 | ⬜ 已定 |

**第一批（v3）：B2.1 → B2.2 → B2.3**（把用户刚发现的两个缺口补上，形成"面板/预览/时间轴三向同步"闭环）。之后 B3 → B5 → B4 → B6 → B7 → B8 沿用 v2 定序。

**范围剔除**：虚化（blur）关键帧——本方案不做。

---

## 5. B2.1 ◆ 状态机 + 点击语义（具体改动点）

### 5.1 改动文件

| 文件 | 改动 |
|---|---|
| `property/kf-panel.js` | 新增 `kfHitAtPlayhead`；`buildKfRow` 的 on 拆 channelOn/hitOn；`updateKfRowValues` 同步刷 ◆ class；◆ 点击改为 `toggleKfAtPlayhead(path)` |
| HTML `toggleKf` (1664) | 改为单点 toggle：hitOn→`remove_keyframe`(该点) / 未命中→`add_keyframe`(当前位置, 当前面板值) |
| HTML `kfOnOff` (99 行逻辑) | 结构 key 仍用 isAnimated（通道开关才 rebuild）；◆ 外观走 updateKfRowValues |

### 5.2 交互语义（对齐 OpenCut）

```
[播放头在 KF 上] ◆ 实心蓝 → 点击 = 删除该关键帧（删空通道自动清理 → ◆ 变灰 + isAnimated=false）
[播放头不在 KF 上] ◆ 空心 → 点击 = 在当前位置打一个点（值 = 当前输入框显示值）
```

### 5.3 与 B1 的关系

B1 的"通道开 → 输入框改值 = 改当前 key"语义不变——只是 ◆ 不再表示"通道开"，输入框编辑语义仍由 `isAnimated` 决定。**两概念分离，互不污染。**

---

## 6. B2.2 预览拖拽→自动打 KF（落码执行计划）

> 完整方案见 `docs/architecture/preview-drag-keyframe-方案-2026-08-20.md`（v2，GPT 7 条已审）。此处只列落码步骤。

```
Step 0  seg.transform 静态层确认（已定：transform = {x,y,scaleX,scaleY,rotation,opacity}）
Step 1  renderer 三层解析确认（animation → transform → default）——已实现（2cf1177），补静态层读取
Step 2  预览元素 pointerdown + hit-test（zIndex 最上层，位移 <3px = 单击选中）
Step 3  拖动：只写 draft.interaction（C2 中间态），renderer 读 draft，绝不 refresh/renderAll
Step 4  松手一次 commit：有 KF 通道→add_keyframe(path, localUsSnap, v)；无→update_segment_transform
Step 5  withTx 收口（一条 undo）+ pointer capture + 播放中禁止拖拽
Step 6  验收：◆ 开后拖预览 → 播放头位置出现菱形 + 面板 ◆ 实心 + 曲线图更新
```

---

## 7. B3-B8（沿用 v2 定序，简要）

- **B3 菱形拖拽改时间**：对齐 OpenCut use-keyframe-drag；拖时间轴菱形 → seek 播放头 + update_keyframe(time_us)；复用 C2 GestureSession + C3 withTx；marker 已有 data-path/data-kftime
- **B5 导出验证**：1080x608 测试项目，素材中心 x=100/y=50/rot=30/scale=1.2 打一个 KF → 导出剪映对照；不通过 → 修 `_apply_keyframes_to_segment` 坐标换算
- **B4 曲线图增强**：hold 显示 + renderKfSel 完整编辑
- **B6 音量 KF**：走 AudioEngine 增益，不走 OverlayState（GPT 定案）
- **B7 复制粘贴/框选多选**：Ctrl+C/V 跨元素复制
- **B8 Bezier/缓动预设**：曲线拉弧度

---

## 8. 风险与护栏（v3 新增）

| 风险 | 缓解 |
|---|---|
| ◆ 外观与 isAnimated 语义混淆（3.1 根因） | channelOn/hitOn 两概念拆开，代码注释标明；B2.1 验收：拖播放头看 ◆ 亮灭 |
| 预览拖拽与播放冲突 | 已定：播放中禁止拖拽（编辑/播放分离） |
| 面板 blur 事务 vs 拖拽松手事务双路径 | 都走 withTx 一次事务；Q3 待 GPT 确认是否需要统一入口互斥 |
| B1 本地打点未提交（用户不 blur 直接关面板） | blur + Enter + 面板销毁钩子三路径 commit（v2 已定） |
| 拖拽松手打的 KF 值 = 面板显示不一致 | 拖拽前先按当前播放头读 kfVal 作为基准值，松手写新值 |
| ◆ 点击删除误伤（点在两个 KF 之间点击 ◆） | 语义明确：未命中时点击 = 打点（不是删）——只有命中才删，天然安全 |

---

## 9. 给 GPT 评审的问题汇总（即 §0，复述供快速定位）

1. **Q1**：以剪映/PR 级别的关键帧系统为标准，我们方案还差什么？（方向：时间基准/◆ 语义/undo 双路径/三层解析/导出映射/曲线编辑器取舍）
2. **Q2**：◆ 按钮对齐 OpenCut（当前位置命中 + 单点 toggle）是否正确？通道生命周期由 B0 removeIfEmpty 管是否就是 OpenCut 语义？
3. **Q3**：面板输入（blur 事务）与预览拖拽（松手事务）双路径并存时，undo 一致性如何保证？是否需要统一入口互斥？

---

*设计者：WorkBuddy · 2026-08-20 22:10 · v3 全新重排（含用户新发现的 3.1/3.2/3.3 缺口），待 GPT 评审后用户 sign-off*
