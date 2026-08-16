"use strict";

/* =====================================================================
 * player.js —— 播放核心（Step 1c 拆 JS：从 工作台v0.8时间轴.html 拆出，纯搬移不改逻辑）
 * 职责：播放状态（PLAY_SESSION_STATE/session）/ 媒体工具 / seek·drift / 跨段 / playTick·startPlay。
 * 依赖：store.js（Store/$/api）+ media.js（PlayerManager/previewState）；运行时引用主 script 的 UI 函数
 *      （positionPlayhead/renderTimecode/ensurePlayheadVisible 等，加载完后才调用）。
 * 加载顺序：store.js → media.js → player.js → HTML 主 script。
 * 注：播放变量（isPlaying/playStartWall 等）仍在主 script（UI 也用），本文件函数运行时访问。
 * ===================================================================== */

/* ---------- 播放状态（Step 2 播放隔离：从 HTML 收口到 player.js） ---------- */
/* ---------- 播放控制（对齐 OpenCut clock-based 模型：一个时钟推进 playheadUs，预览订阅） ---------- */
let isPlaying = false;
let playRAF = null;
let playStartWall = 0;        // 开始播放时的 performance.now()
let playStartUs = 0;          // 开始播放时的 playheadUs
let lastHitSig = "";          // 播放时命中段签名；跨段才重建预览，平时只动红线
let previewMuted = false;     // 全局预览静音：false=有声，true=静音
let mediaClockReady = true;   // 视频/音频已 seek 到播放位置：true 时播放头跟随媒体时钟，false 时信任墙钟（避免读到脏 currentTime 跳回段起点）
let _mcrWaitAt = 0;           // mediaClockReady 看门狗计时起点（performance.now()），用于 D 超时回退
let _lastPlayAll = 0;          // playAllMedia 防抖计时（performance.now()），避免同一媒体被反复 play 引发 AbortError


const audioCtx = (typeof AudioContext !== "undefined") ? new AudioContext() :
                 (typeof webkitAudioContext !== "undefined") ? new webkitAudioContext() : null;
function unlockAudio() {
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(err => console.warn("[audioCtx] resume failed:", err));
  }
}

function totalDurationUs() {
  let maxUs = 0;
  forEachSeg(s => { const e = s.start + s.duration; if (e > maxUs) maxUs = e; });
  return maxUs;
}

// 找到播放头命中的所有段（video/image/audio/text 分别归类）
function resolveHits(us) {
  const hits = [];
  const d = Store.state.draft;
  ["video", "audio", "text", "sticker"].forEach(type => {
    (d[type] || []).forEach((track, ti) => {
      track.forEach((seg, idx) => {
        if (us >= seg.start && us < seg.start + seg.duration) {
          hits.push({ seg, type, ti, idx, key: type + ":" + ti + ":" + idx });
        }
      });
    });
  });
  return hits;
}

// 判断当前时间点是否有可播放内容（video/audio；image/text 只看不播）
function hasPlayableAt(us) {
  for (const h of resolveHits(us)) if (h.type === "video" || h.type === "audio") return true;
  return false;
}
const PLAY_SESSION_STATE = Object.freeze({
  CREATED:        "CREATED",
  STARTING:       "STARTING",
  MUTED_PLAYING:  "MUTED_PLAYING",   // 临时保护态（= PLAYING + autoplayUnlockPending），窗口仅数十 ms；业务主判 autoplayUnlockPending
  PLAYING:        "PLAYING",
  PAUSED:         "PAUSED",
  RECOVERING:     "RECOVERING",
  ENDED:          "ENDED",
  CANCELLED:      "CANCELLED",
});
let currentSessionId = 0;
let currentSession = null;

// Step B：恢复纪律常量
const RECOVER_CAP = 2;            // 单 session 窗口内恢复上限（防无限重试）
const RECOVER_WINDOW_MS = 60000;  // 恢复配额窗口：超过该时长未恢复则配额自动清零（适配长时运行）

// Step B.5：媒体激活门常量
// 实验1（2026-08-15，GPT 拍板验证用）：冷启动 audio 数据加载可能 >1s，
// 1s 内 play() 在 readyState=0 被调 → pending 无声；5s 对齐 v1.4.1 验证过的 _waitMediaReady 等待时长。
// 目的：验证"冷启动等待时间是不是唯一变量"。若成功=B.5.5 收敛；若失败=回到 _playWhenReady 找真实断点，不再加补丁。
const MEDIA_ACTIVATION_TIMEOUT = 5000; // ms，媒体激活等待兜底（实验1：1000→5000）
const MEDIA_ACTIVATION_STATE = Object.freeze({
  WAITING:           "WAITING",           // 已发起 play，尚未收到任何激活信号
  PLAYING_CONFIRMED: "PLAYING_CONFIRMED", // 收到真实 playing 事件（最高优先级）
  READY_FALLBACK:    "READY_FALLBACK",    // 收到 canplaythrough / readyState>=4（辅助信号，非音频输出已启动）
  TIMEOUT_DEGRADED:  "TIMEOUT_DEGRADED",  // 超过 MEDIA_ACTIVATION_TIMEOUT 仍未激活，降级放行（防坏轨死锁）
});

