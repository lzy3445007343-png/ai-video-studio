# 实施手册：PlayerManager 播放内核收尾（Step B → B.5 → C → D）

> **读者**：GPT 参谋（只读评审角色，不碰代码）。本文**自包含**，无需先读其他文档即可评审。
> **项目纪律**：任何代码改动前必须出设计稿并经 GPT 参谋评审。本手册中 Step B 已冻结（设计稿经你终审），B.5 为草案待你审，C/D 仅方向、落地前还会各出独立设计稿并经你终审。
> **配套已冻结文档**：`docs/architecture/player-session-stepB-continueStart.md`（Step B v2.3 冻结版）、`docs/decisions/ADR-001-ai-video-os-route.md`（路线冻结）、`docs/architecture/operation-schema-sketch.md`（Operation 概念草图）。

---

## 1. 背景与当前状态（自包含）

### 1.1 已冻结的设计

- **路线（ADR-001）**：播放器 + 时间轴 = AI 视频操作系统的**运行环境（基础设施）**，不是产品功能。B-D 收尾后**冻结执行层**（维护模式，停止增加功能），进入 `Operation Schema v1 → Command API v1 → Timeline Schema v1 → MCP → Skill → 外部 Agent`。
- **Step A 已完成并真机验证**（commit `3ef8cd6`）：引入 `PlaySession` 状态层、静音起播 + 真实 `playing` 事件解锁、gap 不卡段尾、暂停再播有声、seek 任意位置起播。
- **Step B 设计已冻结**（v2.3，含 GPT 终审 4 钉子）：统一「播放启动失败后的再次启动」路径，消灭第二套裸逻辑。
- **Step B.5 方向已获 GPT 评审确认**（第四轮，2026-08-15）：采用 **Activation Tracker** 取代 `Promise.all`，规避坏轨死锁；`MEDIA_ACTIVATION_TIMEOUT = 1000` 独立常量；信号优先级 `playing → readyState → timeout`。待出独立冻结稿。

### 1.2 Step A 真机验收结果（用户 04:0x 实测）

- ✅ gap 不卡段尾
- ✅ seek 到任意位置起播正常
- ✅ 暂停 → 再播有声
- ✅ `[PlaySession]` 日志正常（CREATED→STARTING→MUTED_PLAYING→PLAYING）
- ❌ **唯一残留**：首次导入新素材后第一次播放偶发没声 —— 已明确归 **B.5** 治，非 B 的职责

### 1.3 代码行号地图（当前 `工作台v0.8时间轴.html`）

| 锚点 | 行 | 说明 |
|---|---|---|
| `PLAY_SESSION_STATE` / `RECOVERING` | L1155 / L1161 | 状态枚举（`RECOVERING` 已存在，待用） |
| `createSession` | L1174-1188 | session 工厂，需加 3 字段 + `canContinue` |
| `PlayerManager.start()` | L1258-1284 | **当前含 L1268-1280 的 `AbortError → 60ms 裸 play` 反模式**（B 要收口的目标） |
| `onPlaying` | L1287-1297 | 真实 `playing` 解锁逻辑（保留） |
| `pause()` | L1299-1304 | `PAUSED` 态记录 |
| `_waitMediaReady` | L1447-1463 | 已有 `canplaythrough` 监听（B.5 可参考） |
| `previewMuted` | L1091 | 全局预览静音开关 |

### 1.4 实施纪律

- 每步**独立 commit + push**（GitHub 纪律：根目录只放运行文件，设计文档在 `docs/`）。
- 改完抽内联 JS → `node --check` 语法校验。
- 每步**真机验收**（重启 `start.bat`，按对应门禁）。
- **回归守卫**：B/C/D 绝不破坏 Step A 战果（暂停再播有声 / gap 不卡 / seek 正常）。

---

## 2. Step B 实施清单（已冻结，落代码）

### 2.1 改动点（精确）

