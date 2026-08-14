# PlayerManager v2 设计稿 —— 补缺失的「状态层」(PlaySession)

> 状态：设计稿（未实现，仅评审）。
> 评审轨迹：
> - v1（2026-08-15 初）：GPT 指出「有 PlayerManager ≠ 有播放状态机，缺 PlaySession 状态层」。
> - v2（2026-08-15）：GPT 终审——防 PlaySession 膨胀；3 必改 + 落地重排。
> - v2.1（2026-08-15）：GPT 实现前 4 钉——state 枚举 / mute 三概念 / Step A 最小 / crossSegment 保护。
> - **v2.2（本版，2026-08-15 修）：GPT 开工前最后 4 实现钉——枚举 freeze + 少依赖 MUTED_PLAYING / mediaMuteReasons:Set / createSession 时机后移 / restore 两阶段。✅ 已批准进入 Step A。**
>
> 落地前需 GPT + 用户最终拍板（见 §8，已决）。

---

## 0. 现状校准（必须先说清，避免误判）

**已完成的（Step1–5 已落地，不是从零开始）：**
- `PlayerManager` facade 已建（`工作台v0.8时间轴.html` L1149），9 方法。
- `playAllMedia` / `pausePlay` / `toggleMute` 已退化为薄壳，全部调 `PlayerManager`（L1691 / L1700 / L1260）。
- **seek 唯一入口**已收口：`PlayerManager.seek`（L1266）。
- **全局静音唯一入口**已收口：`PlayerManager.setGlobalMute`（L1242）。
- 意图入口（开始播放）只有 3 个调用点：L1688(startPlay) / L1813(crossSegment) / L1833(重试)，均经 `playAllMedia`。

**真实的缺口（即本次要补的）：**
- **无 PlaySession 状态层**：`play()` 每次执行是一坨内联逻辑，状态混在 `isPlaying/isMuted/isActive` 布尔里。
- **restore 解静音过度防御**：`stillActive = resolveHits(playheadUs).some(...)` 把「播放头实时命中」当解静音条件（L1191 / L1429 两处复制）→ 永久静音，是「没声家族」根因。
- **AbortError 丢恢复**：L1201 重试只 `el.play()` 无 restore；L1435 直接 `p.catch(()=>{})` 吞掉。
- **muted 写散落 17 处**（见 §3）。

**关于 GPT 提到的「根目录堆 md」：** 已于 2026-08-15 处理——5 份内部文档移入 `docs/`，根目录仅运行文件 + README + SCHEMA。本稿即落在 `docs/architecture/`，符合仓库纪律。

---

## 1. PlaySession 数据结构（纯状态容器）

### 1.1 状态枚举（freeze 锁死，禁止散写字符串）

```javascript
const PLAY_SESSION_STATE = Object.freeze({
  CREATED:        "CREATED",
  STARTING:       "STARTING",
  MUTED_PLAYING:  "MUTED_PLAYING",  // 临时播放保护态（= PLAYING + autoplayUnlockPending），窗口可能仅数十 ms
  PLAYING:        "PLAYING",
  PAUSED:         "PAUSED",
  RECOVERING:     "RECOVERING",
  ENDED:          "ENDED",
  CANCELLED:      "CANCELLED",
});
```

> **职责约定（GPT v2.2 钉子1）**：`MUTED_PLAYING` 是临时保护态，**不应被业务逻辑大量判断**；业务应主要判 `session.autoplayUnlockPending`。它只是「PLAYING 且还在等 autoplay 解锁」的快照，未来浏览器策略/WebAudio 解锁变化时不外溢。

### 1.2 三概念 mute 拆分（GPT v2.1 必改2 + v2.2 钉子2 升级）

```javascript
const PlaySession = {
  id: 0,                       // 单调递增；startPlay 强制起播 ++；crossSegment 不 ++
  state: PLAY_SESSION_STATE.CREATED,
  targets: [ { el, type, ti, rec, key } ],  // 由 resolveHits 选出，仅用于「选谁参与」

  // —— 三个维度的 mute（最终 muted = 三者任一为真）——
  userMuteIntent: false,       // (B) 用户主动点静音按钮的意图（= 旧 previewMuted/global mute）
  autoplayUnlockPending: true, // (A) 浏览器 autoplay 技术态：为解锁已静音起播，等 restore/onPlaying 清除
  mediaMuteReasons: new Set(), // (C) 媒体暂 inactive 原因集合：可共存 'gap'|'seek'|'buffer'|'crossSegment'|'preview'|'hidden'

  userPaused: false,           // 用户主动暂停
  lastPlayhead: 0,             // 暂停/结束时保存的播放头（仅存值）
};
```

