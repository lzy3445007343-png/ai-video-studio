# 关键帧（KF）完整蓝图 · 2026-08-20（v2，GPT 评审已吸收）

> 状态：**v1 已评审（GPT 5 条意见全吸收），待用户 sign-off 后按序落码**
> 位置：`docs/architecture/kf-complete-plan-2026-08-20.md`
> 背景：用户反馈"关键帧打了没反应/菱形在段开头/参数面板数值不同步"——KF 是参数面板的核心，先出全链路蓝图再动手，避免打补丁。
> 前置：C1 Property Kernel ✅（path 统一寻址）C2 Interaction Kernel ✅（GestureSession 状态机）C3 Command Transaction ✅（事务 undo）C4 Subscription Slice ✅ C5 Canvas Coordinate ✅
>
> **v2 核心修正（GPT 评审）**：
> 1. **B1 不得 input→后端 add_keyframe**（打穿 C3 事务模型）——改"交互临时态（OverlayState/KFPreview）+ blur/enter 一次 Command Transaction"
> 2. **新增 B0 KF Channel Manager**（通道生命周期，杜绝"有通道没 key"脏状态）
> 3. **B2 挂 Store.subscribeSlice("playheadUs")**，不挂 renderPlayheadUI（防耦合）
> 4. **顺序调整**：B0→B1→B2→B3→B5→B4→B6→B7→B8（B3 菱形拖拽提前，B5 导出单独验证）
> 5. **B6 音量 KF 走 Audio Engine**（不是 OverlayState）
> 6. **B5 验收建测试项目**（1080x608 中心坐标 x=100/y=50/rot=30/scale=1.2 导出对照）

---

## 1. 目标

让关键帧成为**完整可用的参数动画系统**（对齐 OpenCut）：

```
面板改值 → 预览跟手 → 时间轴菱形跟随 → 播放头移动插值应用 → 导出剪映可编辑
```

用户三个痛点的对应关系：
- "打了没反应" → 时间轴菱形显示（✅ 已修 e8e030f + 9b28bb6）
- "菱形在段开头" → 键名 k.time→k.t（✅ 已修 9b28bb6）
- "参数面板数值不同步 / 改值预览不跟手" → **B1（未做，本轮重点）**

---

## 2. 已做（现状盘点，代码实证）

### 2.1 数据模型（✅ 已定，与 OpenCut 同构）

```js
seg["animations"] = {
  "transform.positionX": { keys: [ {id, t, v, seg}, ... ] },
  ...
}
// t: 段内局部时间（微秒，0..duration）★ 键名是 t 不是 time
// v: 数值（像素/倍数/角度/0~1）；seg: "linear" | "hold"
```

7 个可关键帧通道（main.py:1379 KF_PROPS）：transform.positionX/Y、scaleX/Y、rotate、opacity + **volume（音量）**。

### 2.2 后端命令（✅ 全在，main.py:2882-2981）

| 命令 | 职责 | 状态 |
|---|---|---|
| `add_keyframe` | 打点/更新（±1ms 内同点合并） | ✅ |
| `update_keyframe` | 改 value/时间/插值 | ✅ |
| `remove_keyframe` | 删单个点 | ✅ |
| `get_keyframes` | 查通道 | ✅ |
| `clear_keyframes` | 清通道 | ✅ |
| `_apply_keyframes_to_segment` (1599) | **导出剪映映射**（含坐标换算 px/旋转/透明度） | ✅ 代码在，真机未验 |

### 2.3 前端（✅ 骨架在）

| 函数 | 位置 | 职责 |
|---|---|---|
| `toggleKf(path)` | HTML:1664 | ◆ 开/关通道（有→clear，无→add 默认值） |
| `addKfAtPlayhead(path, val)` | HTML:1677 | 播放头处打点 |
| `kfVal(anims, path, localUs)` | HTML:1578 | 插值读取（linear/hold） |
| `renderKfGraph` | HTML:1595 | 曲线图 |
| `renderKfSel` | HTML:1617 | 选中帧编辑 |
| `onKfDiamondDown` | HTML:1641 | 曲线图菱形拖拽 |
| `kf-panel.js` (200 行) | property/ | 面板 UI：变换/融合 section、◆、值输入、＋ |
| 时间轴菱形 marker | timeline.js | ✅ 显示（e8e030f）+ 位置修（9b28bb6） |

### 2.4 本轮已完成

- **e8e030f**：时间轴段上画白色菱形（对齐 OpenCut KeyframeIndicator）
- **9b28bb6**：菱形位置键名 k.time→k.t（后端存 {id,t,v,seg}）

