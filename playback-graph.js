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

// ⭐源窗口终点推导（2026-08-17 根治：对齐 FableCut —— 源终点永远 = 源起点 + 时间长度×变速，
// 绝不信任 draft.src_end 独立字段——v1/v2 trim 增量累加曾致 src_end 与 duration 失同步，
// 播放器按脏 src_end 算时长 → "前面能播、后面被拉长的部分无声/波形拉伸"）。
// 公式：(srcEndUs - srcStartUs) / speed == durationUs —— 同一物理量的两种表达，结构上不可能失同步。
function deriveSrcEndUs(srcStartUs, durationUs, speed) {
  return srcStartUs + Math.max(0, durationUs) * (speed || 1);
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
  const speed = _clampSpeed(seg.speed);
  // 2026-08-17 根治：src_end 一律推导（不信任 seg.src_end 字段，防 trim 累加失同步脏数据）
  const srcEndUs = deriveSrcEndUs(srcStartUs, durationUs, speed);
  return {
    key: "video:" + ti + ":" + idx,   // 轨:索引（与 resolveHits 同构）
    trackKey: "video:" + ti,
    startUs, durationUs,               // 时间轴位置
    srcStartUs, srcEndUs,              // 源窗口（⭐推导值，非 draft 字段）
    speed,
    gain: resolveGain(trackMuted, !!seg.muted, seg.volume),  // 内嵌声音量（轨/段静音→0），不含 previewMuted
    muted: !!seg.muted,                // 段级静音 → video 元素 muted
    path: _resolvePath(seg, materials),
    type: seg.type || "video",         // 段类型（image 需跳过 video 元素预加载，见 renderer.js preloadNextVideoSlot）
    hidden: trackHidden || !!seg.hidden,  // 轨/段隐藏 → 播放跳过渲染
  };
}

function _flattenAudio(seg, ti, idx, trackMuted, materials) {
  if (!seg || typeof seg !== "object") return null;
  const startUs = _num(seg.start, 0);
  const durationUs = _num(seg.duration, 0);
  const srcStartUs = _num(seg.src_start, 0);
  const speed = _clampSpeed(seg.speed);
  // 2026-08-17 根治：src_end 一律推导（不信任 seg.src_end 字段，防 trim 累加失同步脏数据）
  const srcEndUs = deriveSrcEndUs(srcStartUs, durationUs, speed);
  return {
    key: "audio:" + ti + ":" + idx,
    trackKey: "audio:" + ti,
    startUs, durationUs,
    srcStartUs, srcEndUs,
    speed,
    gain: resolveGain(trackMuted, !!seg.muted, seg.volume),  // 不含 previewMuted（播放端另叠）
    path: _resolvePath(seg, materials),
  };
}

/* ---------- §3 特效/文本/贴纸 平铺（Phase B：修 A1 语义层完整性，特效=预览=导出同源的桥） ---------- */

function _flattenEffect(seg, ti, idx, trackHidden) {
  if (!seg || typeof seg !== "object") return null;
  const startUs = _num(seg.start, 0);
  const durationUs = _num(seg.duration, 0);
  return {
    key: "effect:" + ti + ":" + idx,
    trackKey: "effect:" + ti,
    id: seg.id || null,
    effectType: seg.effect_type || null,
    target: seg.target || { type: "adjustment" },   // 默认调整层(盖整栈)
    params: seg.params || {},
    keyframes: seg.keyframes || [],
    startUs, durationUs,
    hidden: trackHidden || !!seg.hidden,
  };
}

function _flattenText(seg, ti, idx, trackHidden) {
  if (!seg || typeof seg !== "object") return null;
  return {
    key: "text:" + ti + ":" + idx,
    trackKey: "text:" + ti,
    startUs: _num(seg.start, 0), durationUs: _num(seg.duration, 0),
    text: seg.text || "", hidden: trackHidden || !!seg.hidden,
  };
}

function _flattenSticker(seg, ti, idx, trackHidden) {
  if (!seg || typeof seg !== "object") return null;
  return {
    key: "sticker:" + ti + ":" + idx,
    trackKey: "sticker:" + ti,
    startUs: _num(seg.start, 0), durationUs: _num(seg.duration, 0),
    hidden: trackHidden || !!seg.hidden,
  };
}

/* ---------- 主入口：buildPlaybackGraph ---------- */

function _typeTiOf(overlay, oi, type) {
  let cnt = 0;
  for (let i = 0; i < oi; i++) if ((overlay[i] || {}).type === type) cnt++;
  return cnt;
}

function buildPlaybackGraph(draft, materials) {
  const audioClips = [];
  const videoNodes = [];
  const effectNodes = [];
  const textNodes = [];
  const stickerNodes = [];
  const d = draft || {};
  const meta = d._track_meta || {};
  const overlay = Array.isArray(d.overlay) ? d.overlay : [];

  // video：main（ti=0）+ overlay video 覆盖轨（ti 从 1 起）——与 main.py _playback_graph / resolveHits 对拍一致
  const main = (d.main && typeof d.main === "object") ? (d.main.segs || []) : [];
  const mainMeta = meta.main || {};
  (main || []).forEach((seg, idx) => {
    const node = _flattenVideo(seg, 0, idx, !!mainMeta.muted, !!mainMeta.hidden, materials);
    if (node) videoNodes.push(node);
  });
  let vCnt = 0;
  overlay.forEach((tr, oi) => {
    if (!tr || !Array.isArray(tr.segs)) return;
    const tmeta = (meta.overlay || [])[oi] || {};
    const type = tr.type || "video";
    const typeTi = _typeTiOf(overlay, oi, type);
    if (type === "video") {
      vCnt++;
      (tr.segs || []).forEach((seg, idx) => {
        const node = _flattenVideo(seg, vCnt, idx, !!tmeta.muted, !!tmeta.hidden, materials);
        if (node) videoNodes.push(node);
      });
    } else if (type === "effect") {
      (tr.segs || []).forEach((seg, idx) => {
        const node = _flattenEffect(seg, typeTi, idx, !!tmeta.hidden);
        if (node) effectNodes.push(node);
      });
    } else if (type === "text") {
      (tr.segs || []).forEach((seg, idx) => {
        const node = _flattenText(seg, typeTi, idx, !!tmeta.hidden);
        if (node) textNodes.push(node);
      });
    } else if (type === "sticker") {
      (tr.segs || []).forEach((seg, idx) => {
        const node = _flattenSticker(seg, typeTi, idx, !!tmeta.hidden);
        if (node) stickerNodes.push(node);
      });
    }
  });

  // audio 轨 → AudioClip（dict 列表）
  (Array.isArray(d.audio) ? d.audio : []).forEach((a, ti) => {
    if (!a || typeof a !== "object") return;
    const tmeta = (meta.audio || [])[ti] || {};
    (a.segs || []).forEach((seg, idx) => {
      const clip = _flattenAudio(seg, ti, idx, !!tmeta.muted, materials);
      if (clip) audioClips.push(clip);
    });
  });

  return { audioClips, videoNodes, effectNodes, textNodes, stickerNodes, version: ++_graphVersion };
}

// 对拍脚本 / Node 消费
if (typeof module !== "undefined" && module.exports) {
  module.exports = { buildPlaybackGraph, resolveGain, finalPlaybackGain };
}
