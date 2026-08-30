# AI剪辑工作台 · 数据模型契约（agent 与人的共享"理解"）

> 目的：让 agent（和你）用**同一套语言**理解「轨道怎么排、素材在哪、特效放哪」，
> 而不是去读 ~100KB 的 `draft_state.json` 全文（那是黑盒，会爆窗口）。
> 本文件是运行代码（`main.py` X 模型）与读取层（`studio_read.py`）的**权威说明**；
> skill / MCP / Codex / 任何外部 AI 设计操作都以本文件为准。
> **最后更新：2026-08-30 —— 对齐 X 模型（main + overlay + audio）。旧 `draft.video/text/effect` 分桶已废弃，严禁再按旧结构读写。**

---

## 1. 总结构

`draft_state.json` 顶层：

| 字段 | 类型 | 含义 |
|---|---|---|
| `materials` | list | 素材库（见 §3） |
| `draft` | dict | 时间轴全部轨道（见 §2，**X 模型：main + overlay + audio**） |
| `settings` | dict | 预留 |
| `version` | int | 状态版本戳（`domain_version`，撤销/重做门控用） |
| `meta` | dict | 含 `meta.mcp` 连接状态 |
| `bookmarks` | list | 书签列表（纯 UI 标注，不参与剪辑/导出）：`[{us, name}]`，`us`=微秒位置。后端 `add_bookmark`/`remove_bookmark`/`toggle_bookmark`/`rename_bookmark`/`list_bookmarks`；前端 `B` 键切换、双击标尺切换、点书签跳播放头、右键删除 |

> ⚠️ **历史坑（AI 必读）**：2026-08-18 前的草稿用 `draft.video/audio/text/effect/image/sticker` 六类分桶数组 + `layer_order`。
> 该结构**已废弃**，`load_state` 检测到旧草稿直接返回空（用户拍板全删）。任何按旧分桶读写的操作都会落空或破坏工程。

---

## 2. 轨道（tracks）——"轨道排布"（X 模型，当前唯一真模型）

`draft` 内部只有三个容器：**main**（主场景）、**overlay**（混排池）、**audio**（音轨）。

### 2.1 容器与 z 序

```python
draft = {
  "main":    {"segs": [...]},                                          # 主场景：单一主视频轨，恒定存在，只装 video/image
  "overlay": [{"type": "text"|"sticker"|"effect"|"video", "segs": [...]}, ...],  # 混排池，0=最顶，数组顺序=z 序
  "audio":   [{"segs": [...]}, ...],                                    # 音轨列表
  "canvas":  {...}, "_track_meta": {...}
}
```

- **main**：唯一主视频轨。`video` 类型 `ti=0` 永远指向它。
- **overlay**：混排池。每条轨道是一个 `{type, segs}` 对象；数组下标顺序 = 视觉 z 序（下标 0 在最顶层）。
  video 覆盖轨、字幕轨、贴纸轨、特效轨都混在这里，靠 `type` 区分。
- **audio**：独立音轨数组，下标即 `track_index`。

### 2.2 命令寻址（AI / MCP / Command 统一用这套）

所有写操作经 **Command API**（绝不直写草稿结构），轨道用 `(track_type, track_index)` 寻址：

| track_type | track_index 含义 | 真实落点 |
|---|---|---|
| `video` | ti=0 → 主场景；ti≥1 → 第 (ti-1) 条 video 覆盖轨 | `main.segs` / `overlay[type=video][ti-1].segs` |
| `audio` | 数组下标 | `audio[ti].segs` |
| `text` | 该类型在 overlay 中的序号（0 起） | `overlay[type=text][ti].segs` |
| `sticker` | 同上 | `overlay[type=sticker][ti].segs` |
| `effect` | 同上 | `overlay[type=effect][ti].segs` |

> **轨道稳定 id（tid）**：每条轨有 `tid`（前缀 `ov_`/`main_`/`au_`），新建/重排/折叠都不变，AI 可用 tid 稳定引用（`_track_by_tid`）。
> **自动建轨**：落点被占用 / 类型不匹配时，运行代码自动新建同类型轨（对齐 OpenCut `placement/resolve.ts`，**永不右推避让**）。

