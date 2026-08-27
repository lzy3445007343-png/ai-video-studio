/* =====================================================================
 * property/snap-engine.js —— L0-04 吸附/对齐引擎统一（M3）
 * =====================================================================
 * 以现有 工作台.html buildSnapPoints/resolveSnap/snapThresholdUs 为内核，收拢为
 * 单一命名空间 SnapEngine，统一承载：
 *   - 吸附点集缓存（内容签名不变 → 命中，消除每帧 O(轨×段×帧) 全量重建）
 *   - Shift 语义唯一判定（isShiftDisabled，三路径统一）
 *   - 时间轴 move/resize/playhead 吸附解析（resolve）
 *   - 预览区位置吸附（snapPreviewPosition，供 L1-06 消费，本卡不画线）
 *   - 旋转 90°±5° 吸附（snapRotation，供 L1-07 消费）
 * 纯前端判定，不触碰 Api / draft_state.json / seg_id / track_type / 播放器内核。
 * 依赖（均为运行时全局，脚本加载早于本文件之后的内联脚本）：
 *   forEachSeg / TimelineMapper / pps() / Store / buildSnapPoints / snapThresholdUs
 * ===================================================================== */
const SnapEngine = {
  /* —— 吸附点集缓存：以"内容签名"为 key，签名变化才重建 —— */
  _cache: { sig: null, points: null },

  /* 内容签名 = 每段 id/start/duration/各动画通道 keys 长度 + 书签。
   * 刻意排除：Store.state.drag / pendingDrag 临时态（拖动中正式数据不变 → 签名不变 → 命中缓存）、
   *           播放头（播放头作为吸附点走 excludePlayhead 处理，不进签名）。 */
  sigOf() {
    let s = "";
    forEachSeg((seg, type, ti, idx) => {
      s += type + ":" + ti + ":" + idx + ":" + (seg.id || "") + ":" + (seg.start || 0) + ":" + (seg.duration || 0) + ":";
      const anim = seg.animations;
      if (anim) for (const p in anim) {
        const ch = anim[p];
        s += p + ":" + (ch && ch.keys ? ch.keys.length : 0) + ":";
      }
    });
    (Store.state.bookmarks || []).forEach(b => { s += "bm" + (b.us || 0) + ":"; });
    return s;
  },

  /* 取点集：命中缓存直接返回；未命中才调 buildSnapPoints 全量重建（单一实现，无重复）。
   * exclude 仅过滤、不进缓存 key。 */
  getPoints({ excludeSegKey = null, excludePlayhead = false } = {}) {
    const sig = this.sigOf();
    if (this._cache.sig !== sig) this._cache = { sig, points: buildSnapPoints(null, false) };
    let pts = this._cache.points;
    if (excludeSegKey) pts = pts.filter(p => p.segKey !== excludeSegKey);
    if (excludePlayhead) pts = pts.filter(p => p.type !== "playhead");
    return pts;
  },

  /* 阈值（us）：时间轴默认 10px 换算（现状 snapThresholdUs() 口径）。
   * 阈值做成入参，不写死——预览 8px / 拖动 3px 由调用方按域传入（Q17 分支 A：各域独立常量）。 */
  thresholdUs(px) {
    const p = (px != null) ? px : 10;
    return (p / pps()) * 1e6;
  },

  /* 解析吸附：在缓存点集上找最近 ≤ 阈值点。
   * 默认阈值走既有 resolveSnap（10px 口径）；传入自定义阈值则自扫（预览/拖动域）。 */
  resolve(targetUs, { thresholdUs = null, excludeSegKey = null, excludePlayhead = false } = {}) {
    const pts = this.getPoints({ excludeSegKey, excludePlayhead });
    if (thresholdUs != null) {
      let best = null, bestD = Infinity;
      for (const p of pts) {
        const d = Math.abs(targetUs - p.time);
        if (d <= thresholdUs && d < bestD) { bestD = d; best = p; }
      }
      return best ? { snapped: best.time, point: best } : { snapped: targetUs, point: null };
    }
    return resolveSnap(targetUs, pts);
  },

  /* 全局 Shift 语义唯一判定：按住 Shift 临时禁用吸附。三路径统一经此函数。 */
  isShiftDisabled(e) { return !!(e && e.shiftKey); },

  /* 缓存失效：数据变更（refresh / Store._emit 回填 draft）后调用，迫使下次重建。 */
  invalidate() { this._cache = { sig: null, points: null }; },

  /* —— 预览区位置吸附（L0-04 3.3，供 L1-06 消费；本卡不画线）——
   * 输入逻辑坐标 (x,y)、画布尺寸 (W,H)、屏幕缩放 scale。
   * 吸附目标：中心 (0,0) + 四边 (±W/2, ±H/2)；阈值 8 屏像素 → 逻辑 8/scale。
   * 输出 {x, y, lines}：lines 供对齐线渲染（消费端 L1-06），本卡只算命中值。 */
  snapPreviewPosition(x, y, { W = 0, H = 0, scale = 1 } = {}) {
    const thr = 8 / (scale || 1);
    const lines = [];
    let nx = x, ny = y;
    const xTargets = [{ pos: 0, axis: "x", align: "center" }];
    if (W) { xTargets.push({ pos: -W / 2, axis: "x", align: "left" }, { pos: W / 2, axis: "x", align: "right" }); }
    for (const t of xTargets) {
      if (Math.abs(x - t.pos) <= thr) { nx = t.pos; lines.push({ axis: "vertical", pos: t.pos, align: t.align }); break; }
    }
    const yTargets = [{ pos: 0, axis: "y", align: "center" }];
    if (H) { yTargets.push({ pos: -H / 2, axis: "y", align: "top" }, { pos: H / 2, axis: "y", align: "bottom" }); }
    for (const t of yTargets) {
      if (Math.abs(y - t.pos) <= thr) { ny = t.pos; lines.push({ axis: "horizontal", pos: t.pos, align: t.align }); break; }
    }
    return { x: nx, y: ny, lines };
  },

  /* —— 旋转 90°±5° 吸附（L0-04 3.4，供 L1-07 消费）——
   * step=90, threshold=5：最近整 90° 倍数若在 ±5° 内则吸附，否则返回原值。 */
  snapRotation(angleDeg, { enabled = true } = {}) {
    if (!enabled) return angleDeg;
    const step = 90, threshold = 5;
    const s = Math.round(angleDeg / step) * step;
    if (Math.abs(angleDeg - s) <= threshold) return s;
    return angleDeg;
  },
};

if (typeof window !== "undefined") window.SnapEngine = SnapEngine;
