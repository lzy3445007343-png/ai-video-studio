# C1 · Property Kernel 落地方案 v2（2026-08-20，已吸收 GPT 评审）

> 目标：建立**唯一属性访问协议（Property Access Protocol）**——所有属性用同一种方式被 UI / 关键帧 / MCP / Agent 操作。params 是**第一阶段承载层**，不是最终核心；最终核心是"path"。
> 方法：Strangler Pattern（绞杀式迁移），不推倒。
> **v2 变更（GPT 评审 5 条全吸收）**：①params 定位=承载层非核心 ②双写改单向 params→legacy mirror ③C1.4 延后到 C2 ④不加 set_property 后端命令 ⑤registry 提升为协议层。

---

## 0. 最终架构（GPT 定稿，C1 完成后）

```
UI / Agent / MCP / 导出
          │  只认 path
          ▼
  Property Registry（协议层：path → 属性定义）
          │
  Property Resolver（读取：静态 + 动画）
          │
    ┌─────┴─────┐
  params     animations
（真相源）   （关键帧通道）
    │
legacy mirror（缓存：syncLegacyMirror 单向）
    │
 旧字段（seg.transform.x / seg.volume / seg.speed…）
```

---

## 1. 现状盘点（已 grep 实证，9 个读写点）

| 文件 | 读/写 | 字段 |
|---|---|---|
| renderer.js:102 | 读 | `seg.volume` |
| renderer.js:216 | 读 | `seg.transform`（贴纸旧结构，**不迁标注遗留**） |
| renderer.js:673 | 读 | `seg.transform`（resolveTransform） |
| playback-graph.js:85/94/107/116 | 读 | `seg.speed` / `seg.volume` |
| media.js:470/500 | 读 | `seg.speed` |
| audio-panel.js:161 | 写 | `seg.volume = v` |
| speed-panel.js:131 | 写 | `seg.speed = v` |
| preview-drag.js:117-118 | 写 | `seg.transform` |

---

## 2. 设计

### 2.1 数据结构：`seg.params`（承载层，不是核心）
```js
seg.params = {
  "transform.positionX": 100,
  "transform.positionY": 0,
  "transform.scaleX": 1,
  "transform.scaleY": 1,
  "transform.rotation": 0,
  "transform.opacity": 1,
  "audio.volume": 0.8,
  "speed.rate": 1.5,
  "speed.pitchCorrection": false,   // v2：changePitch 是行为不是属性，改名（对齐 OpenCut 语义）
}
```
> **命名保持 OpenCut 风格（不缩短）**：`transform.*` / `audio.*` / `speed.*`。理由（GPT）：未来 video/text/sticker/camera 都有 positionX，短名必冲突。

### 2.2 Property Registry（协议层，v2 提升）
```js
const PROPERTY_REGISTRY = {
  "transform.positionX": { label:"X", type:"number", min:-2, max:2, step:0.01, keyframable:true, interpolation:"linear", unit:"px", group:"transform", default:0 },
  "transform.positionY": { label:"Y", type:"number", min:-2, max:2, step:0.01, keyframable:true, interpolation:"linear", unit:"px", group:"transform", default:0 },
  "transform.scaleX":    { label:"宽 W", type:"number", min:0.01, max:5, step:0.01, keyframable:true, interpolation:"linear", unit:"x", group:"transform", default:1 },
  "transform.scaleY":    { label:"高 H", type:"number", min:0.01, max:5, step:0.01, keyframable:true, interpolation:"linear", unit:"x", group:"transform", default:1 },
  "transform.rotation":  { label:"旋转", type:"number", min:-360, max:360, step:1, keyframable:true, interpolation:"linear", unit:"deg", group:"transform", default:0 },
  "transform.opacity":   { label:"不透明度", type:"number", min:0, max:1, step:0.01, keyframable:true, interpolation:"linear", unit:"", group:"blend", default:1 },
  "audio.volume":        { label:"音量", type:"number", min:0, max:2, step:0.01, keyframable:true, interpolation:"linear", unit:"", group:"audio", default:1 },
  "speed.rate":          { label:"速度", type:"number", min:0.01, max:5, step:0.01, keyframable:true, interpolation:"linear", unit:"x", group:"speed", default:1 },
  "speed.pitchCorrection": { label:"变音", type:"boolean", keyframable:false, group:"speed", default:false },
};
```
> 协议层：未来 AI Agent 改参数 `{path, value}`、MCP `{path, value}`、动画 `{path, time, value}` **全部走 path**。registry 不只驱动 UI，是整个编辑器的属性协议。