### 2.3 片段字段（segment）

| 字段 | 单位 | 含义 |
|---|---|---|
| `id` | str | 段稳定 id（32 位 hex，b9a9206 起引入）；撤销/重做与 AI 引用都用它 |
| `start` | **微秒** | 在时间轴上的起始位置 |
| `duration` | **微秒** | 该段时长（1 秒 = 1_000_000 微秒） |
| `src_start` | 微秒 | 在源素材里的入点（裁剪） |
| `src_end` | 微秒 | 在源素材里的出点 |
| `material_id` | str | 关联 `materials[].uid` |
| `path` | str | 源文件绝对路径 |
| `name` | str | 显示名 |
| `type` | str | `video`/`audio`/`text`/`sticker`/`effect`（与所在 overlay.type 一致） |
| `text` | str | **仅 text 轨**：字幕内容（导出剪映写 TextSegment，不再只写 name） |
| `sub_style` | dict | **仅 text 轨字幕段**：`{font_size,bold,color,align,bg,bg_color}`，导出/预览用；缺省走 `Api.DEFAULT_SUB_STYLE`（白字粗体/底部居中/自动换行） |
| `masks` | list | 遮罩列表（每段最多 1 个）：`[{id, type, params}]`。`type` ∈ `rectangle`/`ellipse`/`star`/`heart`/`diamond`/`split`/`cinematic-bars`；`params` 见下方「遮罩参数」 |
| `animations` | dict | **关键帧数据**（位置/缩放/旋转/透明度等通道），结构见 §2.4 |
| `transform` | dict | **仅 sticker 轨**：贴纸变换 `{x,y,scale,rotation,opacity,flipH,flipV}`（`x/y`：画布中心为 0 的归一化偏移；`scale`：倍率；`rotation`：角度；`opacity`：0~1）。video 段用 `animations` 表达变换，不用此字段 |
| `natural_w`/`natural_h` | int | **仅 sticker 轨**：贴纸图片原始像素宽高（导出换算真实缩放用） |
| `effect_type` | str | **仅 effect 轨**：特效类型 |
| `target` | dict | **仅 effect 轨**：`{track_type,track_index,index}` 作用目标段 |

**遮罩参数 params（归一化到元素空间，0.5 = 中心）**

| 字段 | 范围 | 含义 |
|---|---|---|
| `centerX` / `centerY` | -0.5 ~ 0.5 | 遮罩中心相对元素中心偏移（元素宽/高比例） |
| `width` / `height` | 0 ~ 1 | box 形状宽/高占元素比例 |
| `rotation` | deg | 旋转角度 |
| `scale` | 0 ~ n | 整体缩放（乘到 width/height） |
| `feather` | 0 ~ 1 | 边缘羽化 |
| `inverted` | bool | 反转（保留遮罩外区域） |
| `strokeColor` / `strokeWidth` / `strokeAlign` | - | 描边（预览用，不导出） |

`splits` 仅用 `centerX/centerY/rotation`（线）；`cinematic-bars` 仅用 `height`（横向黑边带）。

### 2.4 关键帧（animations）—— 多通道独立

关键帧以 `animations` 字典表达，**每个属性是一条独立通道**（对齐 OpenCut：`positionX/Y` 是两条独立通道，非共享 2D KF）：

```python
seg["animations"] = {
  "transform.positionX": {"type": "scalar", "keys": [{"id": str, "t": int_us, "v": float_px}, ...]},
  "transform.positionY": {"type": "scalar", "keys": [{"id": str, "t": int_us, "v": float_px}, ...]},
  "transform.scaleX":    {"type": "scalar", "keys": [{"id": str, "t": int_us, "v": float}, ...]},
  "transform.scaleY":    {"type": "scalar", "keys": [{"id": str, "t": int_us, "v": float}, ...]},
  "transform.rotate":    {"type": "scalar", "keys": [{"id": str, "t": int_us, "v": float_deg}, ...]},
  "transform.opacity":   {"type": "scalar", "keys": [{"id": str, "t": int_us, "v": float_0to1}, ...]},
}
```

