# 05 · 潜在风险与隐藏 Bug 报告

> 审计对象：ai-video-studio 运行文件（main.py / mcp_server.py / 工作台v0.8时间轴.html / 根目录 JS / property/ 目录 JS）
> 审计日期：2026-08-22
> 性质：**非已知 bug，而是潜在风险/隐藏 Bug 扫描**（并发 / 边界 / 错误恢复 / AI 批量 / 内存性能）
> 风险等级：🔴 高（大概率触发或后果严重） / 🟠 中（条件触发） / 🟡 低（罕见或影响轻微）

---

## A. 并发风险（async / race / 锁）

### A-101 🔴 跨进程 read-modify-write 竞态：桌面窗口 vs MCP 进程丢失更新
- **风险描述**：桌面窗口（main.py 内）与 MCP 进程（mcp_server.py，独立 python 进程）共用 `draft_state.json`。两者各自 `load_state()`→内存改→`save_state()`。`save_state` 的文件锁（main.py:1063-1066，portalocker LOCK_EX）**只保护写盘瞬间，不保护"读-改-写"整体**：A 进程 reload 后，B 进程也 reload（同一基线），A 写盘，B 写盘覆盖 A 的改动。
- **代码证据**：`main.py:2449-2467` Api._reload（每个写操作前读盘）；`main.py:1061-1084` save_state（锁仅包住 json.dump）；`mcp_server.py:33-37` 每个 MCP tool 新建 `main.Api()` 再 execute。
- **触发场景**：AI 经 MCP 批量加素材的同时，用户正在桌面窗口拖动/调音量——后写者静默覆盖先写者，用户看到"我刚调的音量没了"。
- **影响**：用户编辑被静默丢失，且 **没有冲突检测或提示**。读回验证（main.py:1075）只能发现"写的内容与内存不一致"，无法发现"另一个进程合法覆盖"。
- **建议**：写前重新读盘并在 `save_state` 内做 `version`/`last_committed` 乐观锁（CAS：版本不符则重试或返回冲突）；或引入单一写者（MCP 写操作全部经桌面进程转发）。

### A-102 🔴 事务超时 abort 会清掉对方进程的并发改动
- **风险描述**：`CommandManager._abort_tx`（main.py:997-1002）把 `api.draft` 恢复为 `tx["saved_state"]`（begin 时的 deepcopy）**并立即 save_state 写盘**。若事务是 MCP 进程开的（begin 后卡住 >30s，`_TX_TIMEOUT_S=30`，main.py:915），abort 会把桌面窗口在这 30 秒内写盘的所有新改动整体回滚。
- **代码证据**：`main.py:957-1002` begin_transaction/_tx_expired/_abort_tx；`mcp_server.py:28-37` MCP 走同一 CommandManager。
- **触发场景**：AI 发起几十条命令的批次，其中一条 ffprobe/ffmpeg 卡住 >30s → 事务被超时 abort → 回滚快照覆盖磁盘上的最新草稿（含桌面用户刚做的修改）。
- **影响**：用户未做任何操作却丢了素材/属性，且无任何提示。
- **建议**：abort 前重新读盘做 diff，只回滚本事务真正改过的段/轨道；或把事务 saved_state 改为"路径级快照"而非全量。

### A-103 🟠 三层 Refresh Lock 无看门狗，锁泄漏即 UI 冻结
- **风险描述**：`refresh()`（工作台v0.8时间轴.html:3218-3235）被三层独立锁拦截：`InteractionManager.blocksRefresh()`（property/interaction-kernel.js:70）、`_kfEditing`（property/kf-panel.js:46）、`_kfDragActive`（HTML:2135）。任一锁置位后未复位（异常/分支 return），500ms 轮询将永久跳过 refresh → 时间轴不再同步后端。
- **代码证据**：`startKfMarkerDrag`（HTML:2136-2223）在 up 回调中段手动 `_kfDragActive=false`（:2199），无 try/finally；`InteractionManager.end()`（interaction-kernel.js:58-63）依赖 activeSession.destroy 不抛异常。
- **触发场景**：`move` 回调（HTML:2187-2195）中 `t.el.style` 抛错（如 renderTimeline 恰在期间重建 DOM，`t.el` 被移除）→ mouseup 事件仍会触发 `up`，但 `_kfDragActive` 已在 2199 行前复位？不——2199 行在 `if (!active)` 之前执行，若 `move` 抛错发生在 `_kfDragActive=true` 之后且 `up` 从未绑定成功，锁永不释放。
- **影响**：UI 静默冻结，仅 console 有报错，无恢复手段。
- **建议**：RefreshGate 引用计数 + 超时强制解锁；kf 拖拽整体 try/finally 复位。

