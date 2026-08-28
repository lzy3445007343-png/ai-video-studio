# GPT 评审：KF 拖动问题——时间链路审计指令（2026-08-22）

> 来源：用户将问题报告 `kf-drag-problem-report-2026-08-21.md` 发给 GPT，GPT 返回此评审。
> 本文档 = GPT 评审原文归档 + 我方落码记录（commit a26a555）。

## 一、GPT 的第一判断

最可疑的不是 marker 合并 / data-kids / group drag / update_keyframe / ±1帧 对齐——这些解释不了 X/Y 稳定差 20 帧。

数据铁证：
```
KF2: X=3783326, Y=3116666, 差=666660
KF3: X=5849993, Y=5183333, 差=666660
33333 × 20 = 666660
```
**确定性时间偏移**。排查优先级：
1. 找出 X 和 Y 两次 add_keyframe 实际收到的 t
2. 找出这两个 t 从哪来
3. 最后才看 marker / group drag

## 二、关键二分法（定位分叉点）

- **A**：若日志证明 X/Y 都收到 3783326，但库里变成 X=3783326/Y=3116666 → 查后端 add_keyframe / 跨通道对齐 / upsert / merge
- **B**：若日志证明 X 收到 3783326、Y 收到 3116666 → 后端洗清，查前端为什么两个调用拿到不同时间

## 三、指令：不要改代码，做「KF 时间链路审计」

只加日志，不改变行为。对一次预览拖拽：
```
pointerdown → drag start → pointerup → localSnap → X add_keyframe → Y add_keyframe → backend received → backend stored
```
每一步打印：playheadUs / localUs / segment.start / segment.duration / snapFrame(...) / localSnap / X t / Y t。
尤其是 **X add_keyframe t 与 Y add_keyframe t**。

## 四、唯一时间 ID

不只打印 X=xxx/Y=xxx，而是带 gestureId：
```
KF_TX = 12345
pointerdown: playheadUs=?
drag: playheadUs=?
pointerup: localSnap=?
commit: X t=? Y t=?
backend: X t=? Y t=?
```
一眼看出谁把 20 帧塞进去。

## 五、B3.4 跨通道自动对齐：暂时撤掉

GPT 判断这是"危险的修复"：
- 一个通道的 KF 时间不应该偷偷决定另一个通道的时间（X:0/1/2, Y:0/1.5/3 完全合法）
- 自动对齐会把 X=100/Y=666760 这种真实错位掩盖掉
- 正确结构：预览拖动这类"联合操作"明确产生一个共同时间，而不是后端猜

## 六、OpenCut 到底怎么做（GPT 的严谨声明）

- OpenCut Classic 是官方原始版本，已归档；官方明确 legacy/classic 是可参考的完整旧版编辑器
- 0.3.0 changelog 确认：X/Y 可独立 KF、KF 可复制粘贴、timeline 可展开到每个 animated property、有 graph editor/Bezier、有 preview zoom/pan
- **但**：仅凭公开网页搜索，GPT 不能负责任地断言 preview-drag 是 pointerdown 快照还是 pointerup 实时时间。**"用户实机确认"比 GPT 网页证据更强**。GPT 不假装知道。

## 七、编辑器设计原则：pointerdown 锁定编辑时间

拖预览素材 → 松手 → 自动产生 KF，应采用：
```
pointerdown → editTime = currentPlayhead → drag → pointerup → 用 editTime 给 X/Y 打 KF
```
原因：拖动中 playhead 刷新/播放状态变化/seek/timeline refresh/外部命令/subscription 任何一个改变 playheadUs，都会让 X→时间A、Y→时间B。一次 Gesture 必须拥有 immutable edit context（与 C2 GestureSession 思想契合）。

## 八、更大的架构问题：时间概念混用

明确区分：
```
globalUs
  ↓ localUs = globalUs - segment.startUs
  ↓ frameUs = snap(localUs, fps)
```
一次 Gesture 只产生一个 EditTimeContext `{globalUs, localUs, frameIndex}`，X KF/Y KF 都用 `context.localUs`，不要每个属性自己重新计算。

## 九、segment 边界规范

