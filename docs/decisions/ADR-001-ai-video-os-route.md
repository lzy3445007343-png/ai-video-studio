# ADR-001 项目定位与路线决策：从剪辑软件到 AI 可调用视频操作系统

- **状态**：已冻结（2026-08-15，第三轮架构评审 + 第四轮 3 补充终审，GPT 参谋 + 老大确认）
- ** Supersedes**：`docs/architecture/roadmap.md` 中"播放器是否值得投入"的未决争论（本轮正式终结）
- **相关**：`docs/architecture/player-session-stepB-continueStart.md`（Step B 冻结稿）、`docs/architecture/operation-schema-sketch.md`（Operation Schema 概念草图）

---

## 1. 背景与触发事实

1. **能力可行性已实测验证**：无平台 agent 时，直接给通用 agent（Buddy / Claude / GPT）任务 + 我们的 MCP + Skill，已能执行粗剪、去气口、去口误、字幕、花字、关键帧、变速、蒙版、反向蒙版、MG 动效。
   → 结论：**瓶颈不是"AI 能不能剪"，是编排 / 能力层（MCP + Skill + Command + Schema）未工程化**。
2. **播放器争论已持续多轮**：过去一直在争"播放器到底值不值得继续投入"。本轮给出终局判定（见 §3）。
3. **认知上下文风险**：项目最大风险不是技术，是"认知上下文爆炸"——过早锁死字段会压扁尚未结构化的剪辑经验。

---

## 2. 决策一：项目定位转变

| 旧定位 | 新定位 |
|---|---|
| 做一个更好的剪辑软件 | 做一个 **AI 能调用的视频操作系统** |
| 人操作 Timeline → 播放器显示结果 | AI 生成动作 → 改 Timeline → 用户实时看 → 继续调整 |
| 自研超级剪辑 agent | 外部 Agent（Buddy/Claude/GPT/其他）→ 我们的能力层 |

**架构分层（Agent 唯一可见面是我们的能力层，不直接碰 Timeline）：**

```
外部 Agent（Buddy / Claude / GPT / 其他）
        ↓
我们的 MCP（稳定接口）
        ↓
能力层（Skill 定义的剪辑规则）
        ↓
Command API（意图 → 不变量）
        ↓
Timeline 执行 + 播放器反馈（执行反馈器）
```

**不做自己的超级剪辑 agent**——做能力层更聪明、更可复利。

---

## 3. 决策二：播放器争论正式终结

- **播放器不是产品**，但它是 **AI 编辑闭环里的"执行反馈器"**：AI Command → Timeline 变化 → 播放器立刻反馈 → 用户判断 → 再修改。这条闭环里播放器不稳定，AI 体验直接崩。
- **B-D 的真实意义**：把播放器从"网页 demo 组件"升级为"AI 可调用执行引擎"，**不是优化播放器**。
- **收尾纪律**：B-D 完成 = 播放器达到"可靠基础设施"即停止投入，**不继续给播放器加新功能**（转场 / 滤镜 / 不计其数的轨道特效一律后置，属 Step C/D 边界外）。
- **澄清（第四轮终审补充）**：本决策是"不再把播放器 / 时间轴当**产品竞争力**无限打磨"，**不是停止做播放器 / 时间轴**。恰恰相反——播放器与时间轴是 Operation Schema 得以运行的"运行环境"（类比代码 Agent 不需要自己写 IDE，但必须有可靠运行环境），**最不能停的就是这二者**。区别只在视角：从"功能开发"切换为"基础设施建设"。没有它们，Operation Schema 只是一套漂亮的语言设计；AI 说"删掉这句口误"，用户却看不到变化 / 播放卡死 / 没声，整个 AI 体验直接废。

---

## 4. 决策三：两层 Schema 架构（Operation ↔ Timeline）

Agent 永不直接碰 Timeline。顺序为 **Operation → Command → Timeline Mutation → Render**，不是 Timeline → Command。

> 注：此处的 "Operation" 指 Agent 直接面向的操作语言（见 §11.1，未来其内部可能再分"意图层 Intent Operation"与"原子层 Atomic Operation"，但那是 Operation 之下的子结构，不改变本层顺序）。

| 层 | 名称 | 角色 | 面向 |
|---|---|---|---|
| **Layer 1** | **Operation Schema**（AI 操作语言 / Video DSL） | "要做什么"——意图级动词 | Agent 唯一面向 |
| **Layer 2** | **Timeline Schema**（执行结果结构） | "改完长什么样"——segment / track / effects | 内部引擎 |

- Operation Schema 示例（概念，非字段）：`{ action:"remove_segment", target:"sentence_3", reason:"filler_word", confidence:0.94 }`
- Timeline Schema 示例（概念，非字段）：`{ segment_id, source_range, timeline_range, effects, keyframes }`
- **Command 层负责翻译** Operation → Timeline Mutation，并封装不变量（UI 与 Agent 同走）。

---

## 5. 决策四：护城河 = Video DSL（不是 MCP，不是 Skill）

