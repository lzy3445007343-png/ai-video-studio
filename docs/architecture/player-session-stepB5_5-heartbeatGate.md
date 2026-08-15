# Step B.5.5 — Media Start Confirmation Gate（Heartbeat Confirm，媒体启动确认门）

> 状态：**v1.2 —— 路线调整（2026-08-15 17:45 用户拍板）：本门暂停扩展，改为 STAB 止血 + B.5 收尾 + C.0 AudioEngine 迁移**。
> 日期：2026-08-15
> 上游：B.5.4 v1.1（commit `5f1d79b`）真机残留 3 问题 → GPT 黑盒评审（用户转达）→ 本稿吸收 + 适配。
> 关系：B.5.5 是 B.5 的**自然延伸**，不重写 PlayerManager / 不重做 Runtime / 不改 renderPreview。

> **v1.2 路线调整（用户拍板）**：OpenCut 对比审计（`docs/audits/opencut-vs-ours-playback.md`）确认根因——我们的播放建立在 HTMLMediaElement `play()/pause()/seek()` 之上（WebView2 最不可靠路径），OpenCut 用 Web Audio 调度 + canvas 渲染完全绕开。
> **不再往 B.5 堆 activation gate**。改为：
> 1. **STAB 止血（已完成，commit `fd763ad`）**：`startPlay` 撤掉 3 个 await 屏障（prime/ready/seek），Timeline Clock 是 master 立即启动，媒体作 follower 异步追上（恢复播放头动 + session running + 视频能播）。
> 2. **B.5 收尾**：Commit 1（`d45fdcb` `_attemptPlay` 早返守卫）保留；其余 gate 不再扩展。
> 3. **C.0 AudioEngine 迁移**（`docs/architecture/audio-engine-migration.md`）：音频迁 Web Audio（BufferSourceNode 精确调度），视频暂保持 element follower。

> **命名与职责边界（用户拍板）**：本门叫 **Media Start Confirmation Gate（媒体启动确认门）**，别名 Heartbeat Confirm。
> 它**不是健康检查、不是持续心跳监控**，职责只有一条：`play()` 发起后**确认一次**媒体真的进入播放 pipeline，给 session 一个启动事实，随后**不接管播放**。防止后续被误解扩展成"每秒检查媒体健康"的监控层（那会滑向播放器重构）。

---

## 1. GPT 评审结论（原样要点）

- B.5.4 方向没错，残留不是"激活门设计错误"，是**媒体生命周期还有两个隐藏状态没收口**：
  1. PlaySession 状态和真实 media element 状态**脱钩**；
  2. `src/currentTime/load/play` 生命周期**没有被 session 事务化**。
- 三现象（split 第二段无声 / 从头重播无声 / MP4 卡住）**80% 同源**：真实媒体元素进入"逻辑上应播放、但浏览器 decoder pipeline 没重新进入 active"的状态。
- 核心一句：**`paused=false ≠ playing`**（WebView2 seek+play+pause+play 后元素可 paused=false 但 decoder 停摆、readyState 不推进、playing 不再 fire）。
- 建议：B.5.5 Media Heartbeat Gate（3 改动）+ MediaEpoch + Clock start after media confirmation。

## 2. 我的评估（执行方）

**认同（90%）**：
- `paused=false ≠ playing` 是核心洞见，直击我们 `_attemptPlay` 早返守卫的盲区。
- "clock 在媒体确认前启动 → 播放头跑、媒体死，drift 只能 seek currentTime 救不了 decoder restart" —— **这条完美解释用户实测"播放头在跑但没声"**（截图播放头 00:02.216 在走）。
- MediaEpoch（防旧激活状态污染新播放）方向正确。
- 三处修改都在播放路径内，符合纪律。

**需适配（3 处，GPT 黑盒读码与真实代码对不上）**：
1. GPT 改 1 引用 `session.reason` —— **真实代码 session 无 reason 字段**（reason 是 `play(reason)` 的参数，未存入 session）。落地：不用 reason 判断，改用**元素 seek 落位检查**（见 §4.1）。
2. GPT 改 2"等 PLAYING_CONFIRMED 再 startClock" —— **不能只等 PLAYING_CONFIRMED**：WebView2 `<audio>` 已知不 fire playing（B.5 已用 canplaythrough/loadeddata 兜底）。落地：确认门 = 任一 target 达 **PLAYING_CONFIRMED 或 READY_FALLBACK**，或 800ms 超时降级启动（复用 playTick `_mcrWaitAt` 思路，坏轨不死锁）。
3. GPT 改 3"handoff 后 heartbeat 100-200ms" —— 可落，但超时**不放弃**，降级为对该 target 强制 re-activate（再 attemptPlay 一次）。

---

## 3. 核心设计：三层状态不再脱钩

```
PlaySession(逻辑层)  ── 现有 ──>  HTMLMediaElement(元素层)
                                     │
                          现有没验证   ▼
                              Decoder pipeline / GPU compositor(真实播放层)
```

