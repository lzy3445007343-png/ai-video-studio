# AI 剪辑工作台 — 架构收口路线（给参谋 GPT 评审 · 真实源码版）

> **你的角色：参谋 / 评审，不是执行。**
> 最终代码改动由我（执行方）落地。你**读不到我们的源码文件**，所以本文第四节已把关键函数的**真实代码**贴出（带行号），你无需打开文件即可评审。
> **不要给"请执行第 X 步"式指令**——你的产出是"方向判断 + 风险点 + 替代方案 + Bug A/B 真实根因定位"，我去落地。
> 如果你发现我们诊断有误（尤其第四节代码与第一节诊断对不上），直接指出来，这就是你最大的价值。

---

## 〇、3 句话背景
- **项目**：PyWebView 桌面 NLE（非线性编辑器），定位"给 Agent 操作的剪辑内核"。唯一改动文件 `工作台v0.8时间轴.html`（~3000 行单文件，UI+播放+渲染+同步全挤在内）。后端 `main.py` 本轮不动。
- **当前阶段只做音频**（视频复用同一机制、文本/贴纸/特效由 Renderer 收口、后置）。
- **铁律**：PyWebView 不热更新 → 任何改动必须重启 `start.bat` 真机验。

---

## 一、我们的问题（重要修正：架构病已大部分收口，Bug A/B 是收口未闭环）

### 1.1 用户实测现象
- **Bug A（音频跨段跳/断）**：audio-only 项目，cut 成多段后播放，播放头自己跳到下一段继续播、中间每断（有缝隙/跳变）；但只要叠一条整段视频轨就"正常"。
- **Bug B（拖播放头回弹）**：把播放头拖到某位置点播放，它会回到"之前播放的位置"继续播，不服从新拖的位置。
- 历史上还出现过：没声 / 从头播 / 旧音频误播（部分已修）。

### 1.2 架构病本质 + 我们已做的收口（关键，别再假设"还在乱"）
我们之前的核心架构病是两点：**①媒体元素八处乱碰（渲染管线拥有媒体生命周期）②媒体时钟反向当播放头 master**。
**这两点已通过 Round A~F 系列大幅收口**（代码实证见第四节）：
- **Round A**：删 `canplay` 全局委托里的第二处 `play()`，`play()` 收归 `playAllMedia()` 唯一入口。
- **Round B**：`playTick` 跨段分支从"调 `renderPreview()` 重建媒体"改为调 `seekActiveMediaToPlayhead()`（只 seek 已存在元素，绝不复建/改 src）。
- **Round C**：audio 的 `onplaying` 加 `if(!a.seeking)` 守卫，seek 未 settle 时不置 `mediaClockReady=true`。
- **Round D**：引入 `_waitSeekSettled` seek 屏障（await 真正落位再 play），消除"边 seek 边 play"竞态。
- **Round E（时钟权威收口）**：播放头改为**墙钟 master**（`playStartUs + 墙钟流逝`），新增 `correctActiveMediaDrift` **替代原 `_dominantMediaUs` 的"媒体当 master"角色**——媒体只被动纠正 >100ms 漂移，**绝不反写 `playheadUs`**。
- **Round F**：`_seekMedia` 上界钳制到 `srcEndUs`（修 split 右段反复重播）；`playAllMedia` catch 按错误类型分流（禁 blanket 静音）；`_tryReloadMedia` 守纪律不重建元素。

### 1.3 为什么仍残留 Bug A/B
上述收口后，Bug A/B **仍未干净消**。这说明：**收口差最后一截**——疑似在「跨段时序 / seek 真正落位 / 墙钟与媒体对齐的边界情况」，不是又冒了新 bug，是同一收口未闭环。
→ **请勿再假设"根因还在媒体时钟反推 master"**（那已被 Round E 收了）。请基于第四节真实代码，定位 Bug A/B 的真实残留根因。

---

## 二、我们定的目标架构（你评审时以此为准，不抄 OpenCut 的 React/TS 代码）
对齐 OpenCut 骨架的**思想**（数据模型 / 状态管理 / 播放控制 / Command）：
- **Editor**：拥有 timeline DOM，播放时冻结，只发 Command。
- **Player**：独占媒体元素；RAF 只接受 `seekTo / setActive / play / pause`，**永不主动重建**；媒体元素只能执行播放，不能决定时间轴位置。
- **Renderer**：画面合成（文本/贴纸/特效，后续）。
- **内部 Command API**：`splitClip / trimClip / moveClip / deleteClip` 封装不变量；UI 与 Agent 同走；MCP 暴露 Command，**绝不暴露 `renderAll`**。
- **时间权威铁律（Round E 已落地方向）**：播放头是 master，媒体时钟只做辅助校准，绝不反向当 master。

