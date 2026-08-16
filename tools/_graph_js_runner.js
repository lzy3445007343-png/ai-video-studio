// tools/_graph_js_runner.js —— 对拍脚本专用 runner：从 stdin 读 draft/materials，输出 graph JSON。
// 不参与运行时，仅供 tools/graph_consistency.py 调用。
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildPlaybackGraph } = require(path.join(ROOT, "playback-graph.js"));

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const { draft, materials } = JSON.parse(input || "{}");
    const graph = buildPlaybackGraph(draft || {}, materials || []);
    process.stdout.write(JSON.stringify(graph));
  } catch (e) {
    process.stderr.write("JS runner 异常: " + e.message + "\n");
    process.exit(1);
  }
});