// Step B.5 媒体激活契约：播放事务类型枚举（替代 play({handoff:true}) 布尔参数，避免第二套播放逻辑分支）。
// START=用户/手势主动起播；RECOVER=启动失败恢复（经 _scheduleRecover→continueStart，当前不直传 play）；
// HANDOFF=跨段交接（复用 session，不重建/不重静音全体，仅增量处理本段新增/失活媒体）。
const _PLAY_REASON = Object.freeze({
  START:   "start",
  RECOVER: "recover",
  HANDOFF: "handoff",
  RESUME:  "resume",   // B.5.4-3：暂停→恢复（复用 PAUSED session，非跨段 handoff）
});

// B.5.4-4：MediaTarget 生命周期状态（仅日志显式化，不反向控制行为——防未来回归）。
const MEDIA_TARGET_STATE = Object.freeze({
  UNKNOWN:   "UNKNOWN",
  ACTIVE:    "ACTIVE",     // 本段活跃、参与播放
  PARKED:    "PARKED",     // 失活、停车静音（inactive-park）
  ENTERING:  "ENTERING",   // 新进入（reload/新段，需重新激活）
  LEAVING:   "LEAVING",    // 离开（失活，将停车）
});

// B.5.4-0：统一 muted 写入口（单一日志来源）。所有播放/渲染生命周期内的 muted 修改必须走这里，
// 根绝「谁最后碰了 muted」不可追溯。reason 标注来源：inactive-park/play-mute/activation-*/reload-*/render-*/pool-create/release/prime。
function setMediaMute(el, value, reason, label) {
  if (!el) return;
  el.muted = value;
  console.log("[MUTE]", label || (el.tagName || "?"), "->", value, "reason=" + reason);
}

// B.5.5-SRC（GPT 拍板，诊断不改逻辑）：统一 src 写入日志打点。
// 目的：回答"谁把 readyState 从 4 打回 0"——src 重新赋值 / load() / 元素替换都会归零。
function setMediaSrc(el, src, reason, label) {
  if (!el) return;
  const old = el.currentSrc || el.src || "";
  console.log("[SRC]", label || (el.tagName || "?"), reason, (old || "(empty)").slice(0, 60), "=>", (src || "(empty)").slice(0, 60));
  el.src = src;
}

// B.5.5：seek 确认期间的 target key 集合。correctActiveMediaDrift 见 key 在此集合则跳过，
// 避免"起播前等 seek 落位"期间 drift 又发 seek 打断（修 seek/play/drift 每帧自我震荡）。
const _seekConfirmKeys = new Set();

// 最终媒体是否应静音（单一计算点）：用户意图 / autoplay 待解锁 / 媒体暂 inactive 任一为真即静音。
// 注：本函数供 Step D 收口 _applyMediaState 时使用；Step A 的 restore/onPlaying 直接按 want 解静音。
function shouldMediaBeMuted(s) {
  return previewMuted || s.autoplayUnlockPending || s.mediaMuteReasons.size > 0;
}

function createSession(targets) {
  const s = {
    id: ++currentSessionId,
    state: PLAY_SESSION_STATE.CREATED,
    targets,                                   // [{el,rec,type,ti,key,want}]
    userMuteIntent: previewMuted,               // (B) 用户意图快照
    autoplayUnlockPending: true,                // (A) 静音起播，等 onPlaying 清除
    mediaMuteReasons: new Set(),                // (C) 临时静音来源集合（gap/seek/crossSegment...）
    activation: new Map(),                      // (B.5) key=t.key → ActivationRecord{state,timer,cleanups}
    userPaused: false,
    lastPlayhead: Store.state.playheadUs,
    // Step B：恢复纪律字段（防第二套播放逻辑 + 长时运行配额）
    recoverToken: 0,                            // 恢复调度令牌：每次 _scheduleRecover 自增，旧恢复天然作废
    recoverCount: 0,                            // 窗口内恢复次数（RECOVER_CAP 封顶）
    lastRecoverAt: 0,                           // 上次恢复时间戳（用于窗口清零）
    isCurrent() { return this.id === currentSessionId; },
    canRestore() { return !this.userMuteIntent && !this.userPaused && this.autoplayUnlockPending; },
    // Step B：continueStart 准入（RECOVERING + 当前 + 未逾限）
    canContinue() {
      if (this.state !== PLAY_SESSION_STATE.RECOVERING) return false;
      if (!this.isCurrent()) return false;
      const now = performance.now();
      if (this.lastRecoverAt && now - this.lastRecoverAt > RECOVER_WINDOW_MS) this.recoverCount = 0; // 窗口外清零
      return this.recoverCount < RECOVER_CAP;
    },
    cancel() { this.state = PLAY_SESSION_STATE.CANCELLED; },
  };
  currentSession = s;
  console.log("[PlaySession]", s.id, s.state, s.targets.length, s.autoplayUnlockPending, "token=" + s.recoverToken, "reason=start");
  return s;
}
function _waitSeekSettled(el) {
  return new Promise((resolve) => {
    if (!el || (el.tagName !== "VIDEO" && el.tagName !== "AUDIO")) { resolve(); return; }
    const target = el._seekTarget;
    const isSettled = () => {
      if (el.seeking) return false;
      if (el.readyState < 2) return false;
      if (target != null && Math.abs((el.currentTime || 0) - target) > 0.1) return false;
      return true;
    };
    if (isSettled()) { resolve(); return; }
    let fired = false, timer = null, seekListener = null, errListener = null;
    const cleanup = () => {
      if (fired) return; fired = true;
      if (seekListener) el.removeEventListener("seeked", seekListener);
      if (errListener) el.removeEventListener("error", errListener);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const recheck = () => {
      if (fired) return;
      if (isSettled()) { cleanup(); return; }
      // 没 seek 中但仍没到位 → 强制再 seek 一次（某些 WebView2 构建会吞掉 currentTime 赋值）
      if (!el.seeking && target != null) {
        try { el.currentTime = target; } catch (e) {}
      }
    };
    seekListener = () => { recheck(); };
    errListener = () => { cleanup(); };
    el.addEventListener("seeked", seekListener, { once: false });
    el.addEventListener("error", errListener, { once: true });
    // 轮询检查：每 80ms 验证一次是否真正落位；未落位则主动重 seek。
    timer = setInterval(recheck, 80);
    // 安全网：2.5s 内仍未落位 → 强制放行，避免永久死锁；由 correctActiveMediaDrift/playAllMedia 后续兜底。
    // 真机 2026-08-16：WebView2 跨段 seek 大文件常 700-2000ms 才到 readyState>=2，700ms 太短会卡住 play。
    setTimeout(() => {
      if (fired) return;
      console.warn("[_waitSeekSettled] 超时放行(媒体可能未加载):", el.tagName, "readyState=", el.readyState, "seeking=", el.seeking, "currentTime=", el.currentTime, "target=", target, "src=", (el.currentSrc || el.src || "").slice(0, 70));
      cleanup();
    }, 2500);
  });
}

// Round G1：等媒体元素加载到可 seek 状态（readyState >= 2）。
// startPlay 调用前必须等这一步，否则在元素未加载完时 seek 会静默失败，导致音频从头播。
// Round G3：必须加 3 秒安全网 + error 预检，否则媒体已 error 或事件丢失时会永久 pending，
// 导致 startPlay 卡在 await、playTick 永远不启动、播放头一动不动。
function _waitMediaReady(el) {
  return new Promise((resolve) => {
    if (!el || (el.tagName !== "VIDEO" && el.tagName !== "AUDIO")) { resolve(); return; }
    if (el.readyState >= 2 || el.error) { resolve(); return; }   // error 已存在也放行，让后续 _tryReloadMedia 去恢复
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      el.removeEventListener("canplay", onReady);
      el.removeEventListener("canplaythrough", onReady);
      el.removeEventListener("error", onReady);
      resolve();
    };
    const onReady = () => { cleanup(); };
    el.addEventListener("canplay", onReady, { once: true });
    el.addEventListener("canplaythrough", onReady, { once: true });
    el.addEventListener("error", onReady, { once: true });
    timer = setTimeout(() => { console.warn("[_waitMediaReady] 超时放行:", el.tagName, (el.currentSrc || el.src || "").slice(0, 70)); cleanup(); }, 3000);
  });
}