### 2.3 Property Resolver（v2：拆分静态与动画）
```js
// 静态读取：params 真相 → legacy fallback → default
function getProperty(seg, path) {
  if (seg.params && seg.params[path] !== undefined) return seg.params[path];
  return LEGACY_READ[path] ? LEGACY_READ[path](seg) : REGISTRY[path]?.default ?? null;
}

// 写入：params 是唯一真相，单向同步 legacy mirror（不反向！）
function setProperty(seg, path, value) {
  seg.params = seg.params || {};
  seg.params[path] = value;
  if (LEGACY_MIRROR[path]) LEGACY_MIRROR[path](seg, value);   // v2：syncLegacyMirror 单向
}

// 统一读取（静态 + 动画）：resolveProperty 只判断"是否可关键帧"，
// 动画细节（前/后关键帧/插值/fallback）隔离在 resolveAnimatedProperty —— 不污染普通属性
function resolveProperty(seg, path, localUs) {
  const def = REGISTRY[path];
  const staticValue = getProperty(seg, path);
  if (!def || !def.keyframable) return staticValue;
  return resolveAnimatedProperty(seg, path, localUs, staticValue);
}
function resolveAnimatedProperty(seg, path, localUs, fallback) {
  const channel = (seg.animations || {})[path];
  if (!channel || !channel.keys || !channel.keys.length) return fallback;
  return kfVal(seg.animations, path, localUs) ?? fallback;
}
```
> v2 关键：**动画存在 ≠ 当前有值**（如 0s/5s 有帧、10s 播放头超出）→ 动画 resolver 负责前后关键帧/插值/fallback，普通 resolveProperty 不直接碰 kf 细节。

### 2.4 legacy adapter（v2：单向 mirror）
```js
// READ 保留（legacy fallback）：旧字段没迁移完时，读老数据兼容
const LEGACY_READ = {
  "transform.positionX": s => s.transform?.x,
  "transform.positionY": s => s.transform?.y,
  "transform.scaleX":    s => s.transform?.scaleX,
  "transform.scaleY":    s => s.transform?.scaleY,
  "transform.rotation":  s => s.transform?.rotation,
  "transform.opacity":   s => s.transform?.opacity,
  "audio.volume":        s => s.volume,
  "speed.rate":          s => s.speed,
  "speed.pitchCorrection": s => s.change_pitch,
};
// MIRROR 单向（params → 旧字段缓存）：保证后端/导出读旧字段正常
const LEGACY_MIRROR = {
  "transform.positionX": (s, v) => { s.transform = s.transform || {}; s.transform.x = v; },
  "transform.positionY": (s, v) => { s.transform = s.transform || {}; s.transform.y = v; },
  "transform.scaleX":    (s, v) => { s.transform = s.transform || {}; s.transform.scaleX = v; },
  "transform.scaleY":    (s, v) => { s.transform = s.transform || {}; s.transform.scaleY = v; },
  "transform.rotation":  (s, v) => { s.transform = s.transform || {}; s.transform.rotation = v; },
  "transform.opacity":   (s, v) => { s.transform = s.transform || {}; s.transform.opacity = v; },
  "audio.volume":        (s, v) => { s.volume = v; },
  "speed.rate":          (s, v) => { s.speed = v; },
  "speed.pitchCorrection": (s, v) => { s.change_pitch = v; },
};
```
> v2 关键：**单向** params → legacy。绝不做 legacy → params 反向同步（否则 `seg.volume=0.8` 与 `params["audio.volume"]=0.5` 谁赢？——params 永远是赢家）。

---

## 3. 迁移步骤（v2：C1.4 延后，每步独立 commit + jsdom）

### Step C1.1 — Property Kernel 基础（纯新增，行为零变化）
- 新文件 `property/property-kernel.js`：PROPERTY_REGISTRY + LEGACY_READ + LEGACY_MIRROR + getProperty/setProperty/resolveProperty/resolveAnimatedProperty
- HTML 引入（renderer.js 之后）
- **不接任何业务**
- ✅ 验证：jsdom 测 4 函数语义（getProperty 三态 / setProperty 单向 mirror / resolveProperty 可关键帧判断 / resolveAnimatedProperty 前/后关键帧+fallback）

