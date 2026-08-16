# 视频播放器 A/B Pool 设计稿（Preview Renderer 稳定化）

> 版本：v0.1（2026-08-16 21:00）
> 背景：播放器跨段"反复播开头"根因已定位——WebView2（Chromium）下 video 元素 seek 到当前缓冲范围外时触发媒体管线重置（readyState 4→1，位置丢失）。打补丁修 seek 时机无效，因为"seek→重置→丢位置"是浏览器固有行为。
> 目标：把"seek 失败"从用户视线移走——**后台预加载下一段，切段时 swap 无感**。这属于 Preview Renderer 内部优化，不改变"Timeline 驱动"架构（Playback Graph 已落地）。

---

## 0. 为什么是 A/B Pool（而非 canvas 逐帧）

| 路线 | 成本 | 是否当前必须 |
|------|------|------------|
| **A/B Pool（本设计）** | 半天 | ✅ 当前堵点 |
| canvas 逐帧渲染 | 2-3 天 | ❌ 第二阶段（导出走剪映草稿，不依赖 render tree） |
| WebCodecs/WebGL | 更远 | ❌ 后置 |

**核心逻辑**：video 元素只当"解码器+预加载器"，我们不再在播放中 seek 它——切换前就 seek 好、ready 好，切换瞬间只是 swap 显示。

---

## 1. 现状（问题结构）

```
previewState.visualEls: key="video:0"（轨级），value={el, key, mtype, path}
  每轨只有一个元素
  切段（keySig 变化）→ destroy 旧元素 → renderPreview 建新元素
    → 新元素加载（0→1→4）→ seek 5.572（缓冲外）→ Chromium 重置 → readyState 掉回 1
    → play 从 0 起播 → 用户看到"反复播开头"
```

**问题本质**：切段时"建元素+加载+seek"全发生在用户可见的 Active 路径上。

---

## 2. 目标结构：每轨双槽（active / prepare）

```
previewState.visualEls: key="video:0"（轨级不变），value={
  el: wrap,            // Active 元素（当前显示的）
  prepare: wrap|null,  // Prepare 元素（后台预加载的下一段）
  key, mtype, path, seg
}
```

### 2.1 双槽职责

| 槽 | 职责 | 显示 |
|----|------|------|
| **Active** | 当前段播放 | display=""（可见） |
| **Prepare** | 下一段后台加载+seek+ready | display=none（隐藏） |

### 2.2 切换流程（keySig 变化时）

```
切段瞬间：
  1. Active 显示最后一帧（或淡出，0.15s opacity）
  2. Prepare 已 ready → display=""（可见）→ 从正确位置起播
  3. 旧 Active → display=none → 变成新 Prepare（加载段 N+2）
  → 用户无感，无 seek 等待，无 readyState 抖动可见
```

### 2.3 预加载调度（核心）

```
播放段 N（startUs=6s, srcStartUs=5s）时：
  Prepare 槽 = 段 N+1（同轨内 start 最小且 > N.start 的段）
    ① setMediaSrc(prepare, 段N+1.path)
    ② PlayerManager.seek(prepare, 段N+1, 段N+1.startUs)   ← 后台 seek，失败重试一次
    ③ 等 canplay（readyState>=2）→ 标记 ready
  若同素材（path 相同）→ seek 后台完成即可（Chromium 共享缓存，快）
  若不同素材 → 后台加载+seek，切段时可能还没 ready → 等 500ms 或降级 Active 重载
```

**数据来源**：`buildPlaybackGraph(Store.state.draft, Store.state.materials).videoNodes` —— 已平铺（含 startUs/srcStartUs/srcEndUs/path/key），直接按 startUs 排序找下一段。

---

## 3. 改动点（函数级）

### 3.1 media.js — previewState 结构扩展

```js
// 现状
previewState.visualEls.get(key) → {el, key, mtype, path}
// 改后
previewState.visualEls.get(key) → {el, prepare, key, mtype, path, seg}
```

- `PlayerManager.destroy(key)`：同时清 active + prepare 两个 wrap（按 key 全清）
- `PlayerManager.create`：不变（仍建单个元素，双槽由 renderer 管理）

