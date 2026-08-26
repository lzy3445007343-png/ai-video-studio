# 黑盒压力测试 Prompt — #513 续：get_effects / get_segment_detail 特效盘点闭环

> 用途：让 CodeBuddy / 外部 GPT 当"不懂实现的黑盒测试员"，用 MCP 工具跑「AI 编辑特效→盘点自查」真实流，
> 验证 `get_effects` / `get_segment_detail.effects` 不再恒返回空、AI 编辑可审计闭环打通。
> 跑之前：必须**完全退出 WorkBuddy 重开**（改了 studio_read 依赖，仅重启桌面端不够，MCP server 进程需重建加载新码）。

## 测试员角色设定

你是 ai-video-studio 的黑盒测试员。你只能通过 MCP 工具操作，不允许读源码、不允许看 draft_state.json。
目标：验证"AI 往时间轴挂特效后，能否正确盘点/改参/审计"，每一步记录实际返回并判定通过/失败。

## 工具清单（你可用）

- `get_effects()` — 列出所有已挂特效（紧凑，含 _track 审计字段）
- `get_effect_registry()` — 特效类型与参数目录
- `get_segment_detail(track_type, track_index, index)` — 单段详情，含 `effects` 字段（该段挂的特效）
- `add_effect(track_index, effect_type, target, params, start_us, duration_us, seg_id?)` — 加特效
- `update_effect(track_index, index, patch, seg_id?)` — 改特效参数
- `remove_effect(track_index, index, seg_id?)` — 删特效

## 关键概念：seg_id 是什么（务必读）

- `seg_id` = **段的 `id` 字段**，形如 32 位 hex（`44ced82b873d4a24a09598f220bdd4b8`）。
- 取段 id 的正确来源：`get_effects()` 返回的每条有 `id` 字段；或 `get_segment_detail()` 返回里的 `id` 字段。
- **绝不是 `material_id`**（素材 id，同一素材的多个段共享，挂在段上会定位错段）。
- 09 M1-1b：agent 一律用 `seg_id`（稳定段 id）引用段，不依赖易变 index。

## 测试流程（严格按顺序，每步记录）

### Step 1 — 基线盘点
- 调用 `get_effects()`。
- 预期：返回一个**列表**（可能为空 `[]`，但绝不能是报错或工具无响应）。
- 记录：返回内容。判定：工具可用 = PASS。

### Step 2 — 查注册表 + 选一段（拿到段 id）
- 调用 `get_effect_registry()`，确认 `blur` 存在、参数 `radius`。
- 调用 `get_segment_detail("video", 0, 0)`（若 video 轨无段，改用 `get_segment_detail("text", 0, 0)`）。
- 从返回里取 **`id` 字段**（段 id，记为 `VID`）—— 注意是 `id`，不是 `material_id`。

### Step 3 — 挂特效（用 seg_id 姿势，推荐）
- 调用 `add_effect(track_index=0, effect_type="blur", target={"type":"clip","seg_id":VID}, params={"radius":12}, start_us=0, duration_us=2000000)`。
- 记录返回的 `id`（记为 `EID`）。

### Step 4 — 盘点（#513 核心验证点）
- 调用 `get_effects()`。
- 预期：列表里**有 1 个特效**，其 `id==EID`、`effect_type=="blur"`、`params.radius==12`、`_track` 字段存在（数字）。
- 判定：能盘点到刚挂的特效且字段完整 = **PASS**；若仍返回 `[]` = **FAIL（旧码死路径未生效）**。

### Step 5 — 单段详情里的特效字段
- 调用 `get_segment_detail`（用 Step 2 的 track_type/index）。
- 预期：`effects` 字段**非空**，包含 `EID` 这条 blur。
- 判定：单段特效字段可查 = PASS；若 `effects` 为空 = FAIL。
- 若此处 FAIL 但 Step4 PASS：优先怀疑 VID 取成了 `material_id` 而非段 `id`，回 Step 2 重取 `id` 字段重试。

### Step 6 — 改参数
- 调用 `update_effect(track_index=0, index=0, patch={"params":{"radius":20}}, seg_id=EID)`。
- 再调 `get_effects()`，预期 `params.radius==20`。
- 判定：改参后盘点同步 = PASS。

### Step 7 — 清理 + 复测
- 调用 `remove_effect(track_index=0, index=0, seg_id=EID)`。
- 再调 `get_effects()`，预期返回 `[]`（真干净）。
- 判定：清理后无残留 = PASS。

## 报告格式（必须输出）

```
#513 黑盒测试报告
- Step1 基线: PASS/FAIL — <实际返回摘要>
- Step4 盘点(#513核心): PASS/FAIL — <是否见到 EID/blur/radius/_track>
- Step5 单段effects: PASS/FAIL — <effects 是否非空>
- Step6 改参同步: PASS/FAIL
- Step7 清理: PASS/FAIL
结论: 整体 PASS / FAIL
异常/现象: <任何不符合预期的原话返回>
```

## 判定红线

- **Step4 返回 `[]`** → #513 修复在运行时未生效（先确认是否完全退出了 WB 重开；若已重开仍空，提 bug 给白盒侧）。
- 任意步骤工具报错/超时 → 记录原话，交白盒侧排查。
- 全程不得读源码、不得直接看 draft_state.json（黑盒纪律）。
