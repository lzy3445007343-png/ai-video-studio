/* =====================================================================
 * property/property-kernel.js —— Property Kernel（C1，唯一属性访问协议）
 * =====================================================================
 * 目标（GPT 评审 v2）：建立唯一属性访问协议——所有属性用 path 寻址，
 * 被 UI / 关键帧 / MCP / Agent 用同一种方式操作。
 *   - seg.params[path]  = 静态值（真相源，承载层）
 *   - seg.animations[path] = 关键帧通道（动画覆盖静态）
 *   - Property Registry = 协议层（path → 属性定义：type/keyframable/interpolation/unit/group/default）
 *   - legacy（只读兜底）= 旧字段 fallback（旧草稿兼容）；5b 起不再被前端 mirror 写入，params 为唯一真相源
 * 读取顺序：动画(可关键帧时) → params → legacy fallback → default
 * 本文件是纯新增（C1.1），不接任何业务；C1.2 迁移 renderer 读取、C1.3 迁移面板写入。
 * 依赖：kfVal（全局，HTML 内联，运行时已存在）
 * ===================================================================== */

/* ---------- 1. Property Registry（协议层，v2） ---------- */
const PROPERTY_REGISTRY = {
  "transform.positionX": { label: "X", type: "number", min: -2, max: 2, step: 0.01, keyframable: true, interpolation: "linear", unit: "px", group: "transform", default: 0 },
  "transform.positionY": { label: "Y", type: "number", min: -2, max: 2, step: 0.01, keyframable: true, interpolation: "linear", unit: "px", group: "transform", default: 0 },
  "transform.scaleX":    { label: "宽 W", type: "number", min: 0.01, max: 5, step: 0.01, keyframable: true, interpolation: "linear", unit: "x", group: "transform", default: 1 },
  "transform.scaleY":    { label: "高 H", type: "number", min: 0.01, max: 5, step: 0.01, keyframable: true, interpolation: "linear", unit: "x", group: "transform", default: 1 },
  "transform.rotate":  { label: "旋转", type: "number", min: -360, max: 360, step: 1, keyframable: true, interpolation: "linear", unit: "deg", group: "transform", default: 0 },
  "transform.opacity":   { label: "不透明度", type: "number", min: 0, max: 1, step: 0.01, keyframable: true, interpolation: "linear", unit: "", group: "blend", default: 1 },
  "audio.volume":        { label: "音量", type: "number", min: 0, max: 2, step: 0.01, keyframable: true, interpolation: "linear", unit: "", group: "audio", default: 1 },
  "speed.rate":          { label: "速度", type: "number", min: 0.01, max: 5, step: 0.01, keyframable: true, interpolation: "linear", unit: "x", group: "speed", default: 1 },
  "speed.pitchCorrection": { label: "变音", type: "boolean", keyframable: false, group: "speed", default: false },
};

/* ---------- 2. legacy adapter（旧字段 fallback 只读；5b 起不再 mirror 写，params 为唯一真相源） ---------- */
const LEGACY_READ = {
  "transform.positionX": s => (s.transform && s.transform.x != null) ? s.transform.x : undefined,
  "transform.positionY": s => (s.transform && s.transform.y != null) ? s.transform.y : undefined,
  "transform.scaleX":    s => (s.transform && s.transform.scaleX != null) ? s.transform.scaleX : undefined,
  "transform.scaleY":    s => (s.transform && s.transform.scaleY != null) ? s.transform.scaleY : undefined,
  "transform.rotate":  s => (s.transform && s.transform.rotation != null) ? s.transform.rotation : undefined,
  "transform.opacity":   s => (s.transform && s.transform.opacity != null) ? s.transform.opacity : undefined,
  "audio.volume":        s => (s.volume != null) ? s.volume : undefined,
  "speed.rate":          s => (s.speed != null) ? s.speed : undefined,
  "speed.pitchCorrection": s => (s.change_pitch != null) ? s.change_pitch : undefined,
};

/* 5b（R9）：旧字段 mirror 写入已移除——params 为唯一真相源，旧字段不再被前端同步写入；
 * 旧草稿由 getProperty 的 LEGACY_READ 兜底读。 */

/* 旧关键帧通道名兼容（C1.4 延后到 C2 前的最小兼容：resolver 读旧通道不失效） */
const LEGACY_CHANNEL = {
  "audio.volume": "volume",
};

/* ---------- 3. 访问 API ---------- */

/* 静态读取：params 真相 → legacy fallback → default（不插值） */
function getProperty(seg, path) {
  if (!seg) return PROPERTY_REGISTRY[path] ? PROPERTY_REGISTRY[path].default : null;
  if (seg.params && seg.params[path] !== undefined) return seg.params[path];
  const legacy = LEGACY_READ[path] ? LEGACY_READ[path](seg) : undefined;
  if (legacy !== undefined) return legacy;
  return PROPERTY_REGISTRY[path] ? PROPERTY_REGISTRY[path].default : null;
}

/* 写入：params 是唯一真相源（5b R9 收敛，不再 mirror 旧字段）。
 * 后端 update_segment_transform / set_segment_speed / set_segment_volume 已同步写 params，
 * 导出 _video_clip_settings 已 params 优先 + legacy 兜底。旧 draft 经 getProperty 的 legacy 读兜底。 */
function setProperty(seg, path, value) {
  if (!seg) return;
  seg.params = seg.params || {};
  seg.params[path] = value;
}

/* 动画解析（隔离在独立函数：前/后关键帧/插值/fallback 全在这，不污染普通属性） */
function resolveAnimatedProperty(seg, path, localUs, fallback) {
  const anims = seg.animations || {};
  let kfPath = path;
  const hasNew = anims[path] && anims[path].keys && anims[path].keys.length;
  if (!hasNew && LEGACY_CHANNEL[path] && anims[LEGACY_CHANNEL[path]] && anims[LEGACY_CHANNEL[path]].keys && anims[LEGACY_CHANNEL[path]].keys.length) {
    kfPath = LEGACY_CHANNEL[path];   // 旧通道名兼容（volume → audio.volume）
  }
  const channel = anims[kfPath];
  if (!channel || !channel.keys || !channel.keys.length) return fallback;
  const v = kfVal(anims, kfPath, localUs);
  return v == null ? fallback : v;
}

/* 统一读取：静态（含动画覆盖）——动画细节隔离在 resolveAnimatedProperty */
function resolveProperty(seg, path, localUs) {
  const def = PROPERTY_REGISTRY[path];
  const staticValue = getProperty(seg, path);
  if (!def || def.keyframable === false) return staticValue;
  return resolveAnimatedProperty(seg, path, localUs, staticValue);
}

/* 便捷：批量写（panel commit 用），返回是否全成功 */
function setProperties(seg, patches) {
  if (!seg || !patches) return false;
  for (const [path, value] of Object.entries(patches)) setProperty(seg, path, value);
  return true;
}