### A-104 🟠 MCP 工具间并发：同一 FastMCP server 内多请求交错写
- **风险描述**：FastMCP 处理多个 tool 调用时，每个都新建 Api → 各自 `_reload` → 内存改 → `save_state`。两个并发 tool（如同时 add_clip 与 set_segment_speed）读同一基线，后写覆盖先写（同 A-101，但发生在单进程内线程间，窗口更小更难查）。
- **代码证据**：`mcp_server.py:35` `api = main.Api()`；`main.py:2483` execute 内 `self._reload()`。
- **影响**：AI 的并发命令部分丢失。
- **建议**：MCP 层为 Api 实例加 `threading.Lock`（模块级单例 Api），串行化写操作。

### A-105 🟠 播放状态机并发：playTick（RAF） vs 跨段异步 `_handleCrossSegment`
- **风险描述**：`_handleCrossSegment`（player.js:579-600）是 async、被 fire-and-forget 调用（player.js:666 `PlayerManager.handleCrossSegment(us)`）。执行期间用户拖动播放头 `seekPlayhead`（HTML:607-614）会重锚 `playStartUs/playStartWall`，同时 `crossSegmentQueuedUs` 可能残留过期目标，`while (target != null)` 会多补一轮 seek。
- **代码证据**：player.js:583-596；timeline.js:607-614。
- **影响**：极少数场景下切段后多 seek 一次（可感知为轻微跳动），无数据损坏。
- **建议**：`_handleCrossSegment` 内检查 `isPlaying` 与播放头是否仍有效；跨段协程加 session 令牌（与 recoverToken 同思路）。

### A-106 🟡 AudioEngine 快速拖动时反复取消解码
- **风险描述**：播放头拖动（scrub）每次 `seekActiveMediaToPlayhead(us, true)`（player.js:565-569）都会 `AudioEngine.setClips` → `stopAll` → `_epoch++`（audio-engine.js:207-221）。`_epoch` 使 in-flight decode 全部作废（audio-engine.js:142）。80ms 节流（HTML:2388-2394）下，一次快速拖动可取消十几次解码。
- **影响**：拖动期间音频反复重启/无声；长音频解码反复中断浪费 CPU。
- **建议**：setClips 在 300ms 内去抖（拖动结束才重排）；或 tick 内自动补调度已足够，无需每次 stopAll。

---

## B. 边界条件（0 秒 / 末帧 / fps / 空值 / 除零 / 负值）

### B-101 🔴 `scale_group` 中途异常 → 部分成员已修改 + 未落盘
- **风险描述**：`scale_group`（main.py:3625-3663）循环逐成员改 `seg["duration"]/["speed"]/["start"]`，`sp = _seg_speed(seg) / factor` 在 `factor == 0` 或 `factor` 非数值（`float(m["factor"])` 抛 ValueError 更早）时 **ZeroDivisionError**；异常发生在循环中途 → 前面成员已原地修改，`save_state` 从未执行 → 内存草稿部分污染，磁盘仍是旧版。前端拿到异常后若触发一次含写操作的 refresh，会把部分污染状态带上盘。
- **触发场景**：前端 groupScale.factor 计算出 0（HTML:2296-2335 onGroupHandleDown/onGroupMove 未 clamp factor>0）。
- **建议**：factor 校验（`factor <= 0 → 拒绝`）；循环前深拷贝草稿，失败整体回滚。

