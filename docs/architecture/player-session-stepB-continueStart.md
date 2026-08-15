# PlayerManager v2.2 · Step B：continueStart 契约设计稿

> **状态**：**v2.3 冻结版**（经 GPT 终审通过，含 4 颗钉子 + 最终状态机）。本稿仅设计、**未编码**。Step B 设计已冻结，可进入实现；实现前不得再改本稿接口。
> **配套**：状态机/三概念 mute 见 `player-session-v2-design.md` §1；落地顺序索引见其 §7。
> **下一篇**：Step B.5（Media Activation Gate，治首次没声）单独成文，不在本稿范围。

---

## 0. 一句话定位

**Step B 不治病「首次没声」。它只做一件事：把所有「播放启动失败后的再次启动」收到同一套启动纪律里，消灭 `start()` 里那段 `AbortError → 60ms 裸 play` 的第二套逻辑。**

---

## 1. 目标与边界

### 1.1 B 负责
- 统一「启动失败 → 重启」路径：从 `start()` 的 inline `catch` 分支，收口为 `continueStart(session, reason)`。
- 引入 `RECOVERING` 中间态，让「正在重试」成为状态机的一等公民，而不是藏在 `setTimeout` 里的副作用。
- 给 AbortError 类「事务取消」语义（不是网络错误、不是失败），**窗口内限次**重试，耗尽即停。

### 1.2 B 不负责（红线，违反即膨胀）
- ❌ 加 `readyState` / `canplaythrough` 等待 → 那是 B.5（Media Activation Gate）。
- ❌ 改 `120ms` 兜底的值或语义 → 那是 B.5 要替换的；B 保持原样。
- ❌ 改 muted 策略（`autoplayUnlockPending` / `shouldMediaBeMuted` 语义）→ 那是 Step A 已修、Step D 收口。
- ❌ 改 `_handleCrossSegment` → Step D。
- ❌ 动 `_tryReloadMedia` → Step C（B 只把 `NotSupportedError` **原样移交**给它，不改移交方式）。
- ❌ `_attemptPlay` 承担 state 修改 / restore / 错误分类（钉子3 收口）→ 否则它会膨胀成第二个 PlayerManager。

---

## 2. 问题定位：当前的反模式

`工作台v0.8时间轴.html` `PlayerManager.start()` 内（现状 L1268-1280）：

```javascript
const p = el.play();
if (p && p.catch) p.catch(err => {
  const name = (err && err.name) || "Error";
  if (name === "AbortError") {
    // seek/play 竞态（跨段边 seek 边 play），非致命：轻量重试一次（Step B 将改 continueStart）
    setTimeout(() => { if (isPlaying && el.paused) { const r = el.play(); if (r && r.catch) r.catch(() => {}); } }, 60);
  } else if (name === "NotSupportedError") {
    _tryReloadMedia(el, type, rec.key || (type + ":" + ti));
  } else { /* showFatal */ }
});
```

**为什么是「第二套逻辑」（危险）**：
1. 它绕过了 `onPlaying` / `restore` 的解锁纪律——裸 `el.play()` 后只 `.catch(()=>{})`，不重新挂 `playing` 监听、不走状态机。
2. 它不进 `RECOVERING` 态，重试完全游离在状态机外，无法被 `PAUSED/CANCELLED/ENDED` 守卫拦住（理论上旧事务在暂停后仍可能被它复活）。
3. 重试的「成功」没有统一判据：靠 `el.paused` 粗判，没有解锁回调，和 Step A 的「真实 playing 事件才解锁」原则自相矛盾。

---

## 3. 责任层归属（问题树）

表面现象：「首次/某次播放没声」。按责任层拆，不是顺着现象乱塞：

```
首次没声 ──┬── A. media 未预热 / 输出管线未稳定   ← 主嫌疑，归属 Media 生命周期层（B.5 治）
          │
          ├── B. AbortError 恢复路径不完整        ← 独立架构债，归属 启动事务层（本 Step B 治）
          │
          └── C. mute 解锁条件设计问题            ← Step A 已修一部分（autoplayUnlockPending）
```

