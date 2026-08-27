/* =====================================================================
 * property/SliderField.js —— 滑块字段（Property Framework v1）
 * =====================================================================
 * 对齐 OpenCut MaskNumberField 的拖动语义 + 剪辑软件铁律：
 *   input（拖动）→ preview（每帧只改内存+预览渲染器，不落库）
 *   change（松手）→ commit（落库）
 * DOM 只在 mount 创建一次；update 只改 input.value + 数值显示。
 */
class SliderField extends PropertyField {
  /**
   * @param {Object} opts
   * @param {number} opts.value
   * @param {number} opts.min
   * @param {number} opts.max
   * @param {number} [opts.step]
   * @param {string} [opts.label]
   * @param {Function} [opts.onPreview] (v) => void（拖动实时）
   * @param {Function} [opts.onCommit]  (v) => void（松手落库）
   * @param {Function} [opts.format]    (v) => string（数值显示，默认 Math.round(v*100)/100）
   */
  constructor(opts) {
    super({
      id: opts.id,
      label: opts.label,
      buildDom: () => SliderField._build(opts),
      bind: () => this.bind(),          // 实例方法 bind（mount 时调用一次）
      write: (el, v) => {
        const inp = el.querySelector(".pf-slider-input");
        const valEl = el.querySelector(".pf-slider-val");
        if (inp && document.activeElement !== inp) inp.value = v;
        if (valEl) valEl.textContent = opts.format ? opts.format(v) : SliderField._fmt(v);
      },
      read: el => {
        const inp = el.querySelector(".pf-slider-input");
        const n = parseFloat(inp ? inp.value : NaN);
        return isNaN(n) ? null : n;
      },
    });
    this.min = opts.min;
    this.max = opts.max;
    this.step = opts.step;
    this.onPreview = opts.onPreview || null;
    this.onCommit = opts.onCommit || null;
  }

  bind() {
    const inp = this.el.querySelector(".pf-slider-input");
    if (!inp) return;
    this.on(inp, "input", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) return;
      const valEl = this.el.querySelector(".pf-slider-val");
      if (valEl) valEl.textContent = SliderField._fmt(v);
      window.__inspectorInteracting = true;   // L0-03 Q2=A：拖参期间禁止 2s 轮询 refresh（防预览弹回）
      window.__inspectorInteractingAt = Date.now();   // 超时兜底时间戳（previewActive 15s 自动解锁）
      if (this.onPreview) this.onPreview(v);     // 拖动中每帧预览，不落库
    });
    this.on(inp, "change", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) return;
      window.__inspectorInteracting = false;  // L0-03 Q2=A：松手解除，轮询恢复
      if (this.onCommit) this.onCommit(v);       // 松手才落库
    });
    this.on(inp, "pointerup", () => { window.__inspectorInteracting = false; }); // 安全网：range 未触发 change 也释放
  }

  static _build(opts) {
    const row = document.createElement("div");
    row.className = "pf-field pf-slider";
    if (opts.label !== undefined) {
      const lab = document.createElement("label");
      lab.className = "pf-label";
      lab.textContent = opts.label;
      row.appendChild(lab);
    }
    const inp = document.createElement("input");
    inp.type = "range";
    inp.className = "pf-slider-input";
    inp.min = opts.min;
    inp.max = opts.max;
    if (opts.step) inp.step = opts.step;
    inp.value = opts.value;
    row.appendChild(inp);
    const val = document.createElement("span");
    val.className = "pf-slider-val";
    val.textContent = SliderField._fmt(opts.value);
    row.appendChild(val);
    return row;
  }

  static _fmt(v) { return Math.round(v * 100) / 100; }
}
