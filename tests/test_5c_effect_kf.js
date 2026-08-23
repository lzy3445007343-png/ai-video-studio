// 5c（R18）特效关键帧统一通道：验证 effectParamAt 在「统一 animations 通道」下
// 行为与旧「扁平 seg.keyframes」一致，且静态/多参数/越界夹取正确。
const { effectParamAt } = require("../effects.js");

let ok = true;
function check(name, cond, got) {
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (cond ? "" : "  got=" + JSON.stringify(got)));
  if (!cond) ok = false;
}

// 统一通道：effect.value 0→2 @1s
const anims = { "effect.value": { keys: [ {t:0, v:0, seg:"linear"}, {t:1000000, v:2, seg:"linear"} ] } };
const base = { value: 1 };
check("统一通道 起点=0", effectParamAt(base, anims, 0).value === 0, effectParamAt(base, anims, 0));
check("统一通道 中点=1", effectParamAt(base, anims, 500000).value === 1, effectParamAt(base, anims, 500000));
check("统一通道 终点=2", effectParamAt(base, anims, 1000000).value === 2, effectParamAt(base, anims, 1000000));
check("统一通道 越界夹取=2", effectParamAt(base, anims, 2000000).value === 2, effectParamAt(base, anims, 2000000));

// 旧扁平兜底（无 effect.* 通道时回退）
const legacy = [ {param:"value", time:0, value:0, easing:"linear"}, {param:"value", time:1000000, value:2, easing:"linear"} ];
check("旧扁平 中点=1", effectParamAt(base, {}, 500000, legacy).value === 1, effectParamAt(base, {}, 500000, legacy));

// 统一通道优先于旧扁平（同 param 不冲突时各自独立）
const animsMix = { "effect.value": { keys: [ {t:0, v:9, seg:"linear"}, {t:1000000, v:9, seg:"linear"} ] } };
check("统一通道优先(忽略旧扁平同param)", effectParamAt(base, animsMix, 500000, legacy).value === 9, effectParamAt(base, animsMix, 500000, legacy));

// 静态（无动画）
check("静态 value=1.5", effectParamAt({value:1.5}, {}, 500000, null).value === 1.5, effectParamAt({value:1.5}, {}, 500000, null));

// 多参数
const anims2 = {
  "effect.value":  { keys: [ {t:0, v:0, seg:"linear"}, {t:1000000, v:2, seg:"linear"} ] },
  "effect.radius": { keys: [ {t:0, v:5, seg:"linear"}, {t:1000000, v:10, seg:"linear"} ] },
};
const mp = effectParamAt({value:1, radius:0}, anims2, 500000, null);
check("多参数 value=1", mp.value === 1, mp);
check("多参数 radius=7.5", mp.radius === 7.5, mp);

console.log("\nRESULT:", ok ? "ALL PASS" : "HAS FAILURE");
process.exit(ok ? 0 : 1);