---

## 3. 待做清单（v2 顺序，GPT 评审定序）

| # | 任务 | 依赖 | 预估 | 验收点 |
|---|---|---|---|---|
| **B0** | **KF Channel Manager**（新增，GPT 补漏）：ensureChannel / removeEmptyChannel / isAnimated / getCurrentValue——通道生命周期统一入口，杜绝"有 channel 没 key" | 无 | 1h | 打点/删点/关通道后无脏状态 |
| **B1** | **参数修改 + Preview Draft**（GPT 修正：非实时后端打点）——input 改本地临时态（OverlayState/KFPreview）+ renderPreview；blur/enter **一次 Command Transaction** add_keyframe | B0 | 2h | 改值预览跟手，blur 一条 undo（绝不一次 keystroke 一条） |
| **B2** | **播放头联动**：`Store.subscribeSlice("playheadUs", updateKfPanelValues)`（GPT 定案：独立订阅者，不挂 renderPlayheadUI） | B1 | 1h | 拖播放头 → 面板值实时变 + 预览插值 |
| **B3** | **菱形拖拽改时间**（GPT：提前，用户下一期待交互）对齐 use-keyframe-drag | B1 | 1-2h | 时间轴拖菱形 → 时间变 + 播放头跟随 |
| **B5** | **导出映射真机验证**（GPT：单独验证，建测试项目 1080x608 中心坐标对照） | B1-B4 | 1-2h | 导出剪映：x=100/y=50/rot=30/scale=1.2 中心一致 |
| **B4** | **曲线图增强**（hold 显示 + renderKfSel 完整） | B3 | 1-2h | 曲线 linear/hold 正确，选中帧可编辑 |
| **B6** | **音量关键帧**（GPT：走 Audio Engine，非 OverlayState） | B1 | 1-2h | 音量随插值变化（重新设计） |
| **B7** | 菱形复制粘贴 / 框选多选 | B3 | 2h | Ctrl+C/V 跨元素复制 |
| **B8** | Bezier 曲线 / 缓动预设 | B4 | 3-4h | 曲线拉弧度，过渡不生硬 |

**第一批：B0+B1+B2+B3**（通道管理 → 参数跟手 → 播放联动 → 菱形拖拽，用户感知闭环）。B5 单独验证，B4/B6-B8 随后。

---

## 4. B0 KF Channel Manager 具体方案（GPT 补漏，新增）

```js
// property/kf-channel.js
const KfChannel = {
  ensure(seg, path) {          // 确保通道存在（空 keys 也允许——"有 channel 没 key"是合法态）
    if (!seg.animations) seg.animations = {};
    if (!seg.animations[path]) seg.animations[path] = { keys: [] };
    return seg.animations[path];
  },
  removeIfEmpty(seg, path) {   // 删最后一个 key 后清理空通道
    const ch = seg.animations && seg.animations[path];
    if (ch && (!ch.keys || !ch.keys.length)) delete seg.animations[path];
  },
  isAnimated(seg, path) {      // 通道激活 = 有 key（GPT：看 keys.length 而非 enabled 字段，v1 定案）
    return !!(seg.animations && seg.animations[path] && seg.animations[path].keys && seg.animations[path].keys.length);
  },
  getCurrentValue(seg, path, localUs) {  // 通道开→kfVal 插值 / 关→静态值（C1 resolveProperty 已有）
    return kfVal(seg.animations || {}, path, localUs) ?? getProperty(seg, path);
  },
};
```

**为什么必须补**：toggleKf/addKfAtPlayhead 现在散落 `keys.length` 判断；删最后一个 key 后空通道残留会导致 `isAnimated` 误判（channel 存在但无 key）。统一入口后 B1/B3/B4/B7 全用它。

---

## 5. B1 参数修改 + Preview Draft（GPT 修正后的核心方案）

### 5.1 为什么不能 input→add_keyframe（GPT 论证）

后端是 `浏览器→call→Python→Command→history`，不是 OpenCut 纯前端状态。用户连续输入 scaleX: 100→101→102→103→104，每次 input 都 add_keyframe = **5 次 undo**，直接打穿 C3"一次用户动作=一条 undo"。

### 5.2 目标行为（对齐 C2 交互态→C3 事务）

