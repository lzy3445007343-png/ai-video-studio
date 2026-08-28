# 07 · AI-Native 演进路线图（P0→P3，不推翻重写）

> **文档性质**：系统恢复级审计 · 第三阶段产出（Phase 10）
> **依据**：《06-V1V2对照分析.md》的 Phase 8/9 发现（同目录，2026-08-22）
> **设计原则**：
> 1. **不推翻重写**——保留后端 90+ 命令、MCP、effects.json 单一真源、C1/C2/C3/C4 四内核、EditContext 事务；
> 2. **每阶段可独立交付**，每项有可验证的验收标准；
> 3. **先修正确性（P0），再立协议（P1），再做智能（P2），最后规模化（P3）**；
> 4. 每一项都标注"基于当前哪个源码事实"——不空谈。
> **版本日期**：2026-08-22

---

## 0. 路线图总览（一页）

```
P0 正确性（现在就该修）          P1 协议地基          P2 AI 智能            P3 长期规模化
─────────────────────────      ──────────────      ──────────────      ──────────────
D1 位置索引→id 引用   ◄───►  Document Protocol    Semantic 层          Render Graph
D2 Command 闭环 + args ─────►  EventBus(去轮询)   Resource Graph      多人协作
D3 undo 模型修复       ─────►  Preset 系统         Intent Layer        D5/D6 异步化
D4 保存/协议版本        ─────►  Plugin v0           OperationLog 重放
D5 时间整数化（渐进）    ─────►  动画模型升级(D4)
```

**一句话**：当前系统最大的问题不是"缺系统"，而是**数据源（draft_state.json）、定位方式（type:ti:idx）、同步方式（500ms 轮询）三件事互相咬死**。P0 把它解开，P1 立协议，P2 才有地基做 AI，P3 才能上协作和渲染管线。

---

## 1. P0 必须修（影响系统正确性）

> 判据：这几项不做，后面任何一层都会建在流沙上。P0 全部是**数据模型/命令链/保存语义**层面的收紧，不新增产品功能。

### P0-1 段定位从位置索引改为全局 id 引用（D1）

**源码事实**：段有稳定 `id`（`draft_state.json:24`），但定位全部走 `(type, ti, idx)`——MCP 工具签名（`mcp_server.py:86 remove_segment(track_type, track_index, index)`）、前端 key（`player.js:50 "video:0:"+idx`）、选中态（`store.js:49 selectedKey="type:ti:idx"`）、EditContext（`edit-context.js:28 key="type:ti:idx"`）全是位置索引。圣经 v2 判定它是"最痛、收益最高"的一项，且是 Resource Graph 的硬前提。

**目标**：段引用、选中态、MCP 参数全部以 `seg.id` 为准；位置索引只作为渲染/展示层推导，不再作为领域引用。

**关键动作**：
1. `main.py` 增加 `_seg_ref(draft, seg_id)`（已有 `_seg_by_id` 雏形，`main.py:638`）统一"按 id 定位"；所有 `*_segment(track_type, track_index, index, ...)` 方法增加 `seg_id` 参数并优先走它（已有部分方法带 `segid` 可选参数：`set_segment_speed`/`update_segment_transform`/`remove_segment`/`move_segment`——把它们变为主路径）；
2. MCP 工具新增 `seg_id` 参数并**文档标注优先**；`track_index/index` 降级为兼容参数；
3. 前端选中态从 `selectedKey="type:ti:idx"` 迁移到 `selectedSegId`（已存在字段，`store.js` / `工作台v0.8时间轴.html:3244` refresh 已在用 `segById(selectedSegId)` 校验）——把 `findSegByKey`（`edit-context.js:81` 依赖）改为 id 优先；
4. 删除/移动/裁剪等核心链路的 undo 快照依然全量，但**命令参数记录 id 而非索引**。

**验收标准**：轨道重排后，任何已存在的引用（选中、MCP 参数、EditContext）不因 `ti/idx` 漂移而指向错误段；`tools/graph_consistency.py` 对拍仍通过。

**依赖**：无（独立可做）。是 P1-1（Document Protocol）、P2-3（Resource Graph）的前置。

