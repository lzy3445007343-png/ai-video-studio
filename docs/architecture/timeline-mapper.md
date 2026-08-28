# TimelineMapper · 时间映射层（2026-08-20）

> 来源：GPT 评审（kf-complete-plan-v4 §1.3）要求补的三个核心概念文档之二。
> 定位：**KF 时间基准的唯一权威**——KF 永远存段内局部时间，所有 UI 用全局时间，中间必须有一个转换层。
> GPT 原话："这个建议现在就建，否则 B3 菱形拖动一定重构。"
> 关联：timeline.js（时间轴渲染）/ player.js（播放头）/ B3 菱形拖拽 / 未来 trim/移动/复制。

---

## 1. 为什么必须有映射层

KF 的 t 是**段内局部时间**（localUs，0..duration），但所有 UI 交互（时间轴菱形位置、播放头、拖拽、选中）都在**全局时间轴**（globalUs）上。

如果不建立统一映射层，每个用到时间的模块各写各的换算，迟早出现：
- B3 菱形拖拽：local 当 global 用 → 菱形拖到错误位置
- 移动片段后：KF 时间没跟着走 → 动画错位
- 裁剪后：KF 相对时间错乱

## 2. 时间基准铁律

```
存储层（后端/数据模型）：  一律 local（段内局部，0..duration）
UI 层（时间轴/播放头/交互）：一律 global（全局时间轴，0..totalDuration）
中间：TimelineMapper 双向转换
```

## 3. 映射公式

### 3.1 基本映射（段未移动/未裁剪）

```js
// global → local：段内局部时间 = 全局时间 - 段起点
localUs = globalUs - segment.start

// local → global：全局时间 = 段起点 + 段内局部时间
globalUs = segment.start + localUs

// 钳制：local 永远在 [0, segment.duration]
localClamped = Math.max(0, Math.min(localUs, segment.duration))
```

### 3.2 段的身份

段（segment）通过 `(track_type, track_index, index)` 三元组寻址，`segment.start` 是段在时间轴上的起点（全局微秒）。**KF 的 t 与 segment.start 解耦**——移动段时 start 变，KF 的 t 不变（相对时间保持）。

## 4. 关键操作的时间语义（GPT 第四层缺口 11 的预登记）

| 操作 | 规则 | 说明 |
|---|---|---|
| **移动片段**（move_segment） | KF 的 t **不变**（相对段起点保持）；segment.start 变 → global 位置自动跟随 | 最简单，天然正确 |
| **裁剪头**（trim in） | 段起点右移 Δ → KF 的 t **左移 Δ**（保持相对素材时间）；t<0 的 KF 删除或钳制到 0 | 剪映/PR 规则：保持相对素材时间 |
| **裁剪尾**（trim out） | duration 变短 → t>新duration 的 KF 删除或钳制 | 同上 |
| **复制粘贴**（B7，第二阶段） | 粘贴时 KF 用 **offset 相对时间**（0/1s/2s），非 absolute（GPT 缺口 2） | clipboard 存 offset |
| **变速**（未来，第三阶段） | 速度×2 → KF 的 local 时间按速度比换算（GPT 缺口 12） | 暂不实现，接口预留 |

## 5. API 设计（前端，property/ 或独立模块）

```js
const TimelineMapper = {
  /** global → local（段内局部，钳制到 [0, duration]） */
  globalToLocal(seg, globalUs) {
    return Math.max(0, Math.min(globalUs - seg.start, seg.duration));
  },

  /** local → global（段起点 + 局部） */
  localToGlobal(seg, localUs) {
    return seg.start + Math.max(0, Math.min(localUs, seg.duration));
  },

  /** 时间轴菱形位置（px）：kf.t 是 local，渲染要转 global 再乘 pps() */
  kfMarkerPx(seg, k, pps) {
    return this.localToGlobal(seg, k.t) / 1e6 * pps;
  },

  /** 播放头当前在段内的 local 时间（KF 面板/打点用） */
  playheadLocal(seg, playheadGlobalUs) {
    return this.globalToLocal(seg, playheadGlobalUs);
  },
};
```

## 6. 现状检查（哪些地方已经在用，哪些要改）

| 位置 | 现状 | 结论 |
|---|---|---|
| timeline.js `kf-marker` 位置 | `(k.t/1e6)*pps()` 段内定位（left 相对 seg 容器） | ✅ **正确**——kf-marker 是段内子元素，left 相对段自身，段起点偏移已由段 DOM 的 left 承担，local 直乘无问题（2026-08-20 核实，勿再改） |
| kf-panel.js `local` 计算 | `Math.max(0, Math.min(Store.state.playheadUs - s.start, s.duration))` | ✅ 等价 globalToLocal，但散落各处，收口到 Mapper |
| kf-panel.js input blur 打点 | `time_us: local`（local 传后端） | ✅ 正确（后端存 local） |
| 后端 add_keyframe | 存 local | ✅ 正确 |
| 播放头 seek | global | ✅ 正确 |

## 7. 落地检查表

- [ ] `TimelineMapper` 模块存在（globalToLocal / localToGlobal / playheadLocal；kfMarkerPx 仅作段内/全局换算的语义标注，不改变段内 left 定位）
- [ ] kf-panel.js local 计算收口到 TimelineMapper.playheadLocal
- [ ] B3 菱形拖拽：拖的是 global px → Mapper 转 local → update_keyframe(time_us=local)

---

*设计者：WorkBuddy · 2026-08-20 · timeline-mapper v1（GPT 要求，B3 前必落）*