// Round F4：媒体元素 error 恢复。WebView2 下偶发文件句柄/网络波动会导致 <audio>/<video> 进入 error 状态，
// 一旦 error 后续 seek/play 全部失效（表现为某段后突然没声）。不重建元素（守 E 的媒体生命周期纪律），
// 而是重新 load() 同一 src，并在 load 完成后 seek 回当前播放头、继续播放。
function _tryReloadMedia(el, type, layerKey) {
  if (!el) return;
  const err = el.error;
  const code = err ? err.code : -1;
  // code 1=ABORTED(用户/代码中断，可恢复), 2=NETWORK, 3=DECODE, 4=SRC_NOT_SUPPORTED
  // NotSupportedError/4 有时是 WebView2 对同一 src 的偶发误判，reload 可能恢复；
  // 无限 reload 防护：同一元素 5 秒内最多重试 2 次。
  const now = performance.now();
  el._reloadHistory = el._reloadHistory || [];
  el._reloadHistory = el._reloadHistory.filter(t => now - t < 5000);
  if (el._reloadHistory.length >= 2) {
    console.warn("[_tryReloadMedia] 5 秒内已重试 2 次仍失败，放弃:", layerKey, "code=", code, "src=", (el.currentSrc || el.src || "").slice(0, 80));
    return;
  }
  console.warn("[_tryReloadMedia] 媒体 error，尝试 reload:", layerKey, "code=", code, "src=", (el.currentSrc || el.src || "").slice(0, 80));
  el._reloadHistory.push(now);
  // 先清 error 状态占位，避免立即再次触发
  const oldSrc = el.src;
  const oldCurrentSrc = el.currentSrc;
  // 重新 load()：不重建元素、不改 src，只让浏览器重新拉取（load() 同样会把 readyState 打回 0）
  console.log("[SRC]", layerKey, "reload-load()", (oldCurrentSrc || oldSrc || "").slice(0, 60));
  try { el.load(); } catch (e) { console.warn("load() 失败:", e); }
  // load 完成后 seek 回当前播放头并继续播放
    const onLoaded = () => {
    el.removeEventListener("canplaythrough", onLoaded);
    el.removeEventListener("canplay", onLoaded);
    el.removeEventListener("error", onLoadedError);
    const rec = type === "video" ? previewState.visualEls.get(layerKey) : previewState.audioEls.get(layerKey);
    if (rec && rec.seg) PlayerManager.seek(el, rec.seg, Store.state.playheadUs);
    if (isPlaying && el.paused) {
      const want = wantSound(type, parseInt((layerKey.split(":")[1] || "0"), 10));
      // Round G2：reload 发生在播放中，通常没有用户手势，同样要走静音起播适配 autoplay
      setMediaMute(el, true, "reload-mute", layerKey);
      const restore = () => {
        const stillActive = rec && resolveHits(Store.state.playheadUs).some(h => h.key === rec.key);
        setMediaMute(el, !(stillActive && want), "reload-restore", layerKey);
      };
      el.addEventListener("playing", restore, { once: true });
      const p = el.play();
      if (p && p.then) p.then(restore, restore);
      setTimeout(restore, 80);
      if (p && p.catch) p.catch(() => {});
    }
  };
  const onLoadedError = () => {
    el.removeEventListener("canplaythrough", onLoaded);
    el.removeEventListener("canplay", onLoaded);
    el.removeEventListener("error", onLoadedError);
    console.warn("[_tryReloadMedia] reload 后仍 error:", layerKey);
  };
  el.addEventListener("canplaythrough", onLoaded, { once: true });
  el.addEventListener("canplay", onLoaded, { once: true });
  el.addEventListener("error", onLoadedError, { once: true });
}