---

### P0-2 Command 闭环：所有写操作必须 Command 化 + 命令可重放（补 args）

**源码事实**：`CommandManager.execute`（`main.py:927`）包装方法后，`Command` 只记录 `{cmd_id, saved_state}`，**不记录 args**（`main.py:892` 的 `__slots__` 无 args 字段）。同时存在**双轨**：5a 兜底 `push_snapshot`（`main.py:917`，无语义快照）与 5b `execute` 并存——`save_state(record=True)` 每次真实变更还会压 snapshot（`main.py:1052-1055`），靠 execute 里"弹掉多余 snapshot"（`main.py:948-949`）掩盖。还有未包壳操作（`delete_material` `main.py:5114`、`drop_files` `main.py:5057` 等直接 `save_state(self.state)`）绕过了 execute。

**目标**：**每次领域状态修改都有且仅有一个带 args 的 Command 记录**，undo=还原快照、redo=重放 args（为 P2 OperationLog 重放铺路）。

**关键动作**：
1. `Command` 增加 `args` 字段（`__slots__` 加 `"args"`），`execute` 时存 `copy.deepcopy(args)`；
2. 枚举 `save_state` 直接调用点，把未包壳操作迁到 `execute`（`delete_material`/`drop_files`/`add_bookmark` 等）或显式 `push_snapshot` 标记"非编辑操作"；
3. 双轨收敛：`save_state(record=True)` 的自动 snapshot 语义改为"仅当调用方未走 execute 时才兜底"，并在 Command 上加 `source:"execute"|"snapshot"` 标记；
4. 增加 `redo` 的"重放验证"：当命令有 args 时，redo 优先用 args 重算而非恢复 post_state（与 OpenCut redo=execute 对齐，`opencut-架构圣经-v1:319`）。

**验收标准**：连续执行 10 个编辑操作 + 全量 undo + 全量 redo，draft 状态逐位一致；`audit_log` 每条记录含 `args`。

**依赖**：无。是 P1-2（EventBus 事件载荷）、P2-4（OperationLog 重放）的前置。

---

### P0-3 Undo/Redo 数据模型修复

**源码事实**：
- `history` cap=100（`main.py:910`），超出**静默丢最早历史**——长会话中 AI 无法回退到 100 步之外；
- undo 不恢复选中（无 OpenCut 的 `previousSelection`/`selectionOverride`，`opencut-架构圣经-v1:338-341`），undo 后 UI 选中可能悬空（虽有 `refresh` 的 `selOk` 校验，`工作台v0.8时间轴.html:3244`，但只兜底不修复）；
- 事务超时 30s（`main.py:915`）对 AI 长任务（如 Whisper 转写）可能误 abort；
- `push_snapshot` 与 `execute` 双栈入栈（P0-2 已提）会造成"一次操作两条历史"。

**目标**：undo/redo 语义可靠、不丢历史、不污染选中、事务对大任务宽容。

**关键动作**：
1. cap 改为可配置（`CommandManager(cap=2000)` 或按项目持久化）；
2. undo 时恢复执行前选中：`execute` 时快照 `{selectedSegId, selectedKeys}`，undo 时还原（对 OpenCut selection 语义的简化版）；
3. 事务超时改为**可续期**：每次事务内 `execute` 刷新 `created_at`（对 AI 长批处理友好）；
4. `undo` 在存在未完成事务时先 abort（已有，`main.py:1007-1010`）——保持，但返回信息补 `aborted_tx_count`。

**验收标准**：300 步操作后可完整回退到第 1 步；undo 后选中焦点仍指向 undo 前的同一段（或明确清除）。

**依赖**：P0-2 之后做更顺（依赖 args 字段做选中还原），可并行。

---

### P0-4 保存语义：引入协议版本号 + 保留读回验证

**源码事实**：`save_state` 有文件锁 + 读回验证（`main.py:1064-1083`，这是当前系统做对的地方），但 `draft_state.json` 无 `schemaVersion`，`version` 字段是时间戳（`main.py:1062`）。`_migrate_old_to_x`（`main.py:724`）是数据格式迁移，但无版本驱动。

