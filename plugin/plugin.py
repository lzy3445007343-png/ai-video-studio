# -*- coding: utf-8 -*-
"""
M6-6b Plugin v0 —— 插件清单 + 注册表（对齐 09 方案 M6 6b / 08 施工图 §2.2）。

设计：
- PluginManifest{id, version, registers:{effects, masks, commands, exporters}}：
  一个插件声明它「注册了什么能力」。当前只有内置 effects 插件（masks/commands/exporters 为空位，
  为 M7 Intent 的 exporters 与后续开源特效包留注册点）。
- PluginManager.register/query：
  register 幂等（同 id 覆盖）；query(kind) 返回该能力类型的完整注册表；
  query(kind, key) 返回单个能力；list_plugins() 供审计/调试。
- builtin_effects_manifest(effect_registry, effect_meta)：把 main.py `_load_effects()` 的产出
  （EFFECT_REGISTRY 函数表 + EFFECT_META 自描述）包装成内置 effects 插件，作为当前系统唯一内置插件。

边界：v0 只做「注册表」不做生命周期（load/unload/依赖解析）——当前系统只有一个内置插件，
重型插件系统是过度设计，留到出现第二个第三方插件时再演进。
"""


class PluginManifest:
    """插件清单：声明插件身份与注册的能力。"""

    def __init__(self, plugin_id, version="1.0", registers=None):
        if not plugin_id or not isinstance(plugin_id, str):
            raise ValueError("plugin_id 必须是非空字符串")
        self.id = plugin_id
        self.version = version
        self.registers = {
            "effects": {},
            "masks": {},
            "commands": {},
            "exporters": {},
        }
        if registers:
            for kind, payload in registers.items():
                if kind in self.registers and isinstance(payload, dict):
                    self.registers[kind] = payload

    def to_dict(self):
        """自描述（供 MCP/审计序列化）。"""
        return {
            "id": self.id,
            "version": self.version,
            "registers": {k: list(v.keys()) for k, v in self.registers.items()},
        }


class PluginManager:
    """插件注册表：register / query / list。类级单例由 main.py 持有。"""

    def __init__(self):
        self._plugins = {}

    def register(self, manifest):
        """注册插件（同 id 覆盖，幂等）。"""
        if not isinstance(manifest, PluginManifest):
            raise TypeError("register 需要 PluginManifest 实例")
        self._plugins[manifest.id] = manifest
        return {"ok": True, "plugin": manifest.id, "version": manifest.version}

    def query(self, kind, key=None):
        """查询能力：query("effects") → 全量 dict；query("effects", "blur") → 单条。"""
        out = {}
        for manifest in self._plugins.values():
            payload = manifest.registers.get(kind)
            if payload:
                out.update(payload)
        if key is not None:
            return out.get(key)
        return out

    def list_plugins(self):
        """列出全部插件（自描述），供审计/调试。"""
        return [m.to_dict() for m in self._plugins.values()]


def builtin_effects_manifest(effect_registry, effect_meta):
    """把 main.py `_load_effects()` 的产出包装成内置 effects 插件。

    effect_registry: {key: {"css": fn, "ffmpeg": fn}}（函数表）
    effect_meta:     {key: {"label", "params", "css_expr", "css_when"}}（自描述，前端编译用）
    """
    registers = {"effects": {}}
    for key, meta in (effect_meta or {}).items():
        entry = effect_registry.get(key) or {}
        registers["effects"][key] = {
            "meta": meta,
            "css": entry.get("css"),
            "ffmpeg": entry.get("ffmpeg"),
        }
    return PluginManifest("builtin-effects", "1.0", registers=registers)
