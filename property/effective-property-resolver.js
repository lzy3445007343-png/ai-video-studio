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
  // 面板必须读取与播放器相同的预览视图；拖拽/输入尚未提交时也能立即反映临时值。
  const readSeg = (typeof PreviewState !== "undefined") ? PreviewState.getPreviewSeg(seg) : seg;
  // 1. animation channel（铁律：有动画就绝不回落静态）
  if (KfChannel.isAnimated(readSeg, path)) {
    const keys = readSeg.animations[path].keys;
    const hit = keys.find(k => Math.abs((k.t || 0) - (localTime || 0)) <= KfChannel.KF_HIT_TOLERANCE_US);
    if (hit) return { value: hit.v, source: "keyframe" };
    const iv = kfVal(readSeg.animations, path, localTime);
    return { value: iv == null ? getProperty(readSeg, path) : iv, source: "interpolated" };
  }
  // 2. static / 3. default
  const v = getProperty(readSeg, path);
  // L2-02：文本样式基值落在 seg.sub_style（渲染器读取源，单真源），KF 解析器补一路回退
  let _tv = v;
  let _fromText = false;
  if (path.startsWith("text.") && readSeg.sub_style) {
    const _map = { "text.fontSize": "font_size", "text.letterSpacing": "letter_spacing",
                   "text.color": "color", "text.bold": "bold", "text.align": "align",
                   "text.bg.enabled": "bg.enabled", "text.bg.color": "bg.color" };
    const _sm = _map[path];
    if (_sm) {
      const _parts = _sm.split(".");
      let _o = readSeg.sub_style;
      for (const _p of _parts) { _o = (_o == null) ? undefined : _o[_p]; }
      if (_o !== undefined) { _tv = _o; _fromText = true; }
    }
  }
  // L2-04：graphic params 基值落在 seg.params（描边/填充/圆角），嵌套 path 解析
  let _fromParams = false;
  if (path.startsWith("params.") && readSeg.params) {
    const _parts = path.slice("params.".length).split(".");
    let _o = readSeg.params;
    for (const _p of _parts) { _o = (_o == null) ? undefined : _o[_p]; }
    if (_o !== undefined) { _tv = _o; _fromParams = true; }
  }
  const explicit = _fromText || _fromParams ||
                   !!(typeof LEGACY_READ !== "undefined" && LEGACY_READ[path] && LEGACY_READ[path](readSeg) !== undefined);
  return { value: _tv, source: explicit ? "static" : "default" };
}

if (typeof window !== "undefined") window.getEffectivePropertyValue = getEffectivePropertyValue;
