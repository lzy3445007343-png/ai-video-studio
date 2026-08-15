# Step B.5 Media Activation Contract（媒体激活契约 v1.1）

> **状态**：🟢 已冻结并**已实施**（基于 v1.0 设计稿 + GPT 第三轮评审「Approve with changes」+ 代码事实校准；commit 见版本记录）。
> **目标**：把"视频/音频统一激活协议"钉死，根治**纯音频无声**与**跨段边界掉声**两个现象，且不推翻 B.5、不重写播放器、不跳 C/D。

---

## 0. 结论先行

当前 B.5 v1.2 解决了"首次播放画面不动"（预 ready gate）和"激活门整批解 mute"。但真机验收暴露两个残余现象：

1. **纯 MP3 首次无声音**（无视频锚点时，跨段 `play()` 缺少手势级音频解锁）
2. **跨段边界掉声 / "第一段尾跳第二段头"**（每段边界 session 被拆掉重建 + 全媒体重静音）

根因不是"音视频两套逻辑"（代码已验证：video/audio 走同一 `resolveHits→seekActiveMediaToPlayhead→correctActiveMediaDrift` 路径，无 `videoTargets.length` 之类硬编码，无 `activeMedia=videos` 选择），而是：

> **`PlayerManager.play()` 在每次调用时都 `cancel()` 旧 session 并 `createSession()` 新建（源码 `play()` 冷启动分支），且 `_playWhenReady` 对每次 `_attemptPlay` 都 `el.muted=true`。**
> 该函数在 `_handleCrossSegment`（跨段）和 `playTick` 800ms 重试被反复调用，导致**每个片段边界都重建事务 + 重静音所有媒体**，音频在无手势上下文 + 自动播放策略下需要等 `TIMEOUT_DEGRADED`（1000ms）才解静音 → 边界掉声。

本稿把激活建模为**每元素持久契约**，跨段是**交接（handoff）**而非**重启（reboot）**。

---

## 1. 范围：只治 Playable Media，不碰 Timeline Render

明确两层，避免 GPT 提醒的"无限补特例"陷阱：

| 层 | 成员 | 需要激活协议？ | 说明 |
|---|---|---|---|
| **Playable Media** | `video`、`audio` | **是** | 有 `play/pause/muted/readyState`，需要 Activation Contract |
| **Timeline Render** | `image`、`text`、`effect`、`mask` | 否 | 只需按 `playheadUs` 判定 `display`/渲染态，无媒体生命周期 |

**本稿只改 Playable Media 的激活契约。image/text/effect 不在范围内（它们本就没有 playback 问题）。**

---

## 2. Media Activation Contract v1（每元素持久）

任何可播放媒体进入播放，必须满足以下状态机（与类型无关，video/audio 同合同）：

```
Target Created   →  元素已 createElement 并绑定 src
      ↓
Target Bound    →  已加入当前 session 的 targets 列表
      ↓
Target Seeked   →  currentTime 已对齐到正确源偏移（src_start + playhead 映射）
      ↓
Target Ready    →  readyState >= 2（HAVE_CURRENT_DATA）或可播放
      ↓
Target Activated→  收到 playing / canplaythrough / loadeddata / timeout 任一确认信号
      ↓
Session Unlock  →  全部 target 脱离 WAITING 后整批解 mute（冷启动） / 本 target 单独解 mute（交接）
```

**关键纪律（区别于现状）**：以上状态是**每元素持久**的。已 `Activated` 且仍在播的元素，**跨段时不得被打回 WAITING / 不得被重静音**。只有真正"新进入播放"或"切换源（reload 变 paused）"的元素才走 Created→…→Activated。

---

## 3. 核心重构：跨段 = handoff，不是 reboot

### 3.1 现状（问题）

`PlayerManager.play()` 冷启动分支（原 1289-1291）：
```
play() {
  if (now - _lastPlayAll < 250) return;          // 防抖
  const hits = resolveHits(playheadUs);
  // 选 targets（video + audio 同逻辑）
  if (currentSession?.isCurrent()) currentSession.cancel();   // 拆旧事务
  const session = createSession(targets);                    // 建新事务（autoplayUnlockPending 重置）
  this.start(session);                                       // → _attemptPlay 对每个 target 设 el.muted=true
}
```
`_handleCrossSegment`（跨段）和 `playTick` 重试都调 `playAllMedia()` → 上述逻辑 → **每段边界重建 + 重静音全体**。