### B-102 🟠 分割/裁剪在 `at == start+duration`（末帧）被拒绝但无友好提示
- **风险描述**：`_split_segment_core`（main.py:3777-3779）`if at <= start or at >= start + dur: return {"ok":False,...}`。前端快捷键用 `Math.round(Store.state.playheadUs)`（HTML:2838）切段，播放头恰好停在段末（等于 start+duration）时直接报"分割点不在该片段内部"。
- **影响**：用户困惑；无空态/末帧处理。
- **建议**：分割点 clamp 到 `[start, start+duration]` 内部并吸附一帧；或明确提示"播放头在片段外"。

### B-103 🟠 空草稿/全删后 `totalDurationUs()==0` 与 playTick 收尾
- **风险描述**：`playTick`（player.js:618-625）`us >= maxUs` 时 `Store.state.playheadUs = maxUs; pausePlay()`。若 `maxUs==0`，startPlay 已早退（player.js:360-361）。但若**播放中删除全部片段**（remove_segments 后 get_state 轮询回来），`maxUs` 变 0，下一帧 `wallUs>=0` 恒真 → 立即 pausePlay，同时 `Store.state.playheadUs=0`，看似正常，但 `pausePlay` 内 `PlayerManager.pause()` 会对空元素列表安全。风险点：`renderTimecode` 显示 "0:00 / 0:00"，无"草稿已空"提示。
- **影响**：低，仅体验。
- **建议**：播放中草稿清空时给用户提示。

### B-104 🟠 `_segments_overlap` 对 duration=0 的段判断退化为边界相等
- **风险描述**：`_segments_overlap`（main.py:340-344）`a1=a0` 时 `a1<=b0` 在 a0==b0 时成立 → 0 时长段与任何段都不"重叠"。若导入的 0 时长文件（ffprobe 返回 0）进轨，后续同位置放置不会避让。
- **建议**：`duration_for` 对 `seconds==0` 强制回退 DEFAULT_DURATION（main.py:1976-1981 已有回退，但 `seconds=0` 走 `if seconds:` 为 False → 已回退，**此处实际安全**，仅提示 frontend `add_to_timeline` 直接传 0 时不受保护）。

### B-105 🟠 KF 插值在重复时间键上的行为未定义
- **风险描述**：`kfVal`（工作台v0.8时间轴.html:1586-1600）对 `a.t==b.t`（重复键）用 `span=(b.t-a.t)||1` 兜底；但**重复键存在时线性插值结果取决于排序稳定性**。后端 add_keyframe 已改严格相等合并（main.py:2993），但历史数据或 kf-channel.js upsertLocal（±1ms）仍可产生重复 t。`kfVal` 对 `localUs <= ks[0].t` 返回首键值，若两个同 t 键 v 不同，插值区间内取 a.v（先排者），值不确定。
- **影响**：关键帧曲线偶发跳变。
- **建议**：add_keyframe 与 kfVal 统一走帧吸附 + 严格合并；重复键保留最后一个。

### B-106 🟠 `_trim_core` 无源段（text/sticker/image）右拉不设上限
- **风险描述**：`_trim_core`（main.py:3531-3535）对无源段 `delta = max(MIN-dur, new_edge-(start+dur))`，**没有上限**。text 段可被拉长到任意大，`contentWidth()` 的时间轴会跟着膨胀到天文数字（HTML 上 pxPerSec×时长溢出布局）。
- **影响**：极端拖拽下时间轴卡顿/横向滚动条异常。
- **建议**：对无源段设合理上限（如 10 分钟）或按需求放开但 clamp。

---

## C. 错误恢复（失败后状态回滚 / 数据污染 / 用户知情）

### C-101 🔴 `add_keyframe`/`update_keyframe` 等大量写操作忽略 `save_state` 返回值
- **风险描述**：`save_state` 失败（写盘异常/读回不一致）时返回 False（main.py:1084/1090），但 `add_keyframe`（main.py:3006）、`update_keyframe`（:3046）、`remove_keyframe`（:3066）、`clear_keyframes`（:3089）、`set_segment_volume`（:2836）、`set_segments_props`（:2896）等 **20+ 处均不检查返回值**，仍返回 `{"ok":true,...}`。前端 CommandService.withTx（property/command.js:25-43）按 `res.ok===false` 判定失败 → **写盘失败被当作成功**，undo 栈记录了一条从未落盘的命令。
- **代码证据**：main.py:3006 例；save_state 契约见 main.py:1040-1091。
- **影响**：静默数据丢失——用户看到界面更新（内存态），重启后全部回滚，undo 也无效。
- **建议**：全局策略：`save_state` 失败时所有写方法统一返回 `{ok:false, error:"保存失败"}`（可做 decorator 或在 execute 层兜底）。