**最终媒体是否静音（单一计算点，未来复用）：**
```javascript
function shouldMediaBeMuted(s) {
  return s.userMuteIntent || s.autoplayUnlockPending || s.mediaMuteReasons.size > 0;
}
```

**语义边界：**
- **(A) autoplayUnlockPending**：纯技术态。静音起播 → `playing` 事件确认 → 清除（见 §1.4 两阶段）。
- **(B) userMuteIntent**：用户意图。`setGlobalMute` 读它。restore **绝不**清除它。
- **(C) mediaMuteReasons（Set，v2.2 钉子2）**：为何物临时不该出声。用 `Set` 而非单字符串，因多来源可共存（如同时 gap + crossSegment），解除用 `delete('gap')` 而非整体置 null（否则丢其他来源）。

**restore 解静音条件（PlayerManager.restore 内判断，不再读播放头）：**
```
session.isCurrent()                 // id === currentSessionId（没被新播放/暂停覆盖）
&& !session.userMuteIntent          // (B) 用户没主动静音
&& !session.userPaused              // 用户没主动暂停
&& session.autoplayUnlockPending    // (A) 确实处于等解锁态
```
> 解静音只清 (A)，不动 (B)/(C)。播放头实时命中彻底退出 restore 逻辑。

### 1.3 createSession 时机（GPT v2.2 钉子3）

> 不要在 `play()` 最顶部 `id++`。先确认「确实要播」，再建事务，避免空事务污染日志。

```javascript
PlayerManager.play = function() {
  const targets = resolveHits(Store.state.playheadUs);  // 先用旧逻辑选元素
  if (targets.length === 0) return;                     // 没素材，直接返回，不建 session

  if (currentSession && currentSession.isCurrent())
    currentSession.cancel();                             // 取消旧事务
  currentSessionId++;
  const session = createSession(targets);                // state=CREATED
  PlayerManager.start(session);
};
```

### 1.4 restore 两阶段（GPT v2.2 钉子4）

> `play()` promise resolved ≠ `playing` 事件 fired。不要靠 promise 成功就清 (A)。

```javascript
PlayerManager.restore = function(session) {
  if (!(session.isCurrent() && !session.userMuteIntent && !session.userPaused && session.autoplayUnlockPending))
    return;
  // 阶段一：仅「请求」解静音（按最终 muted 模型计算，此时因 autoplayUnlockPending 仍 true，muted 实际仍 true）
  PlayerManager._applyMediaState(session.targets, /* 由 shouldMediaBeMuted 计算 */);
  // 注意：autoplayUnlockPending 此刻不清，等真实 playing 事件
};

// 真实 playing 事件回调（onPlaying），确认媒体真的在播才清 (A)
PlayerManager.onPlaying = function(session) {
  if (!session.isCurrent()) return;
  session.autoplayUnlockPending = false;   // 阶段二：真确认后才清
  session.state = PLAY_SESSION_STATE.PLAYING;
  PlayerManager._applyMediaState(session.targets, { /* 此刻 shouldMediaBeMuted 已 false */ });
};
```

---

## 1.5 边界铁律：Session 是「状态容器」，PlayerManager 是「执行者」（GPT v2 必改1）

单向依赖分层：
```
 PlaySession            —— 纯数据 + 状态判断/数据方法（只读、可判断、可改自身字段）
      │ 只读状态，绝不写 el
      ▼
 PlayerManager          —— 唯一执行者：创建 / seek / play / pause / mute 只在这里动 el
      │
      ▼
 MediaElement           —— <video> / <audio> DOM
```

**Session 允许的方法（只动自身状态/数据，不碰 el）：**
- `isCurrent()` → bool（id === currentSessionId）
- `canRestore()` → bool（!userMuteIntent && !userPaused && autoplayUnlockPending）
- `canContinue()` → bool（RECOVERING 态下是否可 continueStart）
- `updateTargets()` → 刷新受影响元素的 rec.seg/key（数据操作）
- `cancel()` → 置 CANCELLED（被新事务覆盖时）

**Session 禁止的方法（这些是 PlayerManager 的活，否则循环依赖）：**
- ❌ `session.play()` / `session.pause()` / `session.restore()` / `session.applyMediaState()`

