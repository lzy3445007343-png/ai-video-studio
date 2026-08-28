# EffectivePropertyResolver · 属性解析优先级（2026-08-20）

> 来源：GPT 评审（kf-complete-plan-v4 §1.3）要求补的三个核心概念文档之三。
> 定位：**"读一个属性的当前值"的唯一权威**——所有 UI（面板输入框、预览渲染、导出）都走这一个函数，禁止各写各的读取逻辑。
> GPT 核心要求："不要出现：动画存在但是静态值覆盖动画。这个需要写成 Kernel 规则。"
> 关联：C1 Property Kernel（resolveProperty 三层解析）/ renderer.js applyKfTransform / kf-panel.js / kf-channel.js getCurrentValue。

---

## 1. 三层解析（GPT 确认方向正确，现形式化）

```
getEffectivePropertyValue(segment, path, localTime)
  │
  ├─ 1. animation channel（有 KF？）
  │    └─ 有 → 插值结果（linear/hold，kfVal）
  │
  ├─ 2. static transform（无 KF？）
  │    └─ 有 → segment.transform 的对应字段
  │
  └─ 3. default（兜底）
       └─ 各属性的默认值（x/y=0, scaleX/Y=1, rotate=0, opacity=1）
```

**铁律（Kernel 规则）**：
1. **动画存在时，静态值绝不覆盖动画**——只要 `isAnimated(seg,path)=true`，任何时刻读值都走插值（即使播放头在所有 KF 之前/之后，也取首/尾 KF 值，不回落静态）
2. 读取永远是"单点函数"，禁止在 UI 层各自拼接（曾出现：面板读 kfVal、预览读 transform、导出读另一套——三方不一致的根源）

## 2. 语义细节

| 场景 | 结果 |
|---|---|
| 有 KF，播放头在 KF1 和 KF2 之间 | 线性插值（linear）或保持前值（hold） |
| 有 KF，播放头在所有 KF 之前 | 第一个 KF 的值（kfVal 已实现：`localUs <= ks[0].t → ks[0].v`） |
| 有 KF，播放头在所有 KF 之后 | 最后一个 KF 的值 |
| 无 KF，transform 有该字段 | segment.transform 静态值 |
| 无 KF，transform 无该字段 | default 兜底 |

## 3. PropertyValueState（GPT 缺口 6，随 B2.1 一起做）

> GPT："参数面板显示关键帧状态……还缺当前值来源显示……内部 `PropertyValueState { value, source: "keyframe"|"interpolated"|"static" }`，以后调试特别重要。"

```js
// 返回值（带来源标记，不再只返回裸数字）
function getEffectivePropertyValue(segment, path, localTime) {
  if (KfChannel.isAnimated(segment, path)) {
    const keys = segment.animations[path].keys;
    const hit = keys.find(k => Math.abs((k.t||0) - localTime) <= 1000);
    if (hit) return { value: hit.v, source: "keyframe" };
    return { value: kfVal(segment.animations, path, localTime), source: "interpolated" };
  }
  const tfVal = readTransform(segment, path);           // segment.transform 对应字段
  if (tfVal != null) return { value: tfVal, source: "static" };
  return { value: defaultFor(path), source: "default" };
}
```

- 面板输入框显示 `value`
- ◆ 状态 = `source === "keyframe"`（等价 hitOn）
- 调试工具/未来 UI 可显示来源标签（"K"=keyframe / "I"=interpolated / "S"=static）

## 4. 与 C1 resolveProperty 的关系

| | C1 resolveProperty（已落） | EffectivePropertyResolver（本文档） |
|---|---|---|
| 解析链 | params → legacy → default | animation → transform → default |
| 服务对象 | 静态参数（非动画） | **带 KF 的动画属性**（transform 系） |
| 关系 | 互补：无 KF 的字段走 C1；有 KF 的字段走本 Resolver | B2.1 落地后，KF 面板统一走本函数 |

## 5. 消费方收口（B2.1 改动点）

| 消费方 | 现状 | 改为 |
|---|---|---|
| kf-panel.js buildKfRow 初始显示 | 通道开→kfVal / 关→getProperty（散落） | `getEffectivePropertyValue(...).value` |
| kf-panel.js updateKfRowValues（播放头移动） | 同上 | 同上（source 顺带驱动 ◆ class） |
| renderer.js applyKfTransform | 已按三层解析实现（2cf1177） | 保持，但读值统一走 Resolver（消除三方不一致） |
| 导出 `_apply_keyframes_to_segment`（B5） | 后端独立实现 | 语义对齐（不改代码，B5 验证一致性） |

## 6. 落地检查表

- [ ] `getEffectivePropertyValue(seg, path, localTime)` 返回 `{value, source}`（非裸数字）
- [ ] 动画存在时静态值绝不覆盖动画（Kernel 规则注释写明）
- [ ] kf-panel 两处显示逻辑收口到 Resolver
- [ ] ◆ class 由 `source === "keyframe"` 驱动
- [ ] B5 导出对照：面板显示值 = 导出后剪映读取值（三方一致）

---

*设计者：WorkBuddy · 2026-08-20 · effective-property-resolver v1（GPT 要求，B2.1 落码依据）*
