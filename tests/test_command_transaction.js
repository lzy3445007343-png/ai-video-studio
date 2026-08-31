const fs = require("fs");
const vm = require("vm");

let ok = true;
function check(name, condition, got) {
  console.log((condition ? "PASS" : "FAIL") + " - " + name + (condition ? "" : " got=" + JSON.stringify(got)));
  if (!condition) ok = false;
}

const calls = [];
const context = {
  console,
  refresh: () => {},
  call: (name, ...args) => {
    calls.push([name, ...args]);
    return Promise.resolve({ ok: true, command: args[0] });
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync("property/command.js", "utf8") + "\nglobalThis.__commandService = CommandService;", context);
context.CommandService = context.__commandService;

context.CommandService.withTx("canvas-drag", () => {
  context.CommandService.run("update_segment_transform", { x: 10 });
  context.CommandService.run("add_keyframe", { path: "transform.positionX" });
  context.CommandService.run("add_keyframe", { path: "transform.positionY" });
}, { refresh: false }).then(() => {
  check("事务先开启", calls[0][0] === "begin_transaction", calls);
  check("三条画布写入均在提交前完成", calls.slice(1, 4).every(c => c[0] === "execute") && calls[4][0] === "commit_transaction", calls);
  check("X/Y 关键帧均被执行", calls.filter(c => c[0] === "execute").map(c => c[1]).join(",") === "update_segment_transform,add_keyframe,add_keyframe", calls);
  check("事务收尾后不残留命令收集器", context.CommandService._txRuns === null, context.CommandService._txRuns);
  console.log("\nRESULT:", ok ? "ALL PASS" : "HAS FAILURE");
  process.exit(ok ? 0 : 1);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
