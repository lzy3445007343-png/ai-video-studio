"use strict";

/* =====================================================================
 * effects.js —— 特效渲染纯函数模块（阶段 C，新文件；M6-6b 起 JSON 化）
 *
 * 职责（方案 §3 阶段 C）：把"特效段 → 预览滤镜"的计算收成纯函数，
 * renderer.js 只调用、不内联写滤镜逻辑，守住
 *   Timeline Kernel → Playback Graph → Renderer 单向（特效只是 Graph 上的 Node）。
 *
 * 单一真源（M6-6b）：effects.json 的 filters.css 模板（{expr, when}）。
 *   后端 _load_effects 生成 EFFECT_META（含 css_expr/css_when），前端启动时经
 *   get_effect_registry() 拉取并 Effects.compile(meta) 现场编译 preview 函数——
 *   新增/修改特效只改 effects.json 一处，预览/面板/导出三处自动生效，不再人工镜像。
 *   ffmpeg adapter = 导出（main.py EFFECT_REGISTRY[].ffmpeg），读同一份模板。
 *
 * 浏览器用法：<script src="effects.js"> → 全局 Effects / computeEffectStyle
 * Node 用法（对拍脚本）：require("effects.js").compileEffectPreviews
 * ===================================================================== */

// 数值兜底（与 playback-graph.js _num 同语义）
function _num(v, dflt) {
  if (typeof v !== "number" || isNaN(v)) return dflt;
  return v;
}

// —— M6-6b：Effects 表由 effects.json 现场编译，不再人工镜像 ——
// 单一真源 = filters.css 模板。编译语义：
//   when（Python 风格布尔表达式，如 "radius > 0"）为 false → preview 返回 null
//     （identity，不叠无效滤镜，与 Python 端「无操作返回空串」语义对齐）；
//   expr 为 "blur({radius}px)"（CSS filter 函数）→ 输出 {filter: "blur(5px)"}；
//   expr 为 "opacity:{value}"（含冒号 = style 属性声明）→ 输出 {opacity: 0.5}
//     （opacity 不是 CSS filter，是 el.style.opacity，computeEffectStyle 区分处理）。
let Effects = {};

// Python 风格布尔表达式 → JS 求值（参数名来自 effects.json 的 params 声明，白名单安全）。
// 缺参时用 params 默认值补全（保证 when 里的参数总有定义，identity 判断不因 ReferenceError 失效）。
// 支持 > < >= <= != == and or 与数字/参数引用；求值失败保守返回 true（不拦渲染）。
function _evalWhen(when, p, paramDefs) {
  try {
    const jsExpr = String(when)
      .replace(/\band\b/g, "&&")
      .replace(/\bor\b/g, "||")
      .replace(/!=/g, "!==")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false");
    const keys = Object.keys(paramDefs || {}).filter((k) => /^\w+$/.test(k));
    const fn = new Function(...keys, "return (" + jsExpr + ");");
    return !!fn(...keys.map((k) => _num(p[k], (paramDefs[k] && paramDefs[k].default) || 0)));
  } catch (e) {
    return true;
  }
}