**目标**：文件格式演进有版本号可追溯，迁移可测试。

**关键动作**：
1. `draft_state.json` 顶层加 `"schemaVersion": 1`；
2. `load_state` 增加版本检查：`version < CURRENT` → 依次跑 `_migrate_v1_to_v2...`（现有 `_migrate_old_to_x`/`_ensure_*` 系列迁入迁移器，`_reload` 的补默认值逻辑收敛到迁移管线）；
3. 迁移器必须幂等（重复加载无副作用）——现有 `_ensure_*` 已是幂等风格，直接复用。

**验收标准**：用旧格式（无 schemaVersion）的文件启动，自动迁移到 v1 且数据不丢失；`load_state` 报 `[MIGRATE] from=0 to=1` 日志。

**依赖**：无。是 P1-1（Document Protocol）的种子（schemaVersion 先立起来，协议化时直接扩展）。

---

### P0-5 时间整数化（D3 渐进，不推翻）

**源码事实**：`seg.start/duration/src_start` 是普通 int 微秒；帧吸附靠 `_frame_snap_us`（`main.py:1408`）和前端 `KF_FRAME_US = Math.round(1e6/30)`（`edit-context.js:24`）两处散落定义；导出固定 30fps（`main.py:4580`）。无统一时间类型。

**目标**：时间运算有唯一取整语义，为 MediaTime 品牌类型铺路；导出换算不动。

**关键动作**：
1. `main.py` 新增 `TICKS_PER_SECOND = 1_000_000` + `media_time(us)`/`snap_frame(us, fps)` 工具函数，`_frame_snap_us` 与 `KF_FRAME_US` 收口到它；
2. 前端 `timeline-mapper.js`（`property/timeline-mapper.js`，已存在）统一承担 global→local→frame 换算，删除散落的手写换算（已有 `_previewLocalUs` 注释要求走 TimelineMapper，`preview-drag.js:27`）；
3. 导出换算（`_video_clip_settings`/`_apply_keyframes_to_segment`，`main.py:1516/1653`）保持 µs，仅加注释标注"tick=µs，剪映=µs，无需转换"。

**验收标准**：搜索代码无散落的 `Math.round(1e6/30)` 或 `*1e6` 换算；帧吸附结果前后一致（对拍脚本确认）。

**依赖**：无。长期为 P1-1（Document 里时间字段统一）+ P3-1（Render Graph 帧级运算）铺路。

---

## 2. P1 架构升级（Document Protocol、事件系统、Preset、Plugin、动画模型）

> 判据：P0 解开了数据源与命令链，P1 把它们"立成协议"。这一阶段产出是后续 AI 能力的**可编程契约**。

### P1-1 Document Protocol v1（协议 + 运行时同源）

**源码事实**：`draft_state.json` 是运行时快照（06 报告 §2.1 已详述）；`export_draft` 已能生成剪映 JSON（`main.py:4543`），证明 JSON 协议路线可行。

**目标**：`VideoDocument` 作为唯一事实来源——AI 生成 JSON → 加载器校验/迁移 → 运行时状态，UI/渲染/导出/AI 全部是它的投影。

**关键动作**：
1. 定义 `doc-protocol/schema.py`：`schemaVersion` + `metadata` + `assets` + `timeline`（复用现有 `draft` 结构）+ 预留 `plugins/extensions/animation` 段；
2. `load_state` 升级为 `loadDocument(raw)`：JSON 校验（缺字段给默认值，失败明确报错）→ 迁移（复用 P0-4）→ 装配；
3. `save_state` 升级为 `saveDocument`：先序列化再写盘，保留读回验证；
4. **不破坏现有 draft 结构**——协议字段与 `draft.overlay/main/audio` 一一对应，迁移层透明。

**验收标准**：AI 生成一份最小合法 `VideoDocument` JSON 可被 `loadDocument` 加载并渲染；`schemaVersion` 变更时旧文件自动迁移。

**依赖**：P0-1（id 引用进协议）、P0-4（schemaVersion 种子）。

---

### P1-2 事件系统：EventBus 替代 500ms 轮询（D2）

