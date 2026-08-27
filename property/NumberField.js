/* =====================================================================
 * property/NumberField.js —— 数字输入字段（Property Framework v1）
 * =====================================================================
 * 对齐 OpenCut components/ui/number-field.tsx + PropertyParamField：
 *   - <input type="text" inputmode="decimal">（保证 I-beam 光标 + 数字键盘）
 *   - input → preview（本地草稿，不落库） / blur、Enter → commit
 *   - 步进 / 钳制（min/max）在 parse 里做（对齐 OpenCut snapToStep + clamp）
 * DOM 只在 mount 创建一次；update 只改 input.value（光标/焦点永存）。
 */
class NumberField extends PropertyField {
  /**
   * @param {Object} opts
   * @param {number} opts.value        当前值（初始显示）
   * @param {number} [opts.min=-Infinity]
   * @param {number} [opts.max=Infinity]
   * @param {number} [opts.step=1]
   * @param {string} [opts.unit=""]
   * @param {number} [opts.digits]     显示小数位（默认按 step 推算）
   * @param {Function} [opts.onPreview] (v) => void
   * @param {Function} [opts.onCommit]  (v) => void
   * @param {Function} [opts.onReset]   () => void（可选，复位按钮）
   */
  constructor(opts) {
    super({
      id: opts.id,
      label: opts.label,
      buildDom: () => NumberField._build(opts),
      bind: () => this.bind(),          // 实例方法 bind（mount 时调用一次）
      write: (el, v) => {
        const inp = el.querySelector(".pf-num-input");
        if (inp && document.activeElement !== inp) inp.value = NumberField._fmt(v, opts.digits, opts.step);
      },
      read: el => {
        const inp = el.querySelector(".pf-num-input");
        const n = parseFloat(inp ? inp.value : NaN);
        return isNaN(n) ? null : n;
      },
    });
    this.min = opts.min !== undefined ? opts.min : -Infinity;
    this.max = opts.max !== undefined ? opts.max : Infinity;
    this.step = opts.step || 1;
    this.unit = opts.unit || "";
    this.onPreview = opts.onPreview || null;
    this.onCommit = opts.onCommit || null;
    this.onReset = opts.onReset || null;
    this._draft = new PropertyDraft({
      parse: raw => this._parse(raw),
      getValue: () => this.value,
      preview: opts.onPreview || null,
      commit: opts.onCommit || null,
    });
    this._lastValue = opts.value;
  }

  get value() {
    const n = this.read();
    return n !== null ? n : this._lastValue;
  }

  _parse(raw) {
    const n = parseFloat(raw);
    if (isNaN(n)) return null;
    // 步进吸附 + 钳制（对齐 OpenCut snapToStep + clamp）
    let v = n;
    if (this.step && this.step > 0 && isFinite(this.step)) v = Math.round(n / this.step) * this.step;
    if (isFinite(this.min) && v < this.min) v = this.min;
    if (isFinite(this.max) && v > this.max) v = this.max;
    return v;
  }

  bind() {
    const inp = this.el.querySelector(".pf-num-input");
    if (!inp) return;
    this.on(inp, "input", e => {
      window.__inspectorInteracting = true;   // L0-03 Q2=A：编辑期间禁止 2s 轮询 refresh（防预览弹回）
      window.__inspectorInteractingAt = Date.now();   // 超时兜底时间戳（previewActive 15s 自动解锁）
      this._draft.onInput(e.target.value);
      this._lastValue = this._draft.value;
    });
    this.on(inp, "blur", () => {
      window.__inspectorInteracting = false;  // L0-03 Q2=A：提交/失焦解除，轮询恢复
      this._draft.onCommit();
      this.update(this._lastValue);      // 提交后回显规范化值
    });
    this.on(inp, "keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { e.preventDefault(); this._draft.reset(); this.update(this._lastValue); inp.blur(); }
    });
    const rst = this.el.querySelector(".pf-num-reset");
    if (rst) this.on(rst, "click", () => {
      if (this.onReset) this.onReset();
      else { inp.value = NumberField._fmt(this.min, this._digits, this.step); this._draft.onInput(inp.value); this._draft.onCommit(); }
    });
  }

  static _build(opts) {
    const wrap = document.createElement("div");
    wrap.className = "pf-field pf-num";
    if (opts.label !== undefined) {
      const lab = document.createElement("label");
      lab.className = "pf-label";
      lab.textContent = opts.label;
      wrap.appendChild(lab);
    }
    const num = document.createElement("div");
    num.className = "pf-num-row";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.inputMode = "decimal";
    inp.className = "pf-num-input";
    inp.value = NumberField._fmt(opts.value, opts.digits, opts.step);
    num.appendChild(inp);
    if (opts.unit) {
      const u = document.createElement("span");
      u.className = "pf-unit";
      u.textContent = opts.unit;
      num.appendChild(u);
    }
    if (opts.onReset !== false) {
      const rst = document.createElement("button");
      rst.type = "button";
      rst.className = "pf-num-reset";
      rst.title = "恢复默认";
      rst.textContent = "↺";
      num.appendChild(rst);
    }
    wrap.appendChild(num);
    return wrap;
  }

  static _fmt(v, digits, step) {
    if (v === null || v === undefined || !isFinite(v)) return "0";
    let d = digits;
    if (d === undefined) {
      const s = Math.abs(step || 1);
      d = s < 1 ? Math.min(3, String(s).split(".")[1]?.length || 1) : 1;
    }
    return Number(v).toFixed(d);
  }
}