- **B 治 B 枝**：启动事务层的恢复路径不统一。
- **B.5 治 A 枝**：媒体真正 ready 之前不要解 mute。
- 两者**不能混**：把首次没声塞给 B，会让 B 变成「万能修复」并污染架构（正是用户拍板要避的坑）。

---

## 4. 接口契约

### 4.1 Session 侧（纯状态/数据，不碰 el — 沿用 v2.2 §1.2 白名单）

在 `createSession` 产出的 session 对象上：

| 字段 | 类型 | 职责 | 来源 |
|---|---|---|---|
| `state` / `targets` / `userMuteIntent` / `autoplayUnlockPending` / `mediaMuteReasons` / `userPaused` / `lastPlayhead` / `isCurrent()` / `canRestore()` / `cancel()` | 既有 | 沿用 Step A 已落地 | v2.2 |
| `recoverToken` | `0` | **钉子1**：恢复竞态防护，每次调度恢复自增 | 本稿新增 |
| `recoverCount` | `0` | **钉子2**：窗口内恢复次数（非永久累计） | 本稿新增 |
| `lastRecoverAt` | `0` | **钉子2**：上次恢复时间戳（ms） | 本稿新增 |
| `canContinue()` | bool | 仅当 `state===RECOVERING && isCurrent() && recoverCount < RECOVER_CAP` | 本稿钉死 |

> `canContinue()` 已在 v2.2 §1.2 方法白名单（L148）。窗口清零发生在 `_scheduleRecover`（见 §4.2），`canContinue` 只做最终闸门。

### 4.2 PlayerManager 侧（唯一动 el 的地方）

| 成员 | 类型 | 职责 | 备注 |
|---|---|---|---|
| `_attemptPlay(session, t)` | 新增 | **钉子3**：**纯媒体动作**——静音起播 + 重绑解锁监听 + `return el.play()`；不碰 state / 不 restore / 不分类错误 | 唯一 `el.play()` 起播入口 |
| `_onMediaPlaying(session, t)` | 新增（seam） | **钉子4**：`playing` 事件的统一落点；B 阶段 = 现有 `onPlaying` 解锁逻辑；B.5 将在此插入 Media Activation Gate | `_attemptPlay` 经此 seam，不直接写 restore |
| `_onStartError(session, t, err)` | 新增 | **外层**：`play()` 的 `catch` 统一**错误分类**——AbortError→`_scheduleRecover`；NotSupportedError→移交 `_tryReloadMedia`；其他→`showFatal` | 取代 L1268-1280 的 inline `catch` |
| `_scheduleRecover(session, t)` | 新增 | **钉子1+2**：窗口计数 + `recoverToken++` + 置 `RECOVERING` + 窗口化延迟（60ms，携 token）后调 `continueStart` | 延迟≠第二套逻辑 |
| `continueStart(session, reason)` | 新增 | 校验 `canContinue()` → 置 `STARTING`（**复用启动序列**）→ 对仍 `paused` 的 target 调 `_attemptPlay` → 回 `MUTED_PLAYING` | `reason` 仅日志，行为由 state 决定 |
| `start(session)` | 改造 | 删 L1268-1280 的 inline catch；改调 `_attemptPlay` + 挂 `_onStartError`；保留 `120ms` 兜底（原样） | — |

**调用方如何接 catch**：`_attemptPlay` 只返回 `el.play()` 的 promise（或 `null` 表示无需动作），错误分类由 `start` / `continueStart` 外层 `p.catch(err => this._onStartError(session, t, err))` 负责——保证 `_attemptPlay` 纯媒体动作（钉子3）。

### 4.3 参数与错误类型约束

