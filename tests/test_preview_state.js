const fs = require("fs");
const vm = require("vm");

let ok = true;
function check(name, condition, got) {
  console.log((condition ? "PASS" : "FAIL") + " - " + name + (condition ? "" : " got=" + JSON.stringify(got)));
  if (!condition) ok = false;
}

const context = { console };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync("property/preview-state.js", "utf8"), context);
vm.runInContext(fs.readFileSync("property/property-kernel.js", "utf8"), context);
context.KfChannel = { isAnimated: () => false, KF_HIT_TOLERANCE_US: 0 };
context.kfVal = () => null;
vm.runInContext(fs.readFileSync("property/effective-property-resolver.js", "utf8"), context);

const seg = {
  id: "seg-1",
  params: {
    "transform.positionX": 12,
    "transform.positionY": 24,
    stroke: { width: 2 },
  },
  animations: {},
};
const original = JSON.stringify(seg);

context.PreviewState.set("seg-1", "transform.positionX", 96);
context.PreviewState.set("seg-1", "transform.positionY", -48);
context.PreviewState.set("seg-1", "params.stroke.width", 7);
const view = context.PreviewState.getPreviewSeg(seg);

check("规范 X 写入扁平 params", view.params["transform.positionX"] === 96, view.params);
check("规范 Y 写入扁平 params", view.params["transform.positionY"] === -48, view.params);
check("嵌套 params 预览可读", view.params.stroke.width === 7, view.params);
check("正式段在预览期间不被污染", JSON.stringify(seg) === original, seg);
context.seg = seg;
const effective = vm.runInContext('getEffectivePropertyValue(seg, "transform.positionX", 0)', context);
check("参数面板读取同一预览 X", effective.value === 96, effective);

const channel = { keys: [{ t: 0, v: 96, seg: "linear" }] };
context.PreviewState.setPreviewChannel("seg-1", "transform.positionX", channel);
const animatedView = context.PreviewState.getPreviewSeg(seg);
check("预览关键帧覆盖动画通道", animatedView.animations["transform.positionX"] === channel, animatedView.animations);

let change;
context.PreviewState.subscribe((segId, meta) => { if (segId === "seg-1") change = meta; });
context.PreviewState.clear("seg-1");
check("清除关键帧预览通知时间轴", change && change.keyframes === true, change);

console.log("\nRESULT:", ok ? "ALL PASS" : "HAS FAILURE");
process.exit(ok ? 0 : 1);
