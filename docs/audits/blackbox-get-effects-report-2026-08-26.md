# 黑盒测试报告 — #513 续：get_effects / get_segment_detail 特效盘点闭环

- 日期：2026-08-26
- 驱动：黑盒测试员（CodeBuddy / 外部 GPT 视角），按 `docs/audits/blackbox-get-effects-test-prompt.md` 跑
- 方式：独立进程拉起 `mcp_server.py`（WB 内置 Python，每次全新加载最新码，等效「完全退出 WB 重开」）；全程仅经 MCP 工具接口，未读源码、未直接看 `draft_state.json`
- 白盒修复：`commit 1de0f2e`

## 草稿前提

- main 轨 0 段、overlay video 轨 1 段（`IMG_4382_去停车场_1787665576.mp4`，`material_id=3af7fb1f...`）、text 轨 2 段、初始无特效。

## 步骤结果

| 步骤 | 结果 | 实际返回 |
|---|---|---|
| Step1 基线 | **PASS** | `get_effects()` → `[]`（干净列表，非报错） |
| Step4 盘点（#513 核心） | **PASS** | 挂 blur 后 `get_effects()` → 1 条：`id=effect_c26b0a023b84`、`effect_type=blur`、`params.radius=12`、`_track=2`，字段齐全 |
| Step5 单段 effects | **FAIL** | 按 prompt 姿势 `target={"type":"clip","seg_id":VID}` 挂特效后，`get_segment_detail(video,1,0).effects` 返回 `[]` |
| Step6 改参同步 | **PASS** | `update_effect` 改 radius 12→20 后 `get_effects()` 返回 `radius=20` |
| Step7 清理 | **PASS** | `remove_effect` 后 `get_effects()` → `[]`，无残留 |

## 黑盒侧结论：有条件 PASS

- #513 核心目标（`get_effects` 不再恒返回空、AI 挂特效后可盘点/改参/清理）已生效。
- Step5 暴露一个格式断裂，提白盒侧修复。

## 补充对照（黑盒三组实验）

- **实验 A（seg_id 姿势）**：`add_effect` 成功，但 `get_segment_detail().effects` 依然 `[]` ❌
- **实验 B（track/ti 缺 si）**：`add_effect` 报错原话 `target.type='clip' 需要 track/ti/si 字段或 seg_id` —— 提示把 track/ti 与 si 并列，实测三者缺一不可
- **实验 C（track+ti+si）**：`add_effect` 成功，`get_segment_detail().effects` 非空、命中 EID ✅

## 白盒根因（已定位并修复）

- `add_effect(main.py)` 收到 `seg_id` 时仅 `target["seg_id"]=seg_id` 原样存特效段，**不解析成 track/ti**。
- `_effects_on_segment(studio_read.py)` 对 clip 特效只按 `target.track/ti` 匹配，**完全不认 `target.seg_id`**。
- 两侧 target 形态不对齐：add 侧接了 `seg_id`，query 侧没接 → 用 `seg_id` 姿势挂的特效在单段详情里永远查不到。

## 白盒修复（`commit 1de0f2e`）

- `_effects_on_segment` 增加 **seg_id 反查分支**：由 `get_segment_detail` 传入被查段自身 `id`，查询时比对 `target.seg_id == 段id`。
- 解析时机对齐到**查询时**（非落库时），段被移动（index 变化）后仍精准命中，比落 `track/ti` 更稳，与 `_seg_by_id` 同源稳定引用。
- 保留历史 `track/ti` 匹配分支做向后兼容。
- 回归测试 `tests/test_effects_on_segment.py`：4 断言全 PASS（seg_id 绑定命中正确段 / 不串段 / track-ti 历史姿势仍生效 / `get_effects`(#513) 不变）。

## 残留观察（非阻塞，供白盒后续确认）

1. `remove_effect` 返回 `count:-1`（`removed:true`，功能正常，`count` 语义待确认）。
2. `add_effect` 对 clip target 要求 `track/ti/si` 三字段齐全，提示文案把 track/ti 与 si 并列但实测三者缺一不可。
3. `get_effects` 的 `_track`（特效轨序号）与 `add_effect` 返回的 `track_index`（目标轨）语义不同，agent 审计勿混用。
4. text 段 `material_id=""`（字幕段），若对字幕段挂特效用 `material_id` 姿势无法定位（建议一律用 `seg_id`=段 id）。

## 给后续黑盒的提醒

- `seg_id` = 段的 `id` 字段（来自 `get_effects` / `get_segment_detail` 的 `id`，形如 32 位 hex），**不是 `material_id`**。
- 若 Step5 用 `seg_id` 仍空，先确认 VID 取的是段 `id` 而非 `material_id`；或临时改用 `track/ti/si` 姿势隔离问题。