// 读取 draft._track_meta 判断轨道是否静音/隐藏（用于预览过滤，对齐 OpenCut 语义）
function isTrackMuted(type, ti) {
  const meta = (Store.state.draft._track_meta || {})[type] || [];
  return !!(meta[ti] || {}).muted;
}
// Round E-F：该媒体元素是否“期望有声”（既非全局静音也非轨道静音）
function wantSound(type, ti) {
  return !(previewMuted || isTrackMuted(type, ti));
}
function isTrackHidden(type, ti) {
  const meta = (Store.state.draft._track_meta || {})[type] || [];
  return !!(meta[ti] || {}).hidden;
}
function dbg(msg) { const el = $("mediaStatus"); if (el) el.textContent = msg; }
function togglePlay() {
  if (isPlaying) { pausePlay(); return; }
  // B.5.4-3：PAUSED 态复用 session 恢复，避免 cold start 导致音视频状态错乱
  if (currentSession && currentSession.isCurrent() && currentSession.state === PLAY_SESSION_STATE.PAUSED) {
    if (PlayerManager.resume()) return;
  }
  startPlay();
}
// B.5.4-2（修正版）：手势内媒体权限预热。
// 用一个临时隐藏 <audio>（极短静音 WAV）拿「文档级」autoplay 权限，绝不碰真实时间轴元素。
// 根因修正：原实现对真实元素 play()+pause() 且未 await，会与主流程 _attemptPlay 竞态，
// 导致 _attemptPlay 早返 + prime 的 pause() 把元素暂停 → 首播卡死/无声。临时元素与真实元素互不干扰。
let _silentPrimeUrl = null;
function _getSilentPrimeUrl() {
  if (_silentPrimeUrl) return _silentPrimeUrl;
  const sampleRate = 8000, samples = 1600;              // 0.2s 静音
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, "data"); v.setUint32(40, samples, true);        // 数据全 0 = 静音
  _silentPrimeUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return _silentPrimeUrl;
}
async function primeMediaPlayback(hits) {
  const tmp = document.createElement("audio");
  tmp.muted = true;
  tmp.src = _getSilentPrimeUrl();
  tmp.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(tmp);
  try {
    await Promise.race([tmp.play(), new Promise(r => setTimeout(r, 100))]);
  } catch (e) { /* 预热失败不致命，正式播放仍走激活门 */ }
  try { tmp.pause(); document.body.removeChild(tmp); } catch (e) {}
}
async function startPlay() {
  const maxUs = totalDurationUs();
  if (maxUs <= 0) { dbg("无内容可播放（时间轴为空）"); return; }
  if (Store.state.playheadUs >= maxUs - 1000) Store.set({ playheadUs: 0 });
  // B.5 音频解锁：必须在用户手势上下文内调用，否则 WebView2 下 <audio> 会被自动播放策略拒绝。
  unlockAudio();
  // Round E⑤：NLE 默认行为——播放头从当前位置沿墙钟推进，空白区静音自然穿过，绝不自动跳空隙（避免跳过空镜/转场缓冲）
  isPlaying = true;
  playStartWall = performance.now();
  playStartUs = Store.state.playheadUs;
  mediaClockReady = false;    // 视频/音频尚未 seek 到目标位置，playTick 先信任墙钟
  _mcrWaitAt = 0;
  $("playBtn").textContent = "⏸";
  lastHitSig = resolveHits(Store.state.playheadUs).map(h => h.key).join("|");
  renderPreview();            // 立即更新元素（新素材可能刚设置 src，还未加载完）
  // Phase C-2-fix（2026-08-16 真机）：audio 轨交给 AudioEngine（Web Audio）。
  // 只在这里 attach + 同步静音；**不再 setClips** —— 下方 seekActiveMediaToPlayhead(playheadUs)
  // 内部会 setClips，若这里也调，二次 stopAll+epoch 会作废正在 decode 的调度 → 音频起不来。
  try {
    AudioEngine.attach(audioCtx);
    AudioEngine.setGlobalMuted(previewMuted);
  } catch (e) { console.warn("[AudioEngine] startPlay 接线失败:", e); }
  const hits = resolveHits(Store.state.playheadUs);
  // 止血（B.5.5-STAB，2026-08-15 拍板）：Timeline Clock 是 master，绝不被媒体 await 阻塞。
  // 原实现 3 个 await 屏障（primeMediaPlayback / _waitMediaReady 最长5s / _waitSeekSettled 最长5s）
  // 在 WebView2 媒体就绪慢或不触发时会阻塞 playTick → 播放头不动。改为：
  //   - prime 只 fire-and-forget 拿文档级权限（不阻塞）；
  //   - seekActiveMediaToPlayhead 同步调（元素未 ready 时静默失败，由 canplay 回调 + drift 兜底）；
  //   - playAllMedia 立即调（_attemptPlay 内部 pre-ready gate 自己等就绪后起播）；
  //   - playTick 立即启动墙钟。媒体是 follower，自己追上播放头；播放头永远不被媒体拖住。
  primeMediaPlayback(hits).catch(() => {});
  seekActiveMediaToPlayhead(Store.state.playheadUs);
  playAllMedia();
  playTick();
}
function pausePlay() {
  // Phase C-2：AudioEngine 清场（stopAll 已调度源 + 停轮询）；video 元素由 PlayerManager.pause 处理
  try { AudioEngine.pause(); } catch (e) {}
  return PlayerManager.pause();
}
function toggleMute() { return PlayerManager.setGlobalMute(); }
function playAllMedia(reason) { return PlayerManager.play(reason || _PLAY_REASON.START); }
// Round E②：drift 检测辅助（替代原 _dominantMediaUs 的“媒体当 master”角色）。
// 播放头是 master（墙钟）。这里只做被动收口：媒体若因缓冲/解码滞后偏离播放头 >100ms，
// 才把它 seek 回正确时间轴位置；绝不反写 playheadUs，避免“谁在播谁是老大”导致的跳/双播/回弹。
// B.5.5-hotfix（GPT 拍板 2026-08-15）：drift 是"连续控制"，只允许纯软 seek（PlayerManager.seek，只设 currentTime，
// 不 pause/play/await）；带 pause/play 的 seekBarrier 属"事务操作"（startPlay/handoff/resume），drift 禁用。
// 之前误把 seekBarrier 接入 drift → pause() 是同步副作用，每帧被调 → 播放被重启成"咚咚咚"。
let _lastDriftAt = 0;
function correctActiveMediaDrift(us) {
  const now = performance.now();
  if (now - _lastDriftAt < 200) return;   // hotfix：drift throttle 200ms（防高频设 currentTime 干扰解码器）
  _lastDriftAt = now;
  if (crossSegmentPending) return;   // Step5：跨段期间由 _handleCrossSegment 独占媒体 seek，禁止每帧 drift 与跨段 seek 双系统互殴（修 Bug A）
  const hits = resolveHits(us);
  const consider = (rec, type) => {
    if (!rec) return;
    const el = type === "video" ? rec.el.firstElementChild : rec.el;  // video 元素在 wrap 内；audio 元素本身
    if (!el || el.paused || el.seeking) return;   // 暂停/seek 中不打扰，避免与跨段 seek 抢
    if (el._seekPending) return;                   // B.5.5-2：内部 seek barrier 在跑，drift 跳过（防并发自激振荡）
    if (_seekConfirmKeys.has(rec.key)) return;    // B.5.5：起播前 seek 确认期间，drift 不打断（修 seek/play/drift 每帧自我震荡）
    // 2026-08-16 机制修复（真机死循环根因）：drift 每 200ms 一次 seek，会把正在缓冲的元素（readyState=1）
    // 反复打断 → cur 永远追不上 → 又 seek → 448 次 playing 死循环。两个守卫：
    //  ① 静默期：该元素最近一次 seek 后 1s 内不再碰它（给浏览器完整缓冲时间，自然追上播放头）
    //  ② readyState<2（仅有 metadata 还在加载）时不 seek（seek 会打断加载，永远到不了可播状态）
    if (el._lastSeekAt && now - el._lastSeekAt < 1000) return;
    if (el.readyState < 2) return;   // HAVE_METADATA 以下：元素还在加载，seek 只会打断，交给 play 路径自己追上
    const s = rec.seg; if (!s) return;
    const srcStartUs = s.src_start || 0;
    const srcEndUs = s.src_end || (srcStartUs + s.duration);
    const ct = el.currentTime || 0;
    const ssSec = srcStartUs / 1e6;
    const endSec = srcEndUs / 1e6;
    // Round E-F2：核心修正。当 currentTime 明显落在当前段源区间之前（ct < ss - 100ms），
    // 说明跨段 seek 没有真正落位（WebView2 下 audio 常见：seeked 事件触发后 play() 又把 currentTime 冲回 0）。
    // 这种情况不能当成“映射过期”跳过，必须强制 seek 到正确位置，否则用户会一直听到素材头。
    // B.5.5-hotfix：drift 用纯软 seek（PlayerManager.seek），禁止 seekBarrier（pause/play 会重启播放）。
    if (ct < ssSec - 0.1 || ct > endSec + 0.1) {
      PlayerManager.seek(el, s, us);
      el._lastSeekAt = now;   // 记录静默期起点
      return;
    }
    const mapped = s.start + (ct * 1e6 - srcStartUs);  // 媒体当前位置映射回时间轴
    if (mapped < s.start || mapped > s.start + s.duration) return;  // 映射过期（跨段未刷新）→ 跳过，交给 _handleCrossSegment
    if (Math.abs(mapped - us) > 100000) { PlayerManager.seek(el, s, us); el._lastSeekAt = now; }  // 仅 >100ms 大漂移才纠正；绝不反写播放头
  };
  for (const h of hits) {
    if (h.type === "video") consider(previewState.visualEls.get("video:" + h.ti), "video");
    else if (h.type === "audio") consider(previewState.audioEls.get("audio:" + h.ti), "audio");
  }
}

