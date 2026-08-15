# Operation Schema v1 草图（概念模型 · 不锁字段）

> **本文件是 ADR-001 §9 要求的"Operation Schema 草图"**：只定义目标 / 原则 / 边界 / 概念模型（动词族）。**刻意不锁字段**——字段级设计等到 B-D 收尾后再做，避免压扁尚未结构化的剪辑经验。
>
> **定位**：Operation Schema 是 Agent 唯一面向的"视频编辑语言"（Video DSL，ADR-001 §4 Layer 1）。它描述"要做什么"（意图级），由 Command 层翻译成 Timeline Schema（"改完长什么样"，Layer 2）。

---

## 1. 设计原则

1. **意图驱动（Operation → Command → Timeline Mutation → Render）**：Agent 只表达操作意图，不碰 Timeline 字段。顺序见 ADR-001 §4（注：此 "Operation" 含未来"意图层 / 原子层"两层，见 ADR-001 §11.1）。
2. **可解释 / 可回退 / 可审计**：每个 Operation 携带 `operation_context`（actor / reason / confidence / source / reversible，见 ADR-001 §6）。
3. **多 Agent 兼容**：GPT / Claude / Buddy 同一套 Operation 词汇，不依赖特定模型。
4. **稳定 / 可控**：动词语义固定、不变量由 Command 层封装，AI 每次调用结果可预期（这正是"AI 剪辑工作台"相对"堆功能"的护城河）。

---

## 2. 概念模型：动词族（草图，非最终字段）

按剪辑能力 P0/P1（ADR 收口前已定的口播优先级）粗分，**仅列"有哪些动作类别"**，不定义参数结构：

### 2.1 结构类（剪切 / 重组）
- `cut_silence` 去气口
- `remove_segment` / `remove_filler_word` 去口误 / 删片段
- `split_clip` 分割
- `move_clip` 移动
- `trim_clip` 裁剪

### 2.2 语言类（字幕 / 文本）
- `add_caption` 加字幕
- `apply_caption_style` 套字幕样式
- `add_text_overlay` 花字 / 文字覆盖
- `remove_filler_word`（与 2.1 语义重叠，标注为"同一动作的不同归因"）

### 2.3 视觉类（画面语言）
- `zoom_face` 推近人脸
- `enhance_emotion` 情绪增强（zoom + speed + caption emphasis 组合）
- `add_transition` 过渡
- `create_mask` / `reverse_mask` 蒙版 / 反向蒙版
- `animate_keyframe` 关键帧动画
- `speed_change` 变速

### 2.4 音频类
- `normalize_loudness` 响度归一
- `duck_bgm` 人声压 BGM
- `add_bgm` 加背景乐

### 2.5 包装类（风格化）
- `apply_style` 套风格（如 `xiaohongshu_fast`）
- `add_effect` 加 MG / 动效

### 2.6 未来两层 Operation（概念，暂不设计，ADR-001 §11.1）
当前动词族均为**原子操作**（Atomic Operation）。未来可能需要高层**意图操作**（Intent Operation），例如用户说"做得更像爆款口播" → Agent 先生成意图 `increase_retention` → 规划原子操作序列 `[cut_silence, add_caption, zoom_face]` → 原子操作执行。**现在不锁字段、不设计**，仅记录概念，防以后推翻。

---

## 3. operation_context 草图（随每个 Operation 携带）

```json
{
  "actor": "agent",
  "reason": "remove_filler_word",
  "confidence": 0.94,
  "source": "audio_analysis",
  "reversible": true
}
```

用途：撤销 AI 操作 / 比较多个 AI 版本 / 多 agent 协作归因 / 用户追责。

---

## 4. 与 Timeline Schema 的关系（Layer 1 ↔ Layer 2）

```
Agent
  │  说 Operation（意图）
  ▼
Command API  ──── 翻译 + 封装不变量
  │
  ▼
Timeline Schema（segment_id / source_range / timeline_range / effects / keyframes）
  │
  ▼
播放器反馈（执行反馈器）
```

- **Operation = "要做什么"**（本文件）。
- **Timeline Schema = "改完长什么样"**（未来独立文档，本阶段不设计字段）。
- **Command = 翻译器**，是 Agent 唯一入口，UI 也同走。

---

## 5. 明确 NOT 现在做（边界）

- ❌ 不锁任何 Operation 的字段结构（参数名 / 类型 / 必填项）。
- ❌ 不设计 Timeline Schema 的字段。
- ❌ 不实现 Command 翻译器。
- ❌ 不新增任何播放器功能（属 B-D 边界外，ADR-001 §3）。

**下一步**：B-D 收尾 → 冻结执行层 → 再回来把 §2 动词族升级为带字段的 Operation Schema v1 + 配套 Timeline Schema v1 + Command API。