### Step C1.2 — Renderer 读取迁移（只读，不写）
- renderer.js resolveTransform → 改用 resolveProperty（transform.*）
- renderer.js:102 音量 → resolveProperty(seg, "audio.volume")
- playback-graph.js / media.js speed/volume → resolveProperty
- 贴纸（renderer.js:216）→ **不迁**（旧结构 adapter 兼容，标注遗留）
- ✅ 验证：读值迁移前后完全一致（jsdom 断言）

### Step C1.3 — Writer 迁移（统一 setProperty）
- audio-panel.js:161 → setProperty(seg, "audio.volume", v)
- speed-panel.js:131 → setProperty(seg, "speed.rate", v)
- preview-drag.js:117 → setProperty(seg, "transform.positionX/Y", v)
- 后端命令不变（set_segment_volume/speed/update_segment_transform 保持）；seg.params 落盘由 save_state 自动带
- ✅ 验证：面板改值/拖素材 → params 更新 + legacy mirror 同步 + 刷新不丢

### Step C1.4 — **暂停（延后到 C2）**
- KF 读取/写入**保持原样**（animations 已是 path map，模型已接近目标）
- 标注：future C2 = Property + Keyframe Unified Editing（usePropertyDraft 等价物：面板改值→有动画写关键帧/无动画写静态值）

---

## 4. 文件影响清单

| 文件 | 动作 |
|---|---|
| `property/property-kernel.js` | **新增**：registry + adapter(mirror) + resolver |
| 工作台v0.8时间轴.html | 引入 property-kernel.js |
| renderer.js | 读取改 resolver（~3 处，只读） |
| playback-graph.js / media.js | 读取改 resolver（~5 处，只读） |
| audio-panel.js / speed-panel.js / preview-drag.js | 写入改 setProperty（~3 处） |
| main.py | **本阶段不改**（后端命令保持；save_state 自动带 params） |
| 贴纸渲染 | **不迁**（旧结构遗留标注） |
| KF 面板/kfVal | **不动**（C1.4 延后 C2） |

## 5. 验证方案（jsdom）
1. getProperty 三态：params → legacy fallback → default
2. setProperty 单向：写 params + mirror 同步旧字段；**改旧字段不反向影响 params**（断言 params 权威）
3. resolveProperty：非 keyframable（pitchCorrection）直接返回静态；keyframable 走动画
4. resolveAnimatedProperty：前关键帧/后关键帧/播放头超出（fallback）/无通道（fallback）
5. 迁移等价：构造带 volume/speed/transform 的段，新旧读法一致

## 6. 风险
| 风险 | 对策 |
|---|---|
| 后端读旧字段（导出/命令） | legacy mirror 单向同步保证旧字段始终有值 |
| 贴纸旧 transform 结构 | 不迁，adapter 兼容，标注遗留 |
| volume 通道名（旧 "volume" vs 新 "audio.volume"） | C1 不碰 KF（C1.4 延后），C2 处理时兼容读两种 |
| 回归 | 每步 jsdom + 真机验收，独立 commit 可回退 |

---

## 7. GPT 评审结论归档（v1 的 5 问 → v2 定案）

| # | v1 问题 | v2 定案（GPT） |
|---|---|---|
| 1 | params 路径命名 | **保持 OpenCut 风格**（transform.* / audio.volume / speed.rate），不缩短 |
| 2 | 双写策略 | **单向 params → legacy mirror**（syncLegacyMirror），params 是唯一真相 |
| 3 | 面板值→关键帧互通放哪 | **延后 C2**（Keyframe Property Editing / usePropertyDraft 等价物） |
| 4 | 后端 set_property | **C1 不加**（等 C3 Command Kernel 统一 SetPropertyCommand） |
| 5 | 迁移粒度 | C1.1-C1.3 三 commit，C1.4 暂停延后 C2 |

---

*设计：WorkBuddy · 2026-08-20 15:55 · v2 吸收 GPT 评审（5 条全采纳）· 待用户 sign-off 落码*
