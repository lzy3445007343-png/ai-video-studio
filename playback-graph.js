"use strict";

/* =====================================================================
 * playback-graph.js —— Playback Graph 语义层（Phase A，新文件）
 *
 * 职责（方案 §3）：把"同一份时间轴数据被多套逻辑各自算"收成"一套语义层"。
 * 输入 draft（Store.state.draft），输出平铺后的 { audioClips, videoNodes, version }。
 * 纯函数：无副作用、不碰 DOM、不依赖 Store（路径解析显式传 materials）。
 * 同一 draft 永远产出同一 graph —— tools/graph_consistency.py 用它和
 * main.py _playback_graph() 对拍，保证「预览 = 导出」共用同一套换算。
 *
 * 浏览器用法：<script src="playback-graph.js"> → 全局 buildPlaybackGraph
 * Node 用法（对拍脚本）：require("playback-graph.js").buildPlaybackGraph
 * ===================================================================== */

let _graphVersion = 0;

// 与 main.py 常量对齐（DEFAULT_SPEED / MIN_SPEED / MAX_SPEED）
const GRAPH_DEFAULT_SPEED = 1.0;
const GRAPH_MIN_SPEED = 0.01;
const GRAPH_MAX_SPEED = 5.0;

/* ---------- 内部工具（两端一致的核心，必须与 main.py _playback_graph 逐行对齐） ---------- */

// 数值兜底：非数值 / NaN → 返回 dflt（与 Python _seg_num 对齐）
function _num(v, dflt) {
  if (typeof v !== "number" || isNaN(v)) return dflt;
  return v;
}

// 变速 clamp：与 Python _seg_speed 对齐（缺/非数值/<=0/NaN → DEFAULT_SPEED）
function _clampSpeed(v) {
  if (typeof v !== "number" || v !== v || v <= 0) return GRAPH_DEFAULT_SPEED;
  return Math.max(GRAPH_MIN_SPEED, Math.min(GRAPH_MAX_SPEED, v));
}

// 音量兜底：能转数值就转，否则 1（与 Python _graph_volume 对齐）
function _graphVolume(v) {
  if (v == null || v === "") return 1;
  const f = Number(v);
  return isNaN(f) ? 1 : f;
}

// 素材解析：material_id → materials[].uid 查 path；失败 fallback seg.path（与 store.js resolveSegPath 同构）
function _resolvePath(seg, materials) {
  if (!seg || typeof seg !== "object") return null;
  if (seg.material_id) {
    for (const m of (materials || [])) {
      if (m && m.uid === seg.material_id && m.path) return m.path;
    }
  }
  return seg.path || null;
}

/* ---------- §3.4 统一音量解析（v1.3：拆两层，previewMuted 只在播放端叠加） ---------- */

// 第一层：两端共享（播放 + 导出都用）—— 不含 previewMuted
function resolveGain(trackMuted, segMuted, segVolume) {
  if (trackMuted) return 0;
  if (segMuted) return 0;
  return _graphVolume(segVolume);
}

// 第二层：仅 JS 播放端叠加全局预览静音
function finalPlaybackGain(previewMuted, trackMuted, segMuted, segVolume) {
  if (previewMuted) return 0;
  return resolveGain(trackMuted, segMuted, segVolume);
}

/* ---------- §3.2 clip / node 平铺（字段两端一致） ---------- */

function _flattenVideo(seg, ti, idx, trackMuted, trackHidden, materials) {
  if (!seg || typeof seg !== "object") return null;
  const startUs = _num(seg.start, 0);
  const durationUs = _num(seg.duration, 0);
  const srcStartUs = _num(seg.src_start, 0);
  const srcEndUs = _num(seg.src_end, srcStartUs + durationUs);
  return {
    key: "video:" + ti + ":" + idx,   // 轨:索引（与 resolveHits 同构）
    trackKey: "video:" + ti,
    startUs, durationUs,               // 时间轴位置
    srcStartUs, srcEndUs,              // 源窗口（兼容兜底后）
    speed: _clampSpeed(seg.speed),
    gain: resolveGain(trackMuted, !!seg.muted, seg.volume),  // 内嵌声音量（轨/段静音→0），不含 previewMuted
    muted: !!seg.muted,                // 段级静音 → video 元素 muted
    path: _resolvePath(seg, materials),
    hidden: trackHidden || !!seg.hidden,  // 轨/段隐藏 → 播放跳过渲染
  };
}

function _flattenAudio(seg, ti, idx, trackMuted, materials) {
  if (!seg || typeof seg !== "object") return null;
  const startUs = _num(seg.start, 0);
  const durationUs = _num(seg.duration, 0);
  const srcStartUs = _num(seg.src_start, 0);
  const srcEndUs = _num(seg.src_end, srcStartUs + durationUs);
  return {
    key: "audio:" + ti + ":" + idx,
    trackKey: "audio:" + ti,
    startUs, durationUs,
    srcStartUs, srcEndUs,
    speed: _clampSpeed(seg.speed),
    gain: resolveGain(trackMuted, !!seg.muted, seg.volume),  // 不含 previewMuted（播放端另叠）
    path: _resolvePath(seg, materials),
  };
}

/* ---------- 主入口：buildPlaybackGraph ---------- */

function buildPlaybackGraph(draft, materials) {
  const audioClips = [];
  const videoNodes = [];
  const d = draft || {};
  const meta = d._track_meta || {};

  // video 轨 → VideoNode（含内嵌声）
  (d.video || []).forEach((track, ti) => {
    const tmeta = (meta.video || [])[ti] || {};
    const trackMuted = !!tmeta.muted;
    const trackHidden = !!tmeta.hidden;
    (track || []).forEach((seg, idx) => {
      const node = _flattenVideo(seg, ti, idx, trackMuted, trackHidden, materials);
      if (node) videoNodes.push(node);
    });
  });

  // audio 轨 → AudioClip
  (d.audio || []).forEach((track, ti) => {
    const tmeta = (meta.audio || [])[ti] || {};
    const trackMuted = !!tmeta.muted;
    (track || []).forEach((seg, idx) => {
      const clip = _flattenAudio(seg, ti, idx, trackMuted, materials);
      if (clip) audioClips.push(clip);
    });
  });

  return { audioClips, videoNodes, version: ++_graphVersion };
}

// 对拍脚本 / Node 消费
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildPlaybackGraph, resolveGain, finalPlaybackGain };
}
