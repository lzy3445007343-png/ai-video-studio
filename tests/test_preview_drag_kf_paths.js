// 双轴关键帧判定必须读取提交时的稳定段对象，而不是 pointerdown 旧引用。
const fs = require("fs");
const vm = require("vm");
const src = fs.readFileSync("property/preview-drag.js", "utf8");
const context = {
  console,
  window: {},
  document: { readyState: "loading", addEventListener() {} },
};
vm.createContext(context);
vm.runInContext(src.slice(src.indexOf("function _previewHasAnim"), src.indexOf("function _previewScale")), context);
const has = context._previewHasAnim;
const fresh = { animations: {
  "transform.positionX": { keys: [{ t: 0, v: 1 }] },
  "transform.positionY": { keys: [{ t: 0, v: 1 }] },
} };
const stale = { animations: { "transform.positionX": { keys: [{ t: 0, v: 1 }] } } };
if (!has(fresh, "transform.positionX") || !has(fresh, "transform.positionY")) process.exit(1);
if (has(stale, "transform.positionY")) process.exit(1);
console.log("test_preview_drag_kf_paths: ALL PASSED");
