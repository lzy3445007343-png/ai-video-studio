# 昨日+今日新增功能 · 数据流对比与完整性审计

> 日期：2026-08-16
> 方法：逐项 5 环节审计（前端 UI → 监听 → IPC/Command → 后端 → 反馈），对照 OpenCut 或自身逻辑，**诚实标注 ✅ 完整 / ⚠️ 半成品 / ❌ 未做 / ❓ 待验证**。
> 范围：昨晚（08-15）+ 今早（08-16）所有 commit。

---

## 总览表

| # | 功能 | UI | 监听 | IPC/Command | 后端 | 反馈 | 评级 | 主要问题 |
|---|------|----|------|------------|------|------|------|----------|
| 1 | 拆 JS（store/media/player/timeline/renderer） | - | - | - | - | ✅ | **✅** | - |
| 2 | 播放隔离（9 变量收口） | - | - | - | - | ✅ | **✅** | - |
| 3 | Asset 分离（resolveSegPath + material_id） | - | - | - | - | ✅ | **✅** | - |
| 4 | 回归基线 REGRESSION.md | - | - | - | - | ✅ | **✅** | - |
| 5 | Command 层（CommandManager + execute + audit） | - | - | - | - | ✅ | **✅** | - |
| 6 | UI 对齐（面板 280px + 2 列网格） | - | - | - | - | ✅ | **✅** | - |
| 7 | PropertiesPanel 路由（7 tab + 按 type 分发） | ✅ | ✅ | - | - | ✅ | **✅** | effects 占位（用户同意暂不做） |
| 8 | 左右分隔条 resizable | ✅ | ✅ | - | - | ✅ | **✅** | - |
| 9 | ✕ 取消按钮 | ✅ | ✅ | - | - | ✅ | **✅** | - |
| 10 | 标尺两步调整（mm:ss 短标签 + density 自适应） | ✅ | - | - | - | ✅ | **✅** | 已被 11 取代 |
| 11 | **标尺两级刻度**（主刻度 + 细分 tick） | ✅ | - | - | - | ✅ | **✅** | - |
| 12 | **trim 补素材**（前端按素材边界实时 clamp） | ✅ | ✅ | - | ✅ | ⚠️ | **❓待验证** | 用户截图为压缩/拉长截图，无法证明补素材（需真机播放看素材内容） |
| 13 | **右键菜单**（7 项 + 动态文案） | ✅ | ✅ | ✅ | - | ✅ | **✅** | - |
| 14 | **段级静音/隐藏**（set_segment_flag + 预览过滤 6 处） | ✅ | ✅ | ✅ | ✅ | ✅ | **✅** | 导出剪映映射未做（标注后置） |
| 15 | **轨道锁定**（🔒 + 前端拦截） | ✅ | ✅ | ✅ | ⚠️ | ✅ | **⚠️半成品** | **后端未做保护**：MCP/AI 直接调 split/move/trim 可绕过；UI 拦截只挡手动拖动 |
| 16 | **资产 grid/list 切换** | ✅ | ✅ | - | - | ✅ | **✅** | - |
| 17 | **audio/speed tab**（音量滑块 + 变速下拉） | ✅ | ✅ | ✅ | ✅ | ⚠️ | **❓待验证** | 播放期 volume 是否同步未查；playTick 路径未覆盖 |

---

## 逐项详细数据流（关键项）

### 11. 标尺两级刻度 ✅

**5 环节**：
- **UI**：标尺高 28px，minor 顶部 8px 短竖线（opacity .55），major 贯穿 + 文字
- **监听**：renderTimeline 调用 renderRuler；repositionTimelineZoom 也调用 renderRuler（zoom 时跟随）
- **IPC/Command**：无（纯前端几何）
- **后端**：无
- **反馈**：renderRuler → ruler.innerHTML 清空 + 重建；下次 renderTimeline/repositionTimelineZoom 重绘

**对照 OpenCut ruler-utils.ts**：✅ 算法一致（findOptimalInterval 帧级→秒级 + ensureTickDividesLabel）
**数学验证**：1s label + 0.1s tick（高缩放，10 细分/秒），10s label + 2s tick（低缩放）

### 12. trim 补素材 ⚠️❓

**5 环节**：
- **UI**：拖左把手/右把手时实时移动
- **监听**：onPointerMove 的 resize left/right 分支
- **IPC/Command**：mouseup 调 `trim_segment(type, ti, idx, edge, val, ripple)`
- **后端**：`_trim_core(seg, edge, new_edge_us)` 算 delta = `max(-ss/speed, min(new_edge - start, dur - MIN))`，正确 clamp 到素材头/尾 ✅
- **反馈**：save_state → 0.5s 轮询 → renderTimeline → 段左/右位置重画

**前端 clamp（昨天加）**：
```js
const minLeft = d.s0.start - (d.s0.src_start || 0) / speed;   // 素材头
const maxRight = d.s0.start + (srcEnd - srcStart) / speed;     // 素材尾
```
实时夹紧到素材边界。

**主要问题**：用户截图看到的是"压缩/拉长"而非"补素材内容"——截图只能看到段宽度变化，**看不出实际播放时素材是否真的补回来**。需要真机播放验证（用户承认"播放效果验证不了"）。