**纪律（代码审查红线）**：上表所有「媒体执行」只在 PlayerManager；PlaySession 不出现任何 `el.xxx`。

---

## 2. 状态转移图

（配套 SVG 见本仓库对话内的 `PlayerManager_v2_状态机` 图；文字版如下。所有「→ el.xxx」动作由 **PlayerManager** 执行；状态名用 §1.1 枚举；`MUTED_PLAYING` 仅作临时快照。）

```
 IDLE
  │ 用户点击播放 / startPlay
  │ ① resolveHits → 空则 return（不建 session）
  │ ② cancel 旧 session → currentSessionId++
  ▼
 CREATED              ← createSession(id++)
  │ 收集 targets（resolveHits 仅用于「选谁参与」，不用于解静音）
  ▼
 STARTING             ← PlayerManager.start: el.muted=true(autoplayUnlockPending=true); el.play(); state=STARTING
  │
  ▼
 MUTED_PLAYING        ← state 快照（=PLAYING + autoplayUnlockPending）；await 'playing'/setTimeout(restore,80)
  │  restore() 请求解静音（阶段一：仅请求，不清 A）
  │
  │ 'playing' 事件 → onPlaying() 阶段二：autoplayUnlockPending=false; state=PLAYING
  ▼
 PLAYING              ← 声音已恢复（shouldMediaBeMuted=false）
  │
  ├──────────────┬───────────────────────┐
  │ 用户暂停      │ 跨段(playhead 越界)    │ 到尾/停止
  ▼              ▼                        ▼
 PAUSED      SYNCING(子态)            ENDED
              │ 守卫: state!==ENDED && !==CANCELLED
              │ updateTargets()（复用同 id）+ continueStart(session)
              ▼
         PLAYING (继续，同事务)
```

**v1 → v2.x 的关键差异（红→绿）：**
- v1 `restore` 含 `resolveHits().some(...)` → 播放头稍移即 false → **永久静音（BUG）**。
- v2.2 `restore` 只查 `isCurrent && !userMuteIntent && !userPaused && autoplayUnlockPending`，且**分两阶段**（请求→playing 事件确认），解静音稳定。
- v2.2 `MUTED_PLAYING` 仅临时快照，业务判 `autoplayUnlockPending`。

---

## 3. 入口归属表（全量，含真实行号）

### 3.1 `el.muted =` 写点（真实 17 处；另有 L1298/L1302 是 `wrap.dataset.muted` 非媒体，不计）

| 行号 | 函数 | 分类(GPT) | 处置 |
|---|---|---|---|
| L1308 | `_setVisualContent` | 初始化 | ✅ 保留直接写（创建期 autoplay 静音，合理）|
| L1514 | `renderPreview` | 初始化(创建路径) | ⚠️ 保留直接写，加注释标定「创建期」（Step D 前不动）|
| L1249 / L1255 | `setGlobalMute` | 用户操作(API) | ✅ 已是唯一用户静音入口，读 `userMuteIntent`，保留 |
| L1187 | `PlayerManager.play` | 播放流程(静音起播) | ✅ 保留，归属 `PlayerManager.start(session)`（置 autoplayUnlockPending=true）|
| L1191 | `PlayerManager.play` | **恢复流程(BUG)** | ❌ 删除散落 if，改 `PlayerManager.restore(session)`（按 §1.2/§1.4）|
| L1218 / L1224 | `PlayerManager.play` | 播放流程(非命中停车) | ⚠️ 改 `PlayerManager.park(key)`（Step D）|
| L1426 / L1429 | `_tryReloadMedia` | **恢复流程(BUG复制)** | ❌ Step C 删除复制，改 `PlayerManager.restore(session)` |
| L1751 / L1753 | `seekActiveMediaToPlayhead` | 跨段/同步流程 | ⚠️ Step D 改 `PlayerManager._applyMediaState(media,{muted})` |
| L1760 / L1761 | `seekActiveMediaToPlayhead` | 跨段/同步流程 | ⚠️ Step D 改 `PlayerManager._applyMediaState(media,{muted})` |
| L1648 | `renderPreview(媒体)` | 暂停残留 | ⚠️ Step D 改 `PlayerManager._applyMediaState(media,{muted})` |

**收敛目标（Step D）**：恢复流程(L1191/L1429)与跨段同步流程(L1751-1761/L1648)的 muted 写，全部改调 `PlayerManager._applyMediaState(media, intent)`。

### 3.2 `el.play()` 调用点（真实 3 处）

