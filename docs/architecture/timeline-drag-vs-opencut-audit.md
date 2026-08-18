# 时间轴拖拽交互审计：OpenCut/FableCut 对比与根因诊断

> 日期：2026-08-18
> 范围：素材库拖入时间轴 / 拖拽预览 / 落点高亮 / 特效落轨 / 建轨模型
> 状态：**已落码（commit bd2eb76）**——dragover 零整树重建 + overlay 预览轨 + 特效绑段高亮存活；待用户真机验收。
> 触发背景：用户真机反馈 75e638e 后出现「拖入时间轴变卡（阻尼感）/ 素材无高亮 / 特效不能落轨」

---

## 一、三个真机问题的根因（铁证级）

### 问题 1：素材拖入时间轴变卡（阻尼感）—— 75e638e 引入的回归

**触发链路：**
```
dragover（HTML L2634-2677，每 mousemove 触发一次，~60Hz+）
  └─ L2663: Store._emit()
       └─ renderTimeline()（timeline.js L330）
            ├─ L337: [...content.querySelectorAll(".track, .seg")].forEach(e => e.remove())  ← 销毁全部轨道+片段 DOM
            ├─ L343: ruler.innerHTML = "" + renderRuler()                                    ← 清空重画标尺
            ├─ L377-420: 重建每个 .track / .seg / .track-label                             ← 全部重新 createElement
            └─ L429: drawAllWaves()                                                          ← 全量重绘音频波形 canvas
```

**对照组（为什么别人不卡）：**
| 项目 | dragover 期间做了什么 | DOM 操作成本 |
|---|---|---|
| FableCut（app.js L2722-2729） | `for (const row of els.tracks.children) row.classList.toggle("drop-hint", ...)` | O(轨数)，零重建，纯 CSS 类切换 |
| OpenCut（React） | 只移动一个细 `<DragLine>` 元素；React reconcile 复用节点不销毁 | O(1) 移动 + diff |
| 我们 75e638e | 每 mousemove 全量销毁重建所有轨道/片段/标尺/波形 | O(段数)，每秒 60 次 |

**结论**：卡顿根因 = dragover 里 `Store._emit()` 触发的 `renderTimeline()` 全量重建。
讽刺的是 **a9c349d 的旧实现（HTML L2590-2617）反而是对的**——清类 → computeDrop → 直接 `el.classList.add("drop-target")`，无 `_emit`，不重建。75e638e 为了"预览轨注入 + 高亮存活"错误地改成了整树重建方案。

### 问题 2：素材拖入无高亮 —— 同一根因的次生灾害

- a9c349d：`dragover` 直接对 track DOM 加 `drop-target` 类（L2606），轻量、高亮稳定。
- 75e638e：改为依赖 `renderTimeline` L405 的 `libDrop` 注入——每次 `_emit` 重建 DOM，重建期间高亮随旧节点销毁而消失，新节点上的类要等下一次 mousemove 的 computeDrop 才加上，**渲染闪烁 + 高亮几乎不可见**。
- 特效拖入时更糟：L2648-2661 的**绑段路径先拦截**（`findSegUnderCursor` 命中任何段即走绑段），绑段高亮 `drop-target-seg`（L2655）加在旧节点上，**下一次 mousemove 的 `_emit` 重建即抹掉**——高亮永远画不出来。

### 问题 3：特效不能落轨 —— 绑段拦截 + 无反馈叠加

- **绑段拦截**：拖特效时光标经过任何 video/audio/text/sticker **段**上方 → `findSegUnderCursor`（HTML L2123）命中 → `compatible` 成立 → 走「绑定到 clip」路径（L2084-2086）→ `addEffectFromLibrary(bindTo)` → 落到**特效轨 0**，而不是用户瞄准的轨。用户以为"不能落轨"，实际是被劫持去了特效轨 0。
- **无落点反馈**：绑段路径高亮加不上（见问题 2），新建轨路径的「松开：新建轨道」hint 也存在，但被卡顿掩盖。
- **后端无 bug**：`add_effect`（main.py L3449）`insert_index` 路径（L3477-3480 → `_insert_track` L371）验证过，逻辑正确。

---

## 二、OpenCut / FableCut / 我们 逐项对比表