**次要问题**：speed=0（变速极端值）下 minLeft/maxRight 计算可能除零——`(srcStart || 0) / 0` = 0/0 = NaN，导致位置计算错。当前没处理 speed=0 的边界。

### 14. 段级静音/隐藏 ✅

**5 环节**：
- **UI**：右键菜单"🔇 静音" + "🙈 隐藏"动态文案
- **监听**：timeaxis contextmenu 弹菜单 + 菜单 click 触发
- **IPC/Command**：右键 → `set_segment_flag(type, ti, idx, flag, value)`；MCP `set_segment_flag` 工具（Agent 可调）
- **后端**：✅ 校验 + 改 seg[flag] + save_state（走 execute 自动入 Command 栈）
- **反馈**：✅ renderer 预览 6 处过滤（visualHits/textHits/sticker hidden 不渲染、video 内嵌音频 muted 静音、audio muted 不发声）

**完整度**：✅ 全链路打通 + Agent 可用。
**后置项**：导出剪映映射（muted→volume=0、hidden→跳过画面）— 导出层留 TODO。

### 15. 轨道锁定 ⚠️半成品

**5 环节**：
- **UI**：轨道头 🔒/🔓 按钮（timeline.js buildTracks）
- **监听**：tlLabels click → icon[data-act="lock"]
- **IPC/Command**：调 `set_track_meta(type, ti, "locked", !meta.locked)`
- **后端**：✅ set_track_meta 白名单加 locked
- **反馈**：renderMedia → 轨道头重画 + onTimelineDown 前端拦截

**完整度 UI/前端**：✅ 锁定后拖动/裁剪被拦截（仍可选中看属性）。
**问题**：**后端没有保护**——MCP/Agent 直接调 `split_segment/move_segment/trim_segment/remove_segment` 不检查 locked。AI 可以绕过 UI 修改锁定轨段。
**修法**：每个写操作方法（split/move/trim/remove/duplicate）开头加 `_assert_track_unlocked(track_type, track_index)`。**未做**。

### 17. audio/speed tab ⚠️❓

**5 环节**：
- **UI**：placeholderPanel.phContent 动态渲染；音量滑块 0-2 + 静音按钮；变速下拉 0.5-3x + 保持音调按钮
- **监听**：change/input/click
- **IPC/Command**：
  - 音量：实时本地（s.volume = v）+ 防抖 250ms 调 `set_segment_volume`
  - 变速：change 调 `set_segment_speed(type, ti, idx, speed, !change_pitch)`
  - 静音：调 `set_segment_flag(type, ti, idx, "muted", !s.muted)`
- **后端**：set_segment_volume（新增 0-2 clamp）+ set_segment_speed（已存在）
- **反馈**：preview 应用——✅ renderer 应用 video.volume + audio.volume（在 _setVisualContent 创建时 + audio 创建时）

**主要问题**：播放期（playTick）volume 是否同步？renderPreview 只在创建/切换时设 volume，播放期如果改了音量，video/audio 元素 volume 需要重新设。当前 playTick 没显式更新 volume——需要查。

---

## 发现的问题清单（按严重度）

### ✅ 已修（本次）
- **audio 段显示 transform 关键帧**（OpenCut 对 audio 不显示）—— KF_PATHS_BY_TYPE 过滤 + text/audio 引导提示

### ⚠️ 半成品（需后续修）
1. **轨道锁定后端未保护**：MCP/Agent 可绕过 UI 改锁定轨段（应每个写操作加 _assert_track_unlocked）
2. **播放期 volume 同步未验证**：renderPreview 一次性设 volume，playTick 没显式更新（可能改了音量不立即生效）
3. **导出剪映对 muted/hidden 映射未做**：标注后置
4. **trim 在 speed=0 极端值下未防御**：srcStart/speed=0/0 = NaN

### ❓ 用户验证不了（需真机）
1. **trim 补素材**：截图显示压缩/拉长看不出"补素材内容"——实际播放时素材是否补回，需用户播放验证
2. **音量滑块逻辑**：用户怀疑"只做了图标没做逻辑"——实际做了（set_segment_volume + 预览应用），但用户没播验证
3. **播放期 volume 同步**：改了音量后播放，声音是否立即应用

### ✅ 完整（无问题）
- 拆 JS、播放隔离、Asset 分离、回归基线、Command 层
- PropertiesPanel 路由、空状态、多选、占位
- 左右分隔条、✕ 取消按钮
- 标尺两步调整（被 11 取代）
- 标尺两级刻度
- 右键菜单
- 资产 grid/list
- audio/speed tab 结构

---

## 经验教训（写给自己）

1. **"做了一半" ≠ "做完了"**：用户能看出 UI 和逻辑的不一致。下次先按 OpenCut 完整数据流走一遍再动手。
2. **按 type 过滤**：很多功能需要按 type 分发（KF_PATHS/audio tab/text tab），不能一份代码通用到底。
3. **后端保护 ≠ 前端保护**：UI 拦截只是 UX，MCP/AI 直接调 API 可绕过——任何"禁止编辑"的状态（锁轨、mute）必须在后端写操作方法里二次校验。
4. **播放期同步**：renderPreview 一次性设的属性（volume/src），playTick 需要持续生效——容易遗漏。