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
  // 4b（M4）：翻转 slice 模式——切片订阅者接管渲染，不再 _emit 全量 renderAll。
  // 安全前提（已枚举全部 Store.set 键交叉核对）：交互键(selectedKey/Keys/SegId/selectedMaterialUid/
  // drag/pendingDrag/pendingBox/groupScale/pxPerSec/filter/bookmarks/playheadUs/effects)均有切片订阅者；
  // 数据键(draft/materials/thumbMap/waveMap/meta)仅由 refresh() 显式 renderAll 覆盖（C4.4 已硬化，见 HTML:3284）。
  // 回退：改回 "legacy" 即恢复全量广播。Store.subscribe(renderAll) 作为 dormant 安全网保留（slice 下 _emit 不触发，故不会双跑）。
  renderSliceMode: "slice",
  _batchDepth: 0,          // C4 v2（GPT 建议留接口）：批量通知——同帧多个 set 合并一次 flush
  _batchQueue: [],
  subscribe(fn) { this._subs.push(fn); },
  subscribeSlice(key, fn) {
    (this._sliceSubs[key] || (this._sliceSubs[key] = [])).push(fn);
    return () => {
      const arr = this._sliceSubs[key];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    };
  },
  // 批量通知（C4 v2）：Store.batch(() => { set(a); set(b); set(c); }) → 合并一次 flush
  // 防同帧多个 set 触发 N 次渲染（如 selectKey 同时改 selectedKey/selectedSegId/selectedMaterialUid）
  batch(fn) {
    if (this._batchDepth > 0) { fn(); return; }     // 嵌套 batch 直接执行（不重复排队）
    this._batchDepth = 1;
    this._batchQueue = [];
    try { fn(); } catch (e) { this._batchDepth = 0; this._batchQueue = []; throw e; }
    this._batchDepth = 0;
    if (this._batchQueue.length) {
      const merged = Object.assign({}, ...this._batchQueue);   // 合并 patch
      this._batchQueue = [];
      this._applySet(merged);
    }
  },
  // 合并补丁并触发渲染（切片订阅者必通知；legacy 模式额外全量 _emit）
  set(patch) {
    if (this._batchDepth > 0) {
      Object.assign(this.state, patch);    // state 立即生效（渲染读最新值）
      this._batchQueue.push(patch);        // 通知延迟到 batch 结束统一 flush
      return;
    }
    this._applySet(patch);
  },
  _applySet(patch) {
    const changed = Object.keys(patch);
    Object.assign(this.state, patch);
    // C4 v2：同一订阅者注册多个 key（如 selRender 注册 selectedKey/selectedKeys/selectedSegId）
    // 一次 patch 涉及多 key 时只调一次——batch 合并 + selectKey 单次 set 多 key 都受益
    const seen = new Set();
    for (const k of changed) {
      const fns = this._sliceSubs[k];
      if (fns) for (const fn of fns) {
        if (seen.has(fn)) continue;
        seen.add(fn);
        try { fn(this.state[k], this.state); } catch (e) { console.error("[Store] 切片订阅者异常:", e); }
      }
    }
    if (this.renderSliceMode !== "slice") this._emit();
  },
  // 直接通知（用于原地修改 state.drag 的逐帧拖拽，避免每帧重建对象）
  _emit() { for (const fn of this._subs) fn(this.state); },
};

/* ---------- 工具 ---------- */
const THRESHOLD = 5; // L1-03 Q14=A：统一 5px（对齐 OpenCut TIMELINE_DRAG_THRESHOLD_PX；框选/拖动判定同源）
let $ = id => document.getElementById(id);
let api = () => (window.pywebview && window.pywebview.api) || null;
// 2c（M2）：选中快照 / 还原——撤销时后端返回「操作前选中」，前端据此还原焦点。
function selSnapshot() {
  return {
    selectedKey: Store.state.selectedKey,
    selectedKeys: Store.state.selectedKeys,
    selectedMaterialUid: Store.state.selectedMaterialUid,
    selectedSegId: Store.state.selectedSegId,
  };
}
function applySelection(sel) {
  if (!sel) return;
  Store.set({
    selectedKey: sel.selectedKey ?? null,
    selectedKeys: sel.selectedKeys ?? [],
    selectedMaterialUid: sel.selectedMaterialUid ?? null,
    selectedSegId: sel.selectedSegId ?? null,
  });
}

function call(method, ...args) {
  const a = api();
  if (!a || typeof a[method] !== "function") { console.warn("api 未就绪:", method); return Promise.resolve(null); }
  // 2b 双轨收敛：所有写操作统一经 a.execute 走 Command 闭环（带 cmd_id/args/actor 审计 + 单步撤销）。
  // 走 execute 后方法内部 save_state 不再自动压快照，由 execute 统一压一条语义命令，撤销不再双步。
  // 2c：写入时附当前选中快照，后端记为本命令「操作前选中」，撤销时原样还原焦点。
  if (typeof a.execute === "function") {
    return Promise.resolve(a.execute(method, args, {actor:"user", source:"ui", reversible:true, selection: selSnapshot()}));
  }
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