- **`continueStart(session, reason)`** 的 `reason` 仅用于日志/可观测，**不改变行为**；行为由 `session.state` + `canContinue()` 决定。
- **允许 continueStart 处理的错误**（进 `_scheduleRecover`）：
  - `AbortError`（play 被新 play 取消 / 事务取消，非失败）
  - 其它「临时启动失败」（play promise reject 但媒体本身可恢复）
- **禁止 continueStart 处理的错误**（不进 RECOVERING）：
  - `NotSupportedError` / 解码错误 → 属 reload / 媒体生命周期 → 移交 `_tryReloadMedia`（Step C 才把它也收进 `continueStart`）
  - 网络错误 / `src` 错误 / 资源不存在 → 不是启动事务能救的，交 Step C / 报错 UI

---

## 5. 状态转移图（最终版，采纳 GPT 终审）

```
                         用户点击 / play()
                         ① resolveHits → 空 return（不建 session）
                         ② cancel 旧 → id++ → createSession
                                       ▼
 CREATED ───────────────────────────► STARTING
   │                                    │  _attemptPlay 逐 target：
   │                                    │   el.muted=true; 挂 playing→_onMediaPlaying; el.play()
   │                                    │   p.catch → _onStartError
   │                                    ▼
   │                              MUTED_PLAYING   （已发所有 play，等解锁；state 快照）
   │                                    │  _onMediaPlaying（真实 playing 事件 / 120ms 兜底）
   │                                    ▼
   │                                 PLAYING              ◄──────────────┐
   │                                    │  AbortError(_onStartError)      │ playing 事件
   │                                    ▼（recoverable）                  │
   │                              RECOVERING                             │
   │                                    │  _scheduleRecover：             │
   │                                    │   recoverToken++(钉子1)         │
   │                                    │   recoverCount++ 窗口内(钉子2)  │
   │                                    │   60ms 后 continueStart         │
   │                                    ▼                                │
   │                         continueStart(canContinue?)：                │
   │                           → 置 STARTING（复用启动序列）───┐          │
   │                           → 仍 paused 的 target          │          │
   │                             _attemptPlay → MUTED_PLAYING ┘ ─────────┘
   │                                                              │
   ├─ 用户暂停 ───────────────► PAUSED        （守卫：RECOVERING 期间 pause 则 continueStart 不复活）
   ├─ 被新事务覆盖 ──────────► CANCELLED     （守卫：isCurrent() 为假则一切恢复作废；token 漂移亦作废）
   └─ 到尾/停止 ────────────► ENDED
```

**关键不变量**：
- `RECOVERING` 只能由 `AbortError`（可恢复）进入；`PAUSED / CANCELLED / ENDED` 状态**绝不**经 `continueStart` 复活。
- `continueStart` **回到 `STARTING`**（采纳最终状态机），复用完整启动序列，而非另写一条恢复支线——这正是「统一启动纪律」的落点。
- 重试上限：`RECOVER_CAP = 2` **且** 限在 `RECOVER_WINDOW_MS = 60000`（60s）窗口内；超出窗口清零重计（钉子2）。
- **钉子1（recoverToken）**：`_scheduleRecover` 每次自增并捕获 `token`，`setTimeout` 回调首行 `if (token !== session.recoverToken) return;`。旧恢复天然失效——覆盖「用户暂停 / 新事务 / 重复 abort」等未来 crossSegment/reload 加入后的复杂状态竞争。
- `continueStart` 只对**仍 `paused`** 的 target 重试；已解锁/正在播的轨**不动**（避免打断已好的轨）。

---

## 6. 单一起播入口纪律（消灭第二套逻辑）

**铁律**：在「启动 / 恢复」路径里，`el.play()` 只出现在 `_attemptPlay(session, t)` 一处，且它**只做媒体动作**（钉子3）。`start()` 与 `continueStart()` 都通过它发起播放与重绑解锁链。任何地方（含 `_handleCrossSegment`、reload 回调）未来需要「强制起播」，都调 `PlayerManager.continueStart(session)` 或 `start(session)`，**禁止**再写 `el.play()` + `.catch(()=>{})` 的裸重试。