| 行号 | 函数 | 分类 | 处置 |
|---|---|---|---|
| L1194 | `PlayerManager.play` attempt | 主播放 | ✅ 保留，归属 `PlayerManager.start(session)` |
| L1201 | `PlayerManager.play` AbortError 后 | **BUG:无 restore** | ❌ Step B 改 `PlayerManager.continueStart(session)` |
| L1432 | `_tryReloadMedia` onLoaded | reload 恢复 | ⚠️ Step C 改 `PlayerManager.continueStart(session)` |

意图入口（均经 `playAllMedia`=PlayerManager.play）：L1688(startPlay) / L1813(crossSegment) / L1833(重试)。

### 3.3 `el.pause()` 调用点

| 行号 | 函数 | 处置 |
|---|---|---|
| L1218 / L1224 | `PlayerManager.play` E④ 停车 | → `PlayerManager.park(key)`（Step D）|
| L1235 / L1238 | `PlayerManager.pause` | ✅ 已是 API |
| L1647 | `renderPreview(媒体)` | → `PlayerManager.park(key)`（Step D）|
| L1751 / L1760 | `seekActiveMediaToPlayhead` 停车 | → `PlayerManager.park(key)`（Step D）|

外部均经 `pausePlay()`=PlayerManager.pause：L2815/L2826(拖拽) / L1837/L1847(到尾·seek尾) / L3404/L3419/L3420(键盘) / L1662(togglePlay)。

### 3.4 `el.currentTime =` 写点（真实 2 处）

| 行号 | 函数 | 处置 |
|---|---|---|
| L1273 | `PlayerManager.seek` | ✅ 唯一 seek 入口，保留 |
| L1350 | `_waitSeekSettled` 强制落位 | ⚠️ 保留（屏障内，非第二套逻辑）|

读取点：L1333 / L1362 / L1714（均只读，不污染）。

---

## 4. 各原语允许写入口的纪律（落地后）

| 原语 | 允许直接写的场景 | 禁止直接写的场景 | 统一收口方法 |
|---|---|---|---|
| `el.muted=` | ① 创建期 ② 用户操作(`setGlobalMute` API) | ① 播放流程 ② 恢复流程 ③ 跨段/同步 ④ 暂停残留 | `PlayerManager._applyMediaState(media, intent)` |
| `el.play()` | 仅 `PlayerManager` 内 `start/continueStart` | 禁止各处散落 | `PlayerManager.start` / `continueStart` |
| `el.pause()` | 仅 `PlayerManager.pause` 内 `park` | 禁止散落 | `PlayerManager.park` |
| `el.currentTime=` | 仅 `PlayerManager.seek` + `_waitSeekSettled` | 禁止其他位置 | `PlayerManager.seek` |

**边界红线（GPT v2 必改1）**：上表收口方法都在 PlayerManager；PlaySession 只提供 `isCurrent()/canRestore()/canContinue()` 等 bool 判断（§1.5）。

---

## 5. crossSegment 处理设计

当前：`_handleCrossSegment`(L1286→L1813 附近) 强制 `playAllMedia()` 重新起播整批。

v2.2 调整：
- 跨段**复用当前 session id（不 id++）**，仅调 `session.updateTargets()`。
- **生命周期保护（GPT v2.1 必改4）**：
  ```javascript
  if (session.isCurrent()
      && session.state !== PLAY_SESSION_STATE.ENDED
      && session.state !== PLAY_SESSION_STATE.CANCELLED) {
    session.updateTargets();
    // seek + PlayerManager.continueStart(session)
  }
  ```
- 强制起播调 `PlayerManager.continueStart(session)`（带 restore）。
- `crossSegmentPending` 锁保留，门控内只做 `updateTargets()` + seek，不重建媒体。

---

## 6. reload 处理设计（`_tryReloadMedia`）—— Step C 才动

当前（L1417-1436）：error→`el.load()`→复制 stillActive restore（L1427-1430）+ AbortError 吞掉（L1435）。

**重要（GPT v2.1 必改3）**：reload 是「媒体加载生命周期」，与「播放生命周期」混改会扩大爆炸范围，**Step A 不动它**，推到 Step C。

Step C 调整：reload 恢复改调 `PlayerManager.continueStart(session)`（带 restore），删 L1427-1435 复制，AbortError 不再吞。命名用 `continueStart`（非 `retry`）。

---

## 7. 修复落地顺序（Step A 已批准，v2.2 再缩）

