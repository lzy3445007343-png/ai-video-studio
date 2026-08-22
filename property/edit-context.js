/* =====================================================================
 * property/edit-context.js —— Keyframe Edit Transaction 核心（GPT 评审 §7/§8/§15）
 * =====================================================================
 * 一句话：一次用户手势 = 一个 EditContext（不可变时间基准）
 *          → Draft → Preview → Commit → ONE Command Transaction → ONE Undo
 *
 * GPT 评审要点（kf-gpt-audit-指令-2026-08-22.md）：
 *   §7  拖预览素材 → 松手自动打 KF，必须 pointerdown 锁定 editTime，禁止 pointerup 重读 playhead
 *   §8  明确区分 globalUs / localUs / frameUs；一次 Gesture 只产生一个 EditTimeContext
 *       { globalUs, localUs, frameIndex }，X KF / Y KF 都用 context.localUs，不要各属性自己重算
 *   §15 最终方向：User Gesture → EditContext{targetSegment, editTime, selectedKeys,
 *       originalValues} → Draft → Preview → Commit → X KF / Y KF → ONE Command Transaction
 *
 * 铁律：
 *   1. editTime 只在 lockEditTime()（pointerdown/focus）时锁定一次，之后 immutable
 *   2. X/Y 及各通道一律用 context.localUs，禁止各通道分别读 Store.state.playheadUs
 *   3. marker 组拖 = selectedKeys 快照 → originalTime + delta → 全量 update（不重查 DOM）
 *   4. 拖时间只改 t，绝不改 v（update_keyframe value 永远传 null）
 *   5. Commit 用 currentSeg() 取最新引用（Store 刷新替换 draft 后旧引用失效），
 *      但 localUs 是锁定值，不随刷新变
 * ===================================================================== */

/* 帧长常量（项目 30fps，与后端导出 / timeline 吸附一致）。用 Math.round 对齐后端 int() 截断语义。 */
const KF_FRAME_US = Math.round(1e6 / 30);

class EditContext {
  constructor({ key, seg }) {
    this.key = key;                 // "type:ti:idx"——定位段（commit 时 findSegByKey 反查）
    this.seg = seg;                 // pointerdown 时的段引用（快照用途，commit 请用 currentSeg()）
    this.editTime = null;           // { globalUs, localUs, frameIndex }——锁定后 immutable
    this.selectedKeys = [];         // [{ path, kid, t, v }]——marker 组拖的选中快照
    this.originalValues = {};       // path → 拖前值（preview-drag 的 nx/ny 基准）
    this._locked = false;
  }

  /* 锁定编辑时间（pointerdown / input focus 时调用一次）：
   * playheadUs → globalUs；globalUs - seg.start → localUs；localUs 帧吸附 → frameIndex */
  lockEditTime() {
    if (this._locked) return this.editTime;       // 幂等：一次手势只锁定一次
    const g = Store.state.playheadUs;
    const l = (typeof TimelineMapper !== "undefined")
      ? TimelineMapper.playheadLocal(this.seg)
      : Math.max(0, Math.min(g - (this.seg.start || 0), this.seg.duration || 0));
    this.editTime = {
      globalUs: g,
      localUs: l,
      frameIndex: Math.round(l / KF_FRAME_US),
    };
    this._locked = true;
    return this.editTime;
  }

  /* 锁定选中 KF 快照（marker 组拖用）：[{ path, kid, t, v }] */
  lockSelectedKeys(keys) {
    this.selectedKeys = keys || [];
    return this;
  }

  /* Commit 时取最新段引用（Store refresh 后 seg 引用可能失效） */
  currentSeg() {
    if (typeof findSegByKey === "function") {
      const s = findSegByKey(this.key);
      if (s) return s;
    }
    return this.seg;
  }

  /* 调试：一次手势的全链路时间快照（对齐 GPT §4 唯一时间 ID 建议） */
  audit(label) {
    if (typeof console === "undefined") return;
    console.log("[KF-AUDIT] edit-context", JSON.stringify({
      label, key: this.key,
      editTime: this.editTime,
      selectedKeys: this.selectedKeys.length,
    }));
  }
}

/* 便捷构造：从 key 反查段并锁定时间（preview-drag / marker 拖动统一入口） */
function createEditContext(key, { lockTime = true } = {}) {
  const seg = (typeof findSegByKey === "function") ? findSegByKey(key) : null;
  if (!seg) return null;
  const ctx = new EditContext({ key, seg });
  if (lockTime) ctx.lockEditTime();
  return ctx;
}