**源码事实**：桌面↔MCP 靠 500ms 轮询 `get_state` 拉全量（`工作台v0.8时间轴.html:3362`），每次 `refresh()` → `renderAll` 全量重建（`:3262`），靠 `_suppressPanelRender` 冻结面板防"点不动"（`:1256`）。这是 D2/D6 的实体。

**目标**：**变更推送替代轮询拉取**——后端写盘后主动通知前端（或前端增量拉取），EventBus 承载事件。

**关键动作**：
1. 后端：`main.py` 增加进程内 EventBus（`publish(version_changed)/subscribe`），`save_state` 成功后发 `document-changed` 事件；MCP 侧 `_announce_mcp` 心跳机制（`mcp_server.py:325`）复用为"变更通知"通道（MCP 进程写盘后刷新 `mcp_state.json` 的 `updated_at`，桌面判断 `updated_at` 变化才 `refresh`——比固定 500ms 省 90% 空轮询）；
2. 前端：`refresh()` 改"按 version/updated_at 变化才拉取"，保留 `refresh()` 兜底（用户动作后仍显式 refresh）；
3. `renderAll` 从"无条件全量"改为"按 diff 渲染"——用 `Store.state.draft` 的引用/版本对比跳过未变区块（C4 切片订阅 `initSubscriptionSlices` 已铺路，`renderSliceMode` 从 `"legacy"` 切到 `"slice"`，`store.js:77`）。

**验收标准**：MCP 进程写入后桌面 <100ms 内可见（当前最多 500ms 延迟）；把轮询间隔调到 10s 界面无感知差异；`_suppressPanelRender` 冻结机制可删除。

**依赖**：P0-2（事件载荷需要 Command args）、P0-4（version 语义）。与 P1-1 并行（事件触发对象从"快照"变"Document"）。

---

### P1-3 Preset 系统（模板 = 风格 + 动画 + 节奏配方）

**源码事实**：无任何模板概念（06 报告 §2.1 ③）。当前 AI 只能做命令级操作。`KF_PROPS`（`main.py:1380`）是打点属性表，`CANVAS_PRESETS` 是画幅预设。

**目标**：`applyPreset("xiaohongshu-hot")` 一键展开成命令计划（style + timing 先行，animation 后补）。

**关键动作**：
1. 新增 `presets/` 目录：`preset.py` 定义 `PresetDefinition{id, kind, categories, style, timing, animation(预留)}`；
2. `PresetManager`：`register_preset`/`query_presets`/`apply_preset(id, target) → CommandPlan`（命令序列描述，P2 Intent 层消费）；
3. 内置 2-3 个手工 Preset（口播精剪 / 小红书图文 / 基础文字排版），apply 展开为**现有后端命令序列**（`timeline.split`/`add_effect`/`add_subtitles` 等），包成一个事务（复用 `begin/commit_transaction`）；
4. `preset.apply` 注册为新命令（`Api.execute("preset.apply", {presetId, target})`）。

**验收标准**：`POST /mcp/execute {cmd:"preset.apply", args:{presetId:"koubo"}}` 返回命令计划 JSON，执行后草稿按模板排版，undo 一次整批回滚。

**依赖**：P0-2（命令序列需要 args）、P1-1（Preset 落 Document 需要协议扩展位）。

---

### P1-4 Plugin 系统 v0（把散落注册表收敛成 PluginManager）

**源码事实**：`effects.json` 单一真源 + css/ffmpeg 双适配器（`main.py:1136-1168`），前端 `Effects` 表需人工镜像（`effects.js:29`）。特效是唯一有"声明式注册"能力的内容域。

**目标**：`registerPlugin()` API 出现，effects/masks/subtitles 注册成内置插件包，css 适配器能从 JSON 自动生成（消灭人工镜像）。

**关键动作**：
1. 新增 `plugin/plugin.py`：`PluginManifest{id, version, registers:{effects, masks, commands, exporters}}` + `PluginManager.register/load/unload/query`；
2. 把 `effects.json` 加载逻辑（`_load_effects`）包装成"内置 effects 插件"；`EFFECT_REGISTRY` 查询改走 `PluginManager.queryRegistry("effect")`；
3. **前端 adapter 自动生成**：`effects.js` 的 `Effects` 表改为启动时从 `get_effect_registry`（`main.py:4221`）拉 `EFFECT_META` + filters.css 模板现场编译（`eval` 模板与后端一致），删除人工镜像；
4. `register_effect` 运行时注册 API（新增特效不重启）。