### 3.2 目标（本稿 + GPT 评审修正）

`play()` 用**事务类型枚举**区分调用意图（**不**用 `play({handoff:true})` 布尔参数——避免在未来引入第二套播放逻辑分支，与 Step B「禁止复制 start」原则一致）：

```js
const _PLAY_REASON = Object.freeze({
  START:   "start",    // 用户/手势主动起播（含 playTick 800ms 重试回退）
  RECOVER: "recover",  // 启动失败恢复（经 _scheduleRecover→continueStart，当前不直传 play）
  HANDOFF: "handoff",  // 跨段交接（复用 session，不重建/不重静音全体，仅增量处理）
});
```

- **冷启动（START / 无当前事务）**：`unlockAudio()` → `cancel()` 旧 → `createSession()` 新 → `start()`（与现状同）。
- **跨段交接（HANDOFF）**：**不拆 session、不复静音全体**，复用 `currentSession`，调 `_handoff(session, targets)`。

### 3.3 `_handoff`：增量交接（不重建）

```js
_handoff(session, targets) {
  for (const t of targets) this._attemptPlay(session, t);  // 增量：依赖 _attemptPlay 的 !el.paused 早返守卫
  session.targets = targets;                               // 更新 target 列表（不重置 activation map 既有状态）
  session.state = MUTED_PLAYING;
  log reason=handoff;
}
```

**为什么对每个 target 调 `_attemptPlay` 是安全的（不重静音已在播元素）**：`_attemptPlay` 已有 `if (!el.paused) { _setActivation(PLAYING_CONFIRMED); return; }` 早返——**已在播的元素根本到不了 `el.muted=true`，因此保持 unmuted**；而 src 被换导致 reload 变 `paused` 的元素会自然走 `_playWhenReady`（重静音 + 重起播 + 重新进入激活门）。这一守卫比"active 跳过"启发式更稳，因为它正确区分了"同一元素续播"与"同元素换源需重播"两种情形。

### 3.4 聚合门分流（不修改 `_checkAllActivated` 语义）

`_setActivation` 末尾按 `session.autoplayUnlockPending` 分流：

- **冷启动（Session Gate）**：`autoplayUnlockPending === true` 时调用既有 `_checkAllActivated(session)`——等**全体** target 脱离 WAITING 才整批解 mute（语义**完全不变**）。
- **已解锁（Handoff Gate）**：`autoplayUnlockPending === false`（交接发生在已解锁的 session 上）时，本 target 一旦达到 `PLAYING_CONFIRMED / READY_FALLBACK / TIMEOUT_DEGRADED`，**单独解该 target 的 mute**（`HANDOFF_UNMUTE` 日志），不打扰其它已在播元素。

> GPT 建议的「新增 `_checkActivationBatch(batch)`」被落地为**手handoff 单元素门**（嵌在 `_setActivation` 的已解锁分支）。功能等价且更简单：跨段时其它元素已在播且已 unmuted，再整批解无意义且会打断视频。这既满足"新增 handoff 门、不动 session gate"的纪律，又避免引入第二个聚合函数造成语义分裂。

---

## 4. 纯音频无手势解锁（配合 handoff）

`unlockAudio()` 当前在 `startPlay`（用户手势内首行）调。补强：

- 在 `PlayerManager.play()` 冷启动分支首行亦调用 `unlockAudio()`（轻量、幂等，`AudioContext.resume()` 已存在），兜底 `playTick` 800ms 重试路径。
- **AudioContext 仅作"解锁钥匙"**：严格保持 `audioCtx.resume()`，**不引入** `MediaElementSource` / `AudioNode` / `destination` / 多轨混音 / gain / latency / seek sync——那是音频引擎领域，超出本稿范围。

### WebView2 措辞修正（不过拟合）

原 v1.0 文档写"video.play 解锁页面音频"，措辞过拟合。修正为：

> **video 元素更容易满足 WebView2/Chrome 自动播放策略的媒体激活条件**（基于用户手势、Media Engagement、当前 `muted` 状态、document activation 等综合判定），因此"加视频后音频才正常"是现象，根因是**纯音频在无视频锚点 + 跨段无手势上下文下，首次 `play()` 更易被静默拒绝**。解释不绑定"video 永远高级"这一错误前提。

---

## 5. 不做什么（边界）

