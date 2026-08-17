"use strict";

/* =====================================================================
 * effects.js —— 特效渲染纯函数模块（阶段 C，新文件）
 *
 * 职责（方案 §3 阶段 C）：把"特效段 → 预览滤镜"的计算收成纯函数，
 * renderer.js 只调用、不内联写滤镜逻辑，守住
 *   Timeline Kernel → Playback Graph → Renderer 单向（特效只是 Graph 上的 Node）。
 *
 * 与 main.py EFFECT_REGISTRY（§2.3）镜像同一份 key + 语义：
 *   css adapter = 预览（本文件 preview()）；ffmpeg adapter = 导出（main.py）。
 * 改一个特效类型只动两处：本文件 Effects[].preview + main.py EFFECT_REGISTRY[].ffmpeg。
 *
 * 浏览器用法：<script src="effects.js"> → 全局 Effects / computeEffectStyle
 * Node 用法（对拍脚本）：require("effects.js").computeEffectStyle
 * ===================================================================== */

// 数值兜底（与 playback-graph.js _num 同语义）
function _num(v, dflt) {
  if (typeof v !== "number" || isNaN(v)) return dflt;
  return v;
}

// 每个 effect_type 声明它的「预览端能力」(css adapter)。
// 规则：产生「无视觉变化」(identity) 时返回 null —— 不叠无效滤镜，
// 与 Python 端「无操作返回空串」语义对齐（避免 filter:none 抖动 / 冗余计算）。
// 注：opacity 不是 CSS filter（它是 el.style.opacity），故以 {opacity} 返回，
// computeEffectStyle 区分处理（filter 拼接 vs opacity 相乘）。
const Effects = {
  blur:       { preview(p){ const r=_num(p.radius,0); return r>0 ? { filter:`blur(${r}px)` } : null; } },
  brightness: { preview(p){ const v=_num(p.value,1); return v!==1 ? { filter:`brightness(${v})` } : null; } },
  contrast:   { preview(p){ const v=_num(p.value,1); return v!==1 ? { filter:`contrast(${v})` } : null; } },
  saturate:   { preview(p){ const v=_num(p.value,1); return v!==1 ? { filter:`saturate(${v})` } : null; } },
  hue_rotate: { preview(p){ const v=_num(p.value,0); return v!==0 ? { filter:`hue-rotate(${v}deg)` } : null; } },
  grayscale:  { preview(p){ const v=_num(p.value,0); return v!==0 ? { filter:`grayscale(${v})` } : null; } },
  sepia:      { preview(p){ const v=_num(p.value,0); return v!==0 ? { filter:`sepia(${v})` } : null; } },
  invert:     { preview(p){ const v=_num(p.value,0); return v!==0 ? { filter:`invert(${v})` } : null; } },
  opacity:    { preview(p){ const v=_num(p.value,1); return v!==1 ? { opacity:v } : null; } },
  // 后续 glow/vintage/film/shake/zoom/rgb 只加一条；v2 加 webgl/canvas adapter
};

// 关键帧插值（线性；v1 先 linear，后续可加 easing 字典）。
// keyframes: [{param, time(us,相对段起点), value, easing}]。
// 返回「基础 params 被关键帧覆盖后的当前时刻参数集」。
function effectParamAt(base, keyframes, relUs) {
  const p = Object.assign({}, base || {});
  if (!keyframes || !keyframes.length) return p;
  const byParam = {};
  for (const k of keyframes) {
    if (!k || k.param == null) continue;
    (byParam[k.param] = byParam[k.param] || []).push(k);
  }
  for (const param in byParam) {
    const arr = byParam[param].slice().sort((a, b) => a.time - b.time);
    let v = arr[0].value;
    if (relUs <= arr[0].time) v = arr[0].value;
    else if (relUs >= arr[arr.length - 1].time) v = arr[arr.length - 1].value;
    else {
      for (let i = 0; i < arr.length - 1; i++) {
        if (relUs >= arr[i].time && relUs <= arr[i + 1].time) {
          const span = (arr[i + 1].time - arr[i].time) || 1;
          const t = (relUs - arr[i].time) / span;
          // v1：线性；easing 留作后续（arr[i].easing 已预留字段）
          v = arr[i].value + (arr[i + 1].value - arr[i].value) * t;
          break;
        }
      }
    }
    p[param] = v;
  }
  return p;
}

// 核心：把激活的特效段算成「该挂到哪些层 / 整栈的 filter+opacity」。
// layerByKey: { "video:ti:si": el } —— 由 renderer 在 renderPreview 时从 previewState.visualEls 收集。
// 返回 { layerFilters, layerOpacity, stackFilter, stackOpacity }：
//   layerFilters/Opacity → 逐片段特效（target.type==="clip"，挂指定素材层）
//   stackFilter/Opacity  → 调整层（target.type==="adjustment"，盖整栈 previewStack）
function computeEffectStyle(effectNodes, playheadUs, layerByKey) {
  const layerFilters = {};     // segKey -> 拼接后的 filter 串
  const layerOpacity = {};     // segKey -> 相乘后的 opacity
  let stackFilter = "";
  let stackOpacity = 1;

  for (const n of (effectNodes || [])) {
    if (n.hidden) continue;
    const start = n.startUs || 0;
    const end = start + (n.durationUs || 0);
    if (playheadUs < start || playheadUs > end) continue;   // 播放头不在该段区间内 → 不激活

    const relUs = playheadUs - start;
    const params = effectParamAt(n.params, n.keyframes, relUs);
    const entry = (n.effectType && Effects[n.effectType]) ? Effects[n.effectType].preview(params) : null;
    if (!entry) continue;

    const t = n.target || { type: "adjustment" };
    if (t.type === "adjustment") {
      if (entry.filter) stackFilter = (stackFilter ? stackFilter + " " : "") + entry.filter;
      if (entry.opacity != null) stackOpacity *= entry.opacity;
    } else if (t.type === "clip" && layerByKey) {
      const segKey = "video:" + (t.track != null ? t.track : 0) + ":" + (t.si != null ? t.si : 0);
      if (!layerByKey[segKey]) continue;   // 目标层当前不可见 → 跳过
      if (entry.filter) layerFilters[segKey] = (layerFilters[segKey] ? layerFilters[segKey] + " " : "") + entry.filter;
      if (entry.opacity != null) layerOpacity[segKey] = (layerOpacity[segKey] != null ? layerOpacity[segKey] : 1) * entry.opacity;
    }
    // t.type === "track" → v1.x 跟进（整轨特效）
  }

  return { layerFilters, layerOpacity, stackFilter, stackOpacity };
}

// 对拍脚本 / Node 消费
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Effects, computeEffectStyle, effectParamAt };
}
