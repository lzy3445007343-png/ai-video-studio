/* =====================================================================
 * property/command.js —— CommandService（C3，前端写操作统一入口）
 * =====================================================================
 * 目标：前端所有写操作统一走后端 execute（语义 Command + 审计 meta），
 *       Agent/MCP 复用同一路径；事务（一次手势/一次动作 = 一条 undo）。
 *   - run(cmdId, args, meta)    → call("execute", ...) 统一写入口
 *   - beginTx/commitTx/abortTx  → 后端事务桥接
 *   - withTx(label, fn, meta)   → 便捷事务包装（begin → fn → commit / abort）
 * 约束（GPT 评审 v2）：
 *   - 事务/命令细节在 CommandService，Session（DragSession 等）不直接知道后端命令名
 *   - 空事务不压栈（后端行为）；abort 幂等
 * 依赖：call（store.js）
 * ===================================================================== */

const CommandService = {
  /* 统一写入口：语义 Command + 审计（actor/reason/confidence/source/paths） */
  run(cmdId, args, meta) {
    return call("execute", cmdId, args || {}, meta || { actor: "ui" });
  },
  /* 事务桥接 */
  beginTx(label, meta) { return call("begin_transaction", label || "batch", meta || {}); },
  commitTx() { return call("commit_transaction"); },
  abortTx() { return call("abort_transaction"); },
  /* 便捷事务：begin → fn() 返回 Promise → 成功 commit / 失败 abort（自动 refresh） */
  withTx(label, fn, opts) {
    opts = opts || {};
    return this.beginTx(label, opts.meta).then(beginRes => {
      // 2d（M2）：begin 失败（已有进行中事务 / 超时遗留被 abort 后重开）时**拒绝执行 fn**——
      // 否则 fn 内的 execute 走「非事务」路径各自压栈，一次手势变成多条 undo，事务语义失效。
      if (!beginRes || beginRes.ok === false) {
        if (opts.onError) opts.onError(beginRes && beginRes.error);
        if (opts.refresh !== false) refresh();
        return beginRes || { ok: false, error: "begin 事务失败" };
      }
      return fn().then(
        res => {
          if (res && res.ok === false) {
            if (opts.onError) opts.onError(res.error);
            return this.abortTx().then(() => { if (opts.refresh !== false) refresh(); return res; });
          }
          return this.commitTx().then(() => { if (opts.refresh !== false) refresh(); return res; });
        },
        err => {
          console.error("[CommandService] " + label + " 失败:", err);
          if (opts.onError) opts.onError(err);
          return this.abortTx().then(() => { if (opts.refresh !== false) refresh(); throw err; });
        }
      );
    });
  },
};