B.5.5 在"元素层→真实播放层"之间加 **Heartbeat Gate**：不信任 `paused`，验证 `readyState` / seek 落位 / 出帧。

## 4. 三改动 + MediaEpoch（最终落地设计）

### 4.1 改 1：`_attemptPlay` 早返守卫增强（paused=false ≠ playing）
`_attemptPlay`（1367）现在：
```js
if (!el.paused) { this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED); return; }
```
改为（**不加 async，同步走 re-activate**）：
```js
if (!el.paused) {
  // B.5.5：paused=false 不信任。若 seek 未落位（元素 _seekTarget 与 currentTime 偏差>50ms），
  // 说明是跨段/重播复用元素、decoder 未重入，强制走 _playWhenReady 重新起播（re-activate）。
  const seekPending = el._seekTarget != null && Math.abs((el.currentTime || 0) - el._seekTarget) > 0.05;
  if (!seekPending) { this._setActivation(session, t, MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED); return; }
  // fallthrough → ready gate + _playWhenReady（重新 play + 绑激活事件 + timer）
}
```
- `_seekTarget` 是 `PlayerManager.seek`（1657）已挂在元素上的字段，**读它不碰渲染路径**。
- 效果：split 后同元素 seek 未落位 → 不再被"已在播"骗过 → 重走激活门。

### 4.2 改 2：`startPlay` 墙钟在媒体确认后启动（mediaStartConfirmed 门）
`startPlay`（2067）末尾现在：
```js
playAllMedia();
playTick();
```
改为：
```js
playAllMedia();
await _confirmMediaStarted();   // B.5.5：至少一个 target 达 PLAYING_CONFIRMED/READY_FALLBACK，或 800ms 超时降级
playTick();                      // 媒体确认后才启动墙钟
```
新增 `_confirmMediaStarted()`（**三态确认** + 800ms 超时降级 + `[media-confirm]` 日志）：
```js
function _confirmMediaStarted() {
  return new Promise(resolve => {
    const s = currentSession;
    if (!s || !s.isCurrent()) return resolve();
    const check = () => {
      if (!s.isCurrent()) return resolve();
      for (const [key, rec] of s.activation) {
        if (rec.state !== MEDIA_ACTIVATION_STATE.WAITING) {
          console.log("[media-confirm]", key, "method=" + rec.state, "stage=startPlay");
          return resolve();
        }
      }
      setTimeout(check, 50);
    };
    check();
    setTimeout(() => {
      console.log("[media-confirm]", "-", "method=TIMEOUT_DEGRADED", "stage=startPlay");
      resolve();
    }, 800);
  });
}
```
- **三态任一确认即放行**：`PLAYING_CONFIRMED`（真实 playing 事件，最强）/ `READY_FALLBACK`（canplaythrough/loadeddata，WebView2 `<audio>` 不 fire playing 时的现实路径）/ `TIMEOUT_DEGRADED`（800ms 兜底，坏轨不死锁）。
- **用户拍板语义**：不要为了"证明真实播放"引入死锁。B.5 原则保持——**不阻塞用户操作，但记录退化状态**。
- 效果：播放头不会在媒体确认前空跑（用户实测"播放头在跑但没声"的直接治本）。
- **只读** `session.activation`，不碰渲染。

### 4.3 改 3：`_handleCrossSegment` handoff 后强制 heartbeat
`_handleCrossSegment`（2231）现在：
```js
if (isPlaying) { _lastPlayAll = 0; playAllMedia(_PLAY_REASON.HANDOFF); }
```
改为：
```js
if (isPlaying) {
  _lastPlayAll = 0;
  playAllMedia(_PLAY_REASON.HANDOFF);
  await _confirmHandoffActivated();   // B.5.5：等新 target 激活或 150ms 超时
}
```
新增 `_confirmHandoffActivated()`：
```js
function _confirmHandoffActivated() {
  return new Promise(resolve => {
    const s = currentSession;
    if (!s || !s.isCurrent()) return resolve();
    const check = () => {
      if (!s.isCurrent()) return resolve();
      for (const rec of s.activation.values()) {
        if (rec.state === MEDIA_ACTIVATION_STATE.PLAYING_CONFIRMED ||
            rec.state === MEDIA_ACTIVATION_STATE.READY_FALLBACK) return resolve();
      }
      setTimeout(check, 30);
    };
    check();
    setTimeout(resolve, 150);   // 超时：不放弃，交给 playTick 的 mediaClockReady 重试接管
  });
}
```
- `_handleCrossSegment` 已是 async，直接 await，不阻塞 RAF（fire-and-forget 语义不变）。

### 4.4 MediaEpoch（概念落地，不碰渲染路径）
- **概念**：每次 src 改变 / resume / 跨段换源，媒体进入新"纪元"，旧激活状态不得复用。
- **落地**：不新增全局计数器贯穿渲染路径，而是：
  - 冷启动 `createSession` 天然新 session（activation map 全新，已隔离旧状态）——现有机制已覆盖；
  - 同 session 内跨段复用元素 → 由 **4.1 的 seek 落位检查**承担（`_seekTarget` 偏移即"纪元不符"信号）；
  - 渲染路径已在 src 变化时设 `dataset.pendingSeek`（2008），4.1 可额外读它增强判定（只读，不写）。