---

## 三、我们定的路线（修正：Step1 已大部分落地，当前重心=闭环 Bug A/B）
```
Phase 0  媒体调用地图（只读审计）          ✅ 已完成
Step 1   媒体生命周期收口 + 时钟权威       ⚠️ 主体已落地(Round A~F)，剩余=闭环 Bug A/B 残留
Step 2   时间换算集中（timelineToSource / sourceToTimeline 单一函数，灭散落 src_start）
Step 3   内部 Command 入口包装（只包入口，不重写内部）
```

**验收基线（每步改完必须满足，也是你评审的标尺）**：
1. 播放中 split 一个 clip → 无 AbortError，播放头无缝跨过切点。
2. 同轨两段音频连续播 → 第二段从自身 `src_start` 起播，不是素材 0s。
3. 播放中拖 zoom / 滚动条 → 不丢声、不重建媒体、无 canplay 风暴。
4. 0.5s 轮询在播放中 → 播放头照走，媒体元素身份不变。
5. 拖播放头到任意位置点播放 → 从新位置开始、不回弹（Bug B 验收）。
6. 音频-only 跨段无跳无断（Bug A 验收）。

**明确不做（deferred，底层未稳前禁止）**：字幕/花字/MG/情绪识别/特效原语引擎/音频混音增强/MCP 接口/Skill 封装/媒体缓存池精细复用策略。

---

## 四、当前代码真实状态（核心：你读不到文件，这里贴真实代码 + 行号 + Round 落点）

### 4.1 关键函数地图（当前真实行号）
| 函数 | 行 | 职责 / Round 落点 |
|---|---|---|
| `_seekMedia(el, seg, us)` | 1166 | 唯一 seek 入口：timeline→source 换算（含 src_start 钳制到 srcEndUs），禁第二套 |
| `_waitSeekSettled(el)` | 1187 | Round D：seek 屏障，等真正落位（700ms 安全网 L1221） |
| `_tryReloadMedia` | 1256 | Round F4：error 恢复，**不重建元素** |
| `renderPreview(s)` | 1324 | 媒体创建/复用唯一函数（按轨道 `ti` 复用元素）；跨段已不在此重建 |
| `startPlay()` | 1528 | 起播：墙钟 master 设定 → 等 ready → seek 屏障 → playAllMedia |
| `playAllMedia()` | 1596 | play 唯一入口；防抖 + 按 hits 过滤 + 静音起播 + catch 分流 |
| `correctActiveMediaDrift(us)` | 1659 | **Round E②：替代原 `_dominantMediaUs`**，被动纠偏，**不反写 playheadUs** |
| `seekActiveMediaToPlayhead(us)` | 1691 | Round B：跨段只 seek 已存在元素 + 停车 + 刷新 rec.seg/key |
| `_handleCrossSegment(us)` | 1750 | Round D：跨段异步屏障（crossSegmentPending 锁） |
| `playTick()` | 1775 | Round E①：墙钟推进 master；跨段调 `_handleCrossSegment`（不再 renderPreview） |

### 4.2 真实代码（请据此评审，不要凭空设计）

**① `_seekMedia`（L1166）— 唯一 seek 入口**
```js
function _seekMedia(el, seg, us) {
  const srcStartUs = seg.src_start || 0;
  const srcEndUs = seg.src_end || (srcStartUs + seg.duration);
  const localUs = Math.max(0, us - seg.start);
  // B2-A：上界必须是源绝对结束 srcEndUs（而非段时长），否则 split 右段反复从切点重播
  const t = Math.max(srcStartUs / 1e6, Math.min(srcEndUs / 1e6, (srcStartUs + localUs) / 1e6));
  try {
    if (Math.abs((el.currentTime || 0) - t) > 0.05) el.currentTime = t;
  } catch (e) {}
  el._seekTarget = t;   // Round F2：挂目标时间，供 _waitSeekSettled 验证落位
}
```

