# Step B.5.4 — Media Lifecycle Ownership 收口设计稿（v1.1 真机回归修正）

> 状态：**v1.1 已落码，待真机验收**（提交见仓库 git log，hash 在文末）。
> 日期：2026-08-15
> 上游方案：`player-session-stepB5-mediaActivation-contract.md`（B.5 Media Activation Contract v1.1）
> 关联路线：ADR-001 §路线冻结 `B→B.5→C→D→Operation Schema→Command→Timeline→MCP→Skill→Agent`

---

## 0. 一句话定位

B.5.4 不是「再修一个播放 bug」，而是把**媒体生命周期的所有权（Media Ownership）**和**播放事务（Play Transaction）**从分散在 11 个调用点的隐式状态，收口为少数几个有名字、可追溯、单一职责的函数。这是 `player-ownership.md` facade-first 收口在「播放路径」这一侧的收尾。

**明确不做的**：不重写播放器，不碰渲染路径（`renderPreview` / `_setVisualContent` / pool-create / release），不扩大成 Runtime 重构。

---

## 1. 问题上升到哪一层

B.5.3 之前我们治的是「播放器架构」（PlaySession 状态机、激活门、handoff 契约）。B.5.4 用户实测后指出：残留问题不在重架构，而在**媒体元素自身的生命周期没人单一拥有**——

- `el.muted` 被 **11 处** 直接赋值（seek / drift / playAllMedia / 激活门 / renderPreview / pool-create / release / toggleMute 等），谁最后碰了 muted 不可追溯；
- `startPlay` 里 `await renderPreview()` 之后才首次 `play()`，此时用户手势上下文已过，WebView2 偶发 `NotAllowedError`；
- `pause()` 把 session 设为 `CANCELLED`，导致 `resume()` 只能当 cold start 重走一遍，`PAUSED` 态形同虚设、复用不了已有激活状态；
- `_handoff` 里 target 的新增/移除是隐式的（靠 `_attemptPlay` 的 `!el.paused` 早返守卫和 inactive-park 兜底），没有「target 生命周期 diff」可观测。

这四条的根因是同一件事：**媒体元素的「该不该静音 / 谁在播 / 现在属于哪个 session」没有单一写者**。B.5.4 把这件事收口。

---

## 2. 用户批准的修订版约束（5 条，全部落实）

| # | 约束 | 落点 |
|---|------|------|
| ① | 保留 `inactive-park`（失活停车静音），只删 active-restore（恢复时重写 muted 的双写），ownership 边界才正确 | Edit 2/3（seek 2070/2079）、Edit 4（drift 1831） |
| ② | drift 1831 的 `media.muted = isTrackMuted()||previewMuted` 双写与激活门冲突，一并删 | Edit 4 |
| ③ | `primeMediaPlayback` 改 `await Promise.race([play(), 100ms])` 后 `pause()`，防 WebView2 幽灵态（只拿权限不进 Playing、不触发 seek） | Edit 5/6 |
| ④ | `pause/resume` 不叫 handoff，新增 `_PLAY_REASON.RESUME`；resume 流程 = `PAUSED→resumeCurrentSession→prime→restore position→play existing→restart playTick` | Edit 7 + _PLAY_REASON 加 RESUME |
| ⑤ | `MEDIA_TARGET_STATE` 只日志显式化防回归，**不反向控制行为** | Edit 8 |

---

## 3. 改动清单（仅动播放路径，不碰渲染路径）

### B.5.4-0 `setMediaMute` 统一日志包装（单一 muted 写者）
```javascript
function setMediaMute(el, value, reason, label) {
  if (!el) return;
  el.muted = value;                                   // 唯一真正写 el.muted 的播放路径入口
  console.log("[MUTE]", label || (el.tagName || "?"), "->", value, "reason=" + reason);
}
```
全局所有播放路径的 `el.muted = ...` 全部改为 `setMediaMute(el, value, reason, label)`。grep 复核：播放路径已 0 处裸写（仅剩 `setMediaMute` 内部 1 处 + render-cache 的 `dataset.muted` 1679/1683 非音频静音）。

### B.5.4-1 删除 active muted 写入，保留 inactive-park
`seekActiveMediaToPlayhead`（~2069-2080）：
- 失活元素：`pause()` + `setMediaMute(el, true, "inactive-park", layerKey)`（**保留**，拖动 scrub 与 drift 两调用方不走 play()，删了会回归背景漏音）；
- 活动元素：原 `else if (v.muted = isTrackMuted||previewMuted)` / `else a.muted=...` **删除**（active 的 muted 归 Activation Gate，不再在此双写）。

