/* 音频 Web Audio 引擎（Phase B，方案 §4，v1.3）
 * 职责：audio 轨（独立音频段，如 MP3）的调度播放 —— 替代 <audio> 元素状态机。
 * 根治目标：跨段无声（冻结项核心）—— 每段独立 BufferSource 到点出声，无"交接"动作。
 *
 * 关键纪律（经三轮审查修正，落地必读）：
 *   - 时钟锚定 setAnchor：ctx.currentTime（AudioContext 绝对秒）↔ 时间轴秒 偏移换算，
 *     播放头/seek 变化后必须重新锚定，否则"该响的不响/错位响"。
 *   - previewMuted 只在播放端叠加（engine.globalMuted），clip.gain 不含它 —— 导出端不受预览静音影响（v1.3 拆两层）。
 *   - schedule 必须 async（内部 await decodeAudioData）。
 *   - 不碰 video 内嵌声 —— 那是 Phase C 视频元素重建的事（本引擎只管 audio 轨）。
 *
 * 加载方式：浏览器 <script> 引入；Node 测试 module.exports 导出 createAudioEngine。
 */

function createAudioEngine(ctx) {
  const engine = {
    ctx: ctx || null,          // AudioContext（浏览器：player.js L25 已有，用 attach() 绑定复用解锁状态）
    bufferCache: new Map(),    // path -> AudioBuffer（LRU，上限 MAX_BUFFERS）
    scheduled: new Set(),      // 已调度 BufferSourceNode
    clips: [],                 // 当前 audioClips 快照（graph 平铺结果）
    playheadUs: 0,             // 播放头实时位置（微秒，playTick 每帧喂入；调度用实时锚定消除时钟偏差）
    anchorOffset: 0,           // ctx 秒 ↔ 时间轴秒 偏移换算锚点（旧一次性锚定，保留兼容；调度已改实时锚定）
    globalMuted: false,        // 全局预览静音（previewMuted 的引擎内副本；v1.3：只在播放端叠加）
    _tickTimer: null,
    _decodeInflight: new Map(), // path -> Promise（并发解码去重）
    _epoch: 0,                  // 取消代际：stopAll/setClips 自增，in-flight schedule 完成后校验，防止"解码完仍 start"竞态
  };

  const MAX_BUFFERS = 8;       // LRU 上限（内存对冲：decodeAudioData 全量解码风险）
  const LOOKAHEAD_SEC = 2.0;   // 未来调度窗口
  const TICK_MS = 500;         // lookahead 轮询周期
  const PAST_SLACK = 0.5;      // 秒：startCtx 允许略早于 now 的补播宽容带（防漏调度）

  // 绑定现有 AudioContext（复用 player.js 的 audioCtx 与手势解锁状态）
  engine.attach = function (audioCtx) {
    engine.ctx = audioCtx;
    console.log("[AudioEngine] attach ctx=" + (audioCtx ? audioCtx.state : "null"));
  };

  // 全局静音（播放端专用）：toggleMute 接线时调用
  engine.setGlobalMuted = function (muted) {
    engine.globalMuted = !!muted;
    // 已调度的源即时静音/恢复：重新设置所有已连接 gain
    for (const src of engine.scheduled) {
      if (src._gain) src._gain.gain.value = engine.globalMuted ? 0 : (src._clipGain || 0);
    }
  };

  // 播放头实时喂入（playTick 每帧调；拖动/跨段后播放头跳变，下一帧自动生效）
  engine.setPlayhead = function (us) {
    engine.playheadUs = us;
  };

  // 实时锚定：clip 的 ctx 起始时刻 = clip 时间轴起点 + (当前 ctx - 当前播放头)。
  // 关键修复（2026-08-16 真机）：旧 setAnchor 一次性锚定，AudioContext 时钟与播放头墙钟
  // 存在 ~0.166s 系统性偏差（resume 异步等）→ 跨段后新 clip 的 startCtx 落进"过去"，
  // tick 永不命中 → 第二/三段无声。实时锚定让偏差每帧自愈。
  engine._anchorNow = function () {
    return engine.ctx.currentTime - engine.playheadUs / 1e6;
  };

  // ---- 时钟锚定（v1.2 审查 S2-2 修正；保留兼容，调度主路径用 _anchorNow） ----
  // 原则：时间轴秒 T 对应的 ctx 时刻 = T + anchorOffset（由 setClips 时播放头位置决定）
  engine.setAnchor = function (playheadUs) {
    if (!engine.ctx) return;
    engine.anchorOffset = engine.ctx.currentTime - playheadUs / 1e6;
  };
  engine.timelineToCtx = function (us) {
    return us / 1e6 + engine.anchorOffset;
  };

  // ---- 解码 + LRU 缓存 ----
  engine._decode = async function (path) {
    if (!engine.ctx || !path) return null;
    const hit = engine.bufferCache.get(path);
    if (hit) { // LRU touch：删后重插到末尾
      engine.bufferCache.delete(path);
      engine.bufferCache.set(path, hit);
      return hit;
    }
    if (engine._decodeInflight.has(path)) return engine._decodeInflight.get(path);
    const p = (async () => {
      try {
        const url = (typeof fileURL === "function") ? fileURL(path) : path;
        const resp = await fetch(url);
        if (!resp.ok) { console.warn("[AudioEngine] fetch 失败:", path, resp.status); return null; }
        const arr = await resp.arrayBuffer();
        console.log("[AudioEngine] decode start", path, arr.byteLength + "B");
        const buf = await engine.ctx.decodeAudioData(arr);
        console.log("[AudioEngine] decode ok", path, buf.duration.toFixed(2) + "s");
        engine.bufferCache.set(path, buf);
        if (engine.bufferCache.size > MAX_BUFFERS) {
          const oldest = engine.bufferCache.keys().next().value;
          engine.bufferCache.delete(oldest);
        }
        return buf;
      } catch (e) {
        console.warn("[AudioEngine] 解码失败:", path, e);
        return null;
      } finally {
        engine._decodeInflight.delete(path);
      }
    })();
    engine._decodeInflight.set(path, p);
    return p;
  };

  // ---- 调度单个 clip：到点出声 ----
  // startCtxSnapshot：tick 调度时刻算好的 ctx 起始时刻（decode 是异步的，必须用调度时的
  // 快照，不能用 decode 完成时刻重新算——否则 decode 期间播放头前进，startCtx 又漂移）
  // resumeOffsetSec/resumeDurSec：续播参数（播放头正处 clip 内时由 tick 传入，从播放头位置接上）
  engine.schedule = async function (c, startCtxSnapshot, resumeOffsetSec, resumeDurSec) {
    if (!engine.ctx) return;
    const myEpoch = engine._epoch; // 记录发起时代际（v1.3 防 in-flight 竞态）
    const buf = await engine._decode(c.path);
    if (!buf) return; // 解码失败：跳过该段（控制台已告警）
    if (myEpoch !== engine._epoch) return; // 解码期间被 stopAll/setClips 打断 → 丢弃，不 start
    if (c._scheduled) return; // 已被调度（去重兜底）
    const src = engine.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = c.speed || 1; // 变速（音调随变；change_pitch 后置）
    const g = engine.ctx.createGain();
    src._gain = g;
    src._clipGain = c.gain || 0;
    g.gain.value = engine.globalMuted ? 0 : (c.gain || 0); // v1.3：previewMuted 播放端叠加
    src.connect(g).connect(engine.ctx.destination);
    let offset = (resumeOffsetSec != null) ? resumeOffsetSec : c.srcStartUs / 1e6;
    let dur = (resumeDurSec != null) ? resumeDurSec : (c.srcEndUs - c.srcStartUs) / 1e6 / (c.speed || 1);
    // 2026-08-17 真机：段数据异常（拉长后 start 负值 / src_end 超素材）不崩——
    // ① start 时间 clamp ≥0（Web Audio start() 小于 0 抛 RangeError，日志铁证 -0.5）
    // ② offset clamp 到 buffer 内（防超素材）
    const st = Math.max(0, startCtxSnapshot != null ? startCtxSnapshot : (c.startUs / 1e6 + engine._anchorNow()));
    offset = Math.min(Math.max(0, offset), Math.max(0, buf.duration - 0.05));
    dur = Math.max(0.001, Math.min(dur, buf.duration - offset));
    try {
      src.start(st, offset, dur);
      console.log("[AudioEngine] start ok", c.key, "at=" + st.toFixed(3), "offset=" + offset.toFixed(3), "dur=" + dur.toFixed(3), "ctxNow=" + engine.ctx.currentTime.toFixed(3), "ctxState=" + engine.ctx.state);
    } catch (e) {
      console.warn("[AudioEngine] src.start 失败:", c.key, e);
      return;
    }
    engine.scheduled.add(src);
    c._scheduled = true;
    src.onended = () => { engine.scheduled.delete(src); c._scheduled = false; };
  };

  // ---- lookahead：每 TICK_MS 扫未来 LOOKAHEAD_SEC ----
  engine.tick = function () {
    if (!engine.ctx) return;
    const now = engine.ctx.currentTime;
    const horizon = now + LOOKAHEAD_SEC;
    const anchorNow = engine._anchorNow();   // 实时锚定（每帧随播放头/ctx 自愈偏差）
    const playheadSec = engine.playheadUs / 1e6;
    for (const c of engine.clips) {
      if (c._scheduled) continue;
      if ((c.gain || 0) <= 0) continue; // 静音段跳过（muted 不调度）
      const startCtx = c.startUs / 1e6 + anchorNow;
      const srcSpanSec = (c.srcEndUs - c.srcStartUs) / 1e6;
      // ① 播放头当前正处在这个 clip 内 → 立即续播（起播/暂停恢复/拖动后：从播放头位置接上，
      //    而非等 lookahead 窗口——否则恢复后播放头落在段中段，该段永远不在未来窗口 → 无声）
      if (playheadSec >= c.startUs / 1e6 && playheadSec < (c.startUs + (c.durationUs || 0)) / 1e6) {
        const elapsed = (playheadSec - c.startUs / 1e6) / (c.speed || 1);   // 该段已消耗的源时长
        const resumeOffset = c.srcStartUs / 1e6 + elapsed;
        const remaining = Math.max(0.001, srcSpanSec / (c.speed || 1) - elapsed);
        console.log("[AudioEngine] tick-resume", c.key, "playhead=" + playheadSec.toFixed(3), "offset=" + resumeOffset.toFixed(3), "remaining=" + remaining.toFixed(3));
        engine.schedule(c, now, resumeOffset, remaining);
        continue;
      }
      // ② 未来窗口 lookahead：未来 LOOKAHEAD 内；或刚过去一点点（PAST_SLACK）→ 立即补播
      // （防 tick 抖动/播放头跳过导致漏调度；整段已错过则不补）
      if (startCtx < horizon && startCtx >= now - PAST_SLACK) {
        if (startCtx + srcSpanSec / (c.speed || 1) < now) continue;
        console.log("[AudioEngine] tick-hit", c.key, "startCtx=" + startCtx.toFixed(3), "now=" + now.toFixed(3), "horizon=" + horizon.toFixed(3));
        engine.schedule(c, startCtx);
      }
    }
  };

  // ---- 平铺结果喂进来（播放前 / 播放中重平铺 / seek 后） ----
  engine.setClips = async function (clips, playheadUs) {
    engine.stopAll();
    engine.clips = clips || [];
    if (playheadUs != null) { engine.playheadUs = playheadUs; }   // 同步播放头基准（实时锚定用）
    engine._startTicking();
    console.log("[AudioEngine] setClips n=" + (clips || []).length + " us=" + playheadUs + " ctx=" + (engine.ctx ? engine.ctx.state : "null"));
    engine.tick(); // 立即扫一次
  };

  engine.stopAll = function () {
    engine._epoch++; // v1.3：作废所有 in-flight schedule（解码完也不会 start）
    for (const s of engine.scheduled) { try { s.stop(); } catch (e) {} }
    engine.scheduled.clear();
    for (const c of engine.clips) c._scheduled = false;
  };

  engine._startTicking = function () {
    if (engine._tickTimer) return;
    engine._tickTimer = setInterval(() => engine.tick(), TICK_MS);
  };
  engine.stopTicking = function () {
    if (engine._tickTimer) { clearInterval(engine._tickTimer); engine._tickTimer = null; }
  };

  // 暂停（外部调）：清调度 + 停轮询；恢复走 setClips（重新锚定）
  engine.pause = function () {
    engine.stopAll();
    engine.stopTicking();
  };

  engine.destroy = function () {
    engine.pause();
    engine.bufferCache.clear();
    engine.clips = [];
  };

  return engine;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createAudioEngine };
}

// 浏览器环境：HTML 加载 audio-engine.js 后自动创建全局 AudioEngine 实例。
// audioCtx 在 player.js 里创建，audio-engine.js 在 player.js 之后加载（HTML script 顺序约束）。
// 这里 ctx 传 null，后续在 player.js 的 startPlay() 里 AudioEngine.attach(audioCtx) 绑定（复用解锁状态）。
// 关键修复（2026-08-16 真机 ReferenceError）：之前漏了这一步，player.js 调 AudioEngine.xxx 直接抛 ReferenceError → 整个音频引擎从未运行。
if (typeof window !== "undefined") {
  window.AudioEngine = createAudioEngine(null);
}