**验收标准**：新增一种特效 = 只改 `effects.json` 一条记录，前端面板/预览/导出三处自动生效，无需改 JS。

**依赖**：P1-1（插件声明落 Document 的 `plugins/extensions` 段）。与 P1-3 并行（Preset 是 Plugin 注册的一种能力）。

---

### P1-5 动画模型升级：扁平 keys → bindings + channels（D4）

**源码事实**：`seg.animations = {path: {keys:[{id,t,v,seg}]}}`（`draft_state.json:35`），只有 linear/hold（`_kf_interp` `main.py:1574`）。`KF_PROPS`（`main.py:1380`）8 个属性已定义。`KfChannel`（`property/kf-channel.js:23`）是通道生命周期的前端雏形。

**目标**：动画从"扁平 keys"升级为"绑定 + 通道"双层（OpenCut §3.1），支持 vector2/color 组合通道与贝塞尔缓动，为 Preset 的 animation 段铺路。

**关键动作**（渐进式，不一次性破坏数据）：
1. **读取层先行**：`resolve_kf_value`/`kfVal` 扩展兼容新结构——通道 id 约定 `path:componentKey`（对齐 OpenCut `buildBindingChannelId`），旧 `path` 直接作为单组件通道（**旧数据零迁移可用**）；
2. **写入层**：`add_keyframe`（`main.py:2936`）的 `path` 参数扩展支持 `transform.position:value` 组合通道（内部拆成 positionX/positionY 两个子通道），`_split_animations`/`_clamp_animations_to_duration`（`main.py:1606/1631`）保持对两种结构兼容；
3. **缓动字段**：key 增加 `handle`（对齐 OpenCut `CurveHandle{dt,dv}`），`_kf_interp` 支持 bezier 分支；导出端 `_apply_keyframes_to_segment` 先线性降级（剪映只认 linear/hold）；
4. 前端 `kf-panel.js`/`renderKfGraph`（`工作台v0.8时间轴.html:1603`）曲线编辑器加缓动选项。

**验收标准**：旧存档（扁平 keys）加载后所有 KF 读写/分割/裁剪行为与升级前一致；新增组合通道写入后读取正确；导出剪映仍是 linear（降级明确）。

**依赖**：P0-5（时间取整统一）。是 P2-2（Semantic 的 StoryBeat 与动画关联）、P3-1（Render Graph resolve 解析）的基础。

---

## 3. P2 AI 能力建设（Intent、Semantic、Graph、OperationLog）

> 判据：P1 之后，Document/Plugin/Preset 都是可编程契约，AI 层开始"变聪明"。

### P2-1 AI Intent Layer（AIIntent → Planner → CommandGenerator）

**源码事实**：MCP tools = 命令级（`mcp_server.py`），AI 必须懂 `track_index/at_time_us` 等剪辑师细节；`api.execute` 是统一命令入口（`main.py:2477`），审计 meta 已是意图字段雏形（actor/reason/confidence/source）。

**目标**：AI 说"做小红书知识视频，前 3 秒 hook" → MCP 收 `AIIntent[]` → 校验 → 规则 Planner 展开成命令计划 → `api.execute` 批量执行（一次事务）。

**关键动作**：
1. `main.py` 新增 `IntentManager.submit_intents(intents)`：`validate`（schema 校验 + 资源可达性）→ `decompose`（复合意图拆子意图）→ 交给规则 `Planner`（先不接 LLM）→ 展开命令计划 → `begin/commit_transaction` 包批执行；
2. 首批 IntentType：`create-project` / `apply-preset`（消费 P1-3）/ `import-media` / `arrange-timeline`（规则版）/ `add-subtitles`（消费 `transcribe_media` `main.py:4410`）；
3. MCP 新增 `submit_intents` tool；保留现有 `execute` 兼容（命令直连不删，降级为"专家模式"）；
4. staging 批量事务：Intent 执行失败 → `abort_transaction` 整体回滚（复用 `main.py:988`）。