1. **常量**（与 `PLAY_SESSION_STATE` 同区，L1155 附近新增）：
   - `RECOVER_CAP = 2`（钉子2：窗口内最大恢复次数）
   - `RECOVER_WINDOW_MS = 60000`（钉子2：恢复配额窗口 60s）

2. **`createSession`（L1174-1188）新增字段与方法**：
   - `recoverToken: 0`（钉子1：恢复竞态防护）
   - `recoverCount: 0`（钉子2：窗口内计数，**非永久累计**）
   - `lastRecoverAt: 0`（钉子2）
   - `canContinue() { return this.state === RECOVERING && this.isCurrent() && this.recoverCount < RECOVER_CAP; }`

3. **新增 5 个 `PlayerManager` 方法**（实现依据 = 冻结稿 §11 伪代码）：
   - `_attemptPlay(session, t)`（钉子3·纯媒体动作）：`if(!el || !el.paused) return null; el.muted = true; el.addEventListener("playing", () => this._onMediaPlaying(session, t), { once: true }); return el.play();` —— **唯一 `el.play()` 起播入口**，不碰 state / 不 restore / 不分类错误。
   - `_onMediaPlaying(session, t)`（钉子4·seam）：B 阶段 `this.onPlaying(session, t)`；B.5 将在此处升级为激活门。
   - `_onStartError(session, t, err)`（外层·错误分类）：`AbortError` → `_scheduleRecover`；`NotSupportedError` → 原样 `_tryReloadMedia`（Step C 才改走 `continueStart`）；其他 → `showFatal`。**取代 L1268-1280 的 inline catch**。
   - `_scheduleRecover(session, t)`（钉子1+2）：窗口计数清零判断 + `recoverCount++` + `lastRecoverAt = now` + `recoverToken++` + 置 `RECOVERING` + `setTimeout(60)` 携 `token` 后调 `continueStart`。
   - `continueStart(session, reason)`：`canContinue()` 校验 → 置 `STARTING`（**复用启动序列：只重走 `_attemptPlay` + `_onMediaPlaying` 解锁链，禁止复制 `start()` 内部逻辑**；半年后 `start()` 修 bug，`continueStart` 自动受益，不出现两套启动逻辑）。对仍 `paused` 的 target 调 `_attemptPlay` → `MUTED_PLAYING`。

4. **`start()` 重构（L1258-1284）**：删 L1268-1280 的 inline catch，每个 target 改为 `const p = this._attemptPlay(session, t); if (p && p.catch) p.catch(err => this._onStartError(session, t, err));`；**保留 L1267 的 120ms 兜底（原样，B 不碰）**。

### 2.2 实施顺序

常量 → `createSession` 字段 → 5 方法 → `start()` 重构 → `node --check` → 真机验收。

### 2.3 验收门禁（B 专项 + 回归，详见冻结稿 §9）

- **回归守卫**：暂停再播有声、gap 不卡、seek 任意起播 —— 零回归。
- **B 专项**：跨段边 seek 边 play 触发 `AbortError` 时，控制台出现 `[PlaySession] <id> RECOVERING <key> token <n>`，随后恢复为 `PLAYING`（有声），**不再**走裸 `setTimeout 60ms el.play()`。
- **钉子1 验证**：`RECOVERING` 期间用户点暂停 → 旧 `setTimeout` 触发时 `continueStart` 被 `canContinue()` / `token` 拦住，媒体保持暂停、不假播放。
- **钉子2 验证**：窗口 60s 内连续快速触发 3+ 次 `AbortError` → 第 3 次起 `_scheduleRecover` 直接 `return`（日志 `AbortError 窗口内重试耗尽`），不再无限重试；间隔 >60s 后配额自动恢复。
- **耗尽验证**：`recoverCount` 达上限后媒体静音、不假 `PLAYING`；用户手动再点一次能新建 session（`id++`）正常播。

