# PlayerManager v2.2 · Step B.5：Media Activation Gate 设计稿

> **状态**：v1.2 已落码（commit 待填），在 v1.1 基础上新增：① 用户手势内 `AudioContext.resume()` 解锁页面音频输出（针对 WebView2 下 `<audio>` 比 `<video>` 更严的自动播放策略）；② `_playWhenReady` 额外监听 `canplay` / `loadeddata` 作为 `<audio>` 的激活 fallback。
> **上一篇**：`player-session-stepB-continueStart.md`（Step B v2.3 已落码，commit `9aac35a`）。
> **定位**：Step B.5 只治「媒体未真正 ready 就解 mute」导致的无声，不动 Step B 已冻结的启动事务层（`_attemptPlay` / `start` / `continueStart` / `_scheduleRecover`）。

---

## 0. 一句话定位

**把 "120ms 后默认媒体已播放" 改成 "每个 target 用 `playing → readyState → timeout` 三层信号确认激活，全部激活才解 mute"。**

---

## 1. 问题与责任归属

### 1.1 用户验收现象（Step B 后）

- 第一次点击播放：没声。
- 拖动播放头后再播：有声。
- 中间暂停 → 再播：没声。
- 从头播：有声；暂停 → 拖到 20s 处再播：没声。

### 1.2 根因

Step B 保留了 120ms 逐 target 兜底：`_attemptPlay` 在 `el.play()` 后 120ms 就调 `_onMediaPlaying` 解 mute。但 WebView2/Chrome 音频管线常有"已 play 但解码器尚未输出"的延迟；120ms 对冷启动/seek 后重定位往往不够，导致**状态机以为在播、实际没声**。

拖动后"有声"是因为拖动过程中媒体已被 seek/预读，解码器预热完成；暂停后再播"没声"是因为每次 `start()` 都会重置 `autoplayUnlockPending=true` 并重新等激活信号，但旧逻辑 120ms 提前解锁未等真实 ready。

### 1.3 责任层

- **Step B 已收口**：启动失败后的恢复路径（AbortError→RECOVERING→continueStart）。
- **Step B.5 收口**：媒体真正 ready 之前的等待策略（Media Activation Gate）。
- 两者边界清晰，B.5 不触碰 B 的接口契约。

---

## 2. 设计目标

1. 首次导入新素材后第一次播放有声。
2. seek 到任意位置后起播有声。
3. 暂停后再播有声。
4. 不破坏 Step A/B 战果：gap 不卡、seek 任意起播、暂停再播不回归、AbortError 恢复路径仍走 continueStart。
5. 单坏轨（损坏/纯静音/永不 playing）不拖死整体解锁。

---

## 3. 接口边界（B.5 与 B 的契约）

| 组件 | B.5 是否改动 | 说明 |
|---|---|---|
| `PLAY_SESSION_STATE` | ❌ | 8 态枚举不动。 |
| `createSession` | ⚠️ 仅新增字段 | 加 `activation: Map<key, ActivationRecord>`，纯状态容器。 |
| `PlayerManager.start()` | ❌ | 只调用 `_attemptPlay`，不改动。 |
| `PlayerManager.continueStart()` | ❌ | 只调用 `_attemptPlay`，不改动。 |
| `PlayerManager._attemptPlay()` | ⚠️ 内部扩展 | 保留"唯一 el.play 出口 / 纯媒体动作"纪律；扩展激活追踪初始化（绑 `playing`/`canplaythrough` + timeout + readyState 预检）。 |
| `PlayerManager._onStartError()` | ❌ | 错误分类不动。 |
| `PlayerManager._scheduleRecover()` | ❌ | 恢复调度不动。 |
| `PlayerManager._onMediaPlaying()` | ✅ 核心改动 | 从"立即 restore"升级为"标记激活 + 聚合检查"。这是 Step B 钉子4 预留的 seam。 |

---

## 4. Activation Tracker 设计