**验收标准**：MCP 一条 `submit_intents([create-project, apply-preset, add-subtitles])` 完成建项目 + 套模板 + 字幕，undo 一次整批回滚，`audit_log` 有完整命令链。

**依赖**：P1-1（Document 生成）、P1-3（Preset）、P0-2/P0-3（命令 args + undo）。

---

### P2-2 Semantic 层（bookmarks → StoryBeat + ObjectReference + 自动标注）

**源码事实**：`bookmarks` 是 `{us, name}` 纯标注（`main.py:3171`），`transcribe_media`（`main.py:4410`）本地 Whisper 能产出时间戳文本。

**目标**：Semantic 挂进 Document（`storyBeats`/`semantic`），Whisper + 规则生成标注，AI 能问"hook 段在哪"。

**关键动作**：
1. `seg`/`draft` 增加可选 `story_beats: [{id, type, start, end, label, intensity}]` 与 `annotations: [{element_id, meaning, source, confidence}]`——**零侵入**（不参与渲染，只挂 Document，对齐圣经 v2 "Semantic 不改变编辑行为"）；
2. `transcribe_media` 结果管线加一道：把 Whisper 结果包成"字幕段 + 语义标注"两段产物（标注走 `semantic.annotate` 命令，入 undo）；
3. `semantic.generate_annotations(scope)` 命令：规则版（按段落时长/停顿打 hook/body/cta 标记）；
4. MCP `query` intent 读语义（`list_story_beats`/`get_annotations`）。

**验收标准**：AI 问"视频有没有前 3 秒 hook"能从语义层返回标注结果；字幕与标注同源（Whisper 一次转写两用）。

**依赖**：P1-1（协议段扩展）、P0-2（annotate 命令化）、P2-1 的 query 通道。

---

### P2-3 Resource Graph（关系索引，回答"在哪出现/删了影响什么"）

**源码事实**：`resolveSegPath`（`store.js:144`）/`_resolvePath`（`playback-graph.js:53`）是唯一跨对象引用（material_id → uid → path）；`delete_material`（`main.py:5114`）已手工遍历所有轨检查引用——这是 `analyzeImpact` 的手工版。

**目标**：Document 变更时增量重建 `usedBy/annotates/composes` 图，`find_refs`/`analyze_impact` 两个查询可用。

**关键动作**：
1. `resource_graph.py`：`rebuild_from_document(doc)` + `update_incremental(change)`，节点类型（asset/element/effect/preset/annotation）；
2. `analyze_impact(target_id)` 先实现 asset 维度（复用 `delete_material` 的引用扫描逻辑，`main.py:5131-5140`，升级为通用图查询）；
3. MCP `query` 子命令：`find_refs`/`analyze_impact`。

**验收标准**：AI 问"删这个素材影响什么"返回引用段列表 + 建议；`delete_material` 改为走 `analyze_impact`（消灭手写遍历）。

**依赖**：P0-1（id 引用是图的 key）、P1-1、P2-2（annotation 节点进图）。

---

### P2-4 OperationLog 升级：audit_log 从"只记录"到"记录 + 重放"

**源码事实**：`audit_log` 只返回 `{cmd_id, label, meta}`（`main.py:1034`），无 args、无时间、无版本向量。P0-2 已让 Command 带 args。

**目标**：审计日志可重放（AI 场景恢复 / 撤销链展示 / 协作广播的数据源）。

**关键动作**：
1. 日志落盘升级：从内存 `history` 抽到 `operation_log.json`（`main.py:1034` 改读持久化），字段 `{log_id, cmd_id, args, meta, timestamp, version}`；
2. `replay(log_id)`：按 args 重放命令（包事务）；`get_undo_chain`：回溯撤销链；
3. MCP `audit_log` 升级返回 args；新增 `replay_log` tool。

**验收标准**：杀掉进程重启后，`audit_log` 仍有完整操作历史；`replay` 一条 log 能复现当时效果（可 undo）。