播放头在 segment 开头/结尾时统一 `[0, duration)` 还是 `[0, duration]`，否则 split/trim/duplicate/speed 都会出 KF 边界问题。建议写进 KF 规范。

## 十、"像复制"现象 = 第二条独立问题（BUG B）

不要和 20 帧问题混在一起。正确模型：
```
DragStart: selected KF immutable snapshot
  ↓
Move: newTime = originalTime + delta
  ↓
Commit: update selected KF
```
而不是"当前 DOM marker → 重新查询 → 修改 → 再查询 → 继续修改"（后者会出现"原来的 marker 还在 + 新 marker 又出来"）。

## 十一、X 的 value 从 -147.86 变 407.14（尤其值得查）

update_keyframe(value=null) 确实不会更新 value。v 变了 → 一定有另一条写 v 的路径。重点搜：
add_keyframe / upsertLocal / setProperty / update_segment_transform / preview-drag commit / group-keyframe drag
问：谁在 group drag 过程中调用了 add_keyframe(path, time, value)？
拖关键帧时间理论上应是 `update_keyframe(id, t=newTime)`，而不是 `add_keyframe(path, t=newTime, v=currentPreviewValue)`。若后者被复用 → "我只是拖时间，为什么值也变了"。

## 十二、拆成两个 Bug

- **BUG A：KF 时间错位**——一次 preview drag，X.t = T，Y.t = T。排查 pointerdown→editTime→pointerup→X request→Y request→backend→storage。暂时不要再加任何自动对齐。
- **BUG B：KF 时间拖动导致 value 改变 / 像复制**——拖时间：t 改变、v 不变；组拖：A(t1+Δ,v1)、B(t2+Δ,v2)，绝对不能出现 v1→新值。

## 十三、专业级要求：marker 是 UI 聚合，数据仍独立

同一时间点的 X/Y marker 视觉合并，但数据独立：
```
KF time=3s: X={t:3s,v:100}, Y={t:3s,v:200}
```
不要合并成 `{t:3s, x:100, y:200}`。data-kids/data-paths 方向正确。Marker 是 UI 聚合对象，KF 仍是 property-level 原子对象（对 X/Y 单独删除/编辑/复制/多选/undo 至关重要）。

## 十四、B3.4 定义为"有风险的补丁"，先关掉

不要让后端替前端纠错。正确结构：
```
Gesture → EditContext → 共同 localUs → X/Y 两个 KF
```
而不是 X KF → Y KF → 后端猜"应该差不多" → 自动对齐。

## 十五、最终方向：Keyframe Edit Transaction

一次用户操作就是一个完整事务：
```
User Gesture → EditContext{targetSegment, editTime, selectedKeys, originalValues}
→ Draft → Preview → Commit → X KF / Y KF → ONE Command Transaction → ONE Undo
```
这个软件最终是给 AI Agent 操作的剪辑器。以后让 Agent 执行"在 3 秒把这个素材移到右边，5 秒再移回来"→ 直接生成结构化 KeyframeEditTransaction，而不是模拟鼠标。这是 C1-C5 架构真正应该往下走的方向。

---

## 我方落码记录（2026-08-22）

- **commit a26a555**：审计准备
  - main.py add_keyframe：跨通道对齐默认禁用（`KF_ALIGN_CROSS_CHANNEL=1` 才开）；加 `[KF-AUDIT]` 日志：received(time_us)→t_clamped→store(NEW/UPDATE)
  - main.py update_keyframe：加 `[KF-AUDIT]` 日志：received(before t/v)→stored(after t/v)
  - preview-drag.js：gestureId（pointerdown 锁定）+ pointerdown 日志（segStart/segDur/playheadUs/localSnap）+ commit 日志（xTimeUs/yTimeUs）
  - jsdom 11 测试全绿（行为零变更）

## 待办

- [ ] 用户复现一次 preview-drag，抓 `[KF-AUDIT]` 日志（后端看 start.bat 窗口 / 前端看 DevTools console）
- [ ] 按二分法判断分叉点（前端发送 or 后端存储）
- [ ] BUG A 修复：EditTimeContext 统一时间
- [ ] BUG B 修复：拖时间绝不改 v（找写 v 的另一条路径）
- [ ] segment 边界规范 `[0, duration)` vs `[0, duration]` 写入 KF 规范