### 4.1 每个 target 的激活态枚举

```javascript
const MEDIA_ACTIVATION_STATE = Object.freeze({
  WAITING:            "WAITING",            // 已发起 play，尚未收到任何激活信号
  PLAYING_CONFIRMED:  "PLAYING_CONFIRMED",  // 收到真实 playing 事件（最高优先级）
  READY_FALLBACK:     "READY_FALLBACK",     // 收到 canplaythrough / readyState>=4（辅助信号）
  TIMEOUT_DEGRADED:   "TIMEOUT_DEGRADED",   // 超过 MEDIA_ACTIVATION_TIMEOUT 仍未激活，降级放行
});
```

### 4.2 Session 侧新增状态

在 `createSession` 中：

```javascript
activation: new Map(), // key = t.key, value = { state, timer, cleanups }
```

`ActivationRecord` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | `MEDIA_ACTIVATION_STATE` | 当前激活态。 |
| `timer` | `number\|null` | timeout 句柄，restore 时统一清理。 |
| `cleanups` | `Array<()=>void>` | 解除事件监听/clearTimeout 的回调数组。 |

### 4.3 信号优先级与状态转移

```
WAITING ──playing──► PLAYING_CONFIRMED
     │
     ├──canplaythrough/readyState>=4──► READY_FALLBACK
     │
     └──timeout(1000ms)──► TIMEOUT_DEGRADED
```

- 优先级：`PLAYING_CONFIRMED > READY_FALLBACK > TIMEOUT_DEGRADED > WAITING`。
- 幂等：收到低优先级信号时，若已是高优先级则忽略；同优先级也忽略。
- 不降级：一旦 `PLAYING_CONFIRMED`，不会因为后续 seek 等变回 `WAITING`（session 生命周期内 target 不变时如此；跨段更新 targets 属 Step D）。

### 4.4 四层信号定义

| 信号 | 触发条件 | 可信度 | 备注 |
|---|---|---|---|
| `AUDIO_UNLOCK` | 用户手势内 `audioCtx.resume()` | 全局 | WebView2/CEF 对 `<audio>` 的自动播放策略比 `<video>` 更严，需在用户手势内主动解锁页面音频输出；不实际用 WebAudio 处理音频。 |
| `PRE_READY_GATE` | `el.readyState >= 2` 或收到 `canplay`/`canplaythrough`/`error` | 前置 | 在真正调用 `el.play()` 之前必须满足；防止 HAVE_NOTHING 阶段 play() pending/失败导致画面不动。 |
| `PLAYING_CONFIRMED` | 元素 `playing` 事件 | 最高 | 浏览器确认媒体真正开始播放。 |
| `READY_FALLBACK` | `canplaythrough` / `canplay` / `loadeddata` 事件或调用时 `readyState >= 4` | 中 | 数据已缓冲到可连续播放，但不等于音频输出已启动；WebView2 下 `<audio>` 可能不 fire `playing`，用这组信号兜底。 |
| `TIMEOUT_DEGRADED` | 自 `_playWhenReady` 起超过 `MEDIA_ACTIVATION_TIMEOUT` | 兜底 | 保证不会永久等待；坏轨/损坏文件走此分支。 |

**为什么不只用 `Promise.all` 等全部 playing**：单坏轨（损坏/纯静音/永不 playing）会死锁整体；Activation Tracker 允许单轨降级，不拖死整体。

**为什么加 PRE_READY_GATE**：Step B.5 v1.0 落码后真机验收发现，首次播放时 `el.play()` 在 `readyState < 2` 时被调用，浏览器让 play() 长期处于 pending，画面迟迟不动。因此把 `_attemptPlay` 拆成两步：先等媒体 ready，再 play + 等 playing。

**为什么加 AUDIO_UNLOCK**：真机验收发现“视频有声音、MP3 没声音”， narrowing 到 `<audio>` 自动播放策略更严；`startPlay()` 内在调用 `playAllMedia()` 之前有两个 `await`（等 ready + 等 seek），可能耗尽用户手势上下文。在 `startPlay()` 首行同步 `audioCtx.resume()` 解锁音频输出。

