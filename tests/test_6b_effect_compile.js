"use strict";
/*
 * M6-6b 前端编译对拍测试：用真实 effects.json 数据验证 Effects.compile / compileEffectPreviews
 * 生成的 preview 函数与原人工镜像语义一致（when 控制 identity、expr 编译 filter/style 属性）。
 * 运行：node tests/test_6b_effect_compile.js
 */
const fs = require("fs");
const path = require("path");

const fx = require("../effects.js");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "effects.json"), "utf8"));

// 与后端 _load_effects 相同口径构造 meta（css_expr/css_when）
function buildMeta() {
  const meta = {};
  for (const key in (data.effects || {})) {
    const spec = data.effects[key];
    const css = (spec.filters || {}).css || {};
    meta[key] = {
      label: spec.label,
      params: spec.params,
      css_expr: css.expr || "",
      css_when: css.when || "True",
    };
  }
  return meta;
}

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log("  [PASS] " + name); }
  else { FAIL++; console.log("  [FAIL] " + name + (detail ? " — " + detail : "")); }
}

console.log("== 1 compileEffectPreviews 全量编译 ==");
const meta = buildMeta();
check("meta 9 个特效", Object.keys(meta).length === 9, "got=" + Object.keys(meta).length);
const compiled = fx.compileEffectPreviews(meta);
check("编译产物 9 个 preview", Object.keys(compiled).length === 9);

console.log("== 2 blur（filter 函数 + when 控 identity）==");
check("radius=5 → filter blur(5px)", compiled.blur.preview({ radius: 5 }).filter === "blur(5px)");
check("radius=0 → null（identity）", compiled.blur.preview({ radius: 0 }) === null);
check("radius=2.5 → filter blur(2.5px)", compiled.blur.preview({ radius: 2.5 }).filter === "blur(2.5px)");

console.log("== 3 opacity（style 属性，非 filter）==");
check("value=0.5 → {opacity:0.5}", compiled.opacity.preview({ value: 0.5 }).opacity === 0.5
  && compiled.opacity.preview({ value: 0.5 }).filter === undefined);
check("opacity 保持 number", typeof compiled.opacity.preview({ value: 0.5 }).opacity === "number");
check("value=1 → null（identity）", compiled.opacity.preview({ value: 1 }) === null);

console.log("== 4 其他 filter 特效 ==");
check("brightness 2 → brightness(2)", compiled.brightness.preview({ value: 2 }).filter === "brightness(2)");
check("brightness 1 → null", compiled.brightness.preview({ value: 1 }) === null);
check("hue_rotate 45 → hue-rotate(45deg)", compiled.hue_rotate.preview({ value: 45 }).filter === "hue-rotate(45deg)");
check("grayscale 1 → grayscale(1)", compiled.grayscale.preview({ value: 1 }).filter === "grayscale(1)");

console.log("== 5 Effects.compile 全局填充 + 缺参兜底 ==");
fx.Effects.compile(meta);
check("Effects.blur 可用", typeof fx.Effects.blur.preview === "function");
check("缺参用 params 默认（blur radius 默认 0 → null）", fx.Effects.blur.preview({}) === null);
check("缺参用 params 默认（brightness 默认 1 → null）", fx.Effects.brightness.preview({}) === null);

console.log("== 6 computeEffectStyle 集成（编译后 filter 拼接）==");
const nodes = [
  { effectType: "blur", params: { radius: 8 }, animations: {}, keyframes: [], hidden: false,
    startUs: 0, durationUs: 1000000, target: { type: "adjustment" } },
  { effectType: "brightness", params: { value: 1.5 }, animations: {}, keyframes: [], hidden: false,
    startUs: 0, durationUs: 1000000, target: { type: "adjustment" } },
];
const st = fx.computeEffectStyle(nodes, 500000, {});
check("stackFilter 拼接 blur+brightness", st.stackFilter === "blur(8px) brightness(1.5)", "got=" + st.stackFilter);
check("stackOpacity 保持 1", st.stackOpacity === 1);
const st2 = fx.computeEffectStyle([{ ...nodes[0], effectType: "opacity", params: { value: 0.5 } }], 500000, {});
check("opacity 特效 → stackOpacity 相乘", Math.abs(st2.stackOpacity - 0.5) < 1e-9);
const st3 = fx.computeEffectStyle(nodes, 2000000, {});  // 播放头在段外
check("播放头在段外 → 不激活", st3.stackFilter === "" && st3.stackOpacity === 1);

console.log(`\n结果: ${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
