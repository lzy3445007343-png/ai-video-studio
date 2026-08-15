# Step 3 — Asset 分离（Asset Separation）

> 日期：2026-08-15
> 上游：Step 2 播放隔离完成（commit `9994b81`）
> 目标：segment 通过 `material_id` 引用素材，渲染层不再直接依赖 `seg.path`；验证 snap-once 源窗口不变量。

---

## 1. 现状审计（改前）

| 项 | 事实 |
|----|------|
| SCHEMA | segment 已有 `material_id` + `path` 双字段（过渡态：id 关联已定义，path 冗余存储） |
| 前端 | `material_id` 使用 **0 处**；渲染层 11 处直接读 `seg.path` |
| 本地导入 | `import_media_by_paths` 建 materials（含 uid），但 `add_to_timeline` 建段**不写 material_id** |
| 剪映导入 | import 链路维护 materials + 段 material_id（3393-3490） |
| 导出 | `export_draft` **全部用 `seg["path"]`**（VideoSegment/AudioSegment/import_srt）→ seg.path 不能删 |

**结论**：Asset 分离第一步 = 读层收口（统一解析入口）+ 写层补关联（新段带 material_id）。seg.path 保留（导出依赖），去 path 化是长期目标。

## 2. 本轮改动（3 个文件）

### 2.1 store.js — 新增 `resolveSegPath(seg)`

```js
function resolveSegPath(seg) {
  if (!seg) return null;
  if (seg.material_id) {                       // 新数据：material_id → materials[].uid 查 path
    const ms = Store.state.materials;
    if (ms && ms.length) {
      const m = ms.find(x => x && x.uid === seg.material_id);
      if (m && m.path) return m.path;
    }
  }
  return seg.path || null;                     // fallback：旧存档/剪映导入段无 material_id
}
```

**渲染层禁止再直接读 seg.path，统一走此函数。** fallback 保证行为零变化。

### 2.2 renderer.js — 11 处替换

- 8 处 `h.seg.path` → `resolveSegPath(h.seg)`（渲染命中过滤 + 设 src + 贴纸 + 音频）
- 3 处 `getAsrSource` 的 `s.path` / `seg.path` → 先 `resolveSegPath` 再判空（避免重复解析）

### 2.3 main.py — `add_to_timeline` 补 material_id

```python
for _m in self.state.get("materials", []) or []:
    if isinstance(_m, dict) and _m.get("path") == path and _m.get("uid"):
        seg["material_id"] = _m["uid"]
        break
```

- **按 path 精确匹配**（标准链路：导入→拖入用的是 materials[].path 副本路径，可命中）
- 匹配不到**不设**（MCP 直接传原始路径时 miss，段保持无 material_id → 前端 fallback seg.path，行为不变）
- 新段才带 material_id；旧存档段不变（兼容）

## 3. snap-once 不变量（数学验证）

`_split_segment_core`（main.py 2519）：

```
切点 local，split_src = src_start + local × speed
左段：[src_start, split_src]     右段：[split_src, src_end]
左 + 右 = [src_start, src_end] = 原总源窗口 ✅（含变速：同一 speed 缩放，恒成立）
```

## 4. 验证结果（读 draft_state.json）

| 检查项 | 结果 |
|--------|------|
| 孤儿 material_id（id 不在 materials） | 0 |
| seg.path 未在 materials 登记 | 0 |
| snap-once 同源相邻段 src 连续 | 1 对检查，0 违例 |
| 旧段无 material_id | 2 段（属预期，走 fallback） |

## 5. 剩余（后置，不阻塞）

| 项 | 说明 | 何时 |
|----|------|------|
| `add_to_timeline` 建段不再存 path（或 path 变派生字段） | 需导出层同步改造（export 走 materials 解析） | 导出层重构时 |
| 旧存档段补 material_id 迁移脚本 | 一次性数据迁移，可选 | 需要时 |
| `_asset_check.py` 固化进 `tools/` | 每次改动后跑回归 | Step 4 回归基线时 |

## 6. 交付

- commit：`<fill after commit>`（store.js + renderer.js + main.py）
- 行为零变化验证：等用户重开 start.bat（导入/时间轴正常 = resolveSegPath fallback 生效）
