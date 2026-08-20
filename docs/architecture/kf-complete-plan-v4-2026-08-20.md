# 关键帧（KF）完整蓝图 v4 · 2026-08-20

> 状态：**v3 已评审（GPT 签字通过），v4 吸收全部意见（顺序调整 + 三阶段路线 + 三个核心概念文档），待用户 sign-off 后落码**
> 位置：`docs/architecture/kf-complete-plan-v4-2026-08-20.md`（v3 存档：`kf-complete-plan-v3-2026-08-20.md`）
> 前置：C1 Property Kernel ✅ C2 Interaction Kernel ✅ C3 Command Transaction ✅ C4 Subscription Slice ✅ C5 Canvas Coordinate ✅ R1 Element Bounds ✅ B0/B1/B2 KF 基础 ✅

---

## 1. GPT 评审结论（2026-08-20，已收）

### 1.1 签字项

| 项 | 结论 |
|---|---|
| KF v3 架构方向 | ✅ 通过（比 v2 成熟很多） |
| B0/B1/B2 基础设计 | ✅ 正确 |
| ◆ 状态机修正（B2.1） | ✅ **必须做**（channelOn / hitOn 拆分） |
| 预览拖动自动 KF（B2.2） | ✅ **必须做**（从"参数动画系统"变"编辑器"的关键一步，优先级非常高） |
| Undo 设计（双路径） | ✅ 正确（不合并，加 Interaction Lock） |

### 1.2 GPT 核心论断

> "你们之前踩坑的核心不是'关键帧代码没写'，而是把关键帧误当成了一个**动画通道开关**，而实际上剪映/PR/OpenCut 的关键帧系统本质是一个**时间状态机**。"
> "v3 发现的问题反而说明前面的 C1-C5 架构开始发挥作用了。"
> "你们现在真正的问题已经不是'能不能实现关键帧'，而是已经进入**编辑器语义一致性**阶段了。"

### 1.3 GPT 要求补的三个核心概念文档（已建，见 §5）

1. `kf-state-machine.md` —— KF 状态机（channelOn/hitOn/draft/committed）
2. `timeline-mapper.md` —— 时间映射层（global ↔ local）
3. `effective-property-resolver.md` —— 属性解析优先级（animation → transform → default）

> GPT 原话："这三个补完，你这个 KF 系统基本就进入专业剪辑器架构了。"

### 1.4 顺序调整（GPT 裁决：B5 提前到 B3 之前）

```
v3 顺序：  B2.1 → B2.2 → B2.3 → B3 → B5 → B4 → B6 → B7 → B8
v4 顺序：  B2.1 → B2.2 → B2.3 → B5 → B3 → B4 → B6 → B7 → B8
                                    ↑
                              导出验证提前
```

**原因（GPT）**：导出不要太晚。如果内部 KF 语义错了，导出验证会帮你**提前暴露**（1080x608 测试项目对照，改坐标系比改数据层便宜）。

---

## 2. 给 GPT 的三个问题 → 已回答（归档）

| 问题 | GPT 裁决 | 定案 |
|---|---|---|
| Q1 还差什么 | 方向对；补 3 个核心概念（§5）+ 13 项缺口登记（§4，分三阶段，**不阻塞当前落码**） | ✅ v4 |
| Q2 ◆ 语义对齐 OpenCut | 正确。点击=当前点 toggle（remove_keyframe(localUs)），**不是 clear_channel()**；删空通道由 B0 removeIfEmpty 自动清理 | ✅ v4 |
| Q3 双路径 undo | **不合并**。面板输入（blur 一次命令）与预览拖动（松手一次命令）天然是两个用户动作；但加 **Interaction Lock**：dragSession.active=true 时禁止面板刷新覆盖/播放头更新覆盖/其他编辑入口（C2 已有基础） | ✅ v4 |

---

## 3. 已做盘点（B0/B1/B2 落地，代码实证）

> 完整版见 v3 §2，此处仅保留索引。

