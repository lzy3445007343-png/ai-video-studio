# KF State Machine · 关键帧状态机（2026-08-20）

> 来源：GPT 评审（kf-complete-plan-v4 §1.3）要求补的三个核心概念文档之一。
> 定位：**KF 系统唯一的语义权威**——"通道开关"与"当前位置命中"是两回事；交互中间态与提交态是两回事。
> 关联：C2 Interaction Kernel（GestureSession）/ C3 Command Transaction（withTx）/ property/kf-channel.js（B0）。

---

## 1. 为什么必须有状态机（GPT 核心论断）

> "你们之前踩坑的核心不是'关键帧代码没写'，而是把关键帧误当成了一个**动画通道开关**，而实际上剪映/PR/OpenCut 的关键帧系统本质是一个**时间状态机**。"

错误的抽象：`◆ 亮 = 该属性有关键帧`（v2 及更早，kf-panel.js `on = isAnimated`）→ 播放头移开菱形消失但按钮还亮 → 明显不专业。

正确的抽象：四个独立状态，两两正交。

---

## 2. 四态定义

| 状态 | 含义 | 判定 | 决定什么 |
|---|---|---|---|
| **channelOn** | 该属性是否**进入动画模式**（通道激活） | `isAnimated = seg.animations[path].keys.length > 0` | 输入框编辑语义：改的是 KF 还是静态值 |
| **hitOn** | 当前播放头是否**踩中**某 KF 锚点 | `∃key: |key.t − playheadLocalUs| ≤ 1000`（±1ms，与后端合并容差一致） | ◆ 外观：亮/灰；◆ 点击语义：删该点/打该点 |
| **draft** | 交互过程中的**临时态**（未进 undo） | input 聚焦 / 拖拽进行中 | 预览显示用 draft 值；绝不经 CommandService |
| **committed** | 已提交的**正式态**（进 undo） | blur/Enter/松手后 | Store.document 的真实数据 |

**核心正交性**：
```
channelOn × hitOn 是"通道维度"的两个正交判定
draft × committed 是"时间维度"的两个正交判定

例：
- channelOn=true, hitOn=false  → 通道开着，但播放头在两个 KF 之间（◆ 灰，输入框显示插值）
- channelOn=false, hitOn=false → 纯静态值（◆ 灰，输入框显示 transform/static）
- channelOn=true, hitOn=true  → 播放头恰好在 KF 上（◆ 蓝，输入框显示该 KF 的 v）
```

---

## 3. ◆ 按钮状态表（UI 层）

| channelOn | hitOn | ◆ 外观 | 点击动作 |
|---|---|---|---|
| false | false | 空心灰 | `add_keyframe(playheadLocal, 当前面板值)` → 打点（channelOn 变 true） |
| true | false | 空心灰 | `add_keyframe(playheadLocal, 当前面板值)` → 在当前位置新增点 |
| true | true | **实心蓝** | `remove_keyframe(playheadLocal)` → 删当前点；删空 → B0 removeIfEmpty 自动清通道（channelOn 变 false） |
| false | true | **（不可能）** | 有 key 必然 channelOn=true，该组合不存在 |

**关键裁决（GPT）**：
- ◆ 点击 = **当前位置单点 toggle**，绝不是 `clear_channel()`（否则三个点被一次点击全删，反直觉）
- 删除最后一个点 → keys=[] → 自动 remove channel → channelOn=false（B0 已实现，语义正确）

---

## 4. 输入框编辑状态机（B1 已落码，此处形式化）

```
focus（_kfEditing=true，refresh 暂停 draft 替换）
  │
  ├─ input 事件（交互中，只改 draft）
  │    ├─ channelOn=true  → KfChannel.upsertLocal(seg, path, local, v)   // 本地打点，不进后端/undo
  │    └─ channelOn=false → setProperty(seg, path, v)                     // C1 静态值本地态
  │    两者都 renderPreview()（预览跟手，0 次后端 call）
  │
  └─ blur / Enter（交互结束，一次 Command Transaction）
       ├─ channelOn=true  → CommandService.withTx → add_keyframe(...)
       └─ channelOn=false → CommandService.withTx → update_segment_transform(...)
       → 一条 undo
```

---

## 5. 预览拖拽状态机（B2.2 落码时用，对齐 C2 GestureSession）

```
pointerdown（命中 wrap，位移<3px = 单击选中；≥3px = 进入拖动）
  │  beginTransaction("move element")          // C3 事务起点
  │  dragSession.active = true                  // ★ Interaction Lock
  ▼
pointermove（只写 draft.interaction，renderer 读 draft，绝不 refresh/renderAll）
  ▼
pointerup
  ├─ channelOn=true  → add_keyframe(playheadLocalSnap, 新值)
  └─ channelOn=false → update_segment_transform({transform})
  │  commitTransaction()                        // 一条 undo
  │  dragSession.active = false                 // ★ 释放 Interaction Lock
  │  refresh() 回填；清空 draft.interaction
```

**Interaction Lock（GPT 1.4 定案）**：`dragSession.active=true` 期间禁止：
- 面板刷新覆盖（updateKfPanelValues 跳过）
- 播放头更新覆盖（renderPlayheadUI 对 KF 面板的联动暂停）
- 其他编辑入口（blur 提交、toggleKf、addKfAtPlayhead 全部互斥）

---

## 6. 状态转换总表

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
  [空] ──add_keyframe──► [channelOn=true]                         │
                    │       │ 播放头移动（hitOn 随 playheadUs 变）│
                    │       ▼                                     │
                    │  [hitOn=false] ◄──playhead 移开── [hitOn=true]
                    │       │                                        │
                    │       └──remove 最后一个点──► [空]（通道自动清理）
                    │                                             │
  draft：input/拖拽中 ◄──任何交互开始──► committed：blur/松手
```

---

## 7. 落地检查表（B2.1 验收）

- [ ] `kfHitAtPlayhead(anims, path, localUs)` 函数存在（±1ms）
- [ ] buildKfRow 的 ◆ class 用 hitOn（不是 isAnimated）
- [ ] updateKfRowValues 播放头移动时同步刷 ◆ class + 输入框值
- [ ] toggleKf 改为单点 toggle（remove_keyframe(localUs) / add_keyframe）
- [ ] 结构 key（stateBits）仍用 isAnimated（通道开关才 rebuild，播放头移动只 update 不 rebuild）
- [ ] 真机：拖播放头跨 KF → ◆ 亮→灰→亮 实时变化

---

*设计者：WorkBuddy · 2026-08-20 · kf-state-machine v1（GPT 要求，B2.1 落码依据）*