### C-102 🔴 导入素材失败无回滚且不检查落盘结果
- **风险描述**：`import_media_by_paths`（main.py:4760-4806）对每个文件独立 try，部分成功部分失败时 `items` 已积累、`save_state(self.state)` 返回值被忽略；若 save_state 失败，前端 refresh 拉旧盘 → 素材"导入成功又消失"。
- **触发场景**：磁盘满/权限变更。
- **建议**：保存失败时返回 `{ok:false}` 并回滚 state.materials；前端对 import 结果明确提示成功/失败数。

### C-103 🔴 `import_jianying_project` 整体替换无事务、无回滚
- **风险描述**：`import_jianying_project`（main.py:4819-4979）在 `self.state["draft"]=out; self.state["materials"]=new_materials`（:4971-4972）之后才 `save_state`。若转换中途抛异常（缺字段/类型错），**内存 state 已被部分写入，磁盘未动**；下次 `_reload` 恢复磁盘旧态，但若异常后用户立刻操作（如拖一个素材触发 save_state），会把"半成品草稿"带上盘。且整个导入**没有 undo 入口**（用户无法撤销"导入剪映项目覆盖我现有工程"）。
- **建议**：导入前整体 deepcopy 当前 state，失败/用户取消时恢复；导入作为一条 undo 命令入栈。

### C-104 🟠 导出失败不清理半成品草稿文件夹
- **风险描述**：`export_draft`（main.py:4543-4758）边构建边 `script.add_segment`，某段抛异常时 `except` 直接 return `{ok:false}`，但 `folder/name` 目录内已写入部分 track/segment，**无清理**。用户重试会 `allow_replace=True`（main.py:4580）覆盖，但残留的 meta 文件可能与新草稿混合。
- **建议**：导出到临时目录，成功后原子 rename。

### C-105 🟠 ffprobe/ffmpeg 失败静默降级占位时长，用户不知情
- **风险描述**：`duration_for`（main.py:1969-1981）ffprobe 失败回退 `DEFAULT_DURATION`（video=5s）。一个损坏/0 时长的 mp4 会以 5 秒进轨，用户播放只见 5 秒黑屏，无任何"素材无法读取"提示；`get_media_duration` 返回 None（main.py:1898-1915）。
- **建议**：进轨时对 video/audio 若 ffprobe 失败，返回 `{ok:false, warning}` 或在前端素材卡标注"无法探测时长"。

### C-106 🟠 播放器加载失败后仅 dbg 提示，无重试 UI
- **风险描述**：`_tryReloadMedia`（player.js:253-306）5 秒内最多重试 2 次后放弃；`dbg()`（player.js:319）把错误写进 mediaStatus 文本。用户正常观看时看不到该提示（mediaStatus 位置偏），且无"重试"按钮。
- **影响**：中低——黑屏无声但用户不明确原因。
- **建议**：错误时给一次性 toast + 重试按钮。

### C-107 🟠 undo/redo 快照引用旧引用：redo 依赖 post_state 深拷贝，撤销后引用失效
- **风险描述**：`undo`（main.py:1013-1015）记录 `cmd.post_state = deepcopy(api.draft)` 后恢复 saved_state；`redo`（main.py:1021-1028）恢复 post_state。若 undo 后用户**做了新操作**（execute 已 `redo_stack.clear()`，main.py:953），安全。但若 MCP 进程 execute（新 Api 实例 _reload 后）期间桌面进程 redo，两侧内存快照基于不同磁盘基线 → redo 恢复出一份"过期合成态"。
- **影响**：跨进程撤销/重做语义不可靠（见 A-101 同源）。
- **建议**：跨进程 undo 需基于磁盘 version 校验。

---

## D. AI 批量操作风险（事务 / 半成品）

### D-101 🔴 `CommandService.withTx` 不检查 `beginTx` 返回值
- **风险描述**：`withTx`（property/command.js:25-43）`return this.beginTx(label, opts.meta).then(() => fn()...)`，**不检查 beginTx 的 `{ok:false}`**。当已有进行中事务（后端 `begin_transaction` 返回"已有进行中的事务"，main.py:963）时，`fn()` 照常执行 → 几十个命令在**事务外**逐条执行 → 每条独立入栈（undo 变成 N 步）、失败也不整体回滚。
- **触发场景**：AI 在前一个事务未 commit 的情况下发起第二个批次；或前端手势事务与 AI 批次交错。
- **影响**：批量操作原子性失效，中途失败留下半成品。
- **建议**：beginTx 失败 → 拒绝执行 fn 并返回错误；或等待重试。

### D-102 🔴 事务中途失败（第 N 条命令 ok=false）不会自动回滚已执行的 N-1 条
- **风险描述**：`withTx` 的 `res.ok===false` 分支走 `abortTx()`（command.js:30-33）——**看起来会回滚**。但 `abortTx` 后端实现 `_abort_tx`（main.py:997-1002）恢复的是 **begin 时快照**，正确。真正的漏洞在**前端命令列表**：AI 用 `Promise.all(jobs)` 并行发几十条 execute（如 kf 组拖 `Promise.all(session.targets.map(...))`，HTML:2211），**并行到达后端时每条 execute 都先 `_reload()` 再执行**——reload 会读磁盘旧状态，多条命令基于同一旧基线执行，后执行者的修改覆盖先执行者（读-改-写竞态发生在单事务内部）。
- **代码证据**：main.py:2483 execute 内 `self._reload()`；HTML:2211 Promise.all 并行。
- **影响**：批量关键帧/批量属性设置时部分命令被覆盖（最终只保留最后一条的结果），但 `count` 仍累加 → undo 一次撤销全部。
- **建议**：事务内 execute **不要 _reload**（事务已经基于 begin 快照）；或前端批量改串行 await。

### D-103 🟠 审计历史 cap=100 且纯内存，AI 批量后重启即丢
- **风险描述**：`CommandManager`（main.py:907-1037）history 仅内存 + cap=100，无持久化。MCP 进程重启后 AI 的历史审计/undo 全部丢失（desktop 进程也一样）。"谁改了什么"的护城河只在单进程存活期内成立。
- **建议**：审计日志落盘（append-only JSONL），undo 栈支持恢复最近 N 条。

### D-104 🟠 批量操作无总进度/总结果反馈
- **风险描述**：MCP `execute` 每次返回单命令结果；AI 跑 50 条命令时用户只看到时间轴"逐条变"，失败一条无聚合提示，无法一次性回滚整个批次（除非 AI 自己开事务，但见 D-101/D-102）。
- **建议**：提供 `execute_batch(cmd_list)` 后端原语，单事务 + 聚合结果 + 单 undo。

---

## E. 内存 / 性能风险

### E-101 🔴 `renderSliceMode:"legacy"` 双跑：每个 Store.set 全量重建整条时间轴
- **风险描述**：`store.js:77` `renderSliceMode:"legacy"` → `_applySet`（store.js:111-126）在 slice 订阅者之外仍 `this._emit()` → `renderAll`（HTML:1231-1253）→ `renderTimeline`（timeline.js:491-603）**销毁全部 .track/.seg 再重建** + `renderRuler` 数百个 tick div + `drawAllWaves` 双跑（timeline.js:585-586）。桌面 500ms 轮询每拍一次。大项目（几百段）下主线程每 0.5s 一次 O(N) DOM 重建。
- **代码证据**：store.js:77/125；HTML:3362-3367 500ms 轮询调 refresh → renderAll（HTML:3262）。
- **影响**：编辑体感卡顿；播放头拖动被重建抢占（虽已有 onPhMove 绕开 Store.set 的优化，HTML:2405-2412，但轮询帧仍可能撞上）。
- **建议**：切 `"slice"` 模式（迁移对照已完成）；renderTimeline 改为差量更新。