- **MCP 会普及**——它是传输协议，不构成壁垒。
- **Skill 别人也能写**——它是规则封装，可复制。
- **真正壁垒**：让 AI 拥有一套**稳定 / 可控 / 可解释**的"视频编辑语言"（Video DSL）。例如人类说"这里太平，加一点情绪"，AI 转换为 `EnhanceEmotion(segment=12, zoom=1.08, speed=1.1, caption_style="emphasis")`。

> **护城河的上层（第四轮补充）**：Video DSL 只是"语言"，定义 `zoom_face` 谁都会；真正的壁垒是 **Video Intelligence Layer**——把口播剪辑经验（何时推近、推多少、持续多久、配什么字幕、何时不推）沉淀为"经验 → 规则 → 推荐 Operation"的层。DSL 是骨架，经验模型是血肉。当前不实现，仅留接口意识（它将是 Skill 体系的上层落点，见 §11.2）。

---

## 6. 决策五：operation_context 原则（取代裸 intent_metadata）

每个 Operation / 受影响的 segment **必须携带 `operation_context`**，使 AI 编辑可解释 / 可回退 / 可审计 / 多 agent 协作 / 用户追责：

```json
{
  "actor": "agent",          // 谁发起：agent / user / system
  "reason": "remove_filler_word",
  "confidence": 0.92,
  "source": "audio_analysis",
  "reversible": true
}
```

> 传统 NLE 只存"3-5 秒播"；AI 编辑必须存"为什么改"。`operation_context` 是 AI 编辑可审计性的命脉。

---

## 7. 路线冻结（不可跳步）

```
播放器收尾 (B → B.5 → C → D)
        ↓
冻结执行层（播放器达可靠基础设施，停止投入）
        ↓
Operation Schema v1（AI 操作语言）
        ↓
Command API v1（Operation → Timeline 翻译 + 不变量，是桥非末尾）
        ↓
Timeline Schema v1（执行结果结构，Command 的产物）
        ↓
MCP 稳定暴露
        ↓
Skill 体系（剪辑规则封装）
        ↓
外部 Agent 生态（Buddy / Claude / GPT 调用）
```

---

## 8. 守卫（红线）

- ❌ **不做 Premiere / CapCut AI 壳**：不堆转场、滤镜、轨道、特效。方向永远保持"用户表达意图 → AI 理解 → 自动改时间轴 → 用户确认"，不是"用户操作更多工具"。
- ❌ B-D 收尾后**不回头给播放器加新功能**。
- ❌ **现在不锁 Schema 字段**（见 §9）。

---

## 9. 当前动作（C+ 方案，用户修正 Buddy 的"并行写 Schema"）

- ✅ **Step B 实现**（冻结稿 `player-session-stepB-continueStart.md` 已齐，含 GPT 终审 4 钉子）。
- ✅ **本 ADR 落档**（路线决策锚点）。
- ✅ **提前画 Operation Schema 草图**（`docs/architecture/operation-schema-sketch.md`）——**只画目标 / 原则 / 边界 / 概念模型（动词族），不锁字段**。
- ⏸ **等 B-D 全部完成后**，再正式设计 Operation Schema + Timeline Schema + Command API 的**字段级**结构。
- **原因**：用户大量口播剪辑经验（何处该切、何处留呼吸、何处推近、何处字幕强调）尚未结构化；过早锁字段会把直觉压扁。

---

## 10. 核心认知（收尾语，记入长期）

> 项目现在缺的不是"让 AI 会剪"，而是"让 AI 用一种**稳定、可控、可解释**的方式剪"。

这一步（定义 AI 如何编辑视频的语言）比写代码更重要。

---

## 11. 第四轮终审补充（3 钉子，冻结前钉入，不改方向）

### 11.1 补充1：Operation 未来分"意图层"与"动作层"（暂不实现）
当前动词族（§4 / operation-schema-sketch §2）均为**原子操作**（Atomic Operation）。未来可能需要高层**意图操作**（Intent Operation），Agent 先生成意图、再规划原子操作序列：

```
Intent（用户目标）        e.g. increase_retention / make_more_emotional
        ↓
Operation Plan           e.g. [cut_silence, add_caption, zoom_face]
        ↓
Atomic Operation         e.g. remove_filler_word
        ↓
Command → Timeline
```

**现在不设计、不锁字段**，仅在 ADR 留接口意识，防止以后发现需要再推翻。

### 11.2 补充2：Video DSL 上层还有 "Video Intelligence Layer"
DSL 本身只是语言（谁都能定义 `zoom_face`）。真正差异在**剪辑经验 → 规则 → 推荐 Operation**：例如"说到观点转折 + 语速增加 + 表情变化 → zoom 1.08~1.12、3 秒缓入、字幕关键词放大"。这一层未来结构可能是 `Operation DSL ← Video Intelligence ← Skill ← MCP ← Engine`，**现在不做，只留接口意识**。

### 11.3 补充3：Command API 提前为下一阶段核心（非 Timeline 之后）
原路线把 Command 列在 Timeline 之后。修正：Command 是**桥**（Operation"要做什么" → 如何安全执行 → Timeline"变什么"），应提前到 Timeline Schema 之前（见 §7 已调整）。Timeline 不是设计出来给 AI 看的，它是 Command 的**产物**。顺序应为：语言层 → 执行协议 → 数据结构。