- **数据模型**：`seg.animations[path].keys = [{id, t, v, seg}]`，t=段内局部微秒，键名 `k.t`（踩坑记录：曾误读 k.time）
- **后端命令**（main.py:2882-2981）：add_keyframe（±1ms 合并）/ update_keyframe / remove_keyframe / get_keyframes / clear_keyframes / `_apply_keyframes_to_segment`（导出映射，真机未验）
- **B0 KF Channel Manager**（19d58a2）：ensure / removeIfEmpty / isAnimated / getCurrentValue / upsertLocal / removeLocal
- **B1 参数修改 + Preview Draft**（06689b7+1780b54）：input 本地临时态（upsertLocal / setProperty）+ blur/Enter 一次 withTx；_kfEditing 防轮询覆盖
- **B2 播放头联动**（1780b54）：`Store.subscribeSlice("playheadUs", updateKfPanelValues)` 独立订阅者
- **前端骨架**：toggleKf(1664) / addKfAtPlayhead(1678) / kfVal(1579) / renderKfGraph / renderKfSel / 时间轴白菱形（timeline.js）
- **已通链路**：面板改值→预览 ✅ / 播放头→面板值 ✅ / 时间轴菱形 ✅

---

## 4. 缺口登记表（GPT 13 项，按三阶段归属）

> **决策**：第一阶段**不扩范围**（GPT 明确建议）。以下项登记在案，按阶段排入路线图。

| # | 缺口 | GPT 等级 | 归属阶段 | 说明 |
|---|---|---|---|---|
| 1 | **KF 组移动**（多选/框选/整组拖动保持相对间隔） | 第一层·必须 | 第二阶段 | B3 升级：单点拖动 → 多选组移动 |
| 2 | **KF 复制粘贴（相对时间偏移）** | 第一层·必须 | 第二阶段 | 剪贴板存 offset（0/1s/2s）非 absolute（10s/11s/12s） |
| 3 | **Bezier 插值**（ease in/out/自定义曲线） | 第一层·必须（非增强是核心） | 第二阶段 | B8 从"增强"提级 |
| 4 | Auto Key 自动记录模式 | 第二层·专业体验 | 第三阶段 | 播放中移动自动记录 |
| 5 | **上/下一 KF 导航**（◀ ◆ ▶） | 第二层·小但体验巨大 | 第二阶段 | goToPrevious/NextKeyframe() |
| 6 | **PropertyValueState**（值来源：keyframe/interpolated/static） | 第二层·内部状态 | **第一阶段（随 B2.1）** | 调试利器，见 effective-property-resolver.md |
| 7 | 缓动预设（Linear/Ease/Bounce/Elastic） | 第三层·高级 | 第三阶段 | preset generator |
| 8 | 跨 channel 复制（位置动画→缩放） | 第三层·高级 | 第三阶段 | B7 升级 |
| 9 | KF 锁定（防误拖） | 第三层·高级 | 第三阶段 | |
| 10 | 删除策略双入口（◆ 删当前点 vs 右键 Remove All） | 第二层 | 第二阶段 | ◆=删当前点已定；补"清除整个动画"入口 |
| 11 | **trim 对 KF 的影响**（裁剪后 KF 相对素材时间保持） | 第四层·易踩坑 | **TimelineMapper 预留**（第二阶段实现） | 见 timeline-mapper.md |
| 12 | 变速与 KF 关系 | 第四层·易踩坑 | 第三阶段 | 速度×2 后 KF 时间换算 |
| 13 | Nested / Compound Clip 合成 | 第四层·易踩坑 | 第三阶段 | 外层+内层 KF 叠加（Transform Matrix） |

---

## 5. 三个核心概念文档（GPT 要求，已建）

| 文档 | 内容 | 状态 |
|---|---|---|
| `docs/architecture/kf-state-machine.md` | channelOn（动画模式）/ hitOn（踩中 KF）/ draft（交互临时态）/ committed（已提交）四态 + 状态转换表 + 与 C2/C3 关系 | ✅ 已建 |
| `docs/architecture/timeline-mapper.md` | globalTime ↔ localTime 双向映射；**KF 永远存 local，UI 全用 global**；trim/移动/复制对 KF 的影响规则 | ✅ 已建 |
| `docs/architecture/effective-property-resolver.md` | getEffectivePropertyValue(seg, path, localTime) 三层解析：animation（有 KF→插值）→ transform（静态）→ default；**动画存在时静态值绝不覆盖动画**；PropertyValueState 来源标记 | ✅ 已建 |

---

## 6. 待做清单（v4 顺序，三阶段路线）

### 第一阶段（当前执行范围，目标 = PR 60%：用户觉得"这是正常剪辑软件的关键帧"）

