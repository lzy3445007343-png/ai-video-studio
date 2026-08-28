"use strict";

/* =====================================================================
 * media.js —— 素材/元素管理（Step 1b 拆 JS：从 工作台v0.8时间轴.html 拆出，纯搬移不改逻辑）
 * 职责：previewState（媒体元素状态容器）+ PlayerManager（媒体元素生命周期/播放控制）。
 * 依赖：store.js（$ / Store）；运行时引用 HTML 主 script 的函数（createSession/_waitSeekSettled 等）。
 * 加载顺序：store.js → media.js → HTML 主 script。
 * ===================================================================== */

const previewState = {
  visualEls: new Map(), // key="video:${ti}"，value={el, prepare, key, mtype, path, slotState} —— el=Active 槽，prepare=后台预加载槽（C.5 起）
  audioEls: new Map(),  // key="audio:${ti}"，value={el, key, mtype, path}
  textEls: new Map(),   // key="text:${ti}"，value={el, key, text}
  stickerEls: new Map(), // key="sticker:${ti}"，value={el, key, seg}
};

const PlayerManager = {
  // 媒体池（未来 clip-agnostic；壳阶段仅占位，未启用）
  pool: new Map(),

  // ---- 创建 / 销毁 ----
  // Step2 收口：所有 media 元素的 createElement 只发生在 PlayerManager 内部（_createElement）。
  // 外部（_setVisualContent / renderPreview）只调用 PlayerManager.create(mtype, parent, layerKey) 拿元素，
  // 不再直接 document.createElement('video'/'audio')。类型特有属性（src/muted/playsInline）仍由调用方设置，
  // 以保证行为零变化、可回滚。
  create(mtype, parent, layerKey) {
    return this._createElement(mtype, parent, layerKey);
  },
  _createElement(mtype, parent, layerKey) {
    const el = document.createElement(mtype === "video" ? "video" : "audio");
    // Round C：seek 中不打标，避免读到脏 currentTime 抢置媒体时钟
    el.onplaying = () => { if (!el.seeking) mediaClockReady = true; console.log("[mediaEvent]", layerKey, "playing"); };
    // Round F4：媒体元素 error 后尝试 reload 恢复（video/audio 共用同一恢复路径）
    el.addEventListener("error", () => _tryReloadMedia(el, mtype, layerKey), { once: true });
    parent.appendChild(el);
    return el;
  },
  // 销毁：Phase C（2026-08-16）实现 —— 跨段重建的基石。
  // 元素在 previewState.visualEls/audioEls（pool 是死代码），key 形如 "video:0"（轨级）。
  // 纪律：pause → 清 src → load() 复位解码状态（消灭 WebView2 状态残留）→ 从 DOM 移除 → 从 map 删除。
  // C.5（2026-08-16）：destroy 必须**双槽全清**——active(el) + prepare 后台槽一起销毁，
  // 否则 prepare 槽残留旧元素会在切段时抢显示/占内存（MediaSlot 池纪律）。
  destroy(key) {
    const rec = previewState.visualEls.get(key) || previewState.audioEls.get(key);
    if (!rec) return;
    // Active 槽
    if (rec.el) this._destroyWrap(rec.el);
    // Prepare 后台槽（C.5）
    if (rec.prepare) this._destroyWrap(rec.prepare);
    if (previewState.visualEls.get(key) === rec) previewState.visualEls.delete(key);
    else if (previewState.audioEls.get(key) === rec) previewState.audioEls.delete(key);
  },
  // C.5：销毁单个 wrap（内部 video/audio 元素复位 + 移除）。双槽共用。
  _destroyWrap(wrap) {
    if (!wrap) return;
    const el = wrap.firstElementChild || wrap;
    try { if (el.pause) el.pause(); } catch (e) {}
    // 关键：清 src + load() 触发元素彻底复位（不带 src 的 load 会终止解码，不触发 error 恢复链）
    try { el.removeAttribute("src"); } catch (e) {}
    try { if (el.load) el.load(); } catch (e) {}
    // 移除前清事件引用，防泄漏（onplaying/error 链在新元素上重建）
    try { el.onplaying = null; el.onseeked = null; el.oncanplay = null; el.onloadedmetadata = null; } catch (e) {}
    try { wrap.remove(); } catch (e) {}
  },

  // ---- 播放控制（Step 4：play/pause/全局静音逻辑已收口进 Player；顶层 playAllMedia/pausePlay/toggleMute 退化为薄包装）----
  // 原 playAllMedia()：播放所有命中媒体（点击手势 / sticky-activation 跨段上下文内调用）
  play(reason = _PLAY_REASON.START) {
    const now = performance.now();
    if (now - _lastPlayAll < 250) return;   // 防抖：250ms 内不重复整批 play
    _lastPlayAll = now;

    // ① 先选 targets（resolveHits 仅用于「选谁参与」，绝不用于解静音 —— GPT v2.1 必改）
    const hits = resolveHits(Store.state.playheadUs);
    const activeKeys = new Set(hits.map(h => h.key));
    const targets = [];
    for (const [, rec] of previewState.visualEls) {
      if (rec.el.style.display === "none") continue;
      const v = rec.el.firstElementChild;
      if (v && v.tagName === "VIDEO") {
        const ti = parseInt((rec.key || "video:0").split(":")[1], 10) || 0;
        if (!activeKeys.has(rec.key)) { if (!v.paused) { v.pause(); setMediaMute(v, true, "inactive-park", rec.key); } continue; }  // E④：非命中轨停车静音
        targets.push({ el: v, rec, type: "video", ti, key: rec.key, want: wantSound("video", ti) });
      }
    }
    for (const [, rec] of previewState.audioEls) {
      const ti = parseInt((rec.key || "audio:0").split(":")[1], 10) || 0;
      if (!activeKeys.has(rec.key)) { if (!rec.el.paused) { rec.el.pause(); setMediaMute(rec.el, true, "inactive-park", rec.key); } continue; }  // E④
      targets.push({ el: rec.el, rec, type: "audio", ti, key: rec.key, want: wantSound("audio", ti) });
    }

    // ② 空则直接返回（不建 session、不废旧事务 —— GPT v2.2 钉子3）
    // 关键：此处**不能**设 isPlaying=false。gap 期间 _handleCrossSegment(L1885)/playTick重试(L1905)
    // 也会强制调 play()，若在此关掉 isPlaying，播放头会卡在段尾。正确行为：gap 处不启动任何媒体，
    // 但保留 isPlaying，让 playTick 沿墙钟自然穿过空白到下一段再建 session。
    if (targets.length === 0) return;

    // ③ 跨段交接（HANDOFF）：复用当前 session，不 cancel+createSession 重建、不重静音全体，
    // 仅对每个 target 调 _attemptPlay（其 !el.paused 早返守卫保证已在播元素不被重静音；src 被换导致
    // reload 变 paused 的元素会被正确重起播）。详见 _handoff。
    if (reason === _PLAY_REASON.HANDOFF && currentSession && currentSession.isCurrent()) {
      this._handoff(currentSession, targets);
      return;
    }

    // ④ 冷启动（START / 无当前事务）：取消旧事务 → id++ → 建新事务（Step A：PlaySession 状态层落地）
    unlockAudio();   // B.5：冷启动首行补手势级音频解锁（startPlay 已调，这里兜底 playTick 800ms 重试路径）
    if (currentSession && currentSession.isCurrent()) currentSession.cancel();
    const session = createSession(targets);
    this.start(session);
  },
  // Step B：start 只负责编排状态机 + 调起播入口，不碰媒体动作细节（钉子3：_attemptPlay 是唯一 el.play 出口）。
  // 关键纪律：play() promise 的 reject 不再在 start 内散落处理；AbortError 统一经 _scheduleRecover→continueStart 恢复。
  start(session) {
    session.state = PLAY_SESSION_STATE.STARTING;
    for (const t of session.targets) this._attemptPlay(session, t);  // 唯一起播出口
    session.state = PLAY_SESSION_STATE.MUTED_PLAYING;
    console.log("[PlaySession]", session.id, session.state, session.targets.length, session.autoplayUnlockPending, "token=" + session.recoverToken, "reason=start");
  },
  // Step B 核心：continueStart 复用 start 的启动序列，绝不复制 start 内部逻辑（防第二套 PlayerManager）。
  // 仅重走 _attemptPlay + 解锁链；只对仍 paused 的 target 重新起播（_attemptPlay 内部跳过已播）。
  continueStart(session) {
    if (!session.isCurrent()) return;
    if (session.state === PLAY_SESSION_STATE.CANCELLED || session.state === PLAY_SESSION_STATE.ENDED) return;
    session.state = PLAY_SESSION_STATE.STARTING;
    for (const t of session.targets) this._attemptPlay(session, t);
    session.state = PLAY_SESSION_STATE.MUTED_PLAYING;
    console.log("[PlaySession]", session.id, session.state, session.targets.length, session.autoplayUnlockPending, "token=" + session.recoverToken, "reason=continueStart");
  },
  // Step B.5 媒体激活契约：跨段交接（handoff 非 reboot）。
  // 核心：复用 currentSession，不 cancel+createSession，不重静音已在播元素。
  // 对每个 target 调 _attemptPlay —— 其 !el.paused 早返守卫保证「已在播元素不被重静音」（不会到 el.muted=true）；
  // src 被换导致 reload 变 paused 的元素会被正确重起播 + 重新进入激活门。
  // 失活元素已在 ① 选择阶段 pause+muted，这里仅更新 session.targets（activation map 保留既有元素状态）。
  // 纪律：不碰 start / continueStart / _scheduleRecover / _onStartError（B 红线）。
  _handoff(session, targets) {
    // B.5.4-4：仅打印 target diff（枚举不反向控制行为，防未来回归）
    const oldKeys = new Set((session.targets || []).map(t => t.key));
    const newKeys = new Set(targets.map(t => t.key));
    for (const t of targets) console.log("[target diff]", t.key, oldKeys.has(t.key) ? MEDIA_TARGET_STATE.ACTIVE : MEDIA_TARGET_STATE.ENTERING);
    for (const k of oldKeys) if (!newKeys.has(k)) console.log("[target diff]", k, MEDIA_TARGET_STATE.LEAVING);
    for (const t of targets) this._attemptPlay(session, t);   // 增量：已在播的走早返不动，paused 的重起播
    session.targets = targets;                                // 更新 target 列表（不重置 activation map 既有状态）
    session.state = PLAY_SESSION_STATE.MUTED_PLAYING;
    console.log("[PlaySession]", session.id, session.state, session.targets.length, session.autoplayUnlockPending, "token=" + session.recoverToken, "reason=handoff");
  },
  // 钉子3：唯一 el.play() 入口，纯媒体动作，不碰 state / 不写 restore / 不分类错误。
  // B.5：移除 120ms 裸兜底，改为「先等媒体 ready → 再 play → 再等 playing → 最后整批解 mute」。
  // 若 el.readyState < 2 就直接 play，浏览器可能因数据不足让 play() pending/失败，表现为首次播放画面不动。
  _attemptPlay(session, t) {
    const { el } = t;
    if (!el) return;
    this._initActivation(session, t);          // 确保 record 存在（并清理该 key 的旧监听/timer）
    console.log("[attemptPlay]", t.key, "paused=" + el.paused, "readyState=" + el.readyState, "cur=" + (el.currentTime || 0).toFixed(3), "seekTarget=" + (el._seekTarget == null ? "-" : el._seekTarget.toFixed(3)));
    if (!el.paused) {
      // B.5.5-1：paused=false ≠ playing（WebView2 seek+play+pause+复用元素常见：paused=false 但 decoder 停摆）。
      // 若元素 seek 未落位（_seekTarget 与 currentTime 偏差>50ms），说明跨段/重播复用、未真正进入播放 pipeline，
      // 不信任早返，fallthrough 走 _playWhenReady 重新起播（re-activate）。
      const seekTarget = el._seekTarget;
      const seekPending = seekTarget != null && Math.abs((el.currentTime || 0) - seekTarget) > 0.05;
      if (!seekPending) {
        // 已在播（如 continueStart 时未停的 target）：直接确认，避免 _checkAllActivated 卡在 WAITING
        this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
        console.log("[media-confirm]", t.key, "method=EARLY_RETURN");
        return;
      }
      console.log("[media-confirm]", t.key, "method=REACTIVATE", "ct=" + (el.currentTime || 0).toFixed(3), "seekTarget=" + seekTarget.toFixed(3));
      // fallthrough → B.5.1 预 ready gate → _playWhenReady 重新起播
    }

    // B.5.1 预 ready gate：等媒体至少有当前帧数据（HAVE_CURRENT_DATA，readyState>=2）再 play，
    // 否则 play() 可能在 HAVE_NOTHING/HAVE_METADATA 阶段就 pending，导致画面迟迟不动。
    if (el.readyState >= 2 || el.error) {
      this._playWhenReady(session, t);
      return;
    }

    // 未 ready：监听 canplay/canplaythrough/error，就绪后再 play；timeout 兜底仍尝试 play（避免坏轨永远卡死）。
    let readyTimer = null;
    const onReady = () => {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      this._playWhenReady(session, t);
    };
    const onError = () => {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      // error 状态下 play() 通常也会失败，走 _onStartError 路径处理（含 _tryReloadMedia）
      this._playWhenReady(session, t);
    };
    el.addEventListener("canplay", onReady, { once: true });
    el.addEventListener("canplaythrough", onReady, { once: true });
    el.addEventListener("error", onError, { once: true });
    readyTimer = setTimeout(() => {
      console.warn("[PlaySession]", session.id, "READY_GATE_TIMEOUT", t.key, "readyState=" + el.readyState, "token=" + session.recoverToken);
      onReady();   // 超时仍尝试 play，激活门后续会走 TIMEOUT_DEGRADED 兜底
    }, MEDIA_ACTIVATION_TIMEOUT);
  },

  // B.5.2 真正发起 play + 绑定激活信号（playing / canplaythrough / timeout）。
  // 从 _attemptPlay 拆出，保证等媒体 ready 后才进入。
  // B.5.5 修复（用户拍板 2026-08-15）：改 async，起播前先确认 seek 落位（target 级，不全局 await）。
  async _playWhenReady(session, t) {
    const { el } = t;
    if (!session.isCurrent()) return;
    if (!el || el.paused === undefined) return;
    if (!el.paused) {
      this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
      return;
    }
    // 起播前 seek 确认：v1.4.1 是全局 await seek 再 play（媒体慢拖死播放头），
    // 这里只对当前 target 确认（_waitSeekSettled 80ms 轮询 + 700ms 安全网），
    // 确认期间挂 _seekConfirmKeys 让 drift 不打断（修"seek/play/drift 每帧自我震荡"）。
    // 2026-08-16 真机修复（v3）：**WebView2 只在 readyState<2（未加载完）时吞 currentTime 赋值**——
    // 跨段重建的新元素在 readyState=1 时被 seek 后，play() 不会应用被吞的位置（日志实锤：
    // [seek] to=5.524 ready=1 → [playAFTER] cur=0.002 从 0 起播）。正确顺序：
    // ①元素 canplay（readyState>=2，renderPreview pendingSeek 已保证）
    // ②play 前重设 currentTime（此刻 readyState>=2 赋值生效）
    // ③play 从正确位置起播。_waitSeekSettled 仍保留给 seekBarrier（无调用点）。
    if (el._seekTarget != null && el.readyState >= 2) {
      try {
        if (Math.abs((el.currentTime || 0) - el._seekTarget) > 0.05) { el.currentTime = el._seekTarget; el._lastSeekAt = performance.now(); }   // 关键：play 前重设，此刻生效
      } catch (e) {}
    }
    setMediaMute(el, true, "play-mute", t.key);   // (A) 静音起播，等激活门全部确认才解
    console.log("[playReq]", t.key, "muted=" + el.muted, "cur=" + (el.currentTime || 0).toFixed(3), "readyState=" + el.readyState);
    // 1. playing 事件（最高优先级）→ 经 _onMediaPlaying seam 标记确认
    const onPlaying = () => { console.log("[mediaEvent]", t.key, "playing"); this._onMediaPlaying(session, t); };
    el.addEventListener("playing", onPlaying, { once: true });
    // 2. canplaythrough / canplay / loadeddata 辅助信号（WebView2 下 <audio> 可能不 fire playing，多绑几个兜底）
    const onReady = () => { console.log("[mediaEvent]", t.key, "ready-fallback"); this._setActivation(session, t, MEDIA_ACTIVATION_STATE.READY_FALLBACK); };
    el.addEventListener("canplaythrough", onReady, { once: true });
    el.addEventListener("canplay", onReady, { once: true });
    el.addEventListener("loadeddata", onReady, { once: true });
    // 3. timeout 兜底降级（防坏轨/损坏文件死锁整体）
    const timer = setTimeout(() => this._setActivation(session, t, MEDIA_ACTIVATION_STATE.TIMEOUT_DEGRADED), MEDIA_ACTIVATION_TIMEOUT);
    const rec = session.activation.get(t.key);
    if (rec) {
      rec.timer = timer;
      rec.cleanups.push(
        () => el.removeEventListener("playing", onPlaying),
        () => el.removeEventListener("canplaythrough", onReady),
        () => el.removeEventListener("canplay", onReady),
        () => el.removeEventListener("loadeddata", onReady),
        () => clearTimeout(timer)
      );
    }
    // 预检：已 readyState>=4（如已缓冲轨）直接给 READY_FALLBACK；后续 playing 仍可升级为 PLAYING_CONFIRMED
    if (el.readyState >= 4) {
      this._setActivation(session, t, MEDIA_ACTIVATION_STATE.READY_FALLBACK);
    }
    // 实验2（2026-08-15，GPT 拍板）：play 前后完整状态打点——区分三 case：
    //   Case A: before readyState=0 + play 不 resolve → 媒体太早 play（timeout 问题）
    //   Case B: before readyState=4 + resolve + paused=false 但无声 → mute/session/target 问题
    //   Case C: reject AbortError → src/seek/play 竞争
    console.log("[playBEFORE]", t.key, "paused=" + el.paused, "readyState=" + el.readyState, "cur=" + (el.currentTime || 0).toFixed(3), "src=" + (el.currentSrc || el.src || "").slice(0, 50));
    const p = el.play();
    if (p && p.then) p.then(() => {
      console.log("[playAFTER]", t.key, "resolve", "paused=" + el.paused, "readyState=" + el.readyState, "cur=" + (el.currentTime || 0).toFixed(3));
      console.log("[playRes]", t.key, "resolved");
    });
    if (p && p.catch) p.catch(err => {
      console.log("[playAFTER]", t.key, "reject", err && err.name, "paused=" + el.paused, "readyState=" + el.readyState, "cur=" + (el.currentTime || 0).toFixed(3));
      console.log("[playRej]", t.key, err && err.name, err && err.message);
      this._onStartError(session, t, err);
    });
  },
  // 钉子4 seam（B.5 升级）：不再立即解 mute，改为标记该 target 已激活，交给 _checkAllActivated 聚合判断。
  _onMediaPlaying(session, t) {
    this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
  },
  // ---- B.5 Activation Tracker：媒体激活门 ----
  // 为每个 target 建立激活记录（清理旧 key 的监听/timer，防跨 start/continueStart 泄露）
  _initActivation(session, t) {
    const old = session.activation.get(t.key);
    if (old) {
      if (old.cleanups) old.cleanups.forEach(fn => { try { fn(); } catch (e) {} });
      if (old.timer) clearTimeout(old.timer);
    }
    session.activation.set(t.key, { state: MEDIA_ACTIVATION_STATE.WAITING, timer: null, cleanups: [] });
  },
  // 核心状态 setter：按优先级幂等更新；确认/就绪即清 timer；每次变更触发聚合检查
  _setActivation(session, t, newState) {
    const rec = session.activation.get(t.key);
    if (!rec) return;                                   // 防御性：无 record 不动作
    const order = { WAITING: 0, TIMEOUT_DEGRADED: 1, READY_FALLBACK: 2, PLAYING_CONFIRMED: 3 };
    if (order[rec.state] >= order[newState]) return;    // 已是更高/同优先级 → 忽略（不降级）
    rec.state = newState;
    if (newState === MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED ||
        newState === MEDIA_ACTIVATION_STATE.READY_FALLBACK) {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    }
    if (newState === MEDIA_ACTIVATION_STATE.TIMEOUT_DEGRADED) {
      console.warn("[PlaySession]", session.id, "ACTIVATION", t.key, "state=TIMEOUT_DEGRADED", "token=" + session.recoverToken);
    } else {
      console.log("[PlaySession]", session.id, "ACTIVATION", t.key, "state=" + newState, "token=" + session.recoverToken);
    }
    // 聚合门分流（不修改 _checkAllActivated 语义）：
    // - 冷启动（Session Gate）：autoplayUnlockPending=true 时，等全体脱离 WAITING 才整批解 mute（语义不变）
    // - 已解锁（Handoff Gate）：session 已解锁（autoplayUnlockPending=false）状态下，本 target 激活后
    //   单独解 mute（增量，不打扰其它已在播元素）
    if (session.autoplayUnlockPending) {
      this._checkAllActivated(session);
    } else if (newState === MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED ||
               newState === MEDIA_ACTIVATION_STATE.READY_FALLBACK ||
               newState === MEDIA_ACTIVATION_STATE.TIMEOUT_DEGRADED) {
      if (t.el && t.el.muted) {
        setMediaMute(t.el, !(t.want && !previewMuted), "activation-handoff", t.key);
        console.log("[PlaySession]", session.id, "HANDOFF_UNMUTE", t.key, "state=" + newState, "token=" + session.recoverToken);
      }
    }
  },
  // 辅助信号：canplaythrough / readyState>=4（中可信度，可被 playing 升级）
  _onMediaReady(session, t) {
    this._setActivation(session, t, MEDIA_ACTIVATION_STATE.READY_FALLBACK);
  },
  // 兜底信号：超时降级（保证不永久等待，坏轨不拖死整体）
  _onActivationTimeout(session, t) {
    this._setActivation(session, t, MEDIA_ACTIVATION_STATE.TIMEOUT_DEGRADED);
  },
  // 聚合判断：当且仅当所有 target 均已脱离 WAITING，才整批解 mute
  _checkAllActivated(session) {
    if (!session.isCurrent()) return;
    if (!session.autoplayUnlockPending) return;          // 已 restore，幂等
    if (session.state === PLAY_SESSION_STATE.PAUSED ||
        session.state === PLAY_SESSION_STATE.CANCELLED ||
        session.state === PLAY_SESSION_STATE.ENDED) return;
    for (const t of session.targets) {
      const rec = session.activation.get(t.key);
      if (!rec || rec.state === MEDIA_ACTIVATION_STATE.WAITING) return;
    }
    this._restoreSession(session);
  },
  // 整批解 mute（替代 B 阶段逐 target 解）：所有 target 激活后才统一放开声音
  _restoreSession(session) {
    if (!session.isCurrent() || !session.autoplayUnlockPending) return;
    session.autoplayUnlockPending = false;
    session.state = PLAY_SESSION_STATE.PLAYING;
    for (const t of session.targets) {
      setMediaMute(t.el, !(t.want && !previewMuted), "activation-restore", t.key);           // want=true 且用户没静音才解
    }
    this._cleanupAllActivation(session);                 // 解 mute 后清理监听/timer，防泄露
    console.log("[PlaySession]", session.id, session.state, session.targets.length, session.autoplayUnlockPending, "token=" + session.recoverToken, "reason=activationGate");
  },
  // 清理全部 target 的激活监听与 timer（restore/pause 时调用）
  _cleanupAllActivation(session) {
    if (!session.activation) return;
    for (const rec of session.activation.values()) {
      if (rec.cleanups) rec.cleanups.forEach(fn => { try { fn(); } catch (e) {} });
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    }
  },
  // Step B：play() promise 错误分类入口（集中收口，消灭 start 内散落 catch 第二套逻辑）。
  _onStartError(session, t, err) {
    const name = (err && err.name) || "Error";
    if (name === "AbortError") {
      // seek/play 竞态（跨段边 seek 边 play），非致命：统一经 _scheduleRecover→continueStart 恢复（不再裸 play）。
      this._scheduleRecover(session, t);
    } else if (name === "NotSupportedError") {
      // B 边界：NotSupportedError 不归 B 处理，原样移交 _tryReloadMedia（Step C 才收口 reload）。
      console.warn("[play] 媒体不可解码，尝试 reload:", t.rec.key, err);
      _tryReloadMedia(t.el, t.type, t.rec.key || (t.type + ":" + t.ti));
    } else {
      console.warn("[play] 播放错误:", name, t.rec.key, err);
      showFatal("⚠ 播放错误(" + (t.rec.key || t.type) + ")：" + name + " — 详见控制台");
    }
  },
  // 钉子1：恢复调度。recoverToken 自增防竞态；窗口化配额；超时后回调校验 token + canContinue 才续。
  _scheduleRecover(session, t) {
    if (!session.isCurrent() || session.state === PLAY_SESSION_STATE.CANCELLED) return;
    const now = performance.now();
    if (session.lastRecoverAt && now - session.lastRecoverAt > RECOVER_WINDOW_MS) session.recoverCount = 0; // 窗口外清零
    if (session.recoverCount >= RECOVER_CAP) {
      console.warn("[PlaySession] 恢复配额耗尽，放弃:", session.id, "token=" + session.recoverToken);
      return;
    }
    const token = ++session.recoverToken;   // 每次调度自增，旧 setTimeout 回调见 token 不等即作废
    session.state = PLAY_SESSION_STATE.RECOVERING;
    setTimeout(() => {
      if (token !== session.recoverToken) return;        // 钉子1：旧恢复天然作废（新事务/新调度/暂停后旧回调）
      if (!session.canContinue()) return;                // RECOVERING + 当前 + 未逾限
      session.lastRecoverAt = performance.now();
      session.recoverCount++;
      this.continueStart(session);                       // 复用启动序列
    }, 60);
  },
  // 原 pausePlay()：暂停整个播放会话
  pause() {
    isPlaying = false;
    if (playRAF) { cancelAnimationFrame(playRAF); playRAF = null; }
    if (currentSession && currentSession.isCurrent()) {   // Step A 验证：记录暂停态（pause 属 PlayerManager，可改 session 状态）
      currentSession.userPaused = true;
      currentSession.state = PLAY_SESSION_STATE.PAUSED;
      this._cleanupAllActivation(currentSession);          // B.5：清理激活监听/timer，防暂停后旧回调误触发
      console.log("[PlaySession]", currentSession.id, currentSession.state, currentSession.targets.length, currentSession.autoplayUnlockPending, "token=" + currentSession.recoverToken, "reason=pause");
    }
    $("playBtn").textContent = "▶";
    for (const rec of previewState.visualEls.values()) {
      const v = rec.el.firstElementChild;
      if (v && v.pause) v.pause();
    }
    for (const rec of previewState.audioEls.values()) {
      rec.el.pause();
    }
  },
  // B.5.4-3：暂停→恢复（复用 PAUSED session，不 cancel/create，不重跑激活全量）。
  // 语义：PAUSED→PLAYING，区别于跨段 HANDOFF。绝不改 timeline/播放头所有权。
  resume(reason = _PLAY_REASON.RESUME) {
    if (!currentSession || !currentSession.isCurrent() || currentSession.state !== PLAY_SESSION_STATE.PAUSED) return false;
    unlockAudio();
    isPlaying = true;
    playStartWall = performance.now();
    playStartUs = Store.state.playheadUs;
    mediaClockReady = false;
    _mcrWaitAt = 0;
    $("playBtn").textContent = "⏸";
    const hits = resolveHits(Store.state.playheadUs);
    const activeKeys = new Set(hits.map(h => h.key));
    const targets = [];
    for (const [, rec] of previewState.visualEls) {
      if (rec.el.style.display === "none") continue;
      const v = rec.el.firstElementChild;
      if (v && v.tagName === "VIDEO") {
        const ti = parseInt((rec.key || "video:0").split(":")[1], 10) || 0;
        if (!activeKeys.has(rec.key)) { if (!v.paused) { v.pause(); setMediaMute(v, true, "inactive-park", rec.key); } continue; }
        targets.push({ el: v, rec, type: "video", ti, key: rec.key, want: wantSound("video", ti) });
      }
    }
    for (const [, rec] of previewState.audioEls) {
      const ti = parseInt((rec.key || "audio:0").split(":")[1], 10) || 0;
      if (!activeKeys.has(rec.key)) { if (!rec.el.paused) { rec.el.pause(); setMediaMute(rec.el, true, "inactive-park", rec.key); } continue; }
      targets.push({ el: rec.el, rec, type: "audio", ti, key: rec.key, want: wantSound("audio", ti) });
    }
    if (hits.length > 0 && targets.length === 0) return false;   // 期望有媒体却无（元素可能已释放）→ 降级 startPlay
    primeMediaPlayback(hits).catch(() => {});          // 手势内预热（临时元素，fire-and-forget 安全，不碰真实元素）
    seekActiveMediaToPlayhead(Store.state.playheadUs, true); // 按当前播放头重定位（恢复：音频基准变了，reanchorAudio=true）
    currentSession.targets = targets;                  // 复用既有 session，更新 target 列表（不重置 activation map）
    currentSession.state = PLAY_SESSION_STATE.STARTING;
    currentSession.autoplayUnlockPending = true;        // 恢复也走 Session 门：全体激活后整批解 mute（原 false 会跳过整批解 mute，致元素停在 WAITING 永远静音）
    for (const t of targets) this._attemptPlay(currentSession, t);  // 已在播元素走 !el.paused 早返；paused 元素重起播+重新激活
    currentSession.state = PLAY_SESSION_STATE.MUTED_PLAYING;
    // 不在此提前 _cleanupAllActivation：让 _restoreSession 在 session 门通过后统一清理（提前清理会移除激活监听，致元素卡 WAITING）
    console.log("[PlaySession]", currentSession.id, "RESUME", targets.length, "token=" + currentSession.recoverToken);
    playTick();
    return true;
  },
  // 原 toggleMute()：全局静音切换（切换语义；真正的 setMute(state) 留 Phase 3）
  setGlobalMute() {
    previewMuted = !previewMuted;
    for (const rec of previewState.visualEls.values()) {
      const v = rec.el.firstElementChild;
      if (v && v.tagName === "VIDEO") {
        const layerKey = rec.key || "";
        const trackMuted = layerKey.startsWith("video:") ? isTrackMuted("video", parseInt(layerKey.split(":")[1], 10)) : false;
        setMediaMute(v, previewMuted || trackMuted, "render-preview", layerKey);
      }
    }
    // Phase C-2：audioEls 已空（audio 轨交给 AudioEngine），旧循环跳过；改为同步 AudioEngine 全局静音
    try { AudioEngine.setGlobalMuted(previewMuted); } catch (e) {}
    updateMuteBtn();
  },
  // L2-13：全局预览音量（滑块接线）。与 setGlobalMute 互斥叠加：
  // video 元素 .volume = 段音量(seg.volume，存于 wrap.dataset.vol) * previewVolume；
  // audio 轨交给 AudioEngine，走 globalVolume 增益层。
  setGlobalVolume(v) {
    previewVolume = Math.max(0, Math.min(1, v));
    for (const rec of previewState.visualEls.values()) {
      const el = rec.el.firstElementChild;
      if (el && el.tagName === "VIDEO") {
        // 读取该段既有段级音量作为基底（渲染时写入 wrap.dataset.vol），乘上预览音量
        const base = parseFloat((rec.el.dataset && rec.el.dataset.vol) || "1") || 1;
        el.volume = Math.min(1, Math.max(0, base * previewVolume));
      }
    }
    try { AudioEngine.setGlobalVolume(previewVolume); } catch (e) {}
    updateVolumeBtn();
  },
  // 兼容壳阶段代理名（无外部调用，仅保底）
  setMute() { return this.setGlobalMute(); },

  // ---- 定位 ----
  // 收口：原 PlayerManager.seek(el, seg, us) 已迁入本方法（行为零变化）。
  // 单元素 seek，含 timeline→source 换算：seg 可能只引用原素材一段（src_start~src_end），
  // split/trim 后 start 会变，源内实际起止由 src_start/src_end 决定。
  seek(el, seg, us) {
    const srcStartUs = seg.src_start || 0;
    // 2026-08-17 根治：源终点推导（(srcEnd-srcStart)/speed == duration 不变量，防 trim 脏 src_end 失同步）
    // C1.2：speed 走 getProperty（params → legacy fallback）
    const speed = (typeof getProperty === "function") ? getProperty(seg, "speed.rate") : (seg.speed || 1);
    const srcEndUs = deriveSrcEndUs(srcStartUs, seg.duration || 0, speed);
    // 1c（2026-08-22）：HTMLMediaElement 必须显式设 playbackRate，否则 speed≠1 时视频按 1x 播（仅覆盖源前半段），
    // 与导出变速（rate 语义）不一致（审计 R 点2）。配合现有 t=srcStart+localUs 公式即正确。
    try { el.playbackRate = Math.max(0.0625, Math.min(16, speed || 1)); } catch (e) {}
    const localUs = Math.max(0, us - seg.start);
    // B2-A：上界必须是源绝对结束 srcEndUs（而非段时长）。旧写法对 src_start>0 的右段会反复从切点重播。
    const t = Math.max(srcStartUs / 1e6, Math.min(srcEndUs / 1e6, (srcStartUs + localUs) / 1e6));
    // 2026-08-19 降噪：原日志无条件打印 → 播放头静止时每帧 RAF 调 seek 同位置 → 控制台刷屏。
    // 只在「确实要写 currentTime」（含 readyState<2 记录 pending 目标）时才打。
    const needWrite = (el.readyState < 2) || Math.abs((el.currentTime || 0) - t) > 0.05;
    // DIAG-2026-08-16：打印换算用的段字段（排查"to=时间轴秒"疑点——若 seg.start/src_start 为 0 则前端 draft 是旧数据）
    if (needWrite) console.log("[seek]", el.tagName || "?", "to=" + t.toFixed(3), "cur=" + (el.currentTime || 0).toFixed(3), "ready=" + el.readyState, "seg{start=" + ((seg.start || 0) / 1e6).toFixed(1) + " ss=" + (srcStartUs / 1e6).toFixed(1) + " se=" + (srcEndUs / 1e6).toFixed(1) + "} us=" + (us / 1e6).toFixed(3));
    // 2026-08-16 真机修复（v3）：readyState<2 时**跳过赋值**——WebView2 此刻设 currentTime 必被吞（日志实锤：
    // seek to=5.524 ready=1 → play 从 0 起播）。seek 只记录目标（_seekTarget），由 renderPreview pendingSeek
    // （canplay 后）或 _playWhenReady（play 前 readyState>=2 重设）真正落位。
    if (el.readyState < 2) { el._seekTarget = t; return; }
    try {
      if (Math.abs((el.currentTime || 0) - t) > 0.05) { el.currentTime = t; el._lastSeekAt = performance.now(); }   // 静默期起点：seek 后 1s 内 drift 不碰（2026-08-16 真机修复）
    } catch (e) {}
    // Round F2：把目标时间挂在元素上，供 _waitSeekSettled 验证 seek 是否真正落位（WebView2 下 seeked 可能提前触发）。
    el._seekTarget = t;
  },

  // B.5.5-hotfix（GPT 拍板 2026-08-15）：seekBarrier = 事务 seek（元素级 pause→seek→wait→resume）。
  // 仅允许在事务路径调用（startPlay 起播前 / handoff 跨段 / 用户拖动），**drift 禁用**——
  // drift 是连续控制，每帧调用会让 pause() 同步副作用把播放重启成"咚咚咚"。
  // drift 只用 PlayerManager.seek（纯软 seek，只设 currentTime）。
  // 防并发：_seekPending 期间 drift 跳过（见 correctActiveMediaDrift）。
  async seekBarrier(el, seg, us) {
    if (!el || !seg) return;
    if (el._seekPending) return;                 // 已有 barrier 在跑，跳过
    const srcStartUs = seg.src_start || 0;
    // 2026-08-17 根治：源终点推导（与 PlayerManager.seek 一致）；C1.2 speed 走 getProperty
    const srcEndUs = deriveSrcEndUs(srcStartUs, seg.duration || 0, (typeof getProperty === "function") ? getProperty(seg, "speed.rate") : (seg.speed || 1));
    const localUs = Math.max(0, us - seg.start);
    const t = Math.max(srcStartUs / 1e6, Math.min(srcEndUs / 1e6, (srcStartUs + localUs) / 1e6));
    const wasPlaying = !el.paused;
    el._seekPending = true;
    try {
      if (wasPlaying) el.pause();                // 元素级暂停（不改 PlaySession 状态）
      try { el.currentTime = t; } catch (e) {}   // paused 状态 seek（v1.4.1 证明稳定）
      el._seekTarget = t;
      await _waitSeekSettled(el);                // 等落位（80ms 轮询 + 主动重 seek + 700ms 安全网）
      if (wasPlaying) {                          // 恢复播放（元素级）
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
      }
    } finally {
      el._seekPending = false;
    }
  },

  // ---- 同步（Phase 4 才合并 drift / crossSegment / seek 的内部逻辑）----
  // 原：correctActiveMediaDrift(us) + seekActiveMediaToPlayhead(us)
  syncTimeline(us) {
    correctActiveMediaDrift(us);
    seekActiveMediaToPlayhead(us, true);   // 外部显式同步 = 重定位语义，音频重排
  },
  // 原：_handleCrossSegment(us)（async）
  handleCrossSegment(us) {
    return _handleCrossSegment(us);
  },

  // ---- 重载 / 错误 ----
  // 原：_tryReloadMedia(el, type, layerKey) —— error→load()→canplay 后 seek+play 复合操作
  reload(el, type, layerKey) {
    return _tryReloadMedia(el, type, layerKey);
  },
};
