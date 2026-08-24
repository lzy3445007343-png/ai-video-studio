/* =====================================================================
 * property/timeline-mapper.js —— TimelineMapper（时间映射层，GPT 要求 B3 前必建）
 * =====================================================================
 * 铁律：KF 永远存段内局部时间（local，0..duration），所有 UI 用全局时间
 *       （global，0..totalDuration），中间必须经过本 Mapper 转换。
 *       B3 菱形拖拽 / trim / 移动 / 复制都依赖它（trim 规则见
 *       docs/architecture/timeline-mapper.md §4）。
 * 时间换算统一入口（M7-7c）：所有 us↔帧吸附换算走这里，禁止散落 Math.round(1e6/30)/
 *       33333 硬编码（验收④：全库无散落硬编码，前端/后端帧吸附对拍一致）。
 * API：
 *   globalToLocal(seg, globalUs) —— global → local（钳制 [0, duration]）
 *   localToGlobal(seg, localUs)  —— local → global（段起点 + 局部）
 *   playheadLocal(seg)           —— 播放头在段内的 local 时间（KF 面板/打点统一入口）
 *   frameUs(fps)                 —— 帧长（us），默认 30fps
 *   snapFrame(us, fps)           —— 帧吸附（与后端 main.py snap_frame 同语义：吸附到最近整帧）
 * ===================================================================== */

const TimelineMapper = {
  /** 微秒/秒（对齐后端 TICKS_PER_SECOND） */
  TICKS_PER_SECOND: 1_000_000,

  /** 帧长（us）。默认 30fps；与后端 snap_frame 的 frame_us 口径一致（round）。 */
  frameUs(fps) {
    return Math.round(this.TICKS_PER_SECOND / (fps || 30));
  },

  /** 帧吸附：吸附到最近整帧（等价后端 ((t + f//2) // f) * f）。 */
  snapFrame(us, fps) {
    const f = this.frameUs(fps || 30);
    return Math.round((us || 0) / f) * f;
  },

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
