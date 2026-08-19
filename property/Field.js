/* =====================================================================
 * property/Field.js —— 字段基类（Property Framework v1，ADR-2026-08-19）
 * =====================================================================
 * 对齐 OpenCut PropertyParamField + React 组件生命周期：
 *   mount()   —— 只在结构变化时调用，DOM 创建一次，之后绝不重建
 *   update(v) —— 值同步的唯一路径（只改 value / dataset / class）
 *   unmount() —— 解绑全部事件 + 移除 DOM（无泄漏）
 * 铁律：用户正在交互的控件 DOM 永不被销毁（结构变化除外）。
 * 命名：PropertyField 前缀（命名空间纪律，避免裸 Field 全局名）。
 */
class PropertyField {
  /**
   * @param {Object} opts
   * @param {string} [opts.id]         字段标识（事件代理路由用 data-field）
   * @param {string} [opts.label]      字段标签
   * @param {Function} opts.buildDom   () => HTMLElement（创建根元素，mount 时调用一次）
   * @param {Function} [opts.write]    (el, value) => void（update 时同步值）
   * @param {Function} [opts.read]     (el) => value（读取当前值）
   * @param {Function} [opts.bind]     (field) => void（可选，绑定交互；mount 时调用一次）
   * @param {Function} [opts.onPreview] (value) => void（编辑中预览，不落库）
   * @param {Function} [opts.onCommit]  (value) => void（blur/Enter/确认才落库）
   */
  constructor(opts) {
    this.id = opts.id || null;
    this.label = opts.label;
    this._buildDom = opts.buildDom;
    this._write = opts.write || null;
    this._read = opts.read || null;
    this._bind = opts.bind || null;
    this.onPreview = opts.onPreview || null;
    this.onCommit = opts.onCommit || null;
    this.el = null;
    this._handlers = [];          // 事件解绑记录（unmount 统一清理）
    this._mounted = false;
  }

  mount(host) {
    if (this._mounted) return this;
    this.el = this._buildDom();
    if (this.id) this.el.dataset.field = this.id;
    host.appendChild(this.el);
    if (this._bind) this._bind(this);
    this._mounted = true;
    return this;
  }

  /** 值同步唯一路径：只改值，绝不重建 DOM */
  update(value) {
    if (this._write && this.el) this._write(this.el, value);
  }

  read() {
    return this._read && this.el ? this._read(this.el) : undefined;
  }

  /** 事件绑定记录（unmount 时统一解绑，杜绝重复绑定/泄漏） */
  on(el, type, fn) {
    el.addEventListener(type, fn);
    this._handlers.push(() => el.removeEventListener(type, fn));
  }

  unmount() {
    this._handlers.forEach(h => { try { h(); } catch (e) { console.error("[PropertyField] 解绑失败:", e); } });
    this._handlers = [];
    if (this.el) { this.el.remove(); this.el = null; }
    this._mounted = false;
  }
}