- `path`：属性路径命名空间，形如 `transform.positionX`（见 `main.py:2129` 权威定义）。特效参数走 `effect.{param}` 同源通道（`effects.js:91`）。
- `t`：**微秒**，与 `start/duration` 同坐标系（播放头处打点即用当前 `localUs`）。
- `v`：通道原生单位 —— position 为像素（中心原点，+x 右、+y 下）；scale 为倍数(1.0=100%)；rotate 为角度；opacity 为 0~1。
- **生效铁律**：属性访问走 `PropertyResolver`（`effective-property-resolver.js`）——有 KF 通道就**绝不回落静态值**（C1.2，2026-08-20）。
- 写回统一经 Command API（`add_keyframe`）：画布拖拽（`preview-drag.commit`）、变换手柄（`transform-handle`）、参数面板（`kf-panel`）都在播放头处更新对应通道。

> ⚠️ **已知缺陷（AI 写操作时避开）**：`kf-panel.js:226` 等比缩放写回用 `call()` 原始桥 + `.then()` 链，绕过 `CommandService.run` 抽象，且 `withTx` 在两次异步写完成前就关闭作用域 → `scaleX/scaleY` **非原子**（事务断链），部分撤销会留脏 KF。规范写法应为 `CommandService.withTx(() => { CommandService.run("add_keyframe", {...}) })`。该缺陷列在已知 Bug 清单，待修。

---

## 3. 素材库（materials）——"素材排布"

`materials[]` 每项：

| 字段 | 含义 |
|---|---|
| `name` | 文件名 |
| `path` | 绝对路径 |
| `type` | video/audio/image |
| `size` | 字节 |
| `uid` | 唯一 id（片段用 `material_id` 引用它） |
| `thumbnail` | 缩略图绝对路径 |

---

## 4. 特效（effect）——"特效怎么放"（X 模型）

特效段存放在 **overlay 池**中 `type=effect` 的轨道（**不再是旧 `draft.effect` 空数组**）。
每项结构：`{type:"effect", segs:[{id, effect_type, target, start, duration, params, ...}]}`。
- `target`：`{track_type,track_index,index}` 标识作用于哪一段。
- 读取用 `get_effects()`（遍历 `overlay[type=effect]`，见 `main.py:6542`）。
- 导出剪映：基础特效路径已打通；**复杂特效 / 遮罩混合 / 转场适配器待补**（属渲染层缺口，见项目缺陷清单，非契约问题）。

---

## 5. agent 应该怎么读（避免黑盒）

| 想了解什么 | 调哪个工具 | 返回体量 |
|---|---|---|
| 时间轴整体排布 | `list_tracks()` | ~几 KB |
| 某条字幕写了啥 | `get_track_text(track_index)` | 几百 B |
| 某一段是什么、特效在哪 | `get_segment_detail(track_type, track_index, index)` | 几百 B~1KB |
| 现在挂了哪些特效 | `get_effects()` | 随特效数 |
| 某素材的波形包络（跳切/静音检测） | `get_material_peaks(path)` | `{peaks, has_audio, points}` |
| 某段的波形包络 | `get_segment_peaks(track_type, track_index, index)` | 同上 |

**铁律（来自跳切读取经验）**：绝不直接把整份 `draft_state.json` 喂给 agent。
任何"读草稿"类 skill 都用上表按需抽小数据，每次只拿几百~几千字符。

> 注：本会话新增的读取工具，需在**新对话**里才会被 WorkBuddy 注入（旧对话不会热加载新 MCP 工具）。

**AI 操作铁律（写入侧）**：所有写操作必须经 Command API（`CommandService.run`），
绝不直接改 `draft_state.json` 的轨道结构或段字段；AI 只是同一条 Command 操作链的**调用者**，
人接手后在同一工程上继续编辑（详见项目 ADR-001 / 路C 编辑逻辑文档）。
