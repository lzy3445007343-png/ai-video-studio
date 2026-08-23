/* =====================================================================
 * property/kf-channel.js —— B0 KF Channel Manager（通道生命周期管理）
 * =====================================================================
 * 背景（GPT 评审，kf-complete-plan v2）：toggleKf/addKfAtPlayhead 散落 keys.length 判断，
 * 删最后一个 key 后空通道残留 → "有 channel 没 key" 脏状态 → isAnimated 误判。
 * 统一入口后 B1/B3/B4/B7 全用它。
 *
 * 数据模型（后端 add_keyframe, main.py:2912）：
 *   seg.animations = { path: { keys: [{id, t, v, seg}] } }
 *   - t: 段内局部时间（微秒，0..duration）★ 键名是 t 不是 time
 *   - v: 数值；seg: "linear" | "hold"
 *
 * API：
 *   ensure(seg, path)           —— 确保通道存在（空 keys 合法）
 *   removeIfEmpty(seg, path)    —— 无 key 时删通道（防脏状态）
 *   isAnimated(seg, path)       —— 通道激活 = 有 key
 *   getCurrentValue(seg, path, localUs) —— 通道开→kfVal 插值 / 关→C1 静态值
 *   upsertLocal(seg, path, t, v) —— 前端本地打点（B1 交互临时态，不进后端/undo）
 *   removeLocal(seg, path, t)   —— 前端本地删点（±1ms 内）
 * 依赖：kfVal（HTML 全局）/ getProperty（C1 kernel）
 * ===================================================================== */

const KfChannel = {
  /** P-010 KF 容差统一：命中/合并容差 = 1 帧(33333us @ 30fps)。与 timeline.js:471 合并容差一致；
   *  对齐 OpenCut roundToFrame（输入帧吸附）+ 后端 _frame_snap_us + add_keyframe 严格相等哲学。
   *  旧 ±1ms(1000us) 太苛刻 → 打 X/Y 时播放头微动就被当两个 KF（漂移根因）。前端统一到帧级。 */
  KF_HIT_TOLERANCE_US: 33333,
  /** 确保通道存在（空 keys 是合法态——"通道开但还没打点"） */
  ensure(seg, path) {
    if (!seg) return null;
    if (!seg.animations) seg.animations = {};
    if (!seg.animations[path] || typeof seg.animations[path] !== "object") {
      seg.animations[path] = { keys: [] };
    }
    return seg.animations[path];
  },

  /** 无 key 时删通道（防"有 channel 没 key"脏状态）；返回是否删了 */
  removeIfEmpty(seg, path) {
    if (!seg || !seg.animations) return false;
    const ch = seg.animations[path];
    if (ch && (!ch.keys || !ch.keys.length)) {
      delete seg.animations[path];
      return true;
    }
    return false;
  },

  /** 通道激活 = 有 key（GPT 定案：看 keys.length，不引入 enabled 字段） */
  isAnimated(seg, path) {
    return !!(seg && seg.animations && seg.animations[path] &&
              seg.animations[path].keys && seg.animations[path].keys.length);
  },

  /** 当前位置是否命中 KF（±1帧，与 timeline.js:471 / 后端 _frame_snap_us 帧吸附一致）——◆ 状态机（B2.1）
   * 与 isAnimated 正交：isAnimated=通道激活（输入编辑语义）；hitAtPlayhead=播放头踩中（◆ 外观） */
  hitAtPlayhead(seg, path, localUs) {
    if (!seg || !seg.animations || !seg.animations[path]) return false;
    const keys = seg.animations[path].keys || [];
    return keys.some(k => Math.abs((k.t || 0) - (localUs || 0)) <= KfChannel.KF_HIT_TOLERANCE_US);
  },

  /** 读取：通道开 → kfVal 插值；关 → C1 静态值（params→legacy→default） */
  getCurrentValue(seg, path, localUs) {
    if (!seg) return null;
    if (this.isAnimated(seg, path)) {
      return kfVal(seg.animations, path, localUs);
    }
    return (typeof getProperty === "function") ? getProperty(seg, path) : null;
  },

  /** 前端本地打点（±1帧 合并，同点更新值）——B1 交互临时态，不进后端/undo */
  upsertLocal(seg, path, t, v, segMode) {
    const ch = this.ensure(seg, path);
    const keys = ch.keys || (ch.keys = []);
    const existing = keys.find(k => Math.abs((k.t || 0) - t) <= KfChannel.KF_HIT_TOLERANCE_US);
    if (existing) {
      existing.v = v;
      if (segMode) existing.seg = segMode;
    } else {
      keys.push({ id: "local-" + Date.now() + "-" + Math.floor(Math.random() * 1e4),
                  t: Math.max(0, Math.floor(t)), v, seg: segMode || "linear" });
      keys.sort((a, b) => (a.t || 0) - (b.t || 0));
    }
    return ch;
  },

  /** 前端本地删点（±1帧内）；删空通道自动清理 */
  removeLocal(seg, path, t) {
    if (!seg || !seg.animations || !seg.animations[path]) return false;
    const keys = seg.animations[path].keys || [];
    const idx = keys.findIndex(k => Math.abs((k.t || 0) - t) <= KfChannel.KF_HIT_TOLERANCE_US);
    if (idx < 0) return false;
    keys.splice(idx, 1);
    this.removeIfEmpty(seg, path);
    return true;
  },
};

if (typeof window !== "undefined") window.KfChannel = KfChannel;