### 4.5 Session 聚合判断

当且仅当 **session 当前所有 targets 的 activation.state !== WAITING** 时，触发 `_restoreSession(session)`。

即：每个 target 至少拿到一个信号（playing / readyState / timeout）才解锁。坏轨走 timeout 降级，不阻塞其他轨。

---

## 5. PlayerManager 改动清单

### 5.1 常量

与 `RECOVER_CAP` 同区新增：

```javascript
const MEDIA_ACTIVATION_TIMEOUT = 1000; // ms，独立可调
```

### 5.2 `createSession` 新增字段

```javascript
activation: new Map(), // 见 §4.2
```

### 5.3 新增/改造方法

#### `_initActivation(session, t)`

在 `_attemptPlay` 内部调用，为 target 创建 `ActivationRecord`。

- 若 `session.activation` 已有该 key，先执行旧 `cleanups` 清理旧监听/timer。
- 新建 `{ state: WAITING, timer: null, cleanups: [] }`。

#### `_setActivation(session, t, newState)`

核心状态 setter：

1. 取 record；无则 return（防御性）。
2. 按优先级比较，忽略降级/同态。
3. 更新 `record.state`。
4. 若 newState 是 `PLAYING_CONFIRMED` 或 `READY_FALLBACK`，清理该 target 的 timer（已不需要 timeout）。
5. 调用 `_checkAllActivated(session)`。

#### `_cleanupActivation(session, t)` / `_cleanupAllActivation(session)`

- restore 成功后调用 `_cleanupAllActivation`，解除所有 targets 的 `playing`/`canplaythrough` 监听并 clearTimeout。
- 避免事件泄露与旧 session 的回调在后续误触发。

#### `_onMediaPlaying(session, t)`（升级）

B 阶段 = 立即 restore；B.5 阶段改为：

```javascript
_onMediaPlaying(session, t) {
  this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
}
```

#### `_onMediaReady(session, t)`（新增）

`canplaythrough` / `readyState>=4` 的回调：

```javascript
_onMediaReady(session, t) {
  this._setActivation(session, t, MEDIA_ACTIVATION_STATE.READY_FALLBACK);
}
```

#### `_onActivationTimeout(session, t)`（新增）

```javascript
_onActivationTimeout(session, t) {
  this._setActivation(session, t, MEDIA_ACTIVATION_STATE.TIMEOUT_DEGRADED);
}
```

#### `_checkAllActivated(session)`（新增）

```javascript
_checkAllActivated(session) {
  if (!session.isCurrent()) return;
  if (!session.autoplayUnlockPending) return; // 已 restore，幂等
  if (session.state === PLAY_SESSION_STATE.PAUSED ||
      session.state === PLAY_SESSION_STATE.CANCELLED ||
      session.state === PLAY_SESSION_STATE.ENDED) return;
  for (const t of session.targets) {
    const rec = session.activation.get(t.key);
    if (!rec || rec.state === MEDIA_ACTIVATION_STATE.WAITING) return;
  }
  this._restoreSession(session);
}
```

#### `_restoreSession(session)`（新增，替代旧 `_onMediaPlaying` 中的 restore 逻辑）

```javascript
_restoreSession(session) {
  if (!session.isCurrent() || !session.autoplayUnlockPending) return;
  session.autoplayUnlockPending = false;
  session.state = PLAY_SESSION_STATE.PLAYING;
  for (const t of session.targets) {
    t.el.muted = !(t.want && !previewMuted);
  }
  this._cleanupAllActivation(session);
  console.log("[PlaySession]", session.id, session.state, session.targets.length, false, "token=" + session.recoverToken, "reason=activationGate");
}
```

### 5.4 `_attemptPlay` / `_playWhenReady` 改造