// 由 effects.json 的 css 模板编译单个 preview 函数。
function _compilePreview(cssExpr, cssWhen, paramDefs) {
  return function (p) {
    const params = p || {};
    if (cssWhen && !_evalWhen(cssWhen, params, paramDefs)) return null;   // identity → 不叠滤镜
    const s = String(cssExpr).replace(/\{(\w+)\}/g, (m, k) => {
      const dflt = (paramDefs && paramDefs[k]) ? paramDefs[k].default : 0;
      return String(_num(params[k], dflt));
    });
    const style = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(s);
    if (style) {
      const out = {};
      const v = style[2];
      out[style[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;   // 数字保持 number（opacity 相乘）
      return out;
    }
    return { filter: s };   // blur(5px) 等 CSS filter 函数
  };
}

// 从 EFFECT_META 编译整表：{key: {preview}}。Node 对拍/测试入口。
function compileEffectPreviews(meta) {
  const out = {};
  for (const key in (meta || {})) {
    const e = meta[key] || {};
    out[key] = { preview: _compilePreview(e.css_expr, e.css_when, e.params) };
  }
  return out;
}

// 启动时由 HTML 调 Effects.compile(meta) 填充（保持 Effects 全局引用不变，computeEffectStyle 无需改）。
Effects.compile = function (meta) {
  const compiled = compileEffectPreviews(meta);
  for (const k in compiled) Effects[k] = compiled[k];
};

// 关键帧插值（线性；与 transform 通道同源，统一走 seg['animations'][path]）。
// 照 OpenCut（R18 并入统一 channel）：特效参数也走 animations[path] 统一通道（path='effect.{param}'），
// 与 transform.positionX 等共用同一套关键帧引擎 + 导出映射，消除「特效用 seg.keyframes 扁平、transform 用
// animations 通道」的第二种双真源。
// 兼容：旧草稿用 seg.keyframes（扁平 [{param,time,value,easing}]），无对应 effect.* 通道时回退读它。
// 返回「基础 params 被关键帧覆盖后的当前时刻参数集」。
function effectParamAt(base, anims, relUs, legacyKeyframes) {
  const p = Object.assign({}, base || {});
  const a = anims || {};
  // 1) 统一通道：遍历 effect.* 通道（keys: [{t, v, seg}]，t=相对段起点 us）
  for (const path in a) {
    if (!path.startsWith("effect.")) continue;
    const param = path.slice("effect.".length);
    const ch = a[path];
    const keys = ch && ch.keys ? ch.keys : null;
    if (!keys || !keys.length) continue;
    const v = _effectChannelValue(keys, relUs);
    if (v != null) p[param] = v;
  }
  // 2) 旧扁平 keyframes 兜底（仅当无对应 effect.* 通道时）
  if (legacyKeyframes && legacyKeyframes.length) {
    const byParam = {};
    for (const k of legacyKeyframes) {
      if (!k || k.param == null) continue;
      if (a["effect." + k.param]) continue;   // 已有统一通道，跳过旧值
      (byParam[k.param] = byParam[k.param] || []).push(k);
    }
    for (const param in byParam) {
      const arr = byParam[param].slice().sort((a2, b2) => a2.time - b2.time);
      let v = arr[0].value;
      if (relUs <= arr[0].time) v = arr[0].value;
      else if (relUs >= arr[arr.length - 1].time) v = arr[arr.length - 1].value;
      else {
        for (let i = 0; i < arr.length - 1; i++) {
          if (relUs >= arr[i].time && relUs <= arr[i + 1].time) {
            const span = (arr[i + 1].time - arr[i].time) || 1;
            const t = (relUs - arr[i].time) / span;
            v = arr[i].value + (arr[i + 1].value - arr[i].value) * t;
            break;
          }
        }
      }
      p[param] = v;
    }
  }
  return p;
}

// 单通道线性插值（keys: [{t, v, seg}]，t=相对段起点 us）。越界夹取端点；无键返回 null。
function _effectChannelValue(keys, relUs) {
  const ks = keys.slice().sort((a, b) => a.t - b.t);
  if (relUs <= ks[0].t) return ks[0].v;
  if (relUs >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
  for (let i = 0; i < ks.length - 1; i++) {
    if (relUs >= ks[i].t && relUs <= ks[i + 1].t) {
      const span = (ks[i + 1].t - ks[i].t) || 1;
      const t = (relUs - ks[i].t) / span;
      return ks[i].v + (ks[i + 1].v - ks[i].v) * t;
    }
  }
  return ks[ks.length - 1].v;
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
    const params = effectParamAt(n.params, n.animations, relUs, n.keyframes);
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
  module.exports = { Effects, computeEffectStyle, effectParamAt, compileEffectPreviews, _compilePreview };
}
