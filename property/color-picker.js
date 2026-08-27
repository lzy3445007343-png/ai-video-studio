// L2-07 ColorPickerField：vanilla 颜色选择器（对齐 OpenCut use-keyframed-color-property 交互）
// 触发色块（棋盘格底 + 当前色覆盖层）+ Popover 三拖条（饱和度方区/色相条/不透明度条）
// + hex 输入(uppercase) + 粘贴取色 + 格式下拉(HEX/RGB/HSL/HSV) + EyeDropper(WebView2 支持时显示)
// 两阶段：拖动 onChange 预览 / mouseup+Enter onChangeEnd 提交（一次手势一条 undo）
// 预加载：本文件必须在 kf-panel.js / text-panel.js 之前 <script src> 引入。

(function (global) {
  "use strict";

  // —— hex <-> rgba（分量 0~1）——
  function hexToRgba(hex) {
    hex = (hex || "#000000").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    if (hex.length === 6) hex += "ff";
    if (hex.length !== 8) return { r: 0, g: 0, b: 0, a: 1 };
    const n = parseInt(hex, 16);
    return {
      r: ((n >> 24) & 255) / 255,
      g: ((n >> 16) & 255) / 255,
      b: ((n >> 8) & 255) / 255,
      a: (n & 255) / 255,
    };
  }
  function rgbaToHex(r, g, b, a) {
    const c = v => {
      const x = Math.max(0, Math.min(255, Math.round(v * 255)));
      return x.toString(16).padStart(2, "0");
    };
    return "#" + c(r) + c(g) + c(b) + c(a == null ? 1 : a);
  }
  // rgba(0~1) -> hsl（h:0~360, s/l:0~1）
  function rgbaToHsl(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    const d = max - min;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    return { h, s, l };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    let r, g, b;
    if (s < 1e-6) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      const hk = t => {
        if (t < 0) t += 1; if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      r = hk(h + 1 / 3); g = hk(h); b = hk(h - 1 / 3);
    }
    return { r, g, b };
  }
  // 从任意文本提取 hex（OpenCut color-picker.tsx:196-250 同款：匹配 #rgb/#rrggbb/#rrggbbaa）
  function extractColorFromText(text) {
    const m = (text || "").match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/);
    return m ? "#" + m[1] : null;
  }

  function fmt(rgb, mode) {
    const { r, g, b, a } = rgb;
    if (mode === "RGB") return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    if (mode === "HSL") { const h = rgbaToHsl(r, g, b); return `hsl(${h.h},${Math.round(h.s * 100)}%,${Math.round(h.l * 100)}%)`; }
    if (mode === "HSV") { const h = rgbaToHsl(r, g, b); return `hsv(${h.h},${Math.round(h.s * 100)}%,${Math.round((h.l + h.s * (1 - Math.abs(2 * h.l - 1))) / 2 * 100)}%)`; }
    return rgbaToHex(r, g, b, a);
  }

  class ColorPickerField {
    constructor(opts) {
      this.value = opts.value || "#000000";
      this.onPreview = opts.onPreview || function () {};
      this.onCommit = opts.onCommit || function () {};
      this.mode = opts.mode || "HEX";
      this.el = null;       // 触发色块
      this.pop = null;      // Popover
      this._open = false;
      this._drag = null;    // 当前拖动的条
    }
    mount(parent) {
      const sw = document.createElement("span");
      sw.className = "cp-swatch";
      sw.title = "点击打开颜色选择器";
      sw.style.backgroundImage = "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)";
      sw.style.backgroundSize = "10px 10px";
      sw.style.backgroundPosition = "0 0,0 5px,5px -5px,-5px 0";
      const cur = document.createElement("span");
      cur.className = "cp-swatch-cur";
      cur.style.background = this.value;
      sw.appendChild(cur);
      sw.addEventListener("click", e => { e.stopPropagation(); this.toggle(); });
      parent.appendChild(sw);
      this.el = sw;
      this._cur = cur;
      this._bindOutside();
      return this;
    }
    setColor(hex, fire) {
      this.value = hex;
      if (this._cur) this._cur.style.background = hex;
      if (this.pop) this._renderPop();
      if (fire === "preview") this.onPreview(hex);
      else if (fire === "commit") this.onCommit(hex);
    }
    toggle() { this._open ? this.close() : this.open(); }
    open() {
      if (this._open) return;
      this._open = true;
      const pop = document.createElement("div");
      pop.className = "cp-pop";
      this.pop = pop;
      document.body.appendChild(pop);
      this._renderPop();
      const r = this.el.getBoundingClientRect();
      pop.style.left = Math.min(r.left, window.innerWidth - 270) + "px";
      pop.style.top = (r.bottom + 6) + "px";
    }
    close() {
      this._open = false;
      if (this.pop) { this.pop.remove(); this.pop = null; }
    }
    _renderPop() {
      const pop = this.pop; if (!pop) return;
      const rgb = hexToRgba(this.value);
      const hsl = rgbaToHsl(rgb.r, rgb.g, rgb.b);
      pop.innerHTML = "";
      // 饱和度方区（底色=当前色相）
      const sat = document.createElement("div");
      sat.className = "cp-sat";
      const hueHex = rgbaToHex(hslToRgb(hsl.h, 1, 0.5).r, hslToRgb(hsl.h, 1, 0.5).g, hslToRgb(hsl.h, 1, 0.5).b, 1);
      sat.style.background = `hsl(${hsl.h},100%,50%)`;
      const satDot = document.createElement("span");
      satDot.className = "cp-sat-dot";
      satDot.style.left = (rgb.s * 100) + "%";
      satDot.style.top = (100 - rgb.l * 100) + "%";
      satDot.style.background = this.value;
      sat.appendChild(satDot);
      sat.addEventListener("pointerdown", e => this._startDrag(e, "sat", hueHex));
      pop.appendChild(sat);
      // 色相条
      const hue = document.createElement("div");
      hue.className = "cp-hue";
      hue.addEventListener("pointerdown", e => this._startDrag(e, "hue"));
      pop.appendChild(hue);
      // 不透明度条
      const alp = document.createElement("div");
      alp.className = "cp-alpha";
      alp.style.backgroundImage = "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)";
      alp.style.backgroundSize = "8px 8px";
      alp.style.backgroundPosition = "0 0,0 4px,4px -4px,-4px 0";
      const alpFill = document.createElement("span");
      alpFill.className = "cp-alpha-fill";
      alpFill.style.background = `linear-gradient(90deg, transparent, ${this.value})`;
      alp.appendChild(alpFill);
      alp.addEventListener("pointerdown", e => this._startDrag(e, "alpha"));
      pop.appendChild(alp);
      // 格式下拉 + hex 输入
      const bar = document.createElement("div");
      bar.className = "cp-bar";
      const sel = document.createElement("select");
      ["HEX", "RGB", "HSL", "HSV"].forEach(m => {
        const o = document.createElement("option"); o.value = m; o.textContent = m; if (m === this.mode) o.selected = true; sel.appendChild(o);
      });
      sel.addEventListener("change", () => { this.mode = sel.value; this._renderPop(); });
      const inp = document.createElement("input");
      inp.className = "cp-hex"; inp.value = fmt(rgb, this.mode); inp.spellcheck = false;
      inp.addEventListener("input", () => {
        const t = inp.value.trim();
        const h = t.startsWith("#") ? t : (extractColorFromText(t) || (this.mode === "HEX" ? "#" + t : null));
        if (h && /^#[0-9a-fA-F]{3,8}$/.test(h)) this.setColor(h.toUpperCase(), "preview");
      });
      inp.addEventListener("paste", e => {
        const txt = (e.clipboardData || window.clipboardData).getData("text");
        const h = extractColorFromText(txt);
        if (h) { e.preventDefault(); this.setColor(h.toUpperCase(), "commit"); }
      });
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { this.setColor(inp.value.trim(), "commit"); this.close(); } });
      inp.addEventListener("blur", () => this.setColor(inp.value.trim(), "commit"));
      bar.appendChild(sel); bar.appendChild(inp);
      pop.appendChild(bar);
      // EyeDropper（WebView2 支持 window.EyeDropper 时显示）
      if (global.EyeDropper) {
        const eye = document.createElement("button");
        eye.className = "cp-eye"; eye.textContent = "吸管";
        eye.addEventListener("click", async () => {
          try { const r = await new global.EyeDropper().open(); if (r && r.sRGBHex) this.setColor(r.sRGBHex.toUpperCase(), "commit"); }
          catch (_) {}
        });
        pop.appendChild(eye);
      }
    }
    _startDrag(e, kind, hueHex) {
      e.preventDefault();
      const target = e.currentTarget;
      const move = ev => {
        const rc = target.getBoundingClientRect();
        let p = Math.max(0, Math.min(1, (ev.clientX - rc.left) / rc.width));
        let q = Math.max(0, Math.min(1, (ev.clientY - rc.top) / rc.height));
        const rgb = hexToRgba(this.value);
        let nr = rgb.r, ng = rgb.g, nb = rgb.b, na = rgb.a;
        if (kind === "sat") {
          const h2 = rgbaToHsl(rgb.r, rgb.g, rgb.b);
          const c = hslToRgb(h2.h, p, 1 - q);
          nr = c.r; ng = c.g; nb = c.b;
        } else if (kind === "hue") {
          const h2 = rgbaToHsl(rgb.r, rgb.g, rgb.b);
          const c = hslToRgb(p * 360, h2.s, h2.l);
          nr = c.r; ng = c.g; nb = c.b;
        } else if (kind === "alpha") {
          na = p;
        }
        this.setColor(rgbaToHex(nr, ng, nb, na), "preview");
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        this.setColor(this.value, "commit"); // mouseup 提交一次 undo
        this._renderPop();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      move(e);
    }
    _bindOutside() {
      if (this._bound) return;
      this._bound = true;
      document.addEventListener("click", e => {
        if (this._open && this.pop && !this.pop.contains(e.target) && e.target !== this.el) this.close();
      });
    }
  }

  global.ColorPickerField = ColorPickerField;
  global.ColorPickerUtils = { hexToRgba, rgbaToHex, rgbaToHsl, hslToRgb, extractColorFromText, fmt };
})(window);