**依赖**：P0-2（args）、P0-3（undo 语义）、P1-2（事件触发写日志）。

---

## 4. P3 长期能力（Render Graph、多人协作、异步化）

> 判据：P2 完成时 AI 已能"一句话出片"，P3 解决规模化与专业渲染。

### P3-1 Render Graph（6-Pass 管线，收拢预览/导出两套实现）

**源码事实**：预览 = DOM 合成（`renderer.js:110`），导出 = pyJianYingDraft（`main.py:4543`），靠 `playback-graph.js`↔`_playback_graph` 对拍保证一致（`playback-graph.js:9`）。`Effects` 表（`effects.js:29`）是 Pass 注册雏形。

**目标**：固定 6-Pass 骨架（video/mask/effect/color/composite/output），LUT 成为第一个 color Pass 插件，新增视觉能力=注册 Pass。

**关键动作**：
1. 先做**导出侧 Pass 化**（低成本、风险低）：`export_draft` 内部按 video→mask→effect→color→composite→output 分段组织（现有逐段生成逻辑重新归类），`effects.json` 的 ffmpeg 适配器成为 effect Pass 的插件实现；
2. 再做**预览侧对齐**：前端 DOM 合成层抽象出与导出一致的 Pass 顺序（mask/effect 已存在，`renderer.js:494 applySegMask` + `effects.js computeEffectStyle`），新增 color Pass（亮度/对比度全局滤镜，现有 `effects.json` 已有 contrast/brightness 可先当 color Pass 用）；
3. 预留 `ai-enhance` Pass 类型（超分/去噪插槽，暂不实现）。

**验收标准**：新增一个全局调色 = 注册一个 color Pass（改 `effects.json` + 一个 preview adapter），不碰渲染骨架；预览与导出对拍通过。

**依赖**：P1-1（Document 是 Pass 输入）、P1-4（Pass 注册走 Plugin）、P0-5（帧级时间统一）。

---

### P3-2 多人协作（Command 级 OperationLog + 版本向量 + 命令级 merge）

**源码事实**：单机架构，跨进程同步靠 500ms 轮询（`工作台v0.8时间轴.html:3362`），`audit_log` 单机内存（`main.py:1034`）。`mcp_state.json` 心跳是"伪协作"（`mcp_server.py:325`）。

**目标**：两个客户端同改不同元素互不冲突；同元素冲突可检测可解决（版本向量 + 命令级 merge，不做 OT/CRDT）。

**关键动作**：
1. `save_state` 写盘时附加客户端 `version_vector`（`{client_id: counter}`）；
2. 冲突检测：`load_state` 时比较 version vector，检测"同段同路径双改"；`ConflictResolver` 生成报告（keep-first/keep-last/manual）；
3. P2-4 的 OperationLog 成为广播单位——A 的命令日志 push 给 B，B 重放。

**验收标准**：两个进程同时编辑不同段，互不覆盖；同时改同一段同一参数，后提交者收到冲突报告可选择保留谁。

**依赖**：P2-4（OperationLog）、P1-2（事件）、P0-1（id 引用保证 merge 定位准确）。

---

### P3-3 异步媒体管线（D5）+ 组件级渲染（D6）

**源码事实**：`_make_thumbnail`/`_extract_audio_peaks`/`transcribe_media`（`main.py:2289/2329/4410`）同步阻塞（在 Api 方法内直接调 ffprobe/ffmpeg/Whisper，UI 等待）；前端 `renderAll` 全量重建 DOM（`工作台v0.8时间轴.html:1231`）。

**关键动作**：
1. 导入管线异步化：`import_media_by_paths` 拆"立即返回 + 后台线程探测（ffprobe 时长/尺寸）→ 回调写回状态"；前端先显示占位段，探测完回填；
2. 渲染切片：把 `renderAll` 里的大函数（`renderTimeline`/`renderMedia`/`renderPreviewMaybe`）按 C4 切片彻底解耦，`renderSliceMode` 永久切 `"slice"` 并删除 legacy 双跑（`store.js:77`）；
3. 缩略图/波形缓存到磁盘（避免每次启动重算，`_ensure_video_thumbnails` 已做一半，`main.py:5169`）。

