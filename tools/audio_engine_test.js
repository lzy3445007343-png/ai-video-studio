/* Phase B 单元验证：mock AudioContext 测 AudioEngine 调度逻辑（不碰真实媒体）
 * 验证点：
 *  1. setAnchor/timelineToCtx 锚定换算（v1.2 时钟基准修正）
 *  2. tick 调度判定（lookahead 窗口内调度、窗外不调度、静音跳过）
 *  3. schedule 的 start 参数（offset/duration/playbackRate 换算）
 *  4. globalMuted 播放端叠加（v1.3）
 *  5. stopAll/setClips 清场重建 + epoch 竞态取消（v1.3）
 */
const { createAudioEngine } = require("./audio-engine.js");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  [PASS]", name); }
  else { fail++; console.log("  [FAIL]", name, detail || ""); }
}
const flush = () => new Promise(r => setTimeout(r, 0));

// ---- mock AudioContext ----
function makeMockCtx() {
  const sources = [];
  const ctx = {
    currentTime: 100,
    destination: {},
    createBufferSource() {
      const src = {
        buffer: null, playbackRate: { value: 1 },
        _startArgs: null, _gainNode: null, started: false, stopped: false,
        start(...args) { this._startArgs = args; this.started = true; },
        stop() { this.stopped = true; },
        connect(node) { this._next = node; return node; },
      };
      sources.push(src);
      return src;
    },
    createGain() {
      return { gain: { value: 0 }, connect() { return ctx.destination; } };
    },
    decodeAudioData: async () => ({ sampleRate: 44100, length: 1, duration: 100 }),
  };
  ctx._sources = sources;
  return ctx;
}

function mockFileURLAndFetch(engine) {
  global.fileURL = p => p;
  engine._decode = async function (path) {
    if (!path) return null;
    return { path };
  };
}

