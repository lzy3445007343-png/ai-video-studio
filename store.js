"use strict";

/* =====================================================================
 * store.js —— 数据层（Step 1 拆 JS：从 工作台v0.8时间轴.html 拆出，纯搬移不改逻辑）
 * 职责：可见报错层 + 唯一真相源 Store + 全局工具（$ / api / call）。
 * 依赖：无（最先加载）。其余 script 依赖本文件的 Store/工具。
 * ===================================================================== */

/* 可见报错层：任何未捕获异常都浮在顶部红条，避免“静默死”难排查（WebView2 下看不到控制台时尤其有用） */
let _autoplayFatal = false;   // 当前红条是否由 autoplay 软提醒导致（可被用户手动取消静音消除）
function showFatal(t) {
  let b = document.getElementById("fatalBar");
  if (!b) {
    b = document.createElement("div"); b.id = "fatalBar";
    b.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99999;background:#c0392b;color:#fff;font:12px/1.5 monospace;padding:6px 10px;white-space:pre-wrap;max-height:40vh;overflow:auto;box-shadow:0 2px 8px rgba(0,0,0,.5)";
    (document.body || document.documentElement).appendChild(b);
  }
  b.textContent = "⚠ 运行时错误：\n" + t + "\n（把这段红字截图发我即可定位）";
  if (t && t.indexOf("autoplay 被拒") >= 0) _autoplayFatal = true;
}
function clearAutoplayFatal() {
  if (!_autoplayFatal) return;
  const b = document.getElementById("fatalBar");
  if (b) b.remove();
  _autoplayFatal = false;
}
window.onerror = function (msg, src, line, col, err) {
  showFatal((msg || "") + "  @" + (src || "?").split("/").pop() + ":" + line + ":" + col + (err && err.stack ? "\n" + err.stack : ""));
  return false;
};
/* =====================================================================
 * 架构契约（第 0 步地基，必须守住）：
 *   1. Store 是唯一真相源，任何状态变更只允许通过 Store.set / Store._emit。
 *   2. 所有渲染函数只读 Store.state，绝不直接改 DOM 位置。
 *   3. 交互只产生「意图」：要么改 Store（选中/缩放/播放头）→ 自动重绘；
 *      要么改 Store.drag（拖拽临时预览）→ 自动重绘；松手才提交后端 API，
 *      后端返回后 get_state 回填 Store.draft → 自动重绘。
 *   4. 没有任何代码在 render 之外直接写 seg.style.left / width。
 *   这样彻底消灭「DOM 自己改、state 又改、render 又算」的三处抢控制权。
 * ===================================================================== */

/* ---------- 唯一真相源 Store（胶水层） ---------- */
const Store = {
  state: {
    draft: { video: [[]], audio: [[]], text: [[]], canvas: { ratio: "16:9", locked: false } },
    materials: [],
    thumbMap: {},          // path -> 缩略图（视频抽帧 / 图片原图）
    waveMap: {},           // path -> 音频峰值数组（0~1，按时间顺序，每秒 60 点）
    selectedKey: null,     // "type:ti:idx"
    selectedKeys: [],      // 多选集合（Ctrl+A 全选）；单击也进此集合，selectedKey 为最后选中的焦点段
    selectedMaterialUid: null, // 素材面板选中的素材 uid（与时间轴选中互斥）
    pxPerSec: 120,         // 缩放
    playheadUs: 0,
    bookmarks: [],       // 书签列表 [{us, name}]，纯 UI 标注（对齐 OpenCut scene.bookmarks）
    snapOn: true,
    rippleOn: false,    // 波纹编辑开关（对齐 OpenCut rippleEditingEnabled）
    filter: "media",
    mediaView: "grid",         // 资产面板视图：grid（网格 2 列）/ list（单列紧凑）
    drag: null,            // 临时拖拽态（move / resize），提交后清空
    pendingDrag: null,     // mousedown 后未超过阈值前的待定态
    pendingBox: null,     // 框选待定态（空白区 mousedown 起框选）
    groupScale: null,     // 整组缩放临时预览态 {factor, gStart, gEnd}，render 据此缩放选中段几何
    meta: { mcp: { connected: false, agent: "" } },
  },
  _subs: [],
  /* =====================================================================
   * Phase 5 订阅切片（ADR-2026-08-20 v2，Step 5.1 纯新增，不迁移任何业务渲染）
   * =====================================================================
   * - subscribeSlice(key, fn)：按状态切片订阅（一级字段名，如 playheadUs/selectedKey/drag）。
   *   返回退订函数（防泄漏）。fn(value, state)。
   * - renderSliceMode：feature flag。"legacy"= 切片订阅者 + 全量 _emit 双跑（迁移对照期）；
   *   "slice"= 只跑切片订阅者（迁移完成）。避免"两套 UI 系统长期双跑"（GPT 审阅 R0）。
   * - set()：计算 changed keys → 通知对应切片订阅者；legacy 模式仍 _emit()（行为零变化兜底）。
   * - renderAll 保留不删（debug/导入/MCP 大批量/恢复路径显式调用，非广播订阅）。
   */
  _sliceSubs: {},
  renderSliceMode: "legacy",
  subscribe(fn) { this._subs.push(fn); },
  subscribeSlice(key, fn) {
    (this._sliceSubs[key] || (this._sliceSubs[key] = [])).push(fn);
    return () => {
      const arr = this._sliceSubs[key];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    };
  },
  // 合并补丁并触发渲染（切片订阅者必通知；legacy 模式额外全量 _emit）
  set(patch) {
    const changed = Object.keys(patch);
    Object.assign(this.state, patch);
    for (const k of changed) {
      const fns = this._sliceSubs[k];
      if (fns) for (const fn of fns) { try { fn(this.state[k], this.state); } catch (e) { console.error("[Store] 切片订阅者异常:", e); } }
    }
    if (this.renderSliceMode !== "slice") this._emit();
  },
  // 直接通知（用于原地修改 state.drag 的逐帧拖拽，避免每帧重建对象）
  _emit() { for (const fn of this._subs) fn(this.state); },
};

/* ---------- 工具 ---------- */
const THRESHOLD = 4; // 点击 vs 拖拽 的像素阈值（根治"点一下弹回"）
let $ = id => document.getElementById(id);
let api = () => (window.pywebview && window.pywebview.api) || null;
function call(method, ...args) {
  const a = api();
  if (!a || typeof a[method] !== "function") { console.warn("api 未就绪:", method); return Promise.resolve(null); }
  return Promise.resolve(a[method](...args));
}

// Step 3 Asset 分离：segment → 源文件路径的唯一解析入口。
// 优先 material_id → materials[].uid 查 path（新数据）；查不到 fallback seg.path（旧存档/剪映导入段）。
// 渲染层禁止再直接读 seg.path，统一走这里（为未来 segment 去 path 化铺路）。
function resolveSegPath(seg) {
  if (!seg) return null;
  if (seg.material_id) {
    const ms = Store.state.materials;
    if (ms && ms.length) {
      const m = ms.find(x => x && x.uid === seg.material_id);
      if (m && m.path) return m.path;
    }
  }
  return seg.path || null;
}