### 2.4 B 红线（违反即膨胀，详见冻结稿 §7）

不加 `readyState/canplaythrough` 等待；不改 `120ms`；不改 muted 策略；不改 `_handleCrossSegment`；不动 `_tryReloadMedia`（仅原样移交 `NotSupportedError`）；`_attemptPlay` 不得碰 state / 写 restore / 分类错误。

### 2.5 日志标准（GPT 评审补充 · 强制）

所有 PlaySession 关键事件必须带结构化前缀，供未来 AI 调试：

```
[PlaySession] <id> <STATE> <target/key> token=<n> reason=<...>
```

- `id` = session id；`STATE` = 当前态（CREATED/STARTING/MUTED_PLAYING/PLAYING/RECOVERING/PAUSED/ENDED/CANCELLED）；`token` = `recoverToken` 当前值；`reason` = 触发原因（start/recover/fatal/...）。
- **必须覆盖**：session 创建、进入 STARTING、进入 RECOVERING（含 token 自增）、恢复成功 PLAYING、恢复被拦（token 失效 / `canContinue()` 拦）、配额耗尽。
- 目的：AI 改时间轴后播放异常，Agent/Buddy 能靠日志定位属于哪一层（启动事务 / 媒体激活 / Timeline 调度），不靠猜。

---

## 3. Step B.5 实施草案（待 GPT 审）

### 3.1 目标

治「首次导入新素材后第一次播放偶发没声」。根因 = 媒体未预热 / 音频管线未稳定时，`start()` 内 120ms 兜底已解 mute。归属 **Media 生命周期层**（责任树 A 枝，B 不碰）。

### 3.2 方案（不碰 B 接口，只换 `_onMediaPlaying` 内部）

B 已用钉子4 预留 seam：`_attemptPlay` 的 `playing` 监听只调 `_onMediaPlaying(session, t)`。B.5 把 `_onMediaPlaying` 内部从「立即 `onPlaying` 解锁」升级为「**等全部 target 激活后才 `restore` 解 mute**」。`_attemptPlay` / `start` / `continueStart` **一行不动**。

### 3.3 Media Activation Gate 等待策略（已获 GPT 确认，取代 `Promise.all`）

引入 **Activation Tracker**（GPT 评审指出 `Promise.all` 全成功才解锁会致坏轨死锁，否决）：

- 常量 `MEDIA_ACTIVATION_TIMEOUT = 1000`（独立可调，适配 WebView2 / Electron / Chrome 差异，**不写死字面量**）。
- 每个 target 独立记录激活态：`{ playing:bool, readyState:int, timedOut:bool }`，三层信号：
  - **第一层**：`playing` 事件（真实播放，最高优先级）
  - **第二层**：`readyState >= 4`（`canplaythrough`，音频管线已就绪，**辅助信号**）
  - **第三层**：`timeout fallback`（≥ `MEDIA_ACTIVATION_TIMEOUT` 即标记 `timedOut`）
- **session 聚合判断（非 `Promise.all` 全成功）**：当「**包含当前播放头的 target 全部激活**（`playing` 或 `timedOut`）」即触发 `restore`。单个坏轨（损坏 / 纯静音 / 永不 `playing`）只标记 `timedOut`，**不拖死整体解锁** —— 这是否决 `Promise.all` 的核心原因。
- **激活态枚举（B.5 设计稿细化时采用，GPT 第五轮建议）**：每个 target 的激活态不建议用简单 `activated=true/false`，改用 `activationState: WAITING | PLAYING_CONFIRMED | READY_FALLBACK | TIMEOUT_DEGRADED`。区分「真 playing 确认 / readyState 猜测 / timeout 降级」三类进入播放的原因，使 AI 调试日志能回答「这个轨为什么进入播放」，不丢信息。B.5 落地时与 §2.5 的 `[PlaySession]` 日志标准对接补全格式。
- 信号优先级严格 `playing → readyState → timeout`：`readyState>=4` 不等于音频一定输出，仅作辅助，绝不反向当主判据；不引入 `AudioContext` 监听（B.5 不做，增加复杂度）。