保留"唯一 el.play 出口 / 纯媒体动作"纪律，但把原 `_attemptPlay` 拆成两步：

1. **预 ready gate（`_attemptPlay`）**：若 `el.readyState < 2` 且无 error，先等 `canplay`/`canplaythrough`/`error`，避免在 HAVE_NOTHING/HAVE_METADATA 阶段就调用 `play()`。
2. **真正起播 + 激活追踪（`_playWhenReady`）**：媒体 ready 后走原三层信号逻辑（playing / canplaythrough / timeout）。

```javascript
_attemptPlay(session, t) {
  const { el } = t;
  if (!el) return;
  this._initActivation(session, t);
  if (!el.paused) {
    this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
    return;
  }
  if (el.readyState >= 2 || el.error) {
    this._playWhenReady(session, t);
    return;
  }
  // 未 ready：等 canplay/canplaythrough/error；timeout 兜底仍尝试 play
  let readyTimer = null;
  const onReady = () => { clearTimeout(readyTimer); this._playWhenReady(session, t); };
  const onError = () => { clearTimeout(readyTimer); this._playWhenReady(session, t); };
  el.addEventListener("canplay", onReady, { once: true });
  el.addEventListener("canplaythrough", onReady, { once: true });
  el.addEventListener("error", onError, { once: true });
  readyTimer = setTimeout(() => onReady(), MEDIA_ACTIVATION_TIMEOUT);
}

_playWhenReady(session, t) {
  const { el } = t;
  if (!session.isCurrent() || !el || el.paused === undefined) return;
  if (!el.paused) {
    this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
    return;
  }
  el.muted = true;
  const onPlaying = () => this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED);
  el.addEventListener("playing", onPlaying, { once: true });
  const onReady = () => this._setActivation(session, t, MEDIA_ACTIVATION_STATE.READY_FALLBACK);
  el.addEventListener("canplaythrough", onReady, { once: true });
  el.addEventListener("canplay", onReady, { once: true });
  el.addEventListener("loadeddata", onReady, { once: true });
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
  if (el.readyState >= 4) {
    this._setActivation(session, t, MEDIA_ACTIVATION_STATE.READY_FALLBACK);
  }
  const p = el.play();
  if (p && p.catch) p.catch(err => this._onStartError(session, t, err));
}
```

**B 的 120ms 兜底移除**：B.5 用 Activation Gate 取代它。`_playWhenReady` 不再设置 120ms setTimeout。

---

## 6. 与 Step B 日志标准对接

沿用 `[PlaySession] <id> <STATE> <target/key> token=<n> reason=<...>`：

- `_setActivation` 中当状态变化时打印调试日志：
  ```
  [PlaySession] <id> ACTIVATION <key> state=PLAYING_CONFIRMED token=<n>
  ```
- `_restoreSession` 打印：
  ```
  [PlaySession] <id> PLAYING <n> false token=<n> reason=activationGate
  ```
- `TIMEOUT_DEGRADED` 打印 warn：
  ```
  [PlaySession] <id> ACTIVATION <key> state=TIMEOUT_DEGRADED token=<n>
  ```

---

## 7. 边界与异常

### 7.1 无 targets

`start()` 前已 `if (targets.length === 0) return;`，不进入 Activation Gate。

### 7.2 continueStart 复用

`continueStart` 仍调 `_attemptPlay(session, t)`。对已激活的 target（`!el.paused`），`_attemptPlay` 直接 `_setActivation(PLAYING_CONFIRMED)` 并返回；对仍 paused 的 target，重新初始化 activation 并重走三层信号。`_checkAllActivated` 自然处理"部分已激活、部分需重试"的情况。

### 7.3 pause / cancel / 新事务

`pause()` 将 session.state 置 `PAUSED`；`_checkAllActivated` 遇到 PAUSED 不 restore。旧 activation 的 timer 可能仍在，但 restore 不会触发；session 生命周期结束时不主动清理 timer 也无害（回调里会判断 `isCurrent()` 与 state）。

