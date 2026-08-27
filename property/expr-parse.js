/* =====================================================================
 * property/expr-parse.js —— L1-19 数学表达式输入
 * 对标 OpenCut looksLikeExpression / evaluateMathExpression（行为圣经04 §2.1-A）。
 * 暴露全局 ExprParse：{ looksLikeExpression, evaluateMathExpression, parseNumeric }
 *
 * 安全硬约束：禁止 eval / Function。表达式来自用户输入，eval 是注入面，必须自实现解析。
 * 分支 A（对齐 OpenCut）：`+50` → 一元正号 → 50（非相对增量）。
 * 求值顺序（上层负责）：求值 → step 吸附 → 钳制。
 * ===================================================================== */
(function (global) {
  "use strict";

  /* 是否像表达式：含 * / 或 + ，或中缀 - （排除纯负 -50、小数 1.5、指数 1e3）。
   * `-30`/`1.5` 先去掉首字符负号再判，避免被当成中缀减。 */
  function looksLikeExpression(raw) {
    if (typeof raw !== "string" || !raw.trim().length) return false;
    if (/[*/]/.test(raw)) return true;
    if (raw.indexOf("+") >= 0) return true;
    const t = raw.replace(/^\s*-/, "");          // 去掉首字符负号
    return /^.+-/.test(t);                        // 之后仍含 '-' = 中缀减
  }

  /* 词法：数字（含小数）、( )、+ - * / ；一元 + / - 在运算位置识别为 u+/u-。
   * 其余字符（字母 / e 等）→ 返回 null（非法，上层据此不采纳）。 */
  function tokenize(s) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (c === "(" || c === ")" || c === "*" || c === "/") {
        toks.push({ t: "op", v: c }); i++; continue;
      }
      if (c === "+" || c === "-") {
        const prev = toks.length ? toks[toks.length - 1] : null;
        const unary = !prev || (prev.t === "op" && prev.v !== ")");
        if (unary) toks.push({ t: "op", v: c === "+" ? "u+" : "u-" });
        else toks.push({ t: "op", v: c });
        i++; continue;
      }
      if (/[0-9.]/.test(c)) {
        let j = i, num = "";
        while (j < s.length && /[0-9.]/.test(s[j])) { num += s[j]; j++; }
        if (num === "" || num === "." || (num.match(/\./g) || []).length > 1) return null;
        const n = parseFloat(num);
        if (isNaN(n)) return null;
        toks.push({ t: "num", v: n });
        i = j; continue;
      }
      return null;   // 非法字符
    }
    return toks;
  }

  /* 调度场算法（Shunting-yard）→ 逆波兰式。支持一元 u+ / u- 与二元 + - * / 与括号。 */
  function toRPN(toks) {
    const out = [], op = [];
    const prec = { "u+": 4, "u-": 4, "*": 3, "/": 3, "+": 2, "-": 2 };
    const rightAssoc = { "u+": true, "u-": true };
    for (const tk of toks) {
      if (tk.t === "num") { out.push(tk); }
      else if (tk.v === "(") { op.push(tk); }
      else if (tk.v === ")") {
        while (op.length && op[op.length - 1].v !== "(") out.push(op.pop());
        if (!op.length) return null;            // 括号不匹配
        op.pop();
      } else {
        const o1 = tk.v;
        while (op.length && op[op.length - 1].v !== "(") {
          const o2 = op[op.length - 1].v;
          if ((!rightAssoc[o1] && prec[o1] <= prec[o2]) ||
              (rightAssoc[o1] && prec[o1] < prec[o2])) {
            out.push(op.pop());
          } else break;
        }
        op.push(tk);
      }
    }
    while (op.length) {
      const t = op.pop();
      if (t.v === "(" || t.v === ")") return null;
      out.push(t);
    }
    return out;
  }

  function evalRPN(rpn) {
    const st = [];
    for (const tk of rpn) {
      if (tk.t === "num") { st.push(tk.v); continue; }
      if (tk.v === "u+") { if (st.length < 1) return null; st.push(st.pop()); continue; }
      if (tk.v === "u-") { if (st.length < 1) return null; st.push(-st.pop()); continue; }
      if (st.length < 2) return null;
      const b = st.pop(), a = st.pop();
      if (tk.v === "+") st.push(a + b);
      else if (tk.v === "-") st.push(a - b);
      else if (tk.v === "*") st.push(a * b);
      else if (tk.v === "/") { if (b === 0) return null; st.push(a / b); }
      else return null;
    }
    if (st.length !== 1) return null;
    return st[0];
  }

  /* 表达式求值：失败（语法/除零/非法）一律返回 null（上层不采纳，不打断输入）。 */
  function evaluateMathExpression(raw) {
    if (typeof raw !== "string") return null;
    const toks = tokenize(raw.trim());
    if (!toks) return null;
    const rpn = toRPN(toks);
    if (!rpn) return null;
    const r = evalRPN(rpn);
    if (r === null || r === undefined || isNaN(r) || !isFinite(r)) return null;
    return r;
  }

  /* 统一数值解析：表达式 → 求值；否则 parseFloat。
   * 返回 number；非法时返回 NaN（上层 parse 据此返回 null 不采纳）。 */
  function parseNumeric(raw) {
    if (typeof raw !== "string") {
      const n = parseFloat(raw);
      return isNaN(n) ? NaN : n;
    }
    if (looksLikeExpression(raw)) {
      const v = evaluateMathExpression(raw);
      return (v === null || v === undefined) ? NaN : v;
    }
    return parseFloat(raw);
  }

  global.ExprParse = { looksLikeExpression, evaluateMathExpression, parseNumeric };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ExprParse;
})(typeof window !== "undefined" ? window : globalThis);