### 3.4 B.5 同时解决 B 保留的已知张力（冻结稿 §10）

- 单 `autoplayUnlockPending` flag 全量解 mute → 因「等全部 target 激活」自然解决。
- 假 `PLAYING`（恢复失败但 120ms 提前解锁）→ 因「恢复失败不再走 120ms 提前解锁」解决。

### 3.5 待确认问题（第四轮评审已答，待 B.5 冻结稿吸收）

1. ~~timeout 1000ms 是否合适~~ → **已确认**：采用独立常量 `MEDIA_ACTIVATION_TIMEOUT = 1000`，不写死字面量（环境差异预留）。
2. **120ms 逐 target 兜底去留 → 仍待 B.5 冻结时定**：B.5 激活门成熟后，120ms 兜底在恢复路径上可能冗余；但 B 红线（B 不碰 120ms）要求此决策留在 B.5 阶段处理，不在 B 阶段动。
3. ~~Promise.all 拖死整体~~ → **已确认否决**：改用 Activation Tracker，单坏轨标记 `timedOut` 不拖死（见 §3.3）。
4. ~~readyState>=4 是否可靠~~ → **已确认**：仅辅助信号，优先级 `playing → readyState → timeout`，绝不当音频输出主判据；不引入 `AudioContext` 监听。

### 3.6 验收

首次导入新素材后第一次播放有声；拖动素材后播放有声（不变）；暂停再播有声（不变）；gap 不卡（不变）；任意位置起播有声。

---

## 4. Step C 预期方向（落地前需先出设计稿 + GPT 评审）

- **reload 收口 + 边界（GPT 评审澄清）**：C 中 `reload` 是**前置动作**（媒体重新加载），**不是恢复策略本身**；恢复策略仍是 `continueStart`。即 `_onStartError` 遇 `NotSupportedError` → `_tryReloadMedia`（重载媒体，**前置**）→ 重载成功后 → `continueStart`（恢复播放）。避免 reload 被做成「万能恢复」吞掉所有错误类型。
- **`_applyMediaState`**：集中处理 muted 写收口（冻结稿 §1.2 已提及）。
- **muted 写收口**：当前 `autoplayUnlockPending` + `mediaMuteReasons:Set` + `previewMuted` 三概念已拆（Step A），C 统一写入路径。
- B 的 `_onStartError` 届时只补一行衔接（`NotSupportedError` 走 `_tryReloadMedia`，由 C 在其成功路径尾接 `continueStart`），B 阶段保持「原样移交 `_tryReloadMedia`」红线不变。
- **⚠ 落地纪律**：C 动手前先出 `player-session-stepC.md` 设计稿 + 你终审，**不得直接编码**。

---

## 5. Step D 预期方向（同理）

- `_handleCrossSegment`（当前 L1885 强制 `playAllMedia`）改为**复用当前 session + `updateTargets()` + 生命周期保护**（ended/cancelled 不复活）。
- 复用 B 建立的 `continueStart` 单一入口 + `recoverToken` 竞态防护，自然满足「已解锁轨不被打断」。
- **⚠ 落地纪律**：D 动手前先出 `player-session-stepD.md` 设计稿 + 你终审，**不得直接编码**。

---

## 6. 评审状态（第四轮，2026-08-15 GPT 参谋）