这条纪律是 Step D 收口 `crossSegment` 复用 session 的前置（v2.2 §7 / §8 结论7）。

---

## 7. B 明确禁止触碰的边界（红线 + 理由）

| 红线 | 理由 |
|---|---|
| 不加 `readyState/canplaythrough` 等待 | 那是 B.5 的 Media Activation Gate；B 提前碰会变成「万能修复」 |
| 不改 `120ms` 兜底的值/语义 | B.5 才用「等全部 target 激活」替换它；B 保持原样以保证「行为零变化」 |
| 不改 muted 策略（`autoplayUnlockPending`/`shouldMediaBeMuted`） | Step A 已修、Step D 才全收口；B 碰会重开已闭环的讨论 |
| 不改 `_handleCrossSegment` | Step D 职责；B 只保证 crossSegment 若需强制起播时调 `continueStart` 而非裸 play |
| 不动 `_tryReloadMedia` | Step C 职责；B 仅把 `NotSupportedError` **原样**移交，不改移交方式 |
| `_attemptPlay` 不得碰 state / 写 restore / 分类错误（钉子3） | 否则它膨胀成第二个 PlayerManager，B 的自我约束崩溃 |

---

## 8. 与 B.5 / C / D 的衔接

- **→ B.5（下一篇）**：B 保留的 `120ms` 逐 target 兜底，将在 B.5 被替换为「`Promise.all(targets.map(waitMediaActivated))` → 全部激活才 `restore` 解 mute」。**钉子4 已预留 seam**：`_attemptPlay` 的 `playing` 监听只调 `_onMediaPlaying(session,t)`，B.5 只需把 `_onMediaPlaying` 内部从「立即解锁」升级为「等全部 target 激活再解锁」，**`_attemptPlay` 与 `start`/`continueStart` 一行不动**——这正是钉子4 的价值：B.5 不重构 B。
- **→ C**：`NotSupportedError` 当前移交 `_tryReloadMedia`；Step C 会把 reload 恢复也改为调 `continueStart(session)`（带 restore），届时 B 的 `_onStartError` 只需改一行移交目标，不重写逻辑。
- **→ D**：`crossSegment` 复用 session id + `updateTargets()` + 生命周期保护，复用本稿建立的 `continueStart` 单一入口 + `recoverToken` 竞态防护，自然满足「已解锁轨不被打断」。

---

## 9. 验收门禁

**语法**：抽内联 JS → `node --check`（沿用项目纪律）。

**回归守卫（B 绝不能破坏 Step A 的战果）**：
1. 暂停 → 再播 **有声**（Step A 已验证，B 必须零回归）。
2. gap 处播放头平滑穿过，**不卡段尾**（3ef8cd6 已修，B 不动 `play()` 空 return 逻辑）。
3. seek 到任意位置起播正常。

**B 专项验收（真实 AbortError 路径）**：
4. 跨段边 seek 边 play 触发 `AbortError` 时，控制台出现 `[PlaySession] <id> RECOVERING <key> token <n>`，随后恢复为 `PLAYING`（有声），**不再**走裸 `setTimeout 60ms el.play()`。
5. 日志**禁止**出现「旧事务在 RECOVERING 后被 PAUSED/CANCELLED/ENDED 复活」。
6. **钉子1 验证**：RECOVERING 期间用户点暂停 → 旧 `setTimeout` 触发时 `continueStart` 被 `canContinue()`/`token` 拦住，媒体保持暂停、不假播放。
7. **钉子2 验证**：连续快速触发 3+ 次 AbortError（窗口 60s 内）→ 第 3 次起 `_scheduleRecover` 直接 `return`（日志 `AbortError 窗口内重试耗尽`），不再无限重试；间隔 >60s 后配额自动恢复。
8. 重试耗尽（`recoverCount` 达上限）后，媒体保持静音、不假 PLAYING；用户手动再点一次能新建 session（`id++`）正常播。