// Round B：跨段只 seek 已存在的媒体元素，绝不复建/改 src/重跑 render。
// 仅当命中元素缺失（startPlay 未预建该段，例如音频首段在 t=10、起播在 t=0）才降级 renderPreview 一次，
// 并用 previewState.isRepairing 防止「跨段→renderPreview→跨段」循环（新 GPT 保险建议）。
function seekActiveMediaToPlayhead(us) {
  const hits = resolveHits(us);
  const seeked = [];   // Round D：收集本轮回实际 seek 的媒体元素，供 startPlay/跨段 await 屏障
  // Round B1：未命中的媒体元素必须主动停车（pause+mute），否则空白区/旧段继续发声、
  // 跨段时新旧元素抢播放状态 → 闪/卡/无声。原 renderPreview 重建的「被动停车」在 B 中已移除，这里主动补上。
  // active 判断基于 resolveHits（绝不用媒体元素自身状态）；命中元素 muted 恢复为「轨道静音||全局静音」，不污染用户设置。
  const activeVideoTis = new Set(hits.filter(h => h.type === "video").map(h => h.ti));
  const activeAudioTis = new Set(hits.filter(h => h.type === "audio").map(h => h.ti));
  for (const [layerKey, rec] of previewState.visualEls) {
    const v = rec.el.firstElementChild;
    if (!v) continue;
    const ti = parseInt(layerKey.split(":")[1], 10);
    const isVideo = v.tagName === "VIDEO";                            // visualEls 也可能存图片(<img>)，图片无 pause()/muted
    if (!activeVideoTis.has(ti)) {
      if (isVideo) {
        v.pause(); setMediaMute(v, true, "inactive-park", layerKey);   // 非活动视频：停车静音
        // Phase C-fix（2026-08-16 真机）：间隙时仅 pause 还残留最后一帧画面，必须 hide 让预览区回到占位黑屏
        rec.el.style.display = "none";
      }
    } else {
      // 命中轨恢复显示（跨段后新元素已由 renderPreview 设为 display=""，但若 playTick 跨过边界需保险恢复）
      if (isVideo) rec.el.style.display = "";
    }
  }
  for (const [layerKey, rec] of previewState.audioEls) {
    const a = rec.el;
    if (!a) continue;
    const ti = parseInt(layerKey.split(":")[1], 10);
    if (!activeAudioTis.has(ti)) { a.pause(); setMediaMute(a, true, "inactive-park", layerKey); }   // 非活动音频：停车静音（inactive-park 属 seek/render reconcile；激活门只负责 active 解 mute）
  }
  let allReady = true;
  for (const h of hits) {
    if (h.type !== "video" && h.type !== "audio") continue;
    // Phase C-2：audio 轨交给 AudioEngine（lookahead 自动调度），不参与元素 seek 路径。
    // audioEls 已清空，若不跳过会导致 el=null → allReady=false → 每次 seek 都触发 renderPreview 重建。
    if (h.type === "audio") continue;
    let el = null, rec = null;
    if (h.type === "video") {
      const v = previewState.visualEls.get("video:" + h.ti);
      rec = v; el = v ? v.el.firstElementChild : null;   // video 元素在 wrap 内，firstElementChild 即 <video>
      // C.5-3（MediaSlot swap，2026-08-16）：跨段时若 prepare 槽已 READY（后台预加载完成）→ **swap 无感**：
      //   旧 active 元素转 prepare（隐藏，后台加载下一段 N+2），prepare 转 active（显示，直接播）
      //   根治 WebView2"切段 destroy+重建→新元素加载慢→从 0 起播"（日志实锤 cur=0.002 反复播开头）。
      //   仅当 prepare 未 READY/无 prepare 时，降级走原 destroy+重建（现有逻辑兜底）。
      if (rec && rec.el && rec.key !== h.key) {
        if (rec.prepare && rec.slotState === "READY") {
          // swap：active ↔ prepare
          const oldActive = rec.el;
          rec.el = rec.prepare;
          rec.prepare = oldActive;
          rec.slotState = "ACTIVE";
          rec.el.style.display = "";               // prepare 转 active：显示
          rec.prepare.style.display = "none";      // 旧 active 转 prepare：隐藏（后台）
          rec.prepare.dataset.path = "";           // 旧元素 path 清掉，防误判
          rec.el.dataset.pendingSeek = "";         // prepare 已就位，无需 pendingSeek
          el = rec.el.firstElementChild;
          rec.seg = h.seg; rec.key = h.key;
          // 旧 active 的 media 复位（清 src，避免后台残留解码）
          const oldMedia = rec.prepare.firstElementChild;
          if (oldMedia) { try { oldMedia.pause(); } catch (e2) {} try { oldMedia.removeAttribute("src"); } catch (e2) {} }
          console.log("[MediaSlot] SWAP", "active=" + h.key, "prepare→active");
          // swap 后补位：旧 active（现 prepare）立即开始加载下一段 N+2（播放期 renderPreview 不调，这里手动补）
          try { if (typeof preloadNextVideoSlot === "function") preloadNextVideoSlot(rec, h.ti, h.seg.start || 0); } catch (e3) {}
        } else {
          PlayerManager.destroy("video:" + h.ti);   // 降级：prepare 未就绪 → 原 destroy+重建兜底
          rec = null; el = null;
        }
      }
    } else if (h.type === "audio") {
      const a = previewState.audioEls.get("audio:" + h.ti);
      rec = a; el = a ? a.el : null;   // audio 元素本身直接存于 audioEls.el
    }
    if (!el) { allReady = false; continue; }
    // B2-B：跨段只 seek 不复建元素，必须同步刷新 rec.seg/key，否则 playAllMedia 兜底仍用旧段元数据
    // 算时间轴位置 → 播放头反复判定跨段 → 来回 seek → 闪/卡/反复播。仅跨段（seg/key 变化）才写，避免每 tick 无效写对象。
    // Phase C 注：同段内 rec.seg 不变（不触发 destroy），这里仍会因跨段刷新 rec.seg（h.seg 已是新段）。
    if (rec && (rec.seg !== h.seg || rec.key !== h.key)) { rec.seg = h.seg; rec.key = h.key; }
    PlayerManager.seek(el, h.seg, us);   // 唯一 seek 入口：timeline→source 换算在 PlayerManager.seek 内部完成，禁第二套逻辑
    seeked.push(el);            // Round D：记录待屏障元素
    if (isPlaying) el.onseeked = () => { mediaClockReady = true; };
  }
  if (!allReady && !previewState.isRepairing) {
    previewState.isRepairing = true;
    renderPreview();   // 安全降级：仅缺失元素重建一次，不破坏媒体生命周期纪律
    setTimeout(() => { previewState.isRepairing = false; }, 120);
  }
  // Phase C-2：seek 后重排 AudioEngine 调度（拖动/跨段/起播后音频基准已变，重新锚定 + 重扫）
  try {
    AudioEngine.setClips(buildPlaybackGraph(Store.state.draft, Store.state.materials).audioClips, us);
  } catch (e) { console.warn("[AudioEngine] seek 重排失败:", e); }
  return seeked;   // Round D：调用方凭此 await 屏障，确保 seek 完成后再 playAllMedia()
}