- **结论**：MediaEpoch 的核心意图由 4.1 的 seekPending 检查实现，无需新增贯穿层，避免碰渲染路径。

---

## 5. 验收用例（3 case，控制台 grep）

### Case 1：MP3 split 两段从头播
期望日志序：
```
[PlaySession] N STARTING ...
[target diff] audio:0 ENTERING/ACTIVE
[MUTE] audio -> true reason=play-mute
[seek] ... (PlayerManager.seek)
[PlaySession] N ACTIVATION audio:0 state=PLAYING_CONFIRMED/READY_FALLBACK
[MUTE] audio -> false reason=activation-restore
```
判据：跨段后第二段**不再**出现"早返 PLAYING_CONFIRMED 但无 [play]"；若出现 `heartbeat fail` 类日志 = 仍没根治。

### Case 2：MP3 从头重播
期望：先 `[confirm] media started`（或 800ms 超时降级日志）**后**播放头才开始走。
判据：播放头不再在媒体确认前空跑；暂停后从头再播有声。

### Case 3：MP4 首播
期望：`[PlaySession] ACTIVATION video:0 state=PLAYING_CONFIRMED` + 画面推进。
判据：video 不再卡帧；若仍卡，需进一步用 `requestVideoFrameCallback` 出帧验证（本轮不加，先看激活门是否真正通过）。

---

## 6. 纪律（不可破坏）

1. 不重写 PlayerManager；不重做 Runtime；不放弃 B.5。
2. **不碰渲染路径**：renderPreview / _setVisualContent / _setAudioContent / pool-create / release 一律不改（4.1 只**读** `_seekTarget`/`dataset.pendingSeek`）。
3. 不碰 MCP/pyJianYingDraft/list-of-list。
4. 不动根目录 7 个违规文件。
5. B 红线函数（start / continueStart / _scheduleRecover / _onStartError）不动。
6. 已稳定的首播 MP3（v1.4.1）不可回归。
7. 落码后 `node --check` 语法校验 → 用户真机 8 项验收 → 过才进 C/D。

---

## 7. 源码锚点

```
1367  _attemptPlay 早返守卫        → 4.1 改
1657  PlayerManager.seek 设 _seekTarget（只读）
2067  startPlay 末尾               → 4.2 改（playAllMedia 后加 await _confirmMediaStarted）
2239  playTick（mediaClockReady 重试逻辑保留）
2231  _handleCrossSegment HANDOFF  → 4.3 改
2008  dataset.pendingSeek（渲染路径，只读不写）
```

---

## 8. 一句话

**B.5.5 = 在"元素层→真实播放层"之间加 Media Start Confirmation Gate：`paused` 不再可信，用 seek 落位 + 激活确认门 + 墙钟延后启动，把 session 与真实播放状态重新对齐。三个改动都在播放路径内，最小侵入。**

---

## 9. 落地计划（用户拍板：分三 commit，按风险排序，不一次全改）

### `[media-confirm]` 日志规范（全 commit 统一）
一行可 grep：
```
[media-confirm] <key> method=<EARLY_RETURN|REACTIVATE|PLAYING_CONFIRMED|READY_FALLBACK|TIMEOUT_DEGRADED> [stage=<startPlay|handoff>]
```
用途：一眼区分「play 没成功 / activation 没成功 / 确认门没成功」三段。

### Commit 1（本轮，最高优先级）：`_attemptPlay` 早返守卫增强
- 只改 `_attemptPlay`（1367）的 `if (!el.paused)` 分支：
  - `_seekTarget` 落位检查（偏差 >50ms = seek 未落位）→ **不信任 paused=false，fallthrough 走 `_playWhenReady` 重新起播**；
  - 落位则早返 `PLAYING_CONFIRMED` + `[media-confirm] method=EARLY_RETURN`；
  - seekPending 时打 `[media-confirm] method=REACTIVATE`。
- **不要**改成"永远强制 `_playWhenReady`"（会引入 video 跨段重复 play / audio 不必要 AbortError）。
- 真机测：MP3 split 两段、MP3 从头重播。**有改善 → 继续 Commit 2。**

### Commit 2：`startPlay` 墙钟延后启动（影响最大，单独验证）
- `playAllMedia()` 后 `await _confirmMediaStarted()` 再 `playTick()`（§4.2，三态确认）。
- 改变 `isPlaying`/`playTick` 时序关系，需单独真机验证首播 MP3/MP4。

### Commit 3：`_handleCrossSegment` handoff 后确认
- HANDOFF `playAllMedia` 后 `await _confirmHandoffActivated()`（150ms 确认，超时交给 playTick `_mcrWaitAt` 接管，不阻塞 master）。
- handoff 已比之前稳定，放最后，不同时动。

### 每步纪律
落码 → `node --check` → commit → 用户真机 case → 全过才进下一步。