**Session 日志序列示例（B 后）**：
```
首次: 1 CREATED → 1 STARTING → 1 MUTED_PLAYING → 1 PLAYING
abort: 1 RECOVERING video:0 token 1
恢复: 1 STARTING → 1 MUTED_PLAYING → 1 PLAYING
```

---

## 10. 已知张力（诚实标注，留给 B.5，B 不解决）

`120ms` 逐 target 兜底在 B 中**原样保留**。它有两个已存在的隐患，B 因红线不碰：
1. `autoplayUnlockPending` 是 **session 级单 flag**，任一 target 的 120ms 兜底触发 `_onMediaPlaying` 会**全量解 mute**——可能在某些 target 尚未真正起播时就解静音。
2. 若 `AbortError` 发生且 120ms 兜底先于恢复成功触发，会提前把 state 置 `PLAYING` + 解 mute；若恢复最终**失败**（重试耗尽），会出现「状态 PLAYING 但实际静音」。

这两点正是 B.5 用「等全部 target 激活才 `restore`」根治的对象（经钉子4 的 `_onMediaPlaying` seam 接入）。本稿明确：**B 不试图修它**，否则即违反 §1.2 红线第 2 条。

> **钉子4 与已知张力的关系**：B.5 替换 `_onMediaPlaying` 内部后，第 1 点（单 flag 全量解 mute）会因「等全部 target 激活」自然解决；第 2 点（假 PLAYING）因「恢复失败不再走 120ms 提前解锁」解决。B 当前保留 120ms 是刻意「行为零变化」，待 B.5 一次性替换。

---

## 11. 实现骨架（伪代码，仅供评审，非生产）

