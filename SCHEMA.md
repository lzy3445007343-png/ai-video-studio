# AI剪辑工作台 · 数据模型契约（agent 与人的共享"理解"）

> 目的：让 agent（和你）用**同一套语言**理解「轨道怎么排、素材在哪、特效放哪」，
> 而不是去读 103KB 的 `draft_state.json` 全文（那是黑盒，会爆窗口）。
> 本文件是读取层（`studio_read.py`）的权威说明，skill 设计以此为准。

---

## 1. 总结构

`draft_state.json` 顶层：

| 字段 | 类型 | 含义 |
|---|---|---|
| `draft` | dict | 时间轴全部轨道（见 §2） |
| `materials` | list | 素材库（见 §3） |
| `settings` | dict | 预留 |
| `version` | int | 状态版本戳 |
| `meta` | dict | 含 `meta.mcp` 连接状态 |
| `bookmarks` | list | 书签列表（纯 UI 标注，不参与剪辑/导出）：`[{us, name}]`，`us`=微秒位置。后端方法 `add_bookmark`/`remove_bookmark`/`toggle_bookmark`/`rename_bookmark`/`list_bookmarks`。前端 `B` 键在播放头切换、双击标尺切换、点书签跳播放头、右键书签删除 |

---

## 2. 轨道（tracks）——"轨道排布"

`draft` 下每种类型是一组**轨道**，每条轨道是一组**片段**：

```
draft = {
  "video":   [ [seg, seg, ...], [seg, ...] ],   # 轨道列表，每条轨道 = 片段列表
  "audio":   [ [seg, ...], [seg, ...] ],
  "text":    [ [seg, ...], [seg, ...], ... ],     # 字幕/花字
  "image":   [ ... ],
  "sticker": [ ... ],
  "effect":  [ ... ],                             # 特效（见 §4）
  "_track_meta": {"video":[{},{}], "audio":[...], "text":[...]}
}
```

- **轨道序号** `track_index` = 该类型内列表下标（0 起）。如 `draft.video[0]` = 主视频轨。
- **片段序号** `index` = 该轨道内列表下标（0 起）。

### 片段字段（segment）

| 字段 | 单位 | 含义 |
|---|---|---|
| `start` | **微秒** | 在时间轴上的起始位置 |
| `duration` | **微秒** | 该段时长（1 秒 = 1_000_000 微秒） |
| `src_start` | 微秒 | 在源素材里的入点（裁剪） |
| `src_end` | 微秒 | 在源素材里的出点 |
| `material_id` | str | 关联 `materials[].uid` |
| `path` | str | 源文件绝对路径 |
| `name` | str | 显示名 |
| `type` | str | video/audio/text |
| `text` | str | **仅 text 轨有**：字幕内容（导出剪映时写入 TextSegment，不再是旧版的只写 name） |
| `sub_style` | dict | **仅 text 轨字幕段有**：{font_size,bold,color,align,bg,bg_color}，导出/预览用。缺省走 `Api.DEFAULT_SUB_STYLE`（白字粗体/底部居中/自动换行） |
| `masks` | list | **可选**：遮罩列表（每段最多 1 个）。每项 `{id, type, params}`。`type` ∈ `rectangle`/`ellipse`/`star`/`heart`/`diamond`/`split`/`cinematic-bars`；`params` 见下方「遮罩参数」。导出剪映时仅 `rectangle`/`ellipse`/`star`/`heart`/`split` 5 种生效，`diamond`/`cinematic-bars` 仅预览。后端工具：`set_mask`/`remove_mask`/`toggle_mask_inverted`/`update_mask_param`/`update_mask`。 |
| `transform` | dict | **仅 sticker 轨有**：贴纸变换。`{x, y, scale, rotation, opacity, flipH, flipV}`。`x/y`：画布中心为 0 的归一化偏移（-1~1，对应预览 translate ±50%）；`scale`：倍率（1 = 占画布高 40%，与导出 `STICKER_BASE_HEIGHT_RATIO` 对齐）；`rotation`：角度；`opacity`：0~1；`flipH/flipV`：翻转。导出剪映：本地图片贴纸→`VideoSegment(path, clip_settings=ClipSettings(...))` 放叠加轨，位置/缩放/旋转/透明/翻转全还原；导入的剪映贴纸（仅 `resource_id`）→`StickerSegment(resource_id, ...)` 放 sticker 轨。后端工具：`add_sticker_track`/`delete_sticker_track`/`add_sticker`/`update_sticker`/`pick_sticker_file`。 |
| `natural_w`/`natural_h` | int | **仅 sticker 轨有**：贴纸图片原始像素宽高（add_sticker 时用 PIL 读取），导出把「占画布高度 40%」换算成 `ClipSettings` 的真实缩放。 |
| `resource_id` | str | **仅导入的剪映贴纸有**：剪映内置贴纸模板 id（无本地 path），导出走 `StickerSegment`。 |

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

## 4. 特效（effect）——"特效怎么放"

`draft.effect` 当前为**空数组**（平台基础已就位，特效模型待接入）。
设计约定：特效以对象列表存在，每项可带 `target` 标识作用于哪一段
（`{"track_type","track_index","index"}`），skill 据此把"在某段放某特效"序列化进来。

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

**铁律（来自 8-12 跳切读取经验）**：绝不直接把整份 `draft_state.json` 喂给 agent。
任何"读草稿"类 skill 都用上表按需抽小数据，每次只拿几百~几千字符。

> 注：本会话新增的读取工具，需在**新对话**里才会被 WorkBuddy 注入（旧对话不会热加载新 MCP 工具）。
