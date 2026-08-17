# AI剪辑工作台 · MCP 工具总表

> 生成本表时间：2026-08-17。以 `mcp_server.py` 为唯一真源；**工具定义变更后请同步本表**。
> MCP 协议每个能力叫一个 **tool（工具）**，自带 docstring + 参数 schema，AI 一连上就自动拿到清单（自描述）。

## ⚠️ 活连接 vs 代码 的差异（重要）

`mcp_server.py` 已定义 **33 个工具**（含本表新增的 `get_effect_registry`）。但**本地 MCP 进程按纪律要退出 WorkBuddy 重开才热加载**，所以当前连着的进程可能比代码旧：

- `add_effect` / `update_effect` / `remove_effect` / `duplicate_effect` —— 代码已有，连着的进程缺（重开 WB 即出现）。
- `get_effect_registry` —— 本表新增，连着的进程缺（重开 WB 即出现）。
- 其余工具均已暴露。

**真缺口（代码层面还没写）**：`export_video`（直出 mp4，Stage E）——目前只有 `export_draft`（导剪映草稿）。

---

## 一、读取类（read-only，让 AI "看"草稿）

| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `get_state` | 全量草稿（materials + draft） | 无 | JSON 字符串 |
| `list_tracks` | 轨道主视图（每种类型轨道 + 片段 start/dur/material_id/text），紧凑 | 无 | JSON |
| `get_track_text` | 某文本轨全部字幕 | `track_index` | `[{idx,start_us,dur_us,text}]` |
| `get_segment_detail` | 单段详情 + 挂在它身上的特效 | `track_type,track_index,index` | JSON |
| `get_effects` | 当前已放置的特效（紧凑） | 无 | JSON |
| `get_effect_registry` | **特效类型目录**（有哪些特效 + 参数单位/范围） | 无 | `{effects,note}` |
| `get_material_peaks` | 素材波形包络（跳切/静音检测输入） | `path,max_points=240` | `{peaks,has_audio,points}` |
| `get_segment_peaks` | 片段级波形包络 | `track_type,track_index,index,max_points=240` | `{peaks,has_audio,points}` |

> 另有 resource `aivideo://draft_state`（与 `get_state` 同数据）。

## 二、写入类 · 素材 / 进轨

| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `import_media_by_paths` | 按路径把素材复制进素材库（AI 专用，无弹窗） | `paths:list` | 入库素材列表 |
| `add_clip` | 一步到位：入库 + 直接进轨 | `path` | 进轨结果 JSON |
| `add_to_timeline` | 已入库素材登记进指定轨道 | `name,path,mtype,track_index=0,at_time_us,insert_index` | 落点 JSON |

## 三、写入类 · 片段编辑

| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `remove_segment` | 删除第 index 段并自动重排 | `track_type,track_index,index` | JSON |
| `move_segment` | 同轨内移动到新起始时间 | `track_type,track_index,index,new_start_us` | JSON |
| `relocate_segment` | 跨轨移动（拖到空隙可新建轨） | `track_type,from_track,index,to_track,at_time_us,insert_index` | 落点 JSON |
| `trim_segment` | 双向裁剪（左/右把手） | `track_type,track_index,index,edge,new_edge_us` | JSON |
| `split_segment` | 在指定点切成两段 | `track_type,track_index,index,at_time_us` | `{left,right}` |
| `set_segment_flag` | 段级静音/隐藏 | `track_type,track_index,index,flag(muted/hidden),value` | JSON |

## 四、写入类 · 轨道

| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `add_video_track` | 新增视频覆盖轨 | `insert_index` | 新轨道索引 |
| `delete_video_track` | 删除视频覆盖轨（主轨 0 不可删） | `track_index` | JSON |
| `add_audio_track` | 新增音频轨 | `insert_index` | 新轨道索引 |
| `delete_audio_track` | 删除音频轨 | `track_index` | JSON |
| `add_text_track` | 新增文本轨 | `insert_index` | 新轨道索引 |
| `delete_text_track` | 删除文本轨 | `track_index` | JSON |
| `set_track_meta` | 轨道预览开关（👁隐藏 / 🔊静音） | `track_type,track_index,field,value` | JSON |

## 五、写入类 · 特效（Effect DSL Node）

| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `add_effect` | 新增特效段到特效轨 | `track_index,effect_type,target=None,start_us,duration_us,params,keyframes,name` | `{ok,track_index,index,id}` |
| `update_effect` | 更新特效段（params 合并 / range / target / keyframes） | `track_index,index,patch` | JSON |
| `remove_effect` | 删除特效轨第 index 段 | `track_index,index` | JSON |
| `duplicate_effect` | 复制到同轨紧接其后（重发 id） | `track_index,index` | JSON |
| `get_effect_registry` | 特效类型目录（见上） | 无 | `{effects,note}` |

**`add_effect` 参数速查**
- `effect_type`：必须是 `get_effect_registry` 返回的 `effects` 的 key（blur/brightness/contrast/saturate/hue_rotate/grayscale/sepia/invert/opacity）。
- `target`：省略 = 调整层（盖整栈）；`{type:"clip",track,ti,si}` = 绑素材段；`{type:"track",ti}` = 整轨（v1.x）。
- `params`：见各特效的 `unit/default/range`（如 blur→`{"radius":8}`，opacity→`{"value":1}`）。
- `keyframes`：`[{param,time(us,相对段起点),value,easing}]`，做时间曲线（如渐入 opacity 0→1）。

## 六、写入类 · 导出 / 撤销 / 审计 / 通用入口

| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `export_draft` | 导出标准剪映草稿文件夹 | `name,folder` | JSON（路径/段数） |
| `undo` | 撤销（Ctrl+Z） | 无 | `{剩余步数}` |
| `redo` | 重做（Ctrl+Y） | 无 | `{剩余步数}` |
| `execute` | **通用命令入口**：以 Command 语义执行任意写操作并审计 | `cmd_id,args="{}",meta="{}"` | 与原操作一致 JSON |
| `audit_log` | 操作历史（谁做了什么） | `limit=100,actor` | `[{cmd_id,label,meta}]` |

---

## 阶段对照（工具来自哪些阶段）

- ✅ 阶段 A：特效四件套 + `get_effect_registry`（注册表自描述）
- ✅ 阶段 B/C/D：由 `add_effect` 落段 + 前端泳道 + 渲染合成消费，无专属 MCP 工具
- ⬜ 阶段 E：**缺 `export_video`**（直出 mp4，MVP 硬需求）→ 待补后端 `export_video` + 本表加一行
- ⬜ 阶段 F：开源特效/花字素材接入（届时可能扩 `get_effect_registry` 列出预设包）
- ⬜ 阶段 G/H：属性面板 UI / v2 WebGL，无新 MCP 工具
