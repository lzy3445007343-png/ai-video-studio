/* =====================================================================
 * property/DraftStore.js —— 编辑草稿两阶段状态（Property Framework v1）
 * =====================================================================
 * 对齐 OpenCut use-property-draft.ts：
 *   onInput(raw) —— 只解析+存本地草稿+调 preview（内存态 + 预览渲染器，不碰后端/不触发全局重渲）
 *   onCommit()   —— blur/Enter/确认时取草稿调 commit（后端落库）
 * 剪辑软件铁律：拖动/输入每一帧都写后端 = 灾难。preview 与 commit 必须分离。
 * 未来：commit 是 Command 的入口（预留 UndoManager 接入，评估建议）。
 */
class PropertyDraft {
  /**
   * @param {Object} opts
   * @param {Function} [opts.parse]    (raw) => value | null（解析/钳制，返回 null 表示非法不采纳）
   * @param {Function} [opts.getValue] () => value（未编辑时读取当前值）
   * @param {Function} [opts.preview]  (value) => void（编辑中实时预览）
   * @param {Function} [opts.commit]   (value) => void（确认落库，未来 = Command）
   * @param {Function} [opts.onChanged]() => void（draft 状态变化钩子，可做 UI 反馈）
   */
  constructor(opts) {
    this.parse = opts.parse || (v => v);
    this.getValue = opts.getValue || (() => null);
    this.preview = opts.preview || null;
    this.commit = opts.commit || null;
    this.onChanged = opts.onChanged || null;
    this._draft = null;            // null = 未编辑
    this._editing = false;
  }

  get editing() { return this._editing; }
  get value() { return this._draft !== null ? this._draft : this.getValue(); }

  onInput(raw) {
    const parsed = this.parse(raw);
    if (parsed === null || parsed === undefined) return;   // 非法输入不采纳，不打断用户
    this._draft = parsed;
    this._editing = true;
    if (this.preview) this.preview(parsed);
    if (this.onChanged) this.onChanged();
  }

  onCommit() {
    if (!this._editing) return;                             // 没编辑过就不提交（对齐 OpenCut 守卫）
    const v = this._draft !== null ? this._draft : this.getValue();
    this._reset();
    if (v === null || v === undefined) return;
    if (this.commit) this.commit(v);
  }

  /** 外部值刷新（Store 回填）时调用：丢弃未提交草稿或回填（取决于场景） */
  reset() { this._reset(); }

  _reset() {
    this._draft = null;
    this._editing = false;
    if (this.onChanged) this.onChanged();
  }
}