**② `renderPreview` 音频段（L1470-1515）— 媒体创建/复用/守卫/失活停车**
```js
  // 音频层：命中就维护 audio 元素；播放/暂停在 startPlay/pausePlay/playTick 外统一控制
  const audioHits = hits.filter(h => h.type === "audio" && h.seg.path && !isTrackMuted(h.type, h.ti));
  const activeAudioKeys = new Set();
  for (const h of audioHits) {
    const layerKey = "audio:" + h.ti;
    activeAudioKeys.add(layerKey);
    let rec = previewState.audioEls.get(layerKey);
    if (!rec) {
      const a = document.createElement("audio");
      a.muted = previewMuted;
      a.onplaying = () => { if (!a.seeking) mediaClockReady = true; };   // Round C：seek 中不置 true
      a.addEventListener("error", () => _tryReloadMedia(a, "audio", layerKey), { once: true });
      $("audioPool").appendChild(a);
      rec = { el: a, key: layerKey };
      previewState.audioEls.set(layerKey, rec);
    }
    const src = fileURL(h.seg.path);
    if (rec.el.src !== src) {
      rec.el.src = src;
      rec.el.dataset.pendingSeek = "1";
      rec.el._pendingSeg = h.seg;
      rec.el.oncanplay = () => {
        if (rec.el.dataset.pendingSeek) {
          _seekMedia(rec.el, h.seg, Store.state.playheadUs);
          rec.el.dataset.pendingSeek = "";
        }
      };
    } else {
      _seekMedia(rec.el, h.seg, us);
      if (isPlaying) rec.el.onseeked = () => { mediaClockReady = true; };
    }
    rec.key = h.key;
    rec.seg = h.seg;
  }
  // 未命中的音频暂停即可，不要 removeAttribute("src")+load()：load() 会 abort 正在进行的 play() promise
  for (const [layerKey, rec] of previewState.audioEls) {
    if (!activeAudioKeys.has(layerKey)) {
      rec.el.pause();
      rec.el.muted = true;
    }
  }
```

**③ `startPlay`（L1528）— 墙钟 master 设定 + 等 ready + seek 屏障**
```js
async function startPlay() {
  const maxUs = totalDurationUs();
  if (maxUs <= 0) { dbg("无内容可播放（时间轴为空）"); return; }
  if (Store.state.playheadUs >= maxUs - 1000) Store.set({ playheadUs: 0 });
  isPlaying = true;
  playStartWall = performance.now();
  playStartUs = Store.state.playheadUs;           // ← 墙钟基准；拖播放头后点播放应服从新位置
  mediaClockReady = false;
  _mcrWaitAt = 0;
  $("playBtn").textContent = "⏸";
  lastHitSig = resolveHits(Store.state.playheadUs).map(h => h.key).join("|");
  renderPreview();
  const withTimeout = (p, ms, label) => Promise.race([p, new Promise(r => setTimeout(() => { console.warn("[startPlay] " + label + " 总超时，强制继续"); r(); }, ms))]);
  const hits = resolveHits(Store.state.playheadUs);
  const readyPromises = hits.map(h => {
    const rec = h.type === "video" ? previewState.visualEls.get("video:" + h.ti) : previewState.audioEls.get("audio:" + h.ti);
    const el = rec ? (h.type === "video" ? rec.el.firstElementChild : rec.el) : null;
    return el ? _waitMediaReady(el) : Promise.resolve();
  });
  await withTimeout(Promise.all(readyPromises), 5000, "等待媒体就绪");
  const seeked = seekActiveMediaToPlayhead(Store.state.playheadUs);
  await withTimeout(Promise.all(seeked.map(_waitSeekSettled)), 5000, "等待 seek 落位");
  playAllMedia();
  playTick();
}
```

