"use strict";
/*
 * M7-7c 前端时间统一收口对拍测试：TimelineMapper.frameUs/snapFrame 与后端 snap_frame 同语义。
 * 运行：node tests/test_7c_mapper.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "property", "timeline-mapper.js"), "utf8");
const TM = new Function(src + "\nreturn TimelineMapper;")();

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; console.log("  [PASS] " + name); }
  else { FAIL++; console.log("  [FAIL] " + name + (detail ? " — " + detail : "")); }
}

console.log("== 1 frameUs ==");
check("frameUs(30) = 33333", TM.frameUs(30) === 33333, "got=" + TM.frameUs(30));
check("frameUs(25) = 40000", TM.frameUs(25) === 40000);
check("frameUs(60) = 16667", TM.frameUs(60) === 16667);
check("TICKS_PER_SECOND = 1e6", TM.TICKS_PER_SECOND === 1000000);

console.log("== 2 snapFrame（与后端 snap_frame 同数值）==");
check("snapFrame(0) = 0", TM.snapFrame(0) === 0);
check("snapFrame(33333) = 33333", TM.snapFrame(33333) === 33333);
check("snapFrame(16667) = 33333", TM.snapFrame(16667) === 33333, "got=" + TM.snapFrame(16667));
check("snapFrame(16666) = 0", TM.snapFrame(16666) === 0);
check("snapFrame(50000) = 66666", TM.snapFrame(50000) === 66666);
check("snapFrame(99999) = 99999", TM.snapFrame(99999) === 99999);
check("snapFrame(20000, 25) = 40000", TM.snapFrame(20000, 25) === 40000);
check("snapFrame(19999, 25) = 0", TM.snapFrame(19999, 25) === 0);

console.log("== 3 原 API 兼容（global/local 映射不回归）==");
check("globalToLocal 钳制", TM.globalToLocal({ start: 100, duration: 500 }, 300) === 200
  && TM.globalToLocal({ start: 100, duration: 500 }, 99999) === 500);
check("localToGlobal", TM.localToGlobal({ start: 100, duration: 500 }, 200) === 300);

console.log(`\n结果: ${PASS} PASS / ${FAIL} FAIL`);
process.exit(FAIL ? 1 : 0);