**验收标准**：导入 1GB 视频不卡 UI（先见占位后回填）；时间轴/属性面板 DOM 增量更新（改一个属性不重建整条时间轴）。

**依赖**：P1-2（事件驱动）、P0-1（id 引用支持段级更新定位）。

---

## 5. 依赖关系图与阶段全景

### 5.1 依赖关系图（浓缩）

```
P0-1 位置索引→id 引用 ──► P1-1 Document Protocol ──► P1-4 Plugin v0 ──► P1-3 Preset
P0-2 Command+args  ──┬──► P1-2 EventBus(去轮询) ──► P2-4 OperationLog ──► P3-2 协作
P0-4 schemaVersion ──┘        │
P0-5 时间整数化 ──────────────┼──► P1-5 动画模型(D4) ──► P3-1 Render Graph
P0-3 undo 修复               │
P2-1 Intent Layer ◄── P1-3 Preset（Planner 消费）
P2-2 Semantic ◄──── P1-1（协议段）+ transcribe_media
P2-3 ResourceGraph ◄─ P0-1 + P2-2（annotation 进图）
P3-1 RenderGraph ◄── P1-1 + P1-4 + P0-5
```

### 5.2 阶段全景表

| | P0 正确性 | P1 协议地基 | P2 AI 智能 | P3 长期规模化 |
|---|---|---|---|---|
| **主战场** | 数据模型 + 命令链 + 保存语义 | Document/Event/Preset/Plugin/动画 | Intent/Semantic/Graph/Log | Render Graph/协作/异步 |
| **解决的债务** | D1、D3（渐进）、Command 双轨 | D2、D4 | — | D5、D6 |
| **新增系统** | （无，纯收紧） | Document v1、EventBus、Preset、Plugin v0 | Intent、Semantic、ResourceGraph、OperationLog | Render Graph、协作、异步管线 |
| **AI 能力** | 引用稳定、命令可重放 | 事件驱动、模板可应用 | 一句话出片（规则版）+ 语义问答 | 一句话全自动 + 多人 + 专业渲染 |
| **验收信号** | undo 300 步可回退；引用不漂移；日志带 args | 轮询可调 10s 无感知；新增特效只改 JSON | `submit_intents` 一次整批可回滚；语义问答正确 | LUT 注册 Pass 上线；双人协作无冲突；1GB 导入不卡 |

---

## 6. 风险与注意事项

1. **P0-1（id 引用）是最大工程量**：`type:ti:idx` 散落 mcp_server.py/main.py/前端 27 个模块。建议用**兼容优先**策略——所有方法保留位置索引参数但主路径走 id，逐个模块迁移，每步跑 `tools/graph_consistency.py` 对拍确认零回归。
2. **P1-5（动画模型）绝不破坏旧数据**：读取层先兼容两种结构，写入层后升级，避免历史存档 KF 丢失——这是当前系统唯一的"投资型数据资产"。
3. **P2-1（Intent）先做规则 Planner，不接 LLM**：规则 Planner 可测试、可审计，LLM 解析放在 Intent Layer 之外（MCP/Agent 侧），引擎侧永远保持确定性。
4. **P3-1（Render Graph）优先导出侧**：预览侧 DOM 合成是 30 帧人眼，导出侧才是像素级正确；先 Pass 化导出，预览侧逐步对齐，避免一上来重写渲染导致"能看不能导"。
5. **不删现有能力**：`api.execute` 命令直连、`effects.json` 双适配器、`mcp_state` 心跳、`refresh()` 兜底——全部保留为兼容层，新系统叠加而非替换（Strangler 模式，与当前项目 `PreviewCoordinate.mode` 双轨、`renderSliceMode` 双跑的既有手法一致）。

---

*演进记录：WorkBuddy · 2026-08-22 · 基于《06-V1V2对照分析.md》的 18 项 V1 迁移发现 + 八大系统成熟度评估 · 目标：把"单文件+位置索引+轮询"的自研底座，渐进式演进为"协议+事件+意图"的 AI-Native 视频操作系统*
