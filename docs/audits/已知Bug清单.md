# 已知 Bug 清单

> 纪律（指令③确立，2026-08-27）：**以后出 bug 就记**。任何新观察到的 bug 立即在此文件追加一行，附症状 / 优先级 / 发现日期 / 状态 / 牵连排查结论。
> 收口处：B-01（素材拖入回弹，P0）+ 冻结中的播放器跨段 bug + 历史 deferred 的 #516 拖素材清空。
> 状态取值：`未修(P0)` / `未修` / `临时绕开` / `设计中(门控)` / `已修`。

| 编号 | 优先级 | 发现日期 | 症状（用户/AI 实测描述） | 状态 | 牵连排查结论 | 后续动作 |
|------|--------|----------|--------------------------|------|--------------|----------|
| B-01 | P0 | 2026-08-27 19:00 | 素材从素材库拖入时间轴，松手后**回弹到原点**，落点不保留。用户原话："它回弹"。阻断性——素材放不进时间轴则工具不可用。 | 已修（D组：save_state 冲突改返回 False + add_to_timeline 冲突重试 + 前端拖入串行化；待真机验收） | 已 grep 实证(2026-08-27 续17根因排查)：根因在 add_to_timeline(main.py:3562) 的 _reload()(3584)+save_state()(1578) 链路脆弱性。单拖回弹两候选：①乐观锁(version比对,save_state:1631)偶发拒绝覆盖→段未落盘→前端 refresh 读磁盘无新段=回弹；②drop 复用 dragover 缓存 window.__libDropCache(HTML:3186) 落点漂移(vDir=null 走默认above,computeDrop:334)→落错轨。已排除类型不匹配(TYPE_TRACK:2826 含 image→video)。落码阶段修：前端 drop 重算 computeDrop + 后端乐观锁拒前端醒目 toast/重试。 | 授权后 grep 落点校验 → 定位根因 → 最小修复 → 重启 start.bat 真机验收 |
| B-02 | P1 | 2026-08（既有，冻结中） | 播放器跨段播放问题：MP3 跨段无声 / MP4 跨段卡顿 / drift 死循环。 | 临时绕开 | 已采取临时绕开方案（具体见播放器内核改动），未彻底修复。 | 恢复节奏后彻底修复跨段衔接（Audio Activation Gate / Media Reconciliation 链路） |
| B-03 | P2 | 历史 deferred | #516 拖素材清空：拖素材进时间轴偶发整段/整轨被清空。 | 已修（同源竞态，随 B-01 一并修复；待真机验收） | 已确认同源变体(2026-08-27 续17根因排查)：与 B-01 共享 add_to_timeline 的 _reload()+save_state() 时序脆弱性，触发面不同=并发拖入。清空根因：save_state 无 portalocker 时回退无锁写(1589)，用户快速连续拖入→后到 add 的 _reload 读到先到 add 未save的V1 draft→append后覆盖 V2→先到段丢失=整段/整轨清空。治本：装 portalocker 文件锁 + 前端拖入串行化 + 或并入 R2.5 拖拽handler重做。 | 与 B-01 一并排查；若同源随 R2.5 重做解决则关单，否则单独修 |
| B-04 | P1 | 2026-08-27 续9 | 同轨相邻 clip 之间吸附未触发（SnapEngine 候选点集未含同轨相邻边缘）。 | 未修 | SnapEngine.buildSnapPoints 候选点集未含同轨相邻 clip 边缘；用户"后面再说"。 | L1 手感层细化吸附点逻辑时补 |
| B-05 | P1 | 2026-08-27 续5 | 贴纸变换滑块 + 参数面板音量/特效/蒙版/变速滑块 的"拖参弹回"曾漏保护（首轮只护了 SliderField/NumberField）。 | 已修 | 续6 补丁已覆盖 stBind 贴纸变换滑块 + 超时兜底；`previewActive()` 守卫逻辑收口。 | 仅参数面板/贴纸路径已护；其余新滑块落地时须自检是否走 `previewActive()` |
| B-06 | P1 | 2026-08-28 11:35 | 拖动时间轴播放头时**顶部红字报错**：`TypeError: Cannot read properties of undefined (reading '3') @ renderer.js:692`；KF 面板 live 值更新失败。 | 已修 | 根因（2026-08-28 11:40 排查）：①`renderer.js:692` 硬编码 `KF_PATHS.find(...)[3]`，未按段 type 查找；②`kf-panel.js:118` 只过滤"text 段不渲染变换/融合"，却**没过滤 video/image/sticker 段不渲染文字组**，导致非文本段 KF 面板出现 `text.color/fontSize/letterSpacing` 等 path，而这些 path 不在 `KF_PATHS`（= video 6 通道）中，`find()` 返回 undefined → 读 `[3]` 炸。修复：kf-panel.js 加双向过滤；renderer.js 改用 `KF_PATHS_BY_TYPE[s.type]` 并加 undefined 保护；HTML 内 `renderKfSel`/`addKfAtPlayhead` 两处硬编码 `KF_PATHS.find` 同步按 type 查找保护。 | 重启 start.bat 后拖播放头 + 切换 video/image/text 段验证 KF 面板不再红字；与 B-01 一起验收 |

## 追加规则
- 新增 bug：**追加一行，不要覆盖历史行**（本文件只增不删，除非 bug 被确认修复后把状态改为"已修"并补"修复 commit"列）。
- 牵连排查是硬动作：任何"改一个链路"的修复，先 grep 所有牵连处（调用点、对称路径、撤销栈/快照/乐观锁/前端同步）评估影响，再落码。
- 用户节奏：在妈妈店，真机验收由用户把控；白盒侧（侦察/落码/语法/索引/记忆）AI 全权守关。
