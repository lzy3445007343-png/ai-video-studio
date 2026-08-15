"""Asset 一致性验证（Step 3 固化版）：读 draft_state.json 检查 material_id 一致性 + snap-once 不变量。
用法：python tools/asset_check.py [draft_state.json 路径，默认项目根]
只读，不改数据。改数据模型后跑一遍，回答"素材关联有没有被改坏"。
"""
import io, json, os, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "draft_state.json")
with io.open(p, "r", encoding="utf-8") as f:
    st = json.load(f)

draft = st.get("draft", {})
materials = st.get("materials", [])
mat_by_uid = {m.get("uid"): m for m in materials if isinstance(m, dict) and m.get("uid")}
mat_by_path = {m.get("path"): m for m in materials if isinstance(m, dict) and m.get("path")}

print("== 基本统计 ==")
print("materials:", len(materials))
total_segs = 0
for t in ("video", "audio", "image", "text", "sticker", "effect"):
    for tr in draft.get(t, []):
        total_segs += len(tr)
print("segments:", total_segs)

print("\n== material_id 一致性 ==")
orphan = 0
with_mid = 0
for t in ("video", "audio", "image", "text", "sticker"):
    for tr in draft.get(t, []):
        for seg in tr:
            if not isinstance(seg, dict):
                continue
            mid = seg.get("material_id")
            if mid:
                with_mid += 1
                if mid not in mat_by_uid:
                    orphan += 1
                    print(f"  [孤儿 material_id] {t} seg={seg.get('name')} id={mid}")
print(f"有 material_id 的段: {with_mid} / {total_segs}")
print(f"孤儿 material_id: {orphan}")

print("\n== path 一致性（seg.path 是否在 materials 中存在） ==")
path_missing = 0
for t in ("video", "audio", "image", "text", "sticker"):
    for tr in draft.get(t, []):
        for seg in tr:
            if not isinstance(seg, dict):
                continue
            sp = seg.get("path")
            if sp and sp not in mat_by_path and seg.get("resource_id") is None:
                path_missing += 1
                print(f"  [path 不在 materials] {t} seg={seg.get('name')}")
print(f"seg.path 未在 materials 中登记的段: {path_missing}")

print("\n== snap-once 不变量（同轨相邻段，同源，前段 src_end 应 == 后段 src_start） ==")
violations = 0
checked = 0
for t in ("video", "audio"):
    for ti, tr in enumerate(draft.get(t, [])):
        for i in range(len(tr) - 1):
            a, b = tr[i], tr[i + 1]
            if not isinstance(a, dict) or not isinstance(b, dict):
                continue
            same_src = (a.get("material_id") and a.get("material_id") == b.get("material_id")) or \
                       (a.get("path") and a.get("path") == b.get("path"))
            if not same_src:
                continue
            if a.get("src_end") is not None and b.get("src_start") is not None:
                checked += 1
                if abs(a["src_end"] - b["src_start"]) > 1000:  # 1ms 容差
                    violations += 1
                    print(f"  [snap-once 违例] {t}[{ti}] {i}->{i+1}: src_end={a.get('src_end')} vs src_start={b.get('src_start')}")
print(f"同源相邻段检查: {checked} 对，违例: {violations}")

print("\n== 结论 ==")
ok = orphan == 0 and path_missing == 0 and violations == 0
print("ALL OK" if ok else "ISSUES FOUND")
sys.exit(0 if ok else 1)