`drift` 路径（~1831）：删除 `if (media.tagName === "VIDEO") media.muted = ...` 双写，加注释「re-seek 时不再写 muted（与激活门双写）」。

### B.5.4-2 `primeMediaPlayback` 手势预热
仅在**用户手势上下文内**（`startPlay` / `resume` 同步段）对即将播放的元素做：
```javascript
async function primeMediaPlayback(hits) {
  for (const h of hits) {
    if (h.type !== "video" && h.type !== "audio") continue;
    const rec = ...; const el = ...;
    if (!el || el.error) continue;
    setMediaMute(el, true, "prime", h.key);
    try { await Promise.race([el.play(), new Promise(r => setTimeout(r, 100))]); } catch (e) {}
    el.pause();   // 保留 currentTime，不触发 seek / 不进 Playing 态
  }
}
```
调用点：`startPlay`（Edit 6，在 `await renderPreview` 之后、`await` 屏障之前插入）+ `resume`（Edit 7）。

### B.5.4-3 `PlayerManager.resume()` 复用 PAUSED session
前提：`pause()` 只置 `state = PAUSED`，**不** `CANCELLED`，故 `isCurrent()` 仍 `true`，resume 可安全复用。
流程：`unlockAudio → isPlaying=true → 建 targets（inactive-park 失活）→ primeMediaPlayback → seekActiveMediaToPlayhead(当前播放头) → 更新 session.targets → state=STARTING → _attemptPlay 每个 target → state=MUTED_PLAYING → autoplayUnlockPending=false → _cleanupAllActivation → playTick`。
降级：若 `hits.length>0 && targets.length===0`（如媒体已释放），返回 `false` 让 `togglePlay` 回退 `startPlay`。

`togglePlay`（~2040）：
```javascript
function togglePlay() {
  if (isPlaying) { pausePlay(); return; }
  if (currentSession && currentSession.isCurrent() && currentSession.state === PLAY_SESSION_STATE.PAUSED) {
    if (PlayerManager.resume()) return;   // 复用 PAUSED session
  }
  startPlay();
}
```

### B.5.4-4 `MEDIA_TARGET_STATE` 显式化日志
```javascript
const MEDIA_TARGET_STATE = Object.freeze({
  UNKNOWN:"UNKNOWN", ACTIVE:"ACTIVE", PARKED:"PARKED", ENTERING:"ENTERING", LEAVING:"LEAVING",
});
```
`_handoff`（~1355）新增 target diff 日志（**只读，不反向控制行为**）：
```javascript
const oldKeys = new Set((session.targets||[]).map(t=>t.key));
const newKeys = new Set(targets.map(t=>t.key));
for (const t of targets) console.log("[target diff]", t.key, oldKeys.has(t.key)?MEDIA_TARGET_STATE.ACTIVE:MEDIA_TARGET_STATE.ENTERING);
for (const k of oldKeys) if (!newKeys.has(k)) console.log("[target diff]", k, MEDIA_TARGET_STATE.LEAVING);
```

---

## 4. 所有权边界模型（inactive-park vs active-restore）

```
                        媒体元素的 muted 值由谁决定？
   ┌─────────────────────────────────────────────────────────┐
   │ seekActiveMediaToPlayhead（拖动 scrub / drift）            │
   │   失活元素 → pause() + setMediaMute(true, "inactive-park") │  ← 停车静音（保留）
   │   活动元素 → 不写 muted（交给 Activation Gate）            │  ← 删 active-restore（双写源）
   ├─────────────────────────────────────────────────────────┤
   │ Activation Gate（_setActivation / _attemptPlay）          │
   │   活动元素 → 统一解 mute（START/RECOVER/HANDOFF/RESUME）  │  ← 活元素的唯一静音权威
   └─────────────────────────────────────────────────────────┘
```

设计纪律：**seek/drift 只负责「失活停车」和「currentTime」，不负责活动元素的静音**；活动元素的静音永远归 Activation Gate。这消除了原 active-restore 与激活门的双写竞争（B.5.4-1 的根因）。

---

## 5. 验证状态