**④ `playAllMedia`（L1596）— play 唯一入口 + catch 分流**
```js
function playAllMedia() {
  const now = performance.now();
  if (now - _lastPlayAll < 250) return;   // 防抖：250ms 内不重复整批 play，避免 AbortError
  _lastPlayAll = now;
  const hits = resolveHits(Store.state.playheadUs);
  const activeKeys = new Set(hits.map(h => h.key));
  const attempt = (el, rec, type, ti) => {
    if (!el || !el.paused) return;
    const want = wantSound(type, ti);
    el.muted = true;                        // Round G2：静音起播（autoplay 适配），playing 事件再解除
    const restore = () => {
      const stillActive = resolveHits(Store.state.playheadUs).some(h => h.key === rec.key);
      el.muted = !(stillActive && want);
    };
    el.addEventListener("playing", restore, { once: true });
    const p = el.play();
    if (p && p.then) p.then(restore, restore);
    setTimeout(restore, 80);
    if (p && p.catch) p.catch(err => {
      const name = (err && err.name) || "Error";
      if (name === "AbortError") {
        setTimeout(() => { if (isPlaying && el.paused) { const r = el.play(); if (r && r.catch) r.catch(() => {}); } }, 60);
      } else if (name === "NotSupportedError") {
        _tryReloadMedia(el, type, rec.key || (type + ":" + ti));
      } else {
        console.warn("[playAllMedia] 播放错误:", name, rec.key, err);
        showFatal("⚠ 播放错误(" + (rec.key || type) + ")：" + name + " — 详见控制台");
      }
    });
  };
  for (const [, rec] of previewState.visualEls) {
    if (rec.el.style.display === "none") continue;
    const v = rec.el.firstElementChild;
    if (v && v.tagName === "VIDEO") {
      const ti = parseInt((rec.key || "video:0").split(":")[1], 10) || 0;
      if (!activeKeys.has(rec.key)) { if (!v.paused) { v.pause(); v.muted = true; } continue; }
      attempt(v, rec, "video", ti);
    }
  }
  for (const [, rec] of previewState.audioEls) {
    const ti = parseInt((rec.key || "audio:0").split(":")[1], 10) || 0;
    if (!activeKeys.has(rec.key)) { if (!rec.el.paused) { rec.el.pause(); rec.el.muted = true; } continue; }
    attempt(rec.el, rec, "audio", ti);
  }
}
```

**⑤ `correctActiveMediaDrift`（L1659）— Round E② 替代 `_dominantMediaUs`，只被动纠偏**
```js
// Round E②：替代原 _dominantMediaUs 的"媒体当 master"角色。播放头是 master（墙钟）。
// 媒体若因缓冲/解码滞后偏离播放头 >100ms，才把它 seek 回正确位置；绝不反写 playheadUs。
function correctActiveMediaDrift(us) {
  const hits = resolveHits(us);
  const consider = (rec, type) => {
    if (!rec) return;
    const el = type === "video" ? rec.el.firstElementChild : rec.el;
    if (!el || el.paused || el.seeking) return;
    const s = rec.seg; if (!s) return;
    const srcStartUs = s.src_start || 0;
    const srcEndUs = s.src_end || (srcStartUs + s.duration);
    const ct = el.currentTime || 0;
    const ssSec = srcStartUs / 1e6, endSec = srcEndUs / 1e6;
    // 跨段 seek 没真正落位（WebView2 下 audio 常见：seeked 后 play() 又冲回 0）→ 强制 seek
    if (ct < ssSec - 0.1 || ct > endSec + 0.1) { _seekMedia(el, s, us); return; }
    const mapped = s.start + (ct * 1e6 - srcStartUs);
    if (mapped < s.start || mapped > s.start + s.duration) return;  // 映射过期 → 跳过，交 _handleCrossSegment
    if (Math.abs(mapped - us) > 100000) _seekMedia(el, s, us);      // 仅 >100ms 大漂移才纠正
  };
  for (const h of hits) {
    if (h.type === "video") consider(previewState.visualEls.get("video:" + h.ti), "video");
    else if (h.type === "audio") consider(previewState.audioEls.get("audio:" + h.ti), "audio");
  }
}
```