- ❌ 不重写播放器 / 不新建 Player Runtime 架构（引擎已 Timeline 时钟驱动，无需推倒）。
- ❌ 不扩展 image/text/effect/mask 的激活逻辑（它们在 Timeline Render 层，无 playback 问题）。
- ❌ 不动 `start` / `continueStart` / `_scheduleRecover` / `_onStartError`（B 红线）。
- ❌ 不修"拉长切开片段声音异常"（那是数据模型 `src_start/src_end/duration` 未同步重算，归 C/D 的 Command 收口）。
- ❌ 不跳到 C/D：本稿是 B.5 的收尾，不是 C/D 的开始。

---

## 6. 冻结三原则（本稿核心约束，任何 B.5 后续改动不得违反）

- **Principle 1 · Session owns playback transaction**：Session 生命周期 = 用户 `play → pause → stop`，**不受 segment 数量影响**。跨段不拆 session。
- **Principle 2 · Segment switching is media handoff**：segment 的 enter/leave/replace 是**媒体交接**，不是**重启播放**。
- **Principle 3 · Activation belongs to MediaTarget**：激活状态属于**每个媒体元素**，不是"video 激活 / audio 激活"两套；video/audio 同合同。

---

## 7. 验收标准（必须全过才算 B.5 完成）

| # | 场景 | 预期 |
|---|---|---|
| 1 | 纯 MP3 首次播放（无视频） | 画面/播放头动 + 有声（不再静默拒绝） |
| 2 | 纯 MP3 切开为两段，跨段播放 | 两段都有声，**边界无 ~1s 静音**（handoff 不重静音全体） |
| 3 | 纯 MP3 拖动播放头后播 | 有声 |
| 4 | 纯 MP3 暂停后再播 | 有声 |
| 5 | 视频 + MP3 同播 | 两者都有声，跨段不掉声 |
| 6 | 控制台 | 跨段日志应体现 `reason=handoff` + 仅新增/失活 target 进入 `ACTIVATION`，不应每次全体重建；无 `TIMEOUT_DEGRADED` 滥用 |

---

## 8. 源码锚点（实施后在 `工作台v0.8时间轴.html`）

| 关注点 | 位置 |
|---|---|
| `_PLAY_REASON` 事务枚举 | `const _PLAY_REASON`（MEDIA_ACTIVATION_STATE 之后） |
| `play(reason)` 冷启动 + HANDOFF 分流 | `PlayerManager.play` |
| `_handoff()` 增量交接 | `PlayerManager._handoff`（start/continueStart 之后） |
| `_attemptPlay` `!el.paused` 早返守卫 | `PlayerManager._attemptPlay` |
| 聚合门分流（Session Gate / Handoff Gate） | `PlayerManager._setActivation` 末尾 |
| 跨段调 play(HANDOFF) | `_handleCrossSegment` 内 `playAllMedia(_PLAY_REASON.HANDOFF)` |
| 冷启动补 unlockAudio | `PlayerManager.play` 冷启动分支首行 |
| 视频/音频同路径 | `correctActiveMediaDrift` / `seekActiveMediaToPlayhead` |
| 无 video-centric 硬编码 | grep `videoTargets`/`activeMedia = videos` = 0 命中 |

---

## 9. 版本记录

- **v1.0（设计稿）**：基于 B.5 v1.2 真机验收第三轮 GPT 复盘 + 代码事实校准。定义 Media Activation Contract（每元素持久，跨段 handoff 非 reboot），明确范围（仅 Playable Media）、不做什么、验收标准、源码锚点。
- **v1.1（冻结 + 已实施）**：吸收 GPT 第三轮「Approve with changes」三调整——① 用 `_PLAY_REASON` 事务枚举替代 `play({handoff})` 布尔参数（防第二套播放逻辑）；② 不修改 `_checkAllActivated`，在 `_setActivation` 已解锁分支新增 handoff 单元素门（等价 `_checkActivationBatch` 但更简单）；③ AudioContext 仅 `resume()` 不接管音频管线。新增「冻结三原则」（Session owns transaction / Segment switching = handoff / Activation belongs to MediaTarget）。修正 WebView2 措辞（不过拟合）。落地实现：跨段复用 session 对每个 target 调 `_attemptPlay`（借 `!el.paused` 守卫保护已在播元素），已在播元素不被重静音，reload 变 paused 的元素正确重起播。