| # | 任务 | 依赖 | 说明 |
|---|---|---|---|
| **B2.1** | ◆ 状态机修复 + 点击语义对齐 OpenCut | B2 | ✅ 已落（1ce4641 + 420e1b4 吸附修复）channelOn/hitOn 拆分；◆ 亮=当前位置命中 KF；点击=单点 toggle（remove_keyframe(localUs)）非 clear_channel；**随带 PropertyValueState 内部标记（缺口 6）** |
| **B2.2** | 预览拖动自动 KF | B2.1 | ✅ **已落码（2026-08-20 核实）**——`property/preview-drag.js` 自 b31eef4 起完整实现：hit-test + OverlayState draft + 松手 withTx commit（有 KF→add_keyframe / 无→update_segment_transform）+ 播放禁拖 + pointer capture。v4 初版误判"未落码"（只 grep HTML 未见绑定，实际绑定在 preview-drag.js 自动 bind）——**教训：查功能是否落地必须 grep 实际代码文件（property/*.js），不能只看 HTML** |
| **B2.3** | 三向同步验收 | B2.2 | ⬜ 真机验收：拖拽→◆/值/菱形全同步；undo 一致性验证 |
| **B5** | **导出验证（提前）** | B2.3 | 1080x608 测试项目：中心 x=100/y=50/rot=30/scale=1.2 打 KF → 导出剪映对照 |
| **B3** | 菱形拖拽改时间（单点） | B5 | 对齐 use-keyframe-drag；复用 C2 GestureSession + C3 withTx；**基于 TimelineMapper**（global↔local） |

### 第二阶段（PR 80%：关键帧编辑器能力，GPT"最大遗漏"）

- B3 升级：**KF 组移动**（多选/框选/整组拖动保持相对间隔）——缺口 1
- **KF 复制粘贴**（相对时间偏移 clipboard）——缺口 2（B7 重定义）
- **Bezier 插值**（ease in/out/自定义曲线）——缺口 3（B8 提级）
- **上/下一 KF 导航**（◀ ◆ ▶）——缺口 5
- 删除策略双入口（◆ 删当前点 ✅ + 右键 Remove All Keyframes）——缺口 10
- trim 对 KF 影响（TimelineMapper 落地实现）——缺口 11

### 第三阶段（PR 95%：高级能力）

- Auto Key 自动记录（缺口 4）/ 缓动预设（缺口 7）/ 跨 channel 复制（缺口 8）/ KF 锁定（缺口 9）/ 变速影响（缺口 12）/ Nested Clip（缺口 13）

---

## 7. 风险与护栏（v4 更新）

| 风险 | 缓解 |
|---|---|
| ◆ 外观与 isAnimated 混淆 | channelOn/hitOn 拆两概念（B2.1），kf-state-machine.md 定义状态表 |
| 面板 blur 事务 vs 拖拽松手事务互相踩 | **Interaction Lock**：dragSession.active 期间禁面板刷新/播放头更新/其他编辑入口（C2 已有基础，B2.2 显式化） |
| KF 时间基准混淆（B3 菱形拖拽必踩） | TimelineMapper 现在就建（GPT：否则 B3 一定重构）；KF 存 local、UI 用 global |
| 动画存在但静态值覆盖动画 | EffectivePropertyResolver 写死优先级：animation → transform → default（Kernel 规则，非 UI 层临时判断） |
| 导出映射与内部语义不一致 | **B5 提前**：早期导出验证暴露语义错误，改数据层比改坐标系便宜 |
| 拖拽松手打的 KF 值 ≠ 面板显示 | 拖拽前按当前播放头读 kfVal 作基准，松手写新值 |
| 范围失控（GPT 13 缺口全做） | 三阶段路线冻结：第一阶段只做 B2.1→B2.2→B2.3→B5→B3 |

---

## 8. 落码纪律（延续）

- 每次改动前 grep 现有键名/签名（防 k.t 类低级错误）
- jsdom 冒烟用真实后端数据结构
- 交互改动保持"临时态 → 事务提交"模式（C2/C3）
- 改完必重开 start.bat 真机验收
- 一个 commit 一个里程碑，git ls-files 核对后 push

---

*设计者：WorkBuddy · 2026-08-20 22:30 · v4 已吸收 GPT 全部意见（签字通过 + 顺序调整 + 三阶段路线 + 三个核心概念文档），待用户 sign-off 落码*