| 维度 | OpenCut（React） | FableCut（原生 JS） | 我们（当前 75e638e） | 差距判定 |
|---|---|---|---|---|
| dragover 渲染方式 | 移动单个 `<DragLine>` 元素 | 轨道行 `classList.toggle("drop-hint")` | **每 mousemove 全量重建 DOM** | ❌ 严重差距 |
| 渲染触发时机 | React 状态驱动（diff） | RAF 帧循环 + `dirtyTimeline` 脏标记合并（L5190） | 事件驱动即时全量重建 | ❌ 严重差距 |
| 落点高亮 | CSS 类 + 状态驱动 | `drop-hint` 类切在轨道行 | 类依赖重建 DOM 存活 | ❌ 差距 |
| 落点算法 | `resolveTrackPlacement`：命中轨/间隙/上/下，统一 displayIndex | `trackAtEvent`（L2332）：纯 Y→track，轨道固定不新建 | `computeDrop`（timeline.js L181）：displayIndex 单一真源，支持间隙新建 | ✅ 优于 FableCut，与 OpenCut 同级 |
| 新建轨模型 | 动态建轨（间隙/异类型） | **固定轨**（V1/V2/V3/A1/A2），不动态建轨 | 动态建轨（间隙/异类型/空白） | ✅ 与 OpenCut 同级 |
| 特效落轨 | 拖到 clip=绑段；否则落特效轨（adjustment） | 特效=adjust clip，固定落 V3 轨 | 绑段优先 + 特效轨调整层 + 空白新建特效轨 | ✅ 逻辑齐，但绑段判定过宽（见问题 3） |
| 选中模型 | 单击/多选/框选（marquee） | 单击/多选/框选（`startMarquee` L2348） | 单击/多选（selectedKeys）/框选（pendingBox） | ✅ 已对齐 |
| 建轨后空轨清理 | — | — | `_collapse_empty_tracks`（main.py L425） | ✅ 有 |

**一句话差距**：落点算法和建轨模型我们**已经对齐甚至超过参考实现**；差距全在**渲染层**——dragover 期间不该碰整树，只该切 CSS 类 / 移 overlay 元素。

---

## 三、修复方案（函数级，待 sign-off）

### 核心原则（对标 FableCut/OpenCut 合成最优）
> **dragover 期间零整树重建。** 高亮 = 对现有 DOM 切类；新建轨预览 = overlay 元素移动；drop 才提交数据。

### 改动 1：dragover 移除 `Store._emit()`，回到轻量模型（HTML L2634-2677）
```
dragover:
  1. 清旧反馈：tlContent 内 .track 移除 drop-target/drop-preview/drop-disabled，.seg 移除 drop-target-seg
  2. computeDrop(e, wantType)
  3. existing → trackElOf(tracks[displayIndex]) 直接加 drop-target 类（a9c349d 原样恢复）
  4. new      → 移动 hint 元素到 displayRowCenterY(displayIndex)（已有）
  5. 绑段（特效）→ 对 seg DOM 直接加 drop-target-seg（不重建，类不丢）
  6. 库拖入新建轨预览轨 → 用「预埋 overlay」替代 buildTracks 注入（见改动 2）
```

### 改动 2：新建轨预览从「注入 buildTracks」改为「overlay 占位元素」（timeline.js L366-376 + HTML）
- 当前：`needPreview` → `tracks.splice(di, 0, previewTrack)` → 依赖整树重建才画得出。
- 改为：渲染时**常驻一个绝对定位的「预览轨占位」div**（虚线框 + 轨道名标签，`pointer-events:none`，z-index 高于轨道），dragover 时只改它的 `top`/`display`——OpenCut `<DragLine>` 同思路。
- 优点：预览轨位置实时跟随鼠标，零重建，不闪烁。

### 改动 3：收紧特效绑段判定（HTML L2648-2661 / L2079-2094）
- 现在：光标下有任何段即绑段 → 特效轨空白区旁的段会误拦截。
- 改为：**只有光标精确命中段本体（elementFromPoint 直接命中 .seg 或其子元素）才绑段**；命中轨道空白/间隙 → 落特效轨（existing）或新建特效轨（new）。判定阈值收紧，消除"拖特效被劫持"。

### 改动 4：保留 drop 提交逻辑不动（onTimelineDrop L2067-2104，已验证正确）
- `computeDrop`（timeline.js L181）不用改——displayIndex 单一真源模型是对的。
- 后端 `add_effect` / `_insert_track` / `add_to_timeline` 不用改。

### 改动 5：清理 75e638e 遗留
- 移除 dragover/dragleave/drop 里的 `Store._emit()`（L2653/L2663/L2681/L2683）——高亮/预览不再依赖重建存活。
- `renderTimeline` 的 `libDrop` 预览注入（L366-376、L403-405）改为 overlay 方案后删除或降级为仅 drop 后刷新使用。

---

## 四、验收清单（sign-off 后重启 start.bat 验证）

> 更新：已按 §3 落码（commit bd2eb76），以下清单即真机验收项。

1. 素材从库拖入时间轴：**全程丝滑无阻尼**（对照：拖入前后帧率无感变化）
2. 素材拖到已有视频轨：**该轨立即高亮**（虚线框 + 浅色底），松手落该轨
3. 素材拖到两轨间隙：**间隙处出现预览轨占位**（虚线框 + "叠加N预览"），松手新建该轨并落进
4. 特效拖到段上：段高亮（蓝色描边），松手绑定到该段
5. 特效拖到特效轨空白：特效轨高亮，松手落为调整层
6. 特效拖到空白/间隙：预览轨占位 + 新建特效轨落进
7. 以上全部完成后：拖拽过程中 F12 控制台无报错、无重复重建日志
