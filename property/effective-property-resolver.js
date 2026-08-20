/* =====================================================================
 * property/effective-property-resolver.js —— EffectivePropertyResolver（B2.1）
 * =====================================================================
 * 读"属性的当前有效值"的唯一权威（GPT 要求三个核心概念文档之一，
 * docs/architecture/effective-property-resolver.md）。
 * 三层解析：
 *   1. animation channel（有 KF）→ 命中返回 {v, source:"keyframe"}；否则插值 {v, source:"interpolated"}
 *   2. static（params 真相 / legacy fallback）→ {v, source:"static"}
 *   3. default（PROPERTY_REGISTRY 兜底）→ {v, source:"default"}
 * 铁律：动画存在时，静态值绝不覆盖动画（即使播放头在所有 KF 之外，
 *       也取首/尾 KF 值，不回落静态）。
 * 返回 {value, source}——消费方（kf-panel/◆ 状态/调试）统一用，禁止各写各的读取逻辑。
 * 依赖：KfChannel / kfVal（HTML 全局）/ getProperty + PROPERTY_REGISTRY + LEGACY_READ（C1 kernel）
 * ===================================================================== */

function getEffectivePropertyValue(seg, path, localTime) {
  if (!seg) {
    const def = (typeof PROPERTY_REGISTRY !== "undefined") ? PROPERTY_REGISTRY[path] : null;
    return { value: def ? def.default : null, source: "default" };
  }
  // 1. animation channel（铁律：有动画就绝不回落静态）
  if (KfChannel.isAnimated(seg, path)) {
    const keys = seg.animations[path].keys;
    const hit = keys.find(k => Math.abs((k.t || 0) - (localTime || 0)) <= 1000);
    if (hit) return { value: hit.v, source: "keyframe" };
    const iv = kfVal(seg.animations, path, localTime);
    return { value: iv == null ? getProperty(seg, path) : iv, source: "interpolated" };
  }
  // 2. static / 3. default
  const v = getProperty(seg, path);
  const explicit = !!(seg.params && seg.params[path] !== undefined) ||
                   !!(typeof LEGACY_READ !== "undefined" && LEGACY_READ[path] && LEGACY_READ[path](seg) !== undefined);
  return { value: v, source: explicit ? "static" : "default" };
}

if (typeof window !== "undefined") window.getEffectivePropertyValue = getEffectivePropertyValue;
