const fs = require("fs");
const vm = require("vm");

let ok = true;
function check(name, condition, got) {
  console.log((condition ? "PASS" : "FAIL") + " - " + name + (condition ? "" : " got=" + JSON.stringify(got)));
  if (!condition) ok = false;
}

const context = { console };
context.canvasPxJS = () => ({ W: 1080, H: 608 });
context.PreviewCoordinate = { displayScale: () => 0.5 };
context.InteractionManager = { isActiveOn: id => id === "dragging-seg" };
vm.createContext(context);
vm.runInContext(fs.readFileSync("renderer.js", "utf8"), context);

function imageEl() {
  return {
    firstElementChild: { tagName: "IMG", naturalWidth: 1920, naturalHeight: 1080 },
    dataset: {},
    style: { width: "540px", height: "304px" },
  };
}

const dragging = imageEl();
context._applyVisualSize(dragging, { id: "dragging-seg" });
check("拖动中保留已显示宽度", dragging.style.width === "540px", dragging.style);
check("拖动中保留已显示高度", dragging.style.height === "304px", dragging.style);
check("拖动中仍更新基础尺寸", +dragging.dataset.baseW === 1080 && +dragging.dataset.baseH === 608, dragging.dataset);

const idle = imageEl();
context._applyVisualSize(idle, { id: "idle-seg" });
check("空闲渲染按显示缩放设置宽度", idle.style.width === "540px", idle.style);
check("空闲渲染按显示缩放设置高度", idle.style.height === "304px", idle.style);

console.log("\nRESULT:", ok ? "ALL PASS" : "HAS FAILURE");
process.exit(ok ? 0 : 1);