(async () => {
  console.log("== 1. 锚定换算（v1.2 时钟基准） ==");
  {
    const ctx = makeMockCtx();
    const eng = createAudioEngine(ctx);
    mockFileURLAndFetch(eng);
    eng.setAnchor(5e6);
    assert("anchorOffset = ctx - playheadUs/1e6 = 95", eng.anchorOffset === 95, "got " + eng.anchorOffset);
    assert("timelineToCtx(10s) = 105", eng.timelineToCtx(10e6) === 105, "got " + eng.timelineToCtx(10e6));
    eng.setAnchor(30e6);
    assert("重锚后 anchorOffset = 70", eng.anchorOffset === 70, "got " + eng.anchorOffset);
    assert("重锚后 timelineToCtx(10s) = 80", eng.timelineToCtx(10e6) === 80, "got " + eng.timelineToCtx(10e6));
  }

  console.log("== 2. tick 调度判定（lookahead 2s） ==");
  {
    const ctx = makeMockCtx();
    const eng = createAudioEngine(ctx);
    mockFileURLAndFetch(eng);
    eng.setAnchor(0); // 时间轴 0s = ctx 100s
    const cIn = { key: "a:0:0", path: "p1.mp3", startUs: 1.5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 1 };
    const cOut = { key: "a:0:1", path: "p2.mp3", startUs: 5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 1 };
    const cMuted = { key: "a:0:2", path: "p3.mp3", startUs: 1.7e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 0 };
    eng.clips = [cIn, cOut, cMuted];
    eng.tick();
    await flush();
    assert("窗口内 clip 被调度", cIn._scheduled === true);
    assert("窗口外 clip 不调度", !cOut._scheduled);
    assert("gain=0 静音段跳过", !cMuted._scheduled);
    const started = ctx._sources.find(s => s.started);
    assert("start 参数 [startCtx, offset, dur]", started && started._startArgs.length === 3, JSON.stringify(started && started._startArgs));
    if (started) {
      assert("startCtx = timelineToCtx(1.5s) = 101.5", Math.abs(started._startArgs[0] - 101.5) < 1e-9, started._startArgs[0]);
      assert("offset = 0", started._startArgs[1] === 0, started._startArgs[1]);
      assert("dur = 3s", Math.abs(started._startArgs[2] - 3) < 1e-9, started._startArgs[2]);
    }
  }

  console.log("== 3. 变速 duration/playbackRate 换算 ==");
  {
    const ctx = makeMockCtx();
    const eng = createAudioEngine(ctx);
    mockFileURLAndFetch(eng);
    eng.setAnchor(0);
    const cSpeed = { key: "a:0:0", path: "p.mp3", startUs: 1.5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 6e6, speed: 2, gain: 1 };
    eng.clips = [cSpeed];
    eng.tick();
    await flush();
    const started = ctx._sources.find(s => s.started);
    assert("变速 2x：src 跨度 6s / speed 2 = dur 3s", started && Math.abs(started._startArgs[2] - 3) < 1e-9, started && started._startArgs[2]);
    assert("playbackRate = 2", started && started.playbackRate.value === 2, started && started.playbackRate.value);
  }

  console.log("== 4. globalMuted 播放端叠加（v1.3） ==");
  {
    const ctx = makeMockCtx();
    const eng = createAudioEngine(ctx);
    mockFileURLAndFetch(eng);
    eng.setAnchor(0);
    eng.setGlobalMuted(true);
    const c = { key: "a:0:0", path: "p.mp3", startUs: 1.5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 0.5 };
    eng.clips = [c];
    eng.tick();
    await flush();
    const started = ctx._sources.find(s => s.started);
    assert("globalMuted=true → gain=0", started && started._gain.gain.value === 0, started && started._gain.gain.value);
    // 取消静音后已调度源即时恢复
    eng.setGlobalMuted(false);
    assert("取消静音 → gain 恢复 0.5", started && started._gain.gain.value === 0.5, started && started._gain.gain.value);
  }

  console.log("== 5. stopAll / setClips 清场重建 ==");
  {
    const ctx = makeMockCtx();
    const eng = createAudioEngine(ctx);
    mockFileURLAndFetch(eng);
    eng.setAnchor(0);
    const c1 = { key: "a:0:0", path: "p1.mp3", startUs: 1.5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 1 };
    eng.clips = [c1];
    eng.tick();
    await flush();
    assert("调度了 1 个", ctx._sources.filter(s => s.started).length === 1, ctx._sources.length);
    eng.stopAll();
    assert("stopAll 后 scheduled 清空", eng.scheduled.size === 0, eng.scheduled.size);
    assert("clip._scheduled 复位", c1._scheduled === false);
    const c2 = { key: "a:0:0", path: "p1.mp3", startUs: 11.5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 1 };
    await eng.setClips([c2], 10e6);
    await flush();
    assert("setClips 重锚 anchorOffset = 90", eng.anchorOffset === 90, eng.anchorOffset);
    assert("新 clip 被调度", c2._scheduled === true);
  }

  console.log("== 6. epoch 竞态取消（v1.3）：解码期间 stopAll 后不 start ==");
  {
    const ctx = makeMockCtx();
    const eng = createAudioEngine(ctx);
    // 自定义慢解码：手动 resolve，模拟解码进行中
    let releaseDecode;
    eng._decode = () => new Promise(r => { releaseDecode = r; });
    eng.setAnchor(0);
    const cSlow = { key: "a:0:0", path: "slow.mp3", startUs: 1.5e6, durationUs: 3e6, srcStartUs: 0, srcEndUs: 3e6, speed: 1, gain: 1 };
    eng.clips = [cSlow];
    eng.tick();                       // 触发 schedule（进入 await 解码）
    await flush();
    eng.stopAll();                    // 解码未完成就清场（epoch++）
    releaseDecode({ path: "slow.mp3" }); // 解码"完成"
    await flush();
    const started = ctx._sources.filter(s => s.started);
    assert("epoch 失效：解码完也不 start", started.length === 0, "started=" + started.length);
  }

  console.log("");
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail > 0 ? 1 : 0);
})();
