"""5b（R9）逻辑测试：从真实 main.py 抽取函数，验证 params 成为唯一真相源。
不依赖 pyJianYingDraft / 文件 IO——ClipSettings 与 _media_dims_cached 用桩替代。
"""
import ast, inspect, textwrap

SRC = open("main.py", encoding="utf-8").read()
tree = ast.parse(SRC)

def grab(name):
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return ast.get_source_segment(SRC, node)
    raise RuntimeError("not found: " + name)

# 桩：替代外部依赖
def ClipSettings(**kw):
    return dict(kw)
def _media_dims_cached(p):
    return (None, None)

ns = {"ClipSettings": ClipSettings, "_media_dims_cached": _media_dims_cached}
for fn in ("_write_param", "_seg_param", "_video_clip_settings"):
    src = grab(fn)
    exec(compile(src, fn + ".py", "exec"), ns)
# _FIELD_TO_PARAM 是模块级常量，单独抽取
for node in tree.body:
    if isinstance(node, ast.Assign):
        tgt = node.targets[0]
        if isinstance(tgt, ast.Name) and tgt.id == "_FIELD_TO_PARAM":
            exec(compile(ast.get_source_segment(SRC, node), "_FIELD_TO_PARAM.py", "exec"), ns)

write_param = ns["_write_param"]
seg_param = ns["_seg_param"]
video_cs = ns["_video_clip_settings"]
F2P = ns["_FIELD_TO_PARAM"]

ok = True
def check(cond, msg):
    global ok
    print(("PASS" if cond else "FAIL") + " - " + msg)
    if not cond: ok = False

# 场景1：新 seg（前端只写 params，无 legacy transform）
seg_new = {"id": "s1", "type": "video", "params": {"transform.positionX": 120, "transform.opacity": 0.5}}
# update_segment_transform 行为：写 transform + 同步 params
seg_new["transform"] = {}
for k, p in F2P.items():
    if k in ("x", "opacity"):
        seg_new["transform"][k] = 120 if k == "x" else 0.5
        write_param(seg_new, p, seg_new["transform"][k])
cs = video_cs(seg_new, 1920, 1080)
check(abs(cs["transform_x"] - 120/(1920/2)) < 1e-6, "新seg: params.positionX 被导出正确 (x=120)")
check(abs(cs["alpha"] - 0.5) < 1e-6, "新seg: params.opacity 被导出正确")

# 场景2：旧草稿（只有 legacy transform，无 params）——必须兜底
seg_old = {"id": "s2", "type": "video", "transform": {"x": -300, "scaleX": 2.0, "rotation": 45, "opacity": 0.8}}
cs2 = video_cs(seg_old, 1920, 1080)
check(abs(cs2["transform_x"] - (-300)/(1920/2)) < 1e-6, "旧seg: 兜底 transform.x 正确")
check(abs(cs2["scale_x"] - 2.0) < 1e-6, "旧seg: 兜底 scaleX 正确")
check(abs(cs2["rotation"] - 45) < 1e-6, "旧seg: 兜底 rotation 正确")

# 场景3：漂移消除——params 优先于 legacy（即便 legacy 是旧的）
seg_mix = {"id": "s3", "type": "video",
           "params": {"transform.positionX": 999},          # 新值
           "transform": {"x": 0}}                            # 旧值（stale）
cs3 = video_cs(seg_mix, 1920, 1080)
check(abs(cs3["transform_x"] - 999/(1920/2)) < 1e-6, "params 优先于 stale legacy（漂移消除）")

# 场景4：_seg_param 缺省 + 缺失
check(seg_param({"params": {}}, "transform.rotate", 0.0) == 0.0, "_seg_param 缺省兜底")
check(seg_param({"params": {"speed.rate": 1.5}}, "speed.rate", 1.0) == 1.5, "_seg_param 命中")

print("\nRESULT:", "ALL PASS" if ok else "HAS FAILURE")