- **语法**：抽取内联 `<script>` 块写临时 `.js` → `node --check` → `SYNTAX_OK`；临时文件已删。
- **grep 复核**：`el.muted =` 播放路径 0 处裸写（仅 `setMediaMute` 内部 + render-cache `dataset.muted`）。
- **符号接线**：`RESUME`(1199) / `primeMediaPlayback`(2054, 2083, 1610) / `MEDIA_TARGET_STATE`(1203, 1357, 1358) / `setMediaMute`(1213) / `resume()`(1583, 1618, 2047) 全部命中。
- **未做**：真机播放验收（依赖用户在 WorkBuddy PyWebView 环境实测）。

---

## 6. 真机验收清单（6 项，按优先级）

| 场景 | 操作 | 期望 | 反例（已修） |
|------|------|------|--------------|
| ① 首播 | 导入视频 → 点 ▶ | 画面动 + 有声，无红条 | 画面不动 / autoplay 红条 |
| ② 纯 MP3 | 只导音频 → 点 ▶ | 有声，播放头走 | 纯音频无声 |
| ③ 跨段 | 多 clip 连续播放 | 段切换无缝，不掉声 | 段边界掉声 |
| ④ 拖动 | 拖动播放头到中段 → ▶ | 从指定位置播，背景不漏音 | 拖后背景漏音 |
| ⑤ 暂停/恢复 | 播中按空格暂停 → 再按 | 从原位置继续，有声 | resume 当 cold start 重播/无声 |
| ⑥ 音视频同播 | 视频轨+音频轨同帧 | 两者同步播放 | 其一被静音/抢时钟 |

验收通过标准：上述 6 项零异常 + 控制台 `[MUTE]`/`[target diff]` 日志可追溯（每个 muted 变化都能对应一个 reason）。

---

## 7. 后续（归 C/D）

- **C/D 待设计**：reload 收口、`Media Reconciliation` 协议（Timeline mutation → 媒体生命周期重同步，AI 改时间轴后播放器不播旧媒体）、"拉长切开片段声音异常"（数据模型 `src_start/src_end/duration` 未同步重算，归 Command 收口）。
- B.5.4 不解决**数据模型层**问题（split 拉长异常），那是 C/D 的职责，不在媒体生命周期范围内。

---

## 8. 与既有文档关系

- 本稿是 `player-session-stepB5-mediaActivation-contract.md`（B.5 v1.1）在「播放路径 muted 所有权 + session 复用 + target 可观测」侧的收尾，二者同属 `player-ownership.md` facade-first 收口。
- 不替代、不推翻 B.5 激活门；B.5.4 是在其之上收口 muted 写者与 session 生命周期。

---

## 9. v1.1 真机回归修正（2026-08-15 17:00）

**真机现象**：①纯 MP3 首播无声 ②MP4 首播卡住、无画面无声音（比 B.5.4 之前更糟，属回归）。

**根因**：B.5.4-2 原实现 `primeMediaPlayback` 对**真实时间轴元素**做 `el.play()` + `el.pause()`，且在 `startPlay` 里**未 `await`**。race 序列：
1. prime 的 `el.play()` 已发起、还没走到 `el.pause()`；
2. 主流程已进 `_waitMediaReady → seekActiveMediaToPlayhead → playAllMedia → _attemptPlay`；
3. `_attemptPlay` 见 `!el.paused`（元素还在 prime 的 play 态）→ 早返当「已在播」，不真正起播；
4. 随后 prime 的 `el.pause()` 落盘把元素暂停 → session 以为在播、媒体实际被暂停 → 卡死/无声；
5. `play()` 被 `pause()` 打断还会让 WebView2 对该元素后续 `play()` 进入「被中断」态，再点也起不来。

**修正（v1.1，commit 5f1d79b）**：
1. `primeMediaPlayback` 改用**临时隐藏 `<audio>`**（`_getSilentPrimeUrl()` 动态生成 0.2s 静音 WAV Blob URL）拿**文档级** autoplay 权限，绝不碰真实时间轴元素。autoplay 权限是文档级持久的——临时元素在手势内 play 成功一次后，后续真实元素 `play()` 不再受手势限制。
2. `startPlay` 里 `await primeMediaPlayback(hits)`（放在一切 `await` 之前，手势仍有效时完成解锁）。
3. `resume()` 里 `autoplayUnlockPending` 由 `false` 改回 `true`（恢复也走 Session 门，全体激活后整批解 mute），并去掉提前的 `_cleanupAllActivation`（原来会移除激活监听、致元素卡在 WAITING 永远静音）。

**验证**：`node --check` 语法通过（160505 字符单 script 块）。待真机 6 项验收。