**⑥ `seekActiveMediaToPlayhead`（L1691）— Round B 跨段只 seek**
```js
function seekActiveMediaToPlayhead(us) {
  const hits = resolveHits(us);
  const seeked = [];
  const activeVideoTis = new Set(hits.filter(h => h.type === "video").map(h => h.ti));
  const activeAudioTis = new Set(hits.filter(h => h.type === "audio").map(h => h.ti));
  for (const [layerKey, rec] of previewState.audioEls) {
    const a = rec.el; if (!a) continue;
    const ti = parseInt(layerKey.split(":")[1], 10);
    if (!activeAudioTis.has(ti)) { a.pause(); a.muted = true; }
    else a.muted = previewMuted || isTrackMuted("audio", ti);
  }
  let allReady = true;
  for (const h of hits) {
    if (h.type !== "video" && h.type !== "audio") continue;
    let el = null, rec = null;
    if (h.type === "audio") { const a = previewState.audioEls.get("audio:" + h.ti); rec = a; el = a ? a.el : null; }
    if (!el) { allReady = false; continue; }
    if (rec && (rec.seg !== h.seg || rec.key !== h.key)) { rec.seg = h.seg; rec.key = h.key; } // B2-B
    _seekMedia(el, h.seg, us);
    seeked.push(el);
    if (isPlaying) el.onseeked = () => { mediaClockReady = true; };
  }
  if (!allReady && !previewState.isRepairing) {
    previewState.isRepairing = true;
    renderPreview();   // 安全降级：仅缺失元素重建一次
    setTimeout(() => { previewState.isRepairing = false; }, 120);
  }
  return seeked;
}
```

**⑦ `_handleCrossSegment` + `playTick`（L1750-1821）— 墙钟 master + 跨段异步屏障**
```js
let crossSegmentPending = false, crossSegmentQueuedUs = null;
async function _handleCrossSegment(us) {
  if (crossSegmentPending) { crossSegmentQueuedUs = us; return; }
  crossSegmentPending = true;
  try {
    let target = us;
    while (target != null) {
      mediaClockReady = false;
      _mcrWaitAt = 0;
      const seeked = seekActiveMediaToPlayhead(target);   // Round B：跨段只 seek，绝不复建
      await Promise.all(seeked.map(_waitSeekSettled));
      const currentUs = Store.state.playheadUs;
      if (currentUs !== target) {                          // Round E③：屏障后重读当前播放头再对齐
        const seeked2 = seekActiveMediaToPlayhead(currentUs);
        await Promise.all(seeked2.map(_waitSeekSettled));
      }
      if (isPlaying) { _lastPlayAll = 0; playAllMedia(); }
      target = crossSegmentQueuedUs; crossSegmentQueuedUs = null;
    }
  } finally { crossSegmentPending = false; }
}

function playTick() {
  if (!isPlaying) return;
  const now = performance.now();
  const maxUs = totalDurationUs();
  // Round E①：播放头永远由墙钟推进，是 master。媒体只负责跟着播、被动纠正 drift
  const wallUs = playStartUs + (now - playStartWall) * 1000;
  let us = wallUs;
  if (!mediaClockReady) {                                  // D：800ms 未 ready 则重试 playAllMedia
    if (!_mcrWaitAt) _mcrWaitAt = now;
    else if (now - _mcrWaitAt > 800) { playAllMedia(); _mcrWaitAt = now; }
  } else { _mcrWaitAt = 0; }
  if (us >= maxUs) { Store.state.playheadUs = maxUs; positionPlayhead(); renderTimecode(); pausePlay(); return; }
  if (!hasPlayableAt(us)) { /* 纯空隙：播放头沿墙钟自然穿过，静音滑到下一素材 */ }
  correctActiveMediaDrift(us);
  Store.state.playheadUs = us;
  positionPlayhead(); renderTimecode(); applyKfLiveAll();
  const hits = resolveHits(us);
  const keySig = hits.map(h => h.key).join("|");
  if (keySig !== lastHitSig) {                             // 仅跨段换源才处理；同段内靠浏览器自然播放
    lastHitSig = keySig;
    _handleCrossSegment(us);                               // ← 已不调 renderPreview，改调 seek 屏障
  }
  playRAF = requestAnimationFrame(playTick);
}
```

### 4.3 `_waitSeekSettled` 关键（L1187-1227）— seek 屏障，700ms 安全网
```js
function _waitSeekSettled(el) {
  return new Promise((resolve) => {
    // ... 监听 seeked + 轮询 80ms 验证 currentTime 真正接近 _seekTarget ...
    setTimeout(() => {   // L1221：700ms 内仍未落位 → 强制放行，避免永久死锁
      if (fired) return;
      console.warn("[_waitSeekSettled] 超时放行(媒体可能未加载):", el.tagName, ...);
      cleanup();
    }, 700);
  });
}
```

---

## 五、我们试过 / 已否的方案（防你重复建议）
**已落（见第四节代码）**：Round A~F 全部（删第二处 play / 跨段改 seek / onplaying 守卫 / seek 屏障 / 墙钟 master + correctActiveMediaDrift / src_end 钳制 / catch 分流 / reload 恢复）。