// Round D：跨段异步处理。playTick 是 RAF 同步循环，不能在回调里 await 阻塞下一帧，
// 故抽出异步函数 —— await seek 屏障后再 playAllMedia；期间 mediaClockReady=false，playTick 走墙钟（不读脏 currentTime）。
// crossSegmentPending 锁：防止 RAF 多帧重复进入（音频-only 高频跨段最易触发）导致重复 seek/双播（审核点 2）；
// 若处理期间又跨段，用 crossSegmentQueuedUs 记录最新目标，处理完补一轮，绝不丢 clip。
let crossSegmentPending = false;
let crossSegmentQueuedUs = null;
async function _handleCrossSegment(us) {
  if (crossSegmentPending) { crossSegmentQueuedUs = us; return; }   // 已有跨段在跑：只记最新目标，处理完补一次
  crossSegmentPending = true;
  try {
    let target = us;
    while (target != null) {
      mediaClockReady = false;   // 切源后等新的视频/音频 seeked 再跟随其时钟
      _mcrWaitAt = 0;
      // 2026-08-16 真机修复（与 startPlay 同款不阻塞模式）：不再 await _waitSeekSettled。
      // 日志实锤：WebView2 paused 时吞 currentTime 赋值（readyState=4 但 cur=0 死等 2.5s），
      // 等 seek 落位会让播放头墙钟超前 2.5s → 跨段错位。改为：
      //   seek 只发不管（元素未 ready 时静默失败）→ 立即 playAllMedia（_attemptPlay 内部 pre-ready gate 自己等就绪）
      //   → 落后由 drift（静默期 1s 后）校准。播放头墙钟绝不被媒体 await 拖住（与 startPlay 止血同构）。
      seekActiveMediaToPlayhead(target);
      if (isPlaying) { _lastPlayAll = 0; playAllMedia(_PLAY_REASON.HANDOFF); }   // 跨段强制起播，HANDOFF 交接
      target = crossSegmentQueuedUs;   // 处理期间又跨段？取最新再走一轮
      crossSegmentQueuedUs = null;
    }
  } finally {
    crossSegmentPending = false;
  }
}
function playTick() {
  if (!isPlaying) return;
  const now = performance.now();
  const maxUs = totalDurationUs();
  // Round E①：播放头永远由墙钟（playStartUs + 墙钟流逝）推进，是 master。媒体只负责跟着播、被动纠正 drift，
  // 绝不允许媒体时钟反写 playheadUs（这是过去“跳/双播/回弹”的根因）。
  const wallUs = playStartUs + (now - playStartWall) * 1000;
  let us = wallUs;
  // D: mediaClockReady 超时回退 —— 跨段/初次 seek 后若 2.5s 内媒体仍未 playing，重试播放，避免永久脱节
  // 2026-08-16：800→2500ms，对齐 _waitSeekSettled 安全网（WebView2 大文件加载慢，800ms 内重试会打断缓冲）
  if (!mediaClockReady) {
    if (!_mcrWaitAt) _mcrWaitAt = now;
    else if (now - _mcrWaitAt > 2500) {
      playAllMedia();            // 重试播放（sticky-activation 下通常能成）
      _mcrWaitAt = now;          // 重置计时，避免每帧重试；只等下一次 2.5s 窗口
    }
  } else { _mcrWaitAt = 0; }
  if (us >= maxUs) {
    // DIAG-2026-08-16：播放头≥maxUs 提前收尾时打印前端真实 draft 状态（排查"前端拿旧数据"）
    try {
      const _d = Store.state.draft || {};
      const _count = t => (_d[t] || []).map(tr => tr.length).join("+");
      console.warn("[PAUSED-DIAG] us=" + (us/1e6).toFixed(3) + "s maxUs=" + (maxUs/1e6).toFixed(3) + "s videoSegs=" + _count("video") + " audioSegs=" + _count("audio"));
    } catch (e) {}
    Store.state.playheadUs = maxUs; positionPlayhead(); renderTimecode(); pausePlay(); return;
  }
  // 纯空隙：不再运行时瞬移播放头（Round D.1 —— NLE 行为：播放头沿当前时钟自然穿过空白，静音滑到下一素材）
  // 仅当播放头处于空隙且后面没有任何可播素材时，才在末尾收尾暂停。
  if (!hasPlayableAt(us)) {
    let nextUs = maxUs;
    forEachSeg(s => { if (s.start >= us && s.start < nextUs) nextUs = s.start; });
    if (nextUs >= maxUs) {   // 后面没有可播段了 → 正常收尾
      Store.state.playheadUs = maxUs;
      positionPlayhead();
      renderTimecode();
      pausePlay();
      return;
    }
    // 否则：不修改 us / playStartUs / playStartWall，播放头沿当前时钟自然推进（空白区无声音）
  }
  // Round E②：媒体若因缓冲/解码滞后偏离播放头 >100ms，才把它 seek 回正确时间轴位置；绝不反写 playheadUs。
  correctActiveMediaDrift(us);
  // 播放时绕开 Store.set 的整树重绘：直接写 state + 仅动红线与时间码
  Store.state.playheadUs = us;
  positionPlayhead();
  renderTimecode();
  applyKfLiveAll();   // 每帧刷新关键帧动画（位移/缩放/旋转/透明度）
  // 仅「跨段换源」才重建预览并 seek 一次；同段内靠浏览器自然播放，绝不每帧 seek（这是流畅的关键）
  const hits = resolveHits(us);
  const keySig = hits.map(h => h.key).join("|");
  if (keySig !== lastHitSig) {
    lastHitSig = keySig;
    PlayerManager.handleCrossSegment(us);   // Step5：跨段处理统一走 Player 入口（fire-and-forget，不阻塞 RAF 下一帧）
  }
  playRAF = requestAnimationFrame(playTick);
}