```javascript
// —— 常量 ——
const RECOVER_CAP = 2;            // 钉子2：窗口内最大恢复次数
const RECOVER_WINDOW_MS = 60000;  // 钉子2：恢复配额窗口（60s）

// —— Session 工厂新增字段 ——
function createSession(targets) {
  const s = {
    /* 既有字段: id, state, targets, userMuteIntent, autoplayUnlockPending,
       mediaMuteReasons:new Set(), userPaused, lastPlayhead, isCurrent, canRestore, cancel */
    recoverToken: 0,              // 钉子1
    recoverCount: 0,              // 钉子2（窗口内，非永久累计）
    lastRecoverAt: 0,             // 钉子2
    canContinue() { return this.state === RECOVERING && this.isCurrent() && this.recoverCount < RECOVER_CAP; }
  };
  return s;
}

// —— PlayerManager ——
_attemptPlay(session, t) {                          // 钉子3：纯媒体动作
  const { el } = t;
  if (!el || !el.paused) return null;               // 已在播不算失败，返回 null
  el.muted = true;
  el.addEventListener("playing", () => this._onMediaPlaying(session, t), { once: true });  // 钉子4：经 seam
  return el.play();                                  // 仅返回 promise；错误分类/state 由外层处理
},
_onMediaPlaying(session, t) {                        // 钉子4：B 阶段=现有 onPlaying 解锁；B.5 在此升级为激活门
  this.onPlaying(session, t);                        // 清 autoplayUnlockPending + 置 PLAYING + 按 want 解 mute
},
_onStartError(session, t, err) {                     // 错误分类留在外层
  if (!session.isCurrent()) return;
  const name = (err && err.name) || "Error";
  if (name === "AbortError") this._scheduleRecover(session, t);
  else if (name === "NotSupportedError") _tryReloadMedia(t.el, t.type, t.key || (t.type + ":" + t.ti));  // 原样移交(Step C 接)
  else { console.warn("[play] 播放错误:", name, t.key, err); showFatal("⚠ 播放错误(" + (t.key||t.type) + ")：" + name); }
},
_scheduleRecover(session, t) {                       // 钉子1 + 钉子2
  if (!session.isCurrent()) return;
  const bad = [PLAYING, PAUSED, CANCELLED, ENDED];
  if (bad.includes(session.state)) return;           // 已解锁/已结束不复活
  const now = performance.now();
  if (now - session.lastRecoverAt > RECOVER_WINDOW_MS) session.recoverCount = 0;  // 窗口外清零（钉子2）
  if (session.recoverCount >= RECOVER_CAP) { console.warn("[PlaySession]", session.id, "AbortError 窗口内重试耗尽", t.key); return; }
  session.recoverCount++;
  session.lastRecoverAt = now;
  session.recoverToken++;                            // 钉子1
  const token = session.recoverToken;
  session.state = RECOVERING;
  console.log("[PlaySession]", session.id, session.state, t.key, "token", token);
  setTimeout(() => {                                 // 仅延迟，非第二套逻辑
    if (token !== session.recoverToken) return;       // 钉子1：旧恢复天然失效（被新恢复/新事务/状态变更取代）
    this.continueStart(session, "AbortError");
  }, 60);
},
continueStart(session, reason) {                      // RECOVERING → STARTING（复用启动序列，采纳最终状态机）
  if (!session.canContinue()) return;                 // RECOVERING + current + 未逾上限
  session.state = STARTING;
  let any = false;
  for (const t of session.targets) {
    const p = this._attemptPlay(session, t);
    if (p && p.catch) p.catch(err => this._onStartError(session, t, err));
    else if (p !== null) any = true;                 // null = 已在播跳过；promise = 已重发
  }
  if (any) session.state = MUTED_PLAYING;             // 再等解锁；若全已在播则交给仍 pending 的原监听/120ms
},

// start() 改造：删 L1268-1280 的 inline catch，改为：
start(session) {
  session.state = STARTING;
  for (const t of session.targets) {
    const p = this._attemptPlay(session, t);
    if (p && p.catch) p.catch(err => this._onStartError(session, t, err));
  }
  session.state = MUTED_PLAYING;
  for (const t of session.targets) setTimeout(() => this._onMediaPlaying(session, t), 120);  // 原样保留(B 不碰)
}
```

> **实现备注**：`recoverToken` 与 `canContinue` 双重守卫覆盖「用户暂停 / 新事务 / 重复 abort」；`continueStart` 重绑的 `playing` 监听与 `start` 时可能残留的 `once` 监听并存时，`onPlaying`/`_onMediaPlaying` 幂等（查 `autoplayUnlockPending`）可安全去重——实现时可顺手 `removeEventListener` 清旧监听，属优化非必需。`RECOVER_CAP` / `RECOVER_WINDOW_MS` 与 `PLAY_SESSION_STATE` 同区定义。

---

## 12. 修订记录

- **v2.2（初稿）**：基于 v2.2（Step A 已落地），钉死 `continueStart` 契约、状态转移、`_attemptPlay` 单一入口、五条红线、与 B.5/C/D 衔接。
- **v2.3（冻结版，GPT 终审 + 4 钉子）**：
  - **钉子1** 新增 `recoverToken` 竞态防护（`_scheduleRecover` 自增+捕获，setTimeout 首行比对作废旧恢复）。
  - **钉子2** `_recoverCount` 永久累计 → `recoverCount`+`lastRecoverAt` 窗口化（60s/2 次），适配长时运行剪辑器。
  - **钉子3** `_attemptPlay` 收为纯媒体动作（只 mute+挂监听+return el.play()），state/restore/错误分类交外层。
  - **钉子4** 新增 `_onMediaPlaying` seam，`_attemptPlay` 不直接写 restore，为 B.5 Media Activation Gate 预留无重构接口。
  - 采纳 GPT 最终状态机：`RECOVERING → STARTING`（continueStart 复用启动序列），非独立恢复支线。
  - **结论**：Step B 设计冻结，可进入实现。