- **Step B**：✅ 可落码。GPT 确认无架构方向性错误；补两处实现纪律（§2.1 `continueStart` 禁止复制 `start()`、§2.5 日志标准）已吸收。
- **Step B.5**：✅ 方向已确认（Activation Tracker 取代 `Promise.all` + 常量 timeout + 信号优先级）。仅剩 120ms 去留待 B.5 冻结稿定（§3.5 Q2）。
- **Step C/D**：✅ 边界已澄清（C 的 reload 为前置动作非恢复策略；D 复用 `continueStart` + `recoverToken`，现在不动）。
- **唯一残留待决**：B 实施时冻结稿 §11 伪代码合并 `start()` 当前逻辑（L1258-1284，含 `isPlaying` / `playRAF` 等外部变量）有无隐含冲突 —— 落码时由实现者（Buddy）逐行核对，不在此预判。
- **第五轮（本回合，14:2x）正式放行**：GPT 明确「可以开始 Step B」「你不用再扩展思考范围了」，确认无架构方向性改动需求。仅补 2 项**前瞻性约束**（均不属于 B 改动范围）：① B.5 激活态用枚举取代布尔（§3.3 已注）；② `target` 作抽象边界不提前绑 DOM（§9 已录）。重申 B→B.5→C→D 严格串行、不并行。

## 7. 实施节奏

`B（已冻结，可落码）` → `B.5（方向已确认，待出独立冻结稿后落码）` → `C（先设计稿）` → `D（先设计稿）`。

**每步独立 commit + push + 真机验收，不跨步、不合并。** 改前评审纪律贯穿始终。

---

## 8. 第四/五轮 GPT 评审补充（已吸收，防未来走偏）

1. **`continueStart` 必须复用 `start` 启动流程，禁止复制** —— 否则半年后 `start()` 修 bug、`continueStart` 不同步，第二套 PlayerManager 复活（本手册 §2.1 已钉）。
2. **B.5 禁用 `Promise.all` 全成功解锁** —— 单坏轨（损坏/纯静音/永不 playing）会死锁整体；改用 Activation Tracker 的 session 聚合判断，坏轨 `timedOut` 降级不拖死（§3.3）。
3. **`MEDIA_ACTIVATION_TIMEOUT` 用常量不写死** —— WebView2 / Electron / Chrome 差异预留。
4. **`readyState>=4` 仅辅助信号** —— 不等于音频一定输出，优先级 `playing → readyState → timeout`。
5. **C 的 `reload` 是前置动作非恢复策略** —— 恢复策略仍是 `continueStart`，避免 reload 变万能恢复吞掉错误类型（§4）。
6. **`recoverToken` 是 AI 操作系统必备** —— 传统播放器无此问题，AI 改时间轴时旧 play promise 回灌会污染新状态，token 天然作废旧恢复（冻结稿钉子1）。
7. **日志标准强制** —— `[PlaySession] id/state/token/reason`，未来 AI 调试定位问题层（§2.5）。
8. **不并行** —— B → 验 → B.5 设冻 → B.5 → C 设冻 → C → D 设冻 → D，严格串行。
9. **第五轮前瞻性约束（不属 B 改动）**：① B.5 激活态用 `activationState` 枚举（WAITING/PLAYING_CONFIRMED/READY_FALLBACK/TIMEOUT_DEGRADED）取代布尔，保留 AI 调试「进入播放原因」；② `target` 作抽象边界，PlayerManager 不提前耦合 DOM，未来统一经 `t.mediaElement` 访问（B 阶段保持 `t.el` 现状）。

---

## 9. 保留笔记（未来方向，不在 B 阶段动）

以下为 GPT 第五轮评审提出的**前瞻性约束**，明确**不属于 B 改动范围**，仅记录防未来走偏：

1. **`target` 作抽象边界，不提前绑 DOM** —— `_attemptPlay(session, t)` 当前经 `t.el` 访问媒体元素；未来 Timeline/Segment 演进为 `Render Target → Media Instance → video element` 时，`PlayerManager` 不应过早耦合 DOM，建议统一经 `t.mediaElement` 访问（语义化、与渲染层解耦）。B 阶段保持 `t.el` 现状不动（见 §2.1）。
2. **B.5 激活态用枚举而非布尔** —— 见 §3.3 注（与 §2.5 日志标准对接）。
