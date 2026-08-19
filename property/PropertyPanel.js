/* =====================================================================
 * property/PropertyPanel.js —— 面板外壳（Property Framework v1）
 * =====================================================================
 * 对齐 OpenCut PropertiesPanel（index.tsx）+ React reconciliation 的 vanilla 翻译：
 *   render(ctx) —— key(ctx) 相同 → 只 updateFields（值同步，绝不重建）
 *                   key(ctx) 变化 → destroy 旧 Field 树 → buildFields 建新树 → mount
 * 铁律：用户正在交互的 Field DOM 永不被销毁（结构变化除外）。
 * 命名空间：类名 pf-* / property-* 前缀（ADR Phase 0 命名空间纪律）。
 */
class PropertyPanel {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.host       面板内容容器（字段挂载点）
   * @param {Function} opts.keyFn         (ctx) => string（结构 key：段身份+结构性开关）
   * @param {Function} opts.buildFields   (ctx) => PropertyField[]（结构变化时建 Field 树）
   * @param {Function} [opts.updateFields] (fields, ctx) => void（key 相同时只更新值）
   * @param {Function} [opts.onMount]      (ctx) => void（挂载后钩子，如 nameEl 标题）
   */
  constructor(opts) {
    this.host = opts.host;
    this.keyFn = opts.keyFn || (() => "default");
    this.buildFields = opts.buildFields;
    this.updateFields = opts.updateFields || (() => {});
    this.onMount = opts.onMount || null;
    this.key = null;
    this.ctx = null;
    this.fields = [];
  }

  /** 面板渲染入口：key 相同只 update；key 变化才重建 Field 树 */
  render(ctx) {
    if (!this.host) return;
    const newKey = this.keyFn(ctx);
    if (this.key === newKey && this.fields.length) {
      this.updateFields(this.fields, ctx);   // 只同步值（光标/焦点/事件全保留）
      return;
    }
    // 结构变化 → 重建
    this.destroy();
    this.key = newKey;
    this.ctx = ctx;
    this.fields = this.buildFields ? (this.buildFields(ctx) || []) : [];
    this.fields.forEach(f => { try { f.mount(this.host); } catch (e) { console.error("[PropertyPanel] Field 挂载失败:", e); } });
    if (this.onMount) { try { this.onMount(ctx); } catch (e) { console.error("[PropertyPanel] onMount 失败:", e); } }
    this.updateFields(this.fields, ctx);
  }

  /** 销毁整个 Field 树（切换段/面板关闭时），无泄漏 */
  destroy() {
    this.fields.forEach(f => { try { f.unmount(); } catch (e) { console.error("[PropertyPanel] Field 卸载失败:", e); } });
    this.fields = [];
    this.key = null;
    this.ctx = null;
    if (this.host) this.host.innerHTML = "";
  }
}
