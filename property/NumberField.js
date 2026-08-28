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
        const rst = el.querySelector(".pf-num-reset");                          // L2-29：值=默认时隐藏 reset
        if (rst && this._isDefault) rst.style.display = this._isDefault(v) ? "none" : "";
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
    this._default = (opts.default !== undefined) ? opts.default : this.min;   // L2-29：reset 回退到 default（非 min）
    this._isDefault = opts.isDefault || null;                                 // L2-29：条件显示 reset 的判定函数 (v)=>bool
    this._digits = opts.digits;                                              // L1-17：scrub 回显用
    this._scrubSensitivity = opts.scrubSensitivity;                           // L1-17：flat 灵敏度（默认 0.5）
    this._scrubRanges = opts.scrubRanges || null;                            // L1-17：分段灵敏度（覆盖 flat）
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
    // L1-19：表达式求值（1920/2→960、100*1.5→150），否则退化为 parseFloat
    const n = (typeof ExprParse !== "undefined") ? ExprParse.parseNumeric(raw) : parseFloat(raw);
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
    // L1-18：点击全选（mousedown 阻止原生 caret 放置并 focus+select；focus 兜底再 select 防二次点击取消）
    this.on(inp, "mousedown", e => {
      e.preventDefault();
      inp.focus();
      inp.select();
    });
    this.on(inp, "focus", () => { inp.select(); });
    this.on(inp, "blur", () => {
      window.__inspectorInteracting = false;  // L0-03 Q2=A：提交/失焦解除，轮询恢复
      this._draft.onCommit();
      this.update(this._lastValue);      // 提交后回显规范化值
    });
    this.on(inp, "keydown", e => {
      // L1-18 分支 A（对齐 OpenCut）：Enter / Escape 均提交（blur 触发 commit），无"丢弃"
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); inp.blur(); }
    });
    const rst = this.el.querySelector(".pf-num-reset");
    if (rst) this.on(rst, "click", () => {
      if (this.onReset) this.onReset();
      else { inp.value = NumberField._fmt(this._default, this._digits, this.step); this._draft.onInput(inp.value); this._draft.onCommit(); }
    });
    // L1-17：左侧 icon drag-to-scrub（复用 ScrubSession + InteractionManager 互斥 + refresh 锁）
    const ic = this.el.querySelector(".pf-num-icon");
    if (ic && (this.onPreview || this.onCommit)) {
      const self = this;
      attachScrub(ic, {
        getStart: () => self.value,
        sensitivity: self._scrubSensitivity != null ? self._scrubSensitivity : 0.5,
        ranges: self._scrubRanges || null,
        onScrub: (v) => {
          const i = self.el.querySelector(".pf-num-input");
          if (i) i.value = NumberField._fmt(v, self._digits, self.step);
          self._draft.onInput(String(v));        // → self.onPreview(v) 实时预览（不落库）
        },
        onScrubEnd: (v) => {
          const i = self.el.querySelector(".pf-num-input");
          if (i) i.value = NumberField._fmt(v, self._digits, self.step);
          self._draft.onInput(String(v));
          self._draft.onCommit();                // 松手一条 undo
        },
        onCancel: (startVal) => {
          const i = self.el.querySelector(".pf-num-input");
          if (i) i.value = NumberField._fmt(startVal, self._digits, self.step);
          self._draft.reset();                    // 清未提交草稿
          if (self.onPreview) self.onPreview(startVal);   // 内存态回退到起始值
        },
      });
    }
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
    // L1-17：左侧 scrub 手柄（有 onPreview/onCommit 的活字段才显把手，对齐 OpenCut number-field.tsx）
    if (opts.scrub !== false && (opts.onPreview || opts.onCommit)) {
      const ic = document.createElement("span");
      ic.className = "pf-num-icon";
      ic.textContent = "⇔";
      ic.title = "按住拖动调节（左右拖动改值）";
      ic.style.cursor = "ew-resize";
      ic.style.color = "var(--muted)";
      ic.style.userSelect = "none";
      ic.style.marginRight = "4px";
      num.appendChild(ic);
    }
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