**已否掉、请勿再提**：
- ❌ "裸删 `renderPreview` 跨段调用" → 会引入"中间段媒体从未创建→静默不播"新 bug（renderPreview 已演进为按轨道复用元素）。
- ❌ "抽漂亮 Player 对象" → 3000+ 行单 HTML 里 UI/状态/播放/渲染混在一起，直接抽对象 AI 易复制播放代码；当前只求"播放期间媒体不死"。
- ❌ "全量预建 ensureAllMediaReady" → 1000 素材点播放卡死，已改窗口化。
- ❌ "重写整个 HTML" / "新建第二套播放" / "重构 renderPreview" / "改数据结构" / "改 main.py" / "改 UI"。
- ❌ "blanket `el.muted=true` 静音兜底" → 掩盖播放器状态 bug；已改按错误类型分流。

---

## 六、请参谋 GPT 评审的 5 个问题（基于第四节真实代码回答）
1. **诊断修正确认**：我们判断"架构病（八处乱碰媒体 / 媒体时钟反推 master）已通过 Round A~F 大部分收口，Bug A/B 是收口未闭环"——这个判断对吗？第四节代码与第一节对得上吗？有没有我们漏的根因？
2. **⭐ Bug A（音频跨段跳/断）真实残留根因**：基于真实代码，最可能是哪处？我们怀疑三处候选——① `correctActiveMediaDrift` L1674（`ct < ssSec-0.1` 强制 seek）在跨段边界与 `_handleCrossSegment` 的 seek 互相触发 → 反复 seek/闪；② `_waitSeekSettled` L1221 的 700ms 安全网过早放行（WebView2 下 audio seek 慢）→ 媒体未真正落位就被 `playAllMedia` 起播 → 从头播/跳；③ `onseeked` L1734 跨段置 `mediaClockReady=true` 但 seek 实际未落位（与 ② 同源）。请据代码判断真因与治本改法。
3. **⭐ Bug B（拖播放头回弹）真实残留根因**：拖播放头后点播放应服从新位置（`startPlay` 用 `playStartUs=Store.state.playheadUs` 重设墙钟基准）。回弹说明某处把播放头拽回旧位置——嫌疑：① 拖播放头的交互 handler 没正确写 `Store.state.playheadUs` 或没重置 `playStartWall/playStartUs`；② 0.5s 轮询 `refresh` 某处重置了播放头；③ `correctActiveMediaDrift` 在拖动后误判。请据代码（grep `Store.state.playheadUs =` 的所有写入点）定位。
4. **Step1 收口是否算完成**：grep 验证"播放期间是否还有媒体被重建"——`playTick` 跨段 L1818 已改 `_handleCrossSegment`（不调 renderPreview）；`renderPreview` 仅结构变更/缺失降级调用。是否还有漏网的重建通路？
5. **路线 / 范围**：`Phase0→Step1(闭环Bug A/B)→Step2(时间换算集中)→Step3(Command)` 顺序与范围合理吗？有没有某项其实属于"地基"被我们误关在门外？

---

## 七、硬约束（你评审不能跳出）
- 不重写单 HTML / 不新建 Player 模块 / 不第二套播放 / 不碰 `main.py` / 不改数据结构 / 不改 UI 布局。
- 任何 seek 只经 `_seekMedia`，不准散写 `el.currentTime=xxx`（除 `_seekMedia` 内部与 `_waitSeekSettled` 兜底）。
- 每步独立可回退 + 抽内联 JS 跑 `node --check` + 重启 `start.bat` 真机验。
- 范围：音频优先，视频复用，文本/贴纸/特效/Renderer 后置；不扩功能。

---

## 八、相关文件（你无需读，本文第四节已贴关键代码）
- `架构收口路线_参谋briefing.md` — 本文
- `P0重构实施计划v2.md` — 架构收口计划 v2.2（背景，但其"Step1 拆 Round A/B/C"表述已演进为 A~F，以本文第四节代码为准）
- `项目交接状态_给新GPT.md` — 执行向交接（部分 Round 状态描述已落后于当前代码，以本文为准）
- `工作台v0.8时间轴.html` — 唯一改动文件（当前 = Round F 后 + Bug A/B 残留状态）
- `工作台v0.8时间轴.html.bak` / 各 `Step1_*_backup.html` — 回退链
