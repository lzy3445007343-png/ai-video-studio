/* =====================================================================
 * property/timeline-mapper.js —— TimelineMapper（时间映射层，GPT 要求 B3 前必建）
 * =====================================================================
 * 铁律：KF 永远存段内局部时间（local，0..duration），所有 UI 用全局时间
 *       （global，0..totalDuration），中间必须经过本 Mapper 转换。
 *       B3 菱形拖拽 / trim / 移动 / 复制都依赖它（trim 规则见
 *       docs/architecture/timeline-mapper.md §4）。
 * API：
 *   globalToLocal(seg, globalUs) —— global → local（钳制 [0, duration]）
 *   localToGlobal(seg, localUs)  —— local → global（段起点 + 局部）
 *   playheadLocal(seg)           —— 播放头在段内的 local 时间（KF 面板/打点统一入口）
 * ===================================================================== */

const TimelineMapper = {
  /** global → local：段内局部时间（钳制 [0, duration]） */
  globalToLocal(seg, globalUs) {
    if (!seg) return 0;
    const start = seg.start || 0;
    const dur = seg.duration || 0;
    return Math.max(0, Math.min((globalUs || 0) - start, dur));
  },

  /** local → global：段起点 + 局部时间（钳制 [0, duration]） */
  localToGlobal(seg, localUs) {
    if (!seg) return 0;
    const start = seg.start || 0;
    const dur = seg.duration || 0;
    return start + Math.max(0, Math.min(localUs || 0, dur));
  },

  /** 播放头当前在段内的 local 时间（KF 面板/打点统一入口） */
  playheadLocal(seg) {
    if (!seg || typeof Store === "undefined") return 0;
    return this.globalToLocal(seg, Store.state.playheadUs || 0);
  },
};

if (typeof window !== "undefined") window.TimelineMapper = TimelineMapper;