### E-102 🟠 undo 栈 100 条 × 全草稿 deepcopy 常驻内存
- **风险描述**：每次写操作 `execute` 存 `saved_state`（main.py:936）、`save_state` 存 `last_committed`（main.py:1060）并 `push_snapshot` 再 deepcopy（main.py:1055）——单命令 2~3 次全量深拷贝，undo 栈最多保留 100 份草稿副本。草稿含 peaks 数组（素材级 60000 点 × 素材数）时内存成倍膨胀。
- **影响**：长会话 + 大素材库 → 数百 MB 峰值内存。
- **建议**：快照改路径级；peaks 不随草稿深拷贝（引用共享 + 不可变）。

### E-103 🟠 `_extract_audio_peaks` 长音频全量加载进内存
- **风险描述**：`_extract_audio_peaks`（main.py:2329-2387）用 ffmpeg 输出全量 PCM 后 `np.frombuffer` 加载**整个数组**再分桶。1 小时音频 ≈ 22050×3600=79M 样本 × 4B ≈ 318MB 瞬时内存（随后 `peaks[:60000]` 截断，但计算已全量）。
- **建议**：分块流式处理（ffmpeg 按秒切片输出）或限制最大处理时长。

### E-104 🟠 AudioEngine `bufferCache` 8 条全量解码
- **风险描述**：audio-engine.js:29 `MAX_BUFFERS=8`，每条 clip 全量 `decodeAudioData`（解码后 float32 约为源文件 10 倍）。8 × 长音频可超 300MB。
- **建议**：按播放窗口只解码当前段 ± lookahead 的切片；LRU 优先淘汰长段。

### E-105 🟠 Blob URL 与媒体元素泄漏
- **风险描述**：`_getSilentPrimeUrl`（player.js:332-345）创建的 Blob URL 缓存后**永不 revoke**；`renderPreview` 每次切源 `_setVisualContent` 对 `<video>` 复用元素（renderer.js:62-90）不重建，DOM 元素数量受轨道数限制，**元素本身不泄漏**；但 previewState.visualEls 的 rec 在段被删后无清理路径（preview-drag.js:79 注释自认"wrap 残留于 previewState"）——`destroy` 只在跨段重建时对 key 调，**删除段后旧 wrap 残留**直到下轮 renderPreview 置 display:none。
- **影响**：中低——visualEls 缓慢累积死条目（每删一个段多一个隐藏 DOM + 引用）。
- **建议**：段删除/草稿刷新时对 previewState 做"当前 draft 可见 key"的 GC。

### E-106 🟡 500ms 轮询 + 每次 save_state 读回验证的 IO 放大
- **风险描述**：桌面轮询 `get_state` 每 500ms 读盘一次（main.py:4990-5012）；MCP 每次写操作读盘+写盘+读回；save_state 读回验证再全量 parse（main.py:1072-1083）。草稿文件 100KB+ 时，一轮 = 4~6 次全量 IO。
- **建议**：轮询读用文件 mtime 快路径；写回验证抽样。

---

## 风险总览（按等级）

| 等级 | 条目 | 一句话 |
|---|---|---|
| 🔴 高 | A-101 / A-102 / C-101 / C-102 / C-103 / D-101 / D-102 / E-101 | 跨进程丢数据、写盘失败被当成功、批量事务原子性失效、全量重建卡顿 |
| 🟠 中 | A-103 / A-104 / A-105 / A-106 / B-101 / B-102 / B-105 / B-106 / C-104 / C-105 / C-106 / C-107 / D-103 / D-104 / E-102 / E-103 / E-104 / E-105 | 条件触发的竞态、异常路径的状态污染、内存增长 |
| 🟡 低 | B-103 / B-104 / E-106 | 体验级/罕见 |

**最高优先级修复建议（按性价比）**：
1. **写路径失败可见化**：save_state 返回 False 时所有写 API 返回 `{ok:false}`（C-101，改动面集中在后端 execute 层）。
2. **MCP 写操作串行化**：单进程内加锁 + 事务内禁止 `_reload`（A-104 / D-102）。
3. **事务 begin 失败即拒绝** + abort 前做磁盘 diff（D-101 / A-102）。
4. **renderSliceMode 切 slice** 并清理 legacy 双跑（E-101，一行改动收回架构收益）。
5. **Refresh Lock 加看门狗**（A-103）。