> GPT v2.2 终稿：「Step A 只做：新增枚举/Session/createSession + 改 play() + 新增 start/restore + 删 stillActive。reload/crossSegment/_applyMediaState/pause 全不动。」

### Step A —— 最小可行：建事务 + 修首次播放无声（已批准开工）
**新增：**
1. `PLAY_SESSION_STATE`（`Object.freeze`，§1.1）。
2. `PlaySession` 对象（§1.2）+ `createSession(targets)` 工厂（§1.3 时机）。
3. `shouldMediaBeMuted(session)` 单一计算点（§1.2）。

**改 `PlayerManager.play()`：**
4. 按 §1.3：先 `resolveHits` → 空 return → cancel 旧 → `id++` → `createSession` → `PlayerManager.start(session)`。
5. 抽 `PlayerManager.start(session)`（对 targets `el.muted=true` + `autoplayUnlockPending=true` + `el.play()`；state 走 STARTING→MUTED_PLAYING）。
6. 抽 `PlayerManager.restore(session)`（§1.2 条件，删 `stillActive`/删 `resolveHits` 在 restore 的使用）；抽 `PlayerManager.onPlaying(session)`（§1.4 阶段二，真实 playing 事件清 A + 置 PLAYING）。
7. **删** L1191 散落的 `stillActive` if。

**不动**：`_tryReloadMedia`(Step C)、crossSegment(Step D 后续)、`_applyMediaState` 收口、muted 全收口、pause 重构。

**验收门禁（双重）：**
- `node --check`（抽内联 JS 语法）。
- **真机**：①首次播放有声；②暂停→PLAYING 变 PAUSED；③再播新建 session(id++)，无「旧事务复活」（日志见下）。
- **Session 日志验收（GPT v2.2 加）**：临时在状态转移处 `console.log("[PlaySession]", id, state, targets.length, autoplayUnlockPending)`，确认：
  ```
  首次: 1 CREATED → 1 STARTING → 1 MUTED_PLAYING → 1 PLAYING
  暂停: 1 PAUSED
  再播: 2 CREATED → 2 STARTING → 2 MUTED_PLAYING → 2 PLAYING
  ```
  **禁止出现** `1 STARTING → 2 STARTING → 1 PLAYING`（旧事务复活）。

### Step B —— 迁移 AbortError 到 `continueStart(session)`（L1201）— 验收：暂停再播有声
### Step C —— 迁移 reload 到 `continueStart` + 删复制 restore（L1432/L1427-1435）— 验收：reload 恢复有声
### Step D —— 收口 muted 到 `_applyMediaState(media, intent)`（§3.1 散落点）— 验收：多段 gap 不跳/不双播

每步改完必须 `node --check` + 真机跑一遍；除「没声/跳过」目标修复外，行为零变化。

---

## 8. 拍板结论（GPT 评审已决，无需再问）

1. **暂停再播**：新建 session（id++），保存 `lastPlayhead`。✅
2. **resolveHits 分工**：仅选 targets，绝不用于解静音。✅
3. **L1514/L1648 muted 写**：延迟到 Step D。✅
4. **边界铁律**：Session 只存状态 + 判断/数据方法；所有 `el` 写经 PlayerManager；禁 `session.play/pause/restore`。✅
5. **命名**：`retry` → `continueStart`。✅
6. **muted 收口**：`_applyMute` → `_applyMediaState(media, intent)`。✅
7. **crossSegment**：复用 session id + `updateTargets()` + 生命周期保护。✅
8. **state 枚举 freeze**：`PLAY_SESSION_STATE` 8 态，禁裸字符串；少依赖 `MUTED_PLAYING`，主判 `autoplayUnlockPending`。✅（v2.2 钉子1）
9. **mute 三概念**：`userMuteIntent`(B)/`autoplayUnlockPending`(A)/`mediaMuteReasons:Set`(C)；最终 muted = 三者任一。✅（v2.2 钉子2）
10. **createSession 时机**：resolveHits 空则 return，cancel 旧后再 id++。✅（v2.2 钉子3）
11. **restore 两阶段**：restore 只请求解静音，清 (A)+置 PLAYING 等真实 `playing` 事件（onPlaying）。✅（v2.2 钉子4）
12. **Step A 范围**：只建事务 + 改 play() + 新增 start/restore；reload/crossSegment/_applyMediaState/pause 全不动；加 Session 日志验收。✅（v2.2 终稿）

**下一步**：✅ **Step A 已批准开工**。