```js
// input（交互中）：只改本地临时态 + 预览，绝不碰后端
inp.addEventListener("input", () => {
  const v = parseFloat(inp.value);
  if (isNaN(v)) return;
  const hasKf = KfChannel.isAnimated(seg, path);
  if (hasKf) {
    KfChannel.ensure(seg, path);
    upsertLocalKey(seg, path, localUs, v);   // 前端本地打点（不进后端，undo 无感知）
    renderPreview();                          // 预览跟手
  } else {
    setProperty(seg, path, v);               // C1：静态值本地态
    renderPreview();
  }
});
// blur/enter（交互结束）：一次 Command Transaction
inp.addEventListener("blur", () => {
  const v = parseFloat(inp.value);
  if (isNaN(v)) return;
  const hasKf = KfChannel.isAnimated(seg, path);
  CommandService.withTx(hasKf ? "kf-edit" : "static-edit", () => {
    if (hasKf) {
      return CommandService.run("add_keyframe", {...kfArgs, path, time_us: localUs, value: v});
    } else {
      return CommandService.run("update_segment_transform", {...kfArgs, transform: buildTransformFromParams(seg)});
    }
  });
});
```

**核心原则（GPT 强调）**：交互过程中修改的是**临时态**，用户动作结束才生成 Command——与 C2 GestureSession（overlay→commit）、C3 withTx（事务）完全一致。

### 5.3 静态值语义（GPT 定案）

- **通道开** → 修改当前 key（保持动画通道）
- **通道关** → 修改静态值（不清动画——避免"清动画"的破坏性语义，channel manager 管生命周期）
- 不统一"改静态=清动画"（OpenCut 是分属性行为，我们 v1 简化）

---

## 6. B2 播放头联动（GPT 定案）

```js
// ✅ 独立订阅者（不挂 renderPlayheadUI——UI 层不互相调，防耦合）
Store.subscribeSlice("playheadUs", updateKfPanelValues);
// updateKfPanelValues = 遍历 kf 面板输入框，kfVal 更新值（跳过正在编辑的 input）
```

数据流：`Store.playheadUs → updateKfPanelValues`（KF 面板）+ `renderPlayheadUI`（播放头 DOM）+ 预览插值——三者都是 playheadUs 的独立订阅者。

---

## 7. B3 菱形拖拽（提前，用户下一期待）

- 对齐 OpenCut use-keyframe-drag：拖时间轴菱形 → seek 播放头 + update_keyframe(time_us)
- 复用 C2 GestureSession（拖拽状态机）+ C3 withTx（一次拖一条 undo）
- marker 已有 data-path/data-kftime 属性（上一 commit），直接挂 pointer 事件

---

## 8. B5 导出验证（GPT 要求建测试项目）

```js
// 测试项目（1080x608 画布）：
//   素材中心 x=100 y=50 rotation=30 scale=1.2 → 打一个关键帧
//   导出 → 剪映打开 → 对照中心/旋转/缩放是否一致
// 关键：与 C1 语义对齐（position = 相对中心偏移，剪映 center-based）
// 验收不通过 → 修 _apply_keyframes_to_segment 坐标换算
```

---

## 9. 风险与护栏（v2 补充）

| 风险 | 缓解 |
|---|---|
| B1 本地打点导致"预览与后端不一致" | blur 时 withTx 同步；期间 refresh 被 InteractionManager lock 拦（如 C2） |
| B1 漏 commit（用户不 blur 直接关面板） | blur + Enter + 面板销毁钩子三条路径都 commit |
| KF 通道脏状态（有 channel 没 key） | B0 Channel Manager 统一入口 |
| B6 音量误走 OverlayState | GPT 定案：volume 走 AudioEngine 增益，不走预览 overlay |

---

## 10. 给 GPT 评审的问题（v1 → 已答）

| 问题 | v1 我的方案 | GPT 裁决 | 定案 |
|---|---|---|---|
| B1 实时 vs blur | 实时 add_keyframe | **禁止**——临时态+一次事务 | ✅ v2 |
| 静态值清动画？ | 不清 | 不清，但补 channel manager | ✅ v2 |
| B2 挂哪 | playheadUs 切片 | playheadUs 切片，独立订阅者 | ✅ v2 |
| 优先级 | B1+B2+B5 | B1+B2+B3，B5 单独 | ✅ v2 |
| 漏项 | 无 | B0 Channel Manager + B1 Preview Draft | ✅ v2 |
| B5 坐标 | 凭感觉 | 建测试项目对照 | ✅ v2 |

---

*设计者：WorkBuddy · 2026-08-20 21:30 · v2 已吸收 GPT 评审，待用户 sign-off*