为防微内存泄露，建议 `pause()` / `cancel()` 时调用 `_cleanupAllActivation(session)`。

### 7.4 单坏轨场景

某个 target 损坏/无音频/永不 playing：1000ms 后走 `TIMEOUT_DEGRADED`，其他正常 target 的 playing/readyState 到达后，整体仍 restore。该坏轨被静音（`want` 为真也解 mute，只是它没声），不影响用户体验。

### 7.5 所有轨都 timeout

所有 targets 都 1000ms 无信号 → 全部 `TIMEOUT_DEGRADED` → `_restoreSession` 解 mute。此时播放可能仍没声，但状态机不再假 `PLAYING`，用户能看到"激活失败"类日志，便于定位文件/解码问题。

---

## 8. 验收门禁

### 8.1 语法

抽内联 JS → `node --check` 通过。

### 8.2 回归守卫

- gap 不卡段尾。
- seek 任意位置起播正常。
- 暂停 → 再播有声。
- AbortError 仍走 `_scheduleRecover → continueStart`（控制台见 `reason=continueStart`）。

### 8.3 B.5 专项

- 首次导入素材后第一次播放：有声。
- 拖动播放头到中间再播：有声。
- 暂停后再播：有声。
- 控制台 `[PlaySession]` 日志显示 `ACTIVATION` 行，最终 `PLAYING reason=activationGate`。
- 坏轨/大文件场景：1000ms 后见 `state=TIMEOUT_DEGRADED`，但不卡死整体。

### 8.4 日志示例

正常起播：
```
[PlaySession] 1 STARTING 2 true token=0 reason=start
[PlaySession] 1 ACTIVATION audio:0 state=READY_FALLBACK token=0
[PlaySession] 1 ACTIVATION video:0 state=PLAYING_CONFIRMED token=0
[PlaySession] 1 PLAYING 2 false token=0 reason=activationGate
```

---

## 9. 红线（违反即膨胀）

- ❌ 不改 `start()` / `continueStart()` / `_scheduleRecover()` / `_onStartError()` 的现有结构。
- ❌ 不在 `_attemptPlay` 里加 state 修改 / restore / 错误分类（保持 Step B 钉子3）。
- ⚠️ `AudioContext` 仅作“音频解锁钥匙”，不处理音频流、不分析音频数据。若未来要引入 Web Audio 管线，须单独评审。
- ❌ 不改 `MEDIA_ACTIVATION_TIMEOUT` 为更小值前须经真机测试（WebView2 冷启动可能需接近 1000ms）。
- ❌ 不把 `readyState>=4` 当"一定有声"的主判据（它只是辅助信号，真实 playing 优先）。

---

## 10. 与 Step C/D 的衔接

- **Step C**：reload 收口 + `_applyMediaState` + muted 写收口。B.5 的 `_restoreSession` 是"按播放事务意图解 mute"，为 C 的 `_applyMediaState` 提供单一入口雏形。
- **Step D**：crossSegment 复用 session + `updateTargets()`。B.5 的 `activation: Map` 按 `t.key` 索引，D 更新 targets 时只需清理旧 key、为新 target 初始化 activation。

---

## 11. 修订记录

- **v1.0（冻结版）**：基于实施手册 §3 与第五轮 GPT 评审，明确 Activation Tracker、activationState 枚举、三层信号优先级、与 Step B 接口边界、验收门禁。
- **v1.1（落码后热修）**：根据真机验收发现"首次播放画面不动"，把 `_attemptPlay` 拆为「预 ready gate + `_playWhenReady`」，确保 `el.play()` 不在 `readyState < 2` 时调用。
- **v1.2（音频专项）**：根据真机验收"视频有声音、MP3 没声音"，新增用户手势内 `AudioContext.resume()` 解锁页面音频输出；`_playWhenReady` 额外监听 `canplay` / `loadeddata` 作为 `<audio>` 的 fallback 激活信号。