### 3.2 renderer.js — renderPreview 双槽维护

```
renderPreview(s)：
  Active 槽：现有逻辑（命中段 → _setVisualContent + seek）——**只在段变化时 seek**（playTick 已保证）
  Prepare 槽（新增）：
    nextNode = 从 videoNodes 找同轨下一段
    if nextNode 且 prepare 未 ready：
      prepare 建元素（若无）→ setMediaSrc → seek(nextNode) → 等 canplay → 标记 ready
```

### 3.3 player.js — seekActiveMediaToPlayhead / _handleCrossSegment

```
seekActiveMediaToPlayhead(us)：
  Active 槽：段变化时 destroy→重建（现有 key 判断保留）
  Prepare 槽：**不参与**（它是后台任务，seek 由 renderPreview 的预加载调度负责）

_handleCrossSegment(us)：
  不再"seek Active 换内容"（那是重置源）
  改为：Prepare 已 ready → swap（Active=Prepare, 旧 Active 转 Prepare 预加载 N+2）
       Prepare 未 ready → 降级：Active 重载一次（现有逻辑兜底）
```

### 3.4 播放期轮询（Phase E 已有）配合

```
refresh() 检测 draft 变化 → 重平铺 → 预加载调度重新计算 nextNode
（不影响播放头墙钟）
```

---

## 4. 内存策略

| 项 | 策略 |
|----|------|
| 元素数量 | 每轨最多 2 个（active+prepare），多轨 = 2×轨数（当前 2 轨 = 4 个，可控） |
| 同素材缓存 | 同一 URL 的多个 video 元素共享 Chromium 缓存（98MB MP4 不会翻倍） |
| prepare 释放 | 切段后旧 active 转 prepare 时，先清 src（removeAttribute+load）再复用，避免积压 |
| 大素材 | 4K 素材才考虑单槽降级（后置，当前 1080p 无压力） |

---

## 5. 边界与降级

| 场景 | 处理 |
|------|------|
| 切段时 prepare 未 ready（不同素材加载慢） | 降级：Active 重载一次（现有逻辑兜底，用户看到短暂黑屏但能播） |
| 拖动 seek（非播放切段） | 不依赖 prepare——Active 直接 seek（交互操作，可接受短暂缓冲） |
| 间隙（无素材） | 双槽都 hide，prepare 预加载下一段（不中断） |
| 播放头跳转（点击标尺） | 直接 seek Active + 重新调度 prepare（对齐目标段） |

---

## 6. 验收标准（真机）

| # | 项 | 通过标准 |
|---|----|---------|
| V1 | 3+3 段 17s 连续播放 | 全程无"反复播开头"、无可见重载卡顿 |
| V2 | 跨段时刻 | F12 日志：切段前 prepare 已 ready（无 seek 重置日志） |
| V3 | 同素材切段 | Chromium 共享缓存，切段 <200ms 无感 |
| V4 | 拖动 seek | 点击标尺/拖动播放头直接定位，无死循环 |
| V5 | 播放中 AI 改时间轴 | 重平铺后预加载正确（Phase E 衔接） |

---

## 7. 落地顺序（半天）

```
C.5-1  previewState 双槽结构 + destroy 全清（30 分钟）
C.5-2  renderPreview 预加载调度（nextNode 查找 + 后台 seek + ready 标记）（1 小时）
C.5-3  _handleCrossSegment swap 逻辑 + 降级兜底（40 分钟）
C.5-4  拖动 seek / 间隙 / 跳转边界（30 分钟）
C.5-5  真机验收 V1-V5（30 分钟）
```

每步独立 commit，中途不交付验收（避免误导）。

---

## 8. 与既有架构的关系（不冲突确认）

| 既有件 | 关系 |
|--------|------|
| Playback Graph（playback-graph.js） | 预加载调度的数据源（videoNodes 平铺）——**复用，不改** |
| AudioEngine（audio-engine.js） | 音频轨已 Web Audio，video 内嵌声跟 Active 元素走——**不受影响** |
| Command 层 / MCP | 播放器内部改动，不碰写操作层 |
| REGRESSION.md | V1-V5 落进回归基线 |
