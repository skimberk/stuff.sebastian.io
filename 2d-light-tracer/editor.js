// Scene editor page, main thread: UI only (pointer events, hit-testing, the
// 2D overlay with outlines and handles, toolbar, inspector, undo). Tracing,
// raster and tone mapping run in editor-worker.js on the canvas's
// OffscreenCanvas; this thread posts it the encoded scene on every edit
// (at most once per animation frame).
//
// URL options: raster=webgpu|webgl|cpu, trace=threads-relaxed|threads|relaxed|simd|scalar,
// threads=N, preset=<name>, res=<width> (16:9), rays=<fixed rays/frame>, hud=0,
// limit=<rays per still scene, e.g. 16M; 0 or inf = unlimited>, decay=<0..0.9, trail while dragging>,
// debug=1 (scene revision + frame barcode in the image's top left corner;
// backwards presents logged to the console), lag=<ms> (hold each traced
// batch that long before drawing it: a latency test), inflight=1|2|3 (GPU frames queued; default 2).
// present=direct|bitmap (default: bitmap on Firefox, direct elsewhere; see
// startWorker), present=always|wait (experiments: tone-map every tick / only
// after the previous present completed). With debug=1,
// zpgEditor.recordFrames(ms) decodes the content marker from the frames the
// browser commits (see web/editor-fftest.py / editor-brec.py).
import {
  TYPES, SPECTRA, PRESETS, DESIGN_W, DESIGN_H, makeItem, reId, isLight, distance, handles, dragHandle, encode,
  segEnds, prismVerts, rectVerts, lensGeom, arcGeom, lightColor, wavelengthRGB,
  FILLS, ROOM_FILLS, FILLABLE, applyFill, applyRoomFill, normalizeScene, fillTint, INSERTS, makeInsert,
  lensElemPoly, apertureSegs, constrainToAxis, groupRange, shiftGroup, paraxial, focusFor, setLensVariant, lensVariants,
  depthT, DEPTHS, axialOf, sensorBins, viewRects,
} from './editor-scene.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const RW = Math.max(320, Math.min(2560, Number(params.get('res')) || 1280)) & ~1;
const RH = Math.round((RW * 9) / 16) & ~1;
const HC = navigator.hardwareConcurrency || 4;
let SCENE_NAMES = ['default', 'spectroscope', 'newton', 'lens', 'raindrop', 'grating', 'dichroic', 'pool', 'pool-ripples', 'pool-chop', 'pool-shaft', 'pool-rainbow', 'pool-dispersion'];
const D2R = Math.PI / 180;
// Default ray limit per still scene (was 16M): the Showcase default is tuned
// to look finished at 2M rays at 720p; raise it in Settings or with limit=.
const DEFAULT_LIMIT = 2e6;
function parseRays(v) {
  if (v == null || v === '') return null;
  const t = String(v).trim().toLowerCase();
  if (t === '0' || t === 'inf' || t === 'unlimited' || t === 'none') return 0;
  const m = t.match(/^([0-9.]+(?:e[0-9]+)?)\s*([kmg]?)$/);
  if (!m) return null;
  const x = Number(m[1]) * ({ k: 1e3, m: 1e6, g: 1e9 }[m[2]] || 1);
  return isFinite(x) && x >= 0 ? Math.round(x) : null;
}
const initialLimit = parseRays(params.get('limit')) ?? DEFAULT_LIMIT;
const initialDecay = Math.max(0, Math.min(0.9, Number(params.get('decay')) || 0));

// --- status / errors -------------------------------------------------------------
const statusEl = $('status');
function setStatus(s, err = false) { statusEl.textContent = s; statusEl.classList.toggle('err', err); statusEl.hidden = !s; }
function fail(e) {
  const s = String((e && e.stack) || e);
  console.error('ZPG editor error:', s);
  setStatus(s, true);
}
addEventListener('error', (e) => fail(e.error || e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));
let toastTimer = 0;
function toast(s) { $('toast').textContent = s; clearTimeout(toastTimer); toastTimer = setTimeout(() => ($('toast').textContent = ''), 1800); }

// --- scene state -------------------------------------------------------------------
let scene = null; // {items, walls, wallAlbedo, base, look}
let sel = null; // selected item id
let hover = null; // {id, hid}
const undoStack = [], redoStack = [];
let undoSerial = 0; // bumped by every pushUndo (media controls: one step per gesture)
const snapshot = () => JSON.stringify(scene);
function pushUndo() {
  undoSerial++;
  const s = snapshot();
  if (undoStack[undoStack.length - 1] !== s) undoStack.push(s);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function restore(s) {
  gestureKey = null;
  scene = normalizeScene(JSON.parse(s));
  reId(scene.items);
  sel = null;
  sceneChanged(false);
  buildInspector();
  syncSceneControls();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  updateUndoButtons();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  updateUndoButtons();
}
function updateUndoButtons() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }
const byId = (id) => scene.items.find((i) => i.id === id);

// Edits are coalesced and posted once per animation frame. `interactive`
// (dragging, slider input) lets the worker show drag frames (decay blend) instead of
// restarting the accumulation; any non-interactive edit in the run resets.
let sceneDirty = false, dirtyInteractive = true, lookDirty = false, sceneRev = 0;
const DEBUG = params.get('debug') === '1';
const revPos = new Map(); // debug: selected item's position per posted revision
function sceneChanged(interactive) {
  sceneDirty = true;
  dirtyInteractive = dirtyInteractive && interactive;
  overlayDirty = true;
  saveLocal();
}
let saveTimer = 0;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('zpg-editor-scene', snapshot()); } catch (_) {} }, 400);
}

function loadPreset(name, { keepUndo = false } = {}) {
  if (!keepUndo && scene) pushUndo();
  scene = normalizeScene(PRESETS[name].build());
  sel = null;
  lookDirty = true;
  sceneChanged(false);
  buildInspector();
  syncSceneControls();
}

// --- worker ------------------------------------------------------------------------
let worker = null, info = null, lastStats = null;
let presentMode = 'direct', bitmapCtx = null, shownSeq = 0;
async function detect() {
  const f = { threads: self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' };
  try { f.relaxed = WebAssembly.validate(await (await fetch('pkg-relaxed/zpg_web_bg.wasm')).arrayBuffer()); } catch (_) { f.relaxed = false; }
  try { f.simd = WebAssembly.validate(await (await fetch('pkg-simd/zpg_web_bg.wasm')).arrayBuffer()); } catch (_) { f.simd = false; }
  f.offscreen = typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
  return f;
}

async function startWorker() {
  const f = await detect();
  let variant = params.get('trace');
  const notes = [];
  if (!variant) {
    if (f.threads) variant = f.relaxed ? 'threads-relaxed' : 'threads';
    else variant = f.relaxed ? 'relaxed' : f.simd ? 'simd' : 'scalar';
    if (!f.threads) notes.push('no cross-origin isolation / SharedArrayBuffer: single-threaded');
    if (!f.relaxed) notes.push('no relaxed-SIMD');
  }
  const threads = Number(params.get('threads')) || HC;
  if (!f.offscreen) throw new Error('This page needs OffscreenCanvas (transferControlToOffscreen).');
  const canvas = $('render');
  // Presentation: 'direct' (the canvas's OffscreenCanvas, presented by the
  // worker) or 'bitmap' (the worker renders into its own OffscreenCanvas and
  // posts each frame as an ImageBitmap, shown here with a bitmaprenderer
  // context). Firefox's WebGPU canvas in a worker shows older swap-chain
  // images on vsyncs without a fresh present (frames flash backwards), so
  // it gets 'bitmap'; a bitmaprenderer keeps the last frame it was given.
  const want = params.get('present');
  presentMode = want === 'bitmap' || want === 'direct' ? want : /Firefox\//.test(navigator.userAgent) ? 'bitmap' : 'direct';
  let off = null;
  if (presentMode === 'bitmap') { canvas.width = RW; canvas.height = RH; bitmapCtx = canvas.getContext('bitmaprenderer'); }
  else off = canvas.transferControlToOffscreen();
  worker = new Worker('editor-worker.js', { type: 'module' });
  worker.onerror = (e) => fail(e.message || 'worker error');
  worker.onmessage = onWorker;
  const settings = { decay: Number($('decay').value), limit: Number($('limit').value) };
  if (params.get('rays')) settings.fixedRays = Number(params.get('rays'));
  if (params.get('debug') === '1') settings.debug = true;
  if (params.get('lag')) settings.lag = Number(params.get('lag')) || 0;
  if (params.get('present')) { settings.alwaysPresent = params.get('present') === 'always'; settings.presentWait = params.get('present') === 'wait'; }
  if (params.get('inflight')) settings.maxInFlight = Math.max(1, Math.min(3, Number(params.get('inflight')) || 2));
  worker.postMessage({
    type: 'init', canvas: off, present: presentMode, variant, threads, raster: params.get('raster') || 'webgpu', width: RW, height: RH,
    desc: encode(scene, RW, RH, SCENE_NAMES), look: scene.look, settings, visible: !document.hidden,
  }, off ? [off] : []);
  sceneDirty = false;
  lookDirty = false;
  setStatus(`loading ${variant}…`);
  startWorker.notes = notes;
}

const VARIANT_LABEL = {
  'threads-relaxed': 'relaxed-SIMD', threads: 'SIMD128', relaxed: 'relaxed-SIMD', simd: 'SIMD128', scalar: 'scalar',
};
function onWorker({ data: m }) {
  if (m.type === 'error') return fail(m.error);
  if (m.type === 'debug') { console.warn('ZPG editor:', m.msg); return; }
  if (m.type === 'sensor') { onSensor(m); return; }
  if (m.type === 'frame') {
    if (m.seq > shownSeq) { shownSeq = m.seq; bitmapCtx.transferFromImageBitmap(m.bitmap); } else m.bitmap.close();
    return;
  }
  if (m.type === 'ready') {
    info = m;
    if (m.sceneNames) SCENE_NAMES = m.sceneNames;
    setStatus('');
    const rast = m.raster === 'webgpu' ? 'WebGPU' : m.raster === 'webgl' ? 'WebGL2' : 'CPU raster';
    const notes = [...(startWorker.notes || []), ...(m.note ? [m.note.replace(/; $/, '')] : [])];
    $('path').innerHTML = `<b>wasm ${VARIANT_LABEL[m.variant] || m.variant} × ${m.threads} thread${m.threads > 1 ? 's' : ''} + ${rast}</b>`
      + (m.adapter && m.adapter.trim() ? ` · ${escapeHtml(m.adapter)}` : '')
      + (m.timestamps ? ' · GPU timestamps' : '')
      + (presentMode === 'bitmap' ? ' · bitmap present' : '')
      + (notes.length ? ` <span class="warn">(${escapeHtml(notes.join('; '))})</span>` : '');
    $('path').title = $('path').textContent;
    sceneDirty = true; // with the authoritative scene names
  } else if (m.type === 'stats') {
    lastStats = m;
    drawHud();
  }
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const fmt = (x, d = 1) => {
  if (!isFinite(x)) return '–';
  if (x >= 1e9) return (x / 1e9).toFixed(2) + 'G';
  if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(d) + 'K';
  return x.toFixed(0);
};
function drawHud() {
  const m = lastStats, el = $('hud');
  if (!m || !$('hudOn').checked) { el.textContent = ''; return; }
  const ras = info && info.raster === 'cpu' ? 'raster(cpu) in trace' : `raster ${m.gpuMs ? m.gpuMs.toFixed(1) + ' ms' : '–'}${info && !info.timestamps ? ' (no timestamps)' : ''}`;
  el.innerHTML = (m.idle ? `idle <span class="dim">(${document.hidden ? 'tab hidden' : 'ray limit reached'})</span>\n` : `${m.fps.toFixed(1)} fps  <span class="dim">max frame ${m.maxIv.toFixed(0)} ms</span>\n`)
    + `${fmt(m.raysPerFrame)} rays/frame  ${fmt(m.raysPerSec, 2)} rays/s\n`
    + `trace ${m.traceMs.toFixed(1)} ms  ${ras}\n`
    + (m.dragging ? `drag frame ${fmt(m.accRays, 1)} rays${Number($('decay').value) > 0 ? ` (trail ${$('decay').value})` : ''}` : m.done
      ? `<b>done</b> ${fmt(m.accRays, 1)} rays${m.idle ? ' · idle' : ''}`
      : `accum ${fmt(m.accRays, 1)}${m.rayLimit > 0 ? ` / ${fmt(m.rayLimit)} rays (${Math.min(100, (100 * m.accRays) / m.rayLimit).toFixed(0)}%)` : ' rays'}`)
    + `  <span class="dim">budget ${fmt(m.budget)} · tracer share ${(m.headroom * 100).toFixed(0)}%</span>\n`
    + `<span class="dim">exposure ${m.auto ? 'auto' : 'locked'}${m.inFlight ? ` · ${m.inFlight} in flight` : ''}</span>`
    + (params.get('debug') === '1' ? `\n<span class="dim">rev ${m.rev} (posted ${sceneRev}) · present ${m.presents} · backwards ${m.backwards}</span>` : '');
}

// --- view transform & overlay ------------------------------------------------------------
const stage = $('stage'), ov = $('overlay');
const octx = ov.getContext('2d');
let k = 1, dpr = 1, overlayDirty = true;
function resize() {
  const r = stage.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  ov.width = Math.round(r.width * dpr);
  ov.height = Math.round(r.height * dpr);
  k = r.width / DESIGN_W;
  overlayDirty = true;
}
new ResizeObserver(resize).observe(stage);
const toScene = (e) => {
  const r = ov.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * DESIGN_W, y: ((e.clientY - r.top) / r.height) * DESIGN_H };
};

const OUTLINE = {
  glass: 'rgba(130,200,255,', mirror: 'rgba(225,228,235,', arc: 'rgba(225,228,235,', splitter: 'rgba(170,230,230,',
  wall: 'rgba(215,180,140,', block: 'rgba(255,120,120,',
  lenselem: 'rgba(130,200,255,', aperture: 'rgba(255,170,90,', sensor: 'rgba(120,255,170,', paintblock: 'rgba(255,255,255,', paintdisc: 'rgba(255,255,255,',
};
function pathItem(c, it) {
  c.beginPath();
  switch (it.type) {
    case 'circle': case 'paintdisc': c.arc(it.x, it.y, it.r, 0, Math.PI * 2); break;
    case 'lenselem': { const v = lensElemPoly(it); c.moveTo(v[0].x, v[0].y); for (const p of v.slice(1)) c.lineTo(p.x, p.y); c.closePath(); break; }
    case 'aperture': for (const [a, b] of apertureSegs(it)) { c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); } break;
    case 'prism': { const v = prismVerts(it); c.moveTo(v[0].x, v[0].y); c.lineTo(v[1].x, v[1].y); c.lineTo(v[2].x, v[2].y); c.closePath(); break; }
    case 'block': case 'glassblock': case 'paintblock': { const v = rectVerts(it); c.moveTo(v[0].x, v[0].y); for (const p of v.slice(1)) c.lineTo(p.x, p.y); c.closePath(); break; }
    case 'lens': {
      const g = lensGeom(it);
      const a1 = it.rot + Math.PI;
      c.arc(g.c1.x, g.c1.y, g.R, a1 - g.half, a1 + g.half);
      c.arc(g.c2.x, g.c2.y, g.R, it.rot - g.half, it.rot + g.half);
      c.closePath();
      break;
    }
    case 'mirror': case 'splitter': case 'wall': case 'sensor': { const [a, b] = segEnds(it); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); break; }
    case 'arc': { const g = arcGeom(it); c.arc(g.c.x, g.c.y, it.R, g.mid - g.half, g.mid + g.half); break; }
  }
}
function drawLight(c, it, state) {
  const col = lightColor(it), r = 7 / k;
  c.save();
  c.lineWidth = (state ? 2 : 1.4) / k;
  c.strokeStyle = state === 'sel' ? '#6cc4ff' : state === 'hover' ? '#cfe9ff' : 'rgba(255,255,255,0.75)';
  c.fillStyle = col;
  const arrow = (ang, l) => {
    const d = { x: Math.cos(ang), y: Math.sin(ang) };
    const t = { x: it.x + d.x * l, y: it.y + d.y * l };
    c.beginPath(); c.moveTo(it.x + d.x * r, it.y + d.y * r); c.lineTo(t.x, t.y);
    c.moveTo(t.x, t.y); c.lineTo(t.x - d.x * 7 / k - d.y * 4 / k, t.y - d.y * 7 / k + d.x * 4 / k);
    c.moveTo(t.x, t.y); c.lineTo(t.x - d.x * 7 / k + d.y * 4 / k, t.y - d.y * 7 / k - d.x * 4 / k);
    c.stroke();
  };
  if (it.type === 'point') {
    c.beginPath(); c.arc(it.x, it.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
    if (it.spread < Math.PI - 1e-3) {
      arrow(it.dir, 40);
      c.setLineDash([3 / k, 3 / k]);
      c.beginPath(); c.arc(it.x, it.y, 26, it.dir - it.spread, it.dir + it.spread); c.stroke();
      c.setLineDash([]);
    } else {
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        c.beginPath(); c.moveTo(it.x + Math.cos(a) * r * 1.5, it.y + Math.sin(a) * r * 1.5); c.lineTo(it.x + Math.cos(a) * r * 2.1, it.y + Math.sin(a) * r * 2.1); c.stroke();
      }
    }
  } else {
    const d = { x: Math.cos(it.angle), y: Math.sin(it.angle) }, n = { x: -d.y, y: d.x };
    const hw = Math.max(it.width / 2, 5 / k);
    c.beginPath();
    c.moveTo(it.x + n.x * hw - d.x * 6 / k, it.y + n.y * hw - d.y * 6 / k);
    c.lineTo(it.x + n.x * hw, it.y + n.y * hw);
    c.lineTo(it.x - n.x * hw, it.y - n.y * hw);
    c.lineTo(it.x - n.x * hw - d.x * 6 / k, it.y - n.y * hw - d.y * 6 / k);
    c.closePath();
    c.fill(); c.stroke();
    arrow(it.angle, it.type === 'laser' ? 40 : 48);
  }
  c.restore();
}
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
function drawOverlay() {
  overlayDirty = false;
  const c = octx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, ov.width, ov.height);
  if (!scene) return;
  c.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
  const showAll = $('outlines').checked;
  if (scene.camera) drawCameraOverlay(c, showAll);
  for (const it of scene.items) {
    if (it.hidden) continue;
    const state = it.id === sel ? 'sel' : hover && hover.id === it.id ? 'hover' : null;
    if (isLight(it)) { if (showAll || state) drawLight(c, it, state); continue; }
    if (!showAll && !state) continue;
    const base = OUTLINE[TYPES[it.type].group === 'glass' ? 'glass' : it.type] || 'rgba(255,255,255,';
    pathItem(c, it);
    const filled = FILLABLE.has(it.type) && it.fill && it.fill !== 'none' && FILLS[it.fill];
    if (filled) { // a faint tint by kind / ink colour
      c.globalAlpha = state ? 0.16 : 0.09;
      c.fillStyle = fillTint(it);
      c.fill();
      c.globalAlpha = 1;
    }
    c.lineWidth = (state === 'sel' ? 2 : state ? 1.6 : 1) / k;
    c.strokeStyle = state === 'sel' ? '#6cc4ff' : filled && it.wall === 'clear' ? hexA(fillTint(it), state ? 0.9 : 0.5) : base + (state ? '0.9)' : '0.35)');
    if (it.type === 'splitter') c.setLineDash([6 / k, 4 / k]);
    if (FILLABLE.has(it.type) && it.wall === 'clear') c.setLineDash([5 / k, 4 / k]); // no wall: just a region
    c.stroke();
    c.setLineDash([]);
    if (it.type === 'block' && it.albedo === 0 && (state || showAll)) { c.fillStyle = it.rig ? 'rgba(150,150,160,0.10)' : 'rgba(255,90,90,0.08)'; c.fill(); }
    if (it.color && (it.type === 'paintblock' || it.type === 'paintdisc')) { c.globalAlpha = state ? 0.3 : 0.14; c.fillStyle = it.color; c.fill(); c.globalAlpha = 1; }
  }
  const it = sel != null && byId(sel);
  if (it) {
    for (const h of handles(it)) {
      const hv = hover && hover.id === it.id && hover.hid === h.id;
      c.beginPath();
      if (h.kind === 'rot') {
        c.moveTo(it.x, it.y); c.lineTo(h.x, h.y);
        c.strokeStyle = 'rgba(108,196,255,0.45)'; c.lineWidth = 1 / k; c.stroke();
        c.beginPath();
      }
      const r = (hv ? 7 : 5.5) / k;
      if (h.kind === 'size' || h.kind === 'end') c.rect(h.x - r, h.y - r, 2 * r, 2 * r);
      else c.arc(h.x, h.y, r, 0, Math.PI * 2);
      c.fillStyle = hv ? '#6cc4ff' : '#0c0e11';
      c.strokeStyle = '#6cc4ff';
      c.lineWidth = 1.6 / k;
      c.fill(); c.stroke();
    }
  }
  if (placing) {
    c.fillStyle = 'rgba(108,196,255,0.9)';
    c.font = `${12 / k}px ui-sans-serif, system-ui`;
    c.fillText(`+ ${insertLabel(placing.type)}`, placing.x + 10 / k, placing.y - 10 / k);
  }
}

// --- hit testing ---------------------------------------------------------------------------
function hitHandle(p) {
  const it = sel != null && byId(sel);
  if (!it) return null;
  let best = null, bd = 11 / k;
  for (const h of handles(it)) {
    const d = Math.hypot(p.x - h.x, p.y - h.y);
    if (d < bd) { bd = d; best = { id: it.id, hid: h.id }; }
  }
  return best;
}
function hitItem(p) {
  const tol = 8 / k;
  let best = null, bd = Infinity;
  // Lights win over objects; later items over earlier ones.
  for (const pass of [true, false]) {
    for (let i = scene.items.length - 1; i >= 0; i--) {
      const it = scene.items[i];
      if (isLight(it) !== pass || it.hidden || isLocked(it)) continue;
      const d = distance(it, p) - (pass ? 6 / k : 0);
      if (d <= tol && d < bd - 1e-6) { bd = d; best = it; }
    }
    if (best) return best;
  }
  return null;
}

// --- pointer interaction -----------------------------------------------------------------------
let drag = null; // {id, hid?, start, orig, moved}
let placing = null; // {type, x, y} while dragging from the toolbar
ov.addEventListener('pointerdown', (e) => {
  if (!scene || e.button !== 0) return;
  ov.focus({ preventScroll: true });
  const p = toScene(e);
  const h = hitHandle(p);
  let it = h ? byId(h.id) : hitItem(p);
  if (!it) { setSel(null); return; }
  if (e.altKey && !h) { // alt-drag: duplicate
    pushUndo();
    const copy = { ...structuredClone(it), id: undefined };
    it = makeItem(copy.type, copy.x, copy.y, copy);
    scene.items.push(it);
    sceneChanged(false);
  }
  setSel(it.id);
  drag = { id: it.id, hid: h && h.hid, start: p, orig: structuredClone(it), moved: false, undoPushed: false, pointerId: e.pointerId };
  try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});
ov.addEventListener('pointermove', (e) => {
  if (!scene) return;
  if (DEBUG && drag) (window.__pm = window.__pm || []).push([e.pointerId, e.pointerType, e.isTrusted, Math.round(e.clientX), Math.round(e.clientY)]);
  const p = toScene(e);
  if (drag) {
    // Only the pointer that started the drag moves the item (another mouse
    // or touch, or the browser's synthetic moves under a still cursor,
    // would make it jump back and forth).
    if (e.pointerId !== drag.pointerId) return;
    const it = byId(drag.id);
    if (!it) { drag = null; return; }
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * k < 2) return;
    if (!drag.undoPushed) {
      // The state before the drag (the item as it was at pointerdown).
      const cur = structuredClone(it);
      Object.assign(it, drag.orig);
      pushUndo();
      Object.assign(it, cur);
      drag.undoPushed = true;
    }
    drag.moved = true;
    if (drag.hid) Object.assign(it, dragHandle(drag.orig, drag.hid, p, e.shiftKey));
    else if (it.rig === 'lens' && scene.camera) Object.assign(it, constrainToAxis(scene, drag.orig, p.x - drag.start.x, p.y - drag.start.y));
    else {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      it.x = drag.orig.x + dx; it.y = drag.orig.y + dy;
    }
    sceneChanged(true);
    refreshInspectorValues();
    return;
  }
  const h = hitHandle(p);
  const it = h ? null : hitItem(p);
  const nh = h || (it ? { id: it.id, hid: null } : null);
  if (JSON.stringify(nh) !== JSON.stringify(hover)) { hover = nh; overlayDirty = true; }
  ov.style.cursor = h ? 'crosshair' : it ? 'move' : 'default';
});
function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  if (drag.moved) sceneChanged(false); // released: full accumulation from here
  drag = null;
}
ov.addEventListener('pointerup', endDrag);
ov.addEventListener('pointercancel', endDrag);
ov.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; overlayDirty = true; } });

function setSel(id) {
  if (sel === id) return;
  sel = id;
  overlayDirty = true;
  buildInspector();
}

// --- toolbar -----------------------------------------------------------------------------------------
const ICONS = {
  point: '<circle cx="9" cy="9" r="3.2" fill="currentColor"/><path d="M9 1.5v3M9 13.5v3M1.5 9h3M13.5 9h3M3.7 3.7l2 2M12.3 12.3l2 2M14.3 3.7l-2 2M5.7 12.3l-2 2" stroke="currentColor" stroke-width="1.3"/>',
  beam: '<path d="M3 3v12" stroke="currentColor" stroke-width="2"/><path d="M5 5h10M5 9h10M5 13h10" stroke="currentColor" stroke-width="1.2"/>',
  laser: '<rect x="1.5" y="6.5" width="6" height="5" rx="1" fill="currentColor"/><path d="M8 9h9" stroke="#ff5d5d" stroke-width="1.6"/>',
  circle: '<circle cx="9" cy="9" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  prism: '<path d="M9 2.5L16 15H2z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  lens: '<path d="M9 1.5C12.5 5 12.5 13 9 16.5C5.5 13 5.5 5 9 1.5z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  glassblock: '<rect x="2.5" y="5" width="13" height="8" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  mirror: '<path d="M3 15L15 3" stroke="currentColor" stroke-width="2.2"/>',
  arc: '<path d="M13 2.5C7 6 7 12 13 15.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  splitter: '<path d="M3 15L15 3" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.5 2"/>',
  wall: '<path d="M9 2v14" stroke="currentColor" stroke-width="3" opacity=".7"/>',
  block: '<rect x="4" y="4" width="10" height="10" fill="currentColor" opacity=".8"/>',
  milkglass: '<circle cx="9" cy="9" r="6.5" fill="#f2f0e6" fill-opacity=".55" stroke="currentColor" stroke-width="1.4"/>',
  inkcell: '<rect x="2.5" y="5" width="13" height="8" fill="#2a5cff" fill-opacity=".7" stroke="currentColor" stroke-width="1.4"/>',
  paintblock: '<rect x="4" y="4" width="10" height="10" fill="#e03c28" stroke="currentColor" stroke-width="1"/>',
  paintdisc: '<circle cx="9" cy="9" r="5.5" fill="#2fb84a" stroke="currentColor" stroke-width="1"/>',
  lenselem: '<path d="M7 2C9.5 6 9.5 12 7 16H11C9 12 9 6 11 2z" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  aperture: '<path d="M9 1.5v5M9 11.5v5" stroke="currentColor" stroke-width="2.4"/>',
  sensor: '<path d="M9 2v14" stroke="#7dffaa" stroke-width="2.6"/><path d="M12 5v8" stroke="currentColor" stroke-width="1" opacity=".6"/>',
  fogpatch: '<rect x="2.5" y="4" width="13" height="10" fill="#c8d2dc" fill-opacity=".35" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.5 2"/>',
};
const GROUPS = [['light', 'Lights'], ['glass', 'Glass'], ['surface', 'Surfaces'], ['camera', 'Camera']];
function buildToolbar() {
  const tb = $('toolbar');
  for (const [g, label] of GROUPS) {
    const h = document.createElement('h3'); h.textContent = label; tb.appendChild(h);
    for (const [type, t] of Object.entries(TYPES)) {
      if (t.group !== g) continue;
      const b = document.createElement('button');
      b.innerHTML = `<svg class="ic" viewBox="0 0 18 18" aria-hidden="true">${ICONS[type] || ''}</svg>${t.label}<kbd>${t.key || ''}</kbd>`;
      b.title = `${t.label}: click to add at the centre, or drag onto the scene`;
      b.dataset.type = type;
      b.addEventListener('pointerdown', (e) => toolDown(e, type, b));
      tb.appendChild(b);
    }
  }
  const h = document.createElement('h3'); h.textContent = 'Media'; tb.appendChild(h);
  for (const [name, t] of Object.entries(INSERTS)) {
    const b = document.createElement('button');
    b.innerHTML = `<svg class="ic" viewBox="0 0 18 18" aria-hidden="true">${ICONS[name] || ''}</svg>${t.label}`;
    b.title = `${t.label} (a ${TYPES[t.type].label.toLowerCase()} filled with ${FILLS[t.fill].label.toLowerCase()}): click to add at the centre, or drag onto the scene`;
    b.addEventListener('pointerdown', (e) => toolDown(e, name, b));
    tb.appendChild(b);
  }
}
const insertLabel = (type) => (TYPES[type] || INSERTS[type]).label;
function toolDown(e, type, b) {
  if (e.button !== 0) return;
  e.preventDefault();
  try { b.setPointerCapture(e.pointerId); } catch (_) {}
  const move = (ev) => {
    const r = ov.getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    placing = inside ? { type, ...toScene(ev) } : null;
    overlayDirty = true;
  };
  const up = (ev) => {
    b.removeEventListener('pointermove', move);
    b.removeEventListener('pointerup', up);
    b.removeEventListener('pointercancel', up);
    const r = ov.getBoundingClientRect();
    const inside = ev.type === 'pointerup' && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    const overButton = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('button') === b;
    placing = null;
    overlayDirty = true;
    if (inside) insert(type, toScene(ev));
    else if (overButton) insert(type, null);
  };
  b.addEventListener('pointermove', move);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
}
let insertCount = 0;
function insert(type, at) {
  pushUndo();
  if (!at) { const o = (insertCount++ % 6) * 24; at = { x: DESIGN_W / 2 - 60 + o, y: DESIGN_H / 2 - 60 + o }; }
  const it = INSERTS[type] ? makeInsert(type, at.x, at.y) : makeItem(type, at.x, at.y);
  scene.items.push(it);
  sceneChanged(false);
  setSel(it.id);
  toast(`added ${insertLabel(type).toLowerCase()}`);
}
function removeSelected() {
  const it = sel != null && byId(sel);
  if (!it) return;
  pushUndo();
  scene.items = scene.items.filter((i) => i.id !== sel);
  sel = null;
  hover = null;
  sceneChanged(false);
  buildInspector();
  toast(`deleted ${TYPES[it.type].label.toLowerCase()}`);
}
function duplicateSelected() {
  const it = sel != null && byId(sel);
  if (!it) return;
  pushUndo();
  const c = makeItem(it.type, it.x + 24, it.y + 24, { ...structuredClone(it), id: undefined, x: it.x + 24, y: it.y + 24 });
  scene.items.push(c);
  sceneChanged(false);
  setSel(c.id);
}

// --- inspector ------------------------------------------------------------------------------------------
const propInputs = []; // [{prop, range, num, sel, swatch}]
function buildInspector() {
  const box = $('props');
  box.textContent = '';
  propInputs.length = 0;
  inspFill = null;
  const it = sel != null && byId(sel);
  if (!it) {
    box.innerHTML = '<div class="empty">Click an object or light to select it. Drag to move; drag the handles to aim, rotate and resize.</div>';
    return;
  }
  const t = TYPES[it.type];
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin:4px 2px 6px;display:flex;align-items:center;gap:8px';
  title.innerHTML = `<svg class="ic" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">${ICONS[it.type] || ''}</svg>${t.label}`;
  box.appendChild(title);
  for (const prop of t.props) {
    const row = document.createElement('div');
    row.className = 'row';
    const id = `p-${prop.key}`;
    const lab = document.createElement('label');
    lab.htmlFor = id;
    lab.textContent = prop.label;
    row.appendChild(lab);
    const entry = { prop, row };
    if (prop.kind === 'color') {
      const s = document.createElement('input');
      s.type = 'color'; s.id = id;
      s.style.cssText = 'grid-column:1/-1;width:100%;height:24px;padding:0 2px';
      const key = {};
      s.oninput = () => edit(key, true, () => { it[prop.key] = s.value; });
      s.onchange = () => edit(key, false, () => { it[prop.key] = s.value; });
      row.appendChild(s);
      entry.color = s;
    } else if (prop.kind === 'spectrum') {
      const s = document.createElement('select');
      s.id = id;
      for (const [k2, sp] of Object.entries(SPECTRA)) s.add(new Option(sp.label, k2));
      s.value = it.spec;
      s.onchange = () => { pushUndo(); it.spec = s.value; sceneChanged(false); refreshInspectorValues(); };
      row.appendChild(s);
      entry.sel = s;
    } else {
      const isAng = prop.kind === 'angle';
      const min = isAng ? (prop.min ?? -180) : prop.min, max = isAng ? (prop.max ?? 180) : prop.max;
      const step = isAng ? 0.5 : prop.step;
      const range = document.createElement('input');
      Object.assign(range, { type: 'range', id, min, max, step });
      const num = document.createElement('input');
      Object.assign(num, { type: 'number', min, max, step });
      num.setAttribute('aria-label', prop.label);
      const toUi = (x) => (isAng ? normDeg(x / D2R, min, max) : x);
      const fromUi = (x) => (isAng ? x * D2R : x);
      let started = false;
      const apply = (val, interactive) => {
        if (!isFinite(val)) return;
        if (!started) { pushUndo(); started = true; }
        it[prop.key] = fromUi(val);
        sceneChanged(interactive);
        if (!interactive) started = false;
        refreshInspectorValues(entry);
      };
      range.oninput = () => apply(Number(range.value), true);
      range.onchange = () => apply(Number(range.value), false);
      num.onchange = () => apply(Number(num.value), false);
      entry.range = range; entry.num = num; entry.toUi = toUi;
      if (prop.kind === 'wl') {
        const sw = document.createElement('span');
        sw.className = 'swatch';
        lab.appendChild(sw);
        entry.swatch = sw;
      }
      row.append(range, num);
    }
    propInputs.push(entry);
    box.appendChild(row);
  }
  inspFill = FILLABLE.has(it.type) ? fillSection(box, it) : null;
  const btns = document.createElement('div');
  btns.className = 'btns';
  btns.innerHTML = '<button id="dup" title="Duplicate (⌘D)">Duplicate</button><button id="del" title="Delete (Del)">Delete</button>';
  box.appendChild(btns);
  $('dup').onclick = duplicateSelected;
  $('del').onclick = removeSelected;
  refreshInspectorValues();
}
const normDeg = (d, min, max) => {
  if (min >= 0) return Math.round(d * 10) / 10;
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  return Math.round(x * 10) / 10;
};
function refreshInspectorValues(except) {
  const it = sel != null && byId(sel);
  if (!it) return;
  for (const e of propInputs) {
    if (e.prop.kind === 'wl') e.row.hidden = it.spec !== 'mono';
    if (e === except) { if (e.num) e.num.value = round(e.toUi(it[e.prop.key])); if (e.swatch) e.swatch.style.background = wavelengthRGB(it.wl); continue; }
    if (e.sel) { e.sel.value = it[e.prop.key]; continue; }
    if (e.color) { e.color.value = it[e.prop.key]; continue; }
    const v = e.toUi(it[e.prop.key]);
    e.range.value = v;
    e.num.value = round(v);
    if (e.swatch) e.swatch.style.background = wavelengthRGB(it.wl);
  }
  if (inspFill) inspFill.refresh();
}
const round = (x) => (Math.abs(x) >= 100 ? Math.round(x * 10) / 10 : Math.round(x * 1000) / 1000);

// --- media controls -------------------------------------------------------------------------------------
// The medium of a filled shape (inspector) and of the room (scene panel),
// and the display weights. All edits go through `edit`: one undo step per
// gesture (a slider drag, a colour pick: the first change pushes the state
// before it), sceneChanged(true) while dragging and (false) on release, as
// for the other inspector sliders. Only cheap DOM updates run per input;
// encoding happens once per animation frame in `frame`.
let gestureKey = null, gestureSerial = -1;
function edit(key, interactive, fn) {
  if (gestureKey !== key || gestureSerial !== undoSerial) { pushUndo(); gestureKey = key; gestureSerial = undoSerial; }
  fn();
  sceneChanged(interactive);
  if (!interactive) gestureKey = null;
}
let ctlId = 0;
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// Slider maps between a value and a slider position u in [0, 1].
const logMap = (lo, hi, invert = false) => {
  const L = Math.log(hi / lo);
  const to = (v) => Math.min(1, Math.max(0, Math.log(Math.max(lo, v) / lo) / L));
  return invert ? { to: (v) => 1 - to(v), from: (u) => lo * Math.exp(L * (1 - u)) } : { to, from: (u) => lo * Math.exp(L * u) };
};
// Albedo: most of the range goes to the last nines (0.9 at u ≈ 0.3, 0.99 at 0.57, 0.999 at 0.86).
const albedoMap = { to: (a) => (a >= 1 ? 1 : Math.min(1, -Math.log10(1 - a) / 3.5)), from: (u) => (u >= 1 ? 1 : 1 - Math.pow(10, -3.5 * u)) };
// Draw weight: 0, then 0.02 .. 20 on a log scale.
const weightMap = { to: (w) => (w < 0.02 ? 0 : Math.min(1, 0.02 + 0.98 * Math.log(w / 0.02) / Math.log(1000))), from: (u) => (u < 0.02 ? 0 : 0.02 * Math.pow(1000, (u - 0.02) / 0.98)) };
const sig = (x) => (x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 1000) / 1000);

// A slider + number row. `map`: value <-> slider position (else a linear
// slider over [min, max]); the number box always shows the value.
function sliderRow(o) {
  const row = mk('div', 'row'), lab = mk('label', null, o.label), id = `m-${++ctlId}`;
  lab.htmlFor = id;
  const range = mk('input'), num = mk('input');
  Object.assign(range, { type: 'range', id, min: o.map ? 0 : o.min, max: o.map ? 1 : o.max, step: o.map ? 0.001 : o.step });
  Object.assign(num, { type: 'number', min: o.min, max: o.max, step: o.step ?? 'any' });
  num.setAttribute('aria-label', o.label);
  if (o.title) { row.title = o.title; }
  const map = o.map || { to: (v) => v, from: (u) => u };
  const key = {};
  const put = (v, inter) => { if (isFinite(v)) edit(key, inter, () => o.set(Math.min(o.max, Math.max(o.min, v)))); o.changed?.(); };
  range.oninput = () => put(map.from(Number(range.value)), true);
  range.onchange = () => put(map.from(Number(range.value)), false);
  num.onchange = () => put(Number(num.value), false);
  row.append(lab, range, num);
  return { row, lab, range, num, refresh() { const v = o.get(); range.value = map.to(v); num.value = sig(v); } };
}
function checkRow(label, title, get, set, changed) {
  const lab = mk('label', 'check'), cb = mk('input');
  cb.type = 'checkbox';
  lab.append(cb, ' ' + label);
  if (title) lab.title = title;
  cb.onchange = () => { edit({}, false, () => set(cb.checked)); changed?.(); };
  return { row: lab, cb, refresh() { cb.checked = !!get(); } };
}
function selectRow(label, options, get, set, changed) {
  const row = mk('div', 'row'), lab = mk('label', null, label), s = mk('select'), id = `m-${++ctlId}`;
  lab.htmlFor = id; s.id = id;
  for (const [v, t] of options) s.add(new Option(t, v));
  s.onchange = () => { edit({}, false, () => set(s.value)); changed?.(); };
  row.append(lab, s);
  return { row, sel: s, refresh() { s.value = get(); } };
}

// Optical thickness hint for a medium across a region of `size` [min, max] px.
function depthHint(mfp, size) {
  const t = (d) => d / Math.max(1e-6, mfp);
  const [a, b] = size.map(t);
  const p2 = (x) => (x >= 10 ? String(Math.round(x)) : x.toPrecision(2));
  const span = Math.abs(b - a) < 0.05 * b ? p2(b) : `${p2(a)}–${p2(b)}`;
  const regime = b < 0.3 ? 'single scattering (thin haze)' : b < 4 ? 'a few scatterings' : 'diffuse glow';
  return `mean free path ${sig(mfp)} px · ${span} mean free paths across: ${regime}`;
}
function sizeOf(it) {
  switch (it.type) {
    case 'circle': return [2 * it.r, 2 * it.r];
    case 'prism': return [it.size * 0.866, it.size];
    case 'lens': { const g = lensGeom(it); return [g.t, 2 * g.aperture]; }
    case 'glassblock': return [Math.min(it.w, it.h), Math.max(it.w, it.h)];
  }
  return [DESIGN_H, DESIGN_W];
}

// Controls of one medium `get()` ({mfp, g, albedo, spectral, ink, vis, glow,
// fill?}) into `box`: density (+ the ink colour for ink) up front, the rest
// under "Advanced". `o`: {lo, hi} mean free path range, size() for the hint,
// glass() true when the medium sits in lossless glass (warn on albedo 1).
function mediumPanel(box, get, o) {
  const ctls = [];
  const refresh = () => {
    const m = get();
    for (const c of ctls) c.refresh();
    hint.textContent = depthHint(m.mfp, o.size());
    const ink = m.fill === 'ink';
    (ink ? basic : adv).insertBefore(inkRow, ink ? null : adv.firstChild);
    inkCb.hidden = ink;
    inkText.textContent = ink ? 'Ink colour (white light after one mean free path)' : 'Absorption tint (the absorbed part)';
    inkPick.hidden = !ink && !m.ink;
    trap.hidden = !(o.glass() && m.albedo >= 0.9999);
  };
  const basic = mk('div'), det = mk('details', 'adv'), sum = mk('summary', null, 'Advanced'), adv = mk('div');
  det.append(sum, adv);
  box.append(basic, det);
  const density = sliderRow({ label: 'Density', min: o.lo, max: o.hi, step: 'any', map: logMap(o.lo, o.hi, true),
    title: 'Log scale; right = denser. The number is the mean free path (design px at 550 nm).',
    get: () => get().mfp, set: (v) => { get().mfp = v; }, changed: refresh });
  const hint = mk('div', 'hint');
  basic.append(density.row, hint);
  ctls.push(density);
  // Ink / absorption tint: a colour picker (+ an on/off box for non-ink media).
  const inkRow = mk('div', 'row'), inkLab = mk('label'), inkText = document.createTextNode(''), inkCb = mk('input'), inkPick = mk('input');
  inkCb.type = 'checkbox'; inkPick.type = 'color';
  inkCb.title = 'Tint the absorbed part (shows only when albedo < 1)';
  inkLab.append(inkCb, inkText);
  inkRow.append(inkLab, inkPick);
  inkPick.style.cssText = 'grid-column:1/-1;width:100%;height:24px;padding:0 2px';
  let lastInk = '#c06030';
  const inkKey = {};
  inkPick.oninput = () => edit(inkKey, true, () => { get().ink = lastInk = inkPick.value; });
  inkPick.onchange = () => edit(inkKey, false, () => { get().ink = lastInk = inkPick.value; });
  inkCb.onchange = () => { edit({}, false, () => { get().ink = inkCb.checked ? lastInk : ''; }); refresh(); };
  ctls.push({ refresh() { const m = get(); inkCb.checked = !!m.ink; if (m.ink) { inkPick.value = m.ink; lastInk = m.ink; } else inkPick.value = m.fill === 'ink' ? '#808080' : lastInk; } });
  const add = (c) => { adv.appendChild(c.row); ctls.push(c); return c; };
  add(sliderRow({ label: 'Anisotropy g (− back, + forward)', min: -0.9, max: 0.9, step: 0.01,
    title: 'Henyey–Greenstein asymmetry: mean cosine of the turn at each scattering', get: () => get().g, set: (v) => { get().g = v; } }));
  add(sliderRow({ label: 'Albedo (0 absorbs … 1 scatters)', min: 0, max: 1, step: 'any', map: albedoMap,
    title: 'Fraction of each collision that scatters; the rest is absorbed', get: () => get().albedo, set: (v) => { get().albedo = v; }, changed: refresh }));
  const trap = mk('div', 'hint warn', 'Albedo 1 in glass: light trapped by total internal reflection never dies (slow). Keep a little absorption.');
  adv.appendChild(trap);
  add(sliderRow({ label: 'Spectral exponent (0 white haze … 4 λ⁻⁴ Rayleigh)', min: 0, max: 4, step: 0.1,
    title: 'Scattering ∝ (550 nm / λ)^exponent', get: () => get().spectral, set: (v) => { get().spectral = v; } }));
  add(sliderRow({ label: 'Draw weight inside', min: 0, max: 20, step: 'any', map: weightMap,
    title: 'Display only: brightness of light inside this medium (1 = physical)', get: () => get().vis ?? 1, set: (v) => { get().vis = v; } }));
  add(checkRow('Glow (camera above: weight ∝ σ_s)', 'Display only: draw light inside with weight ∝ the scattering coefficient, i.e. the light scattered out of the plane towards a camera above (blue for Rayleigh media)',
    () => get().glow, (v) => { get().glow = v; }));
  adv.insertBefore(inkRow, adv.firstChild);
  return { refresh };
}

// Inspector section for a closed glass shape: fill kind, wall, medium.
function fillSection(box, it) {
  const h = mk('h4', null, 'Inside');
  box.appendChild(h);
  const panel = mk('div');
  const glassRows = () => propInputs.filter((e) => e.prop.key === 'ior' || e.prop.key === 'disp');
  const refresh = () => {
    fill.refresh(); wall.refresh();
    panel.hidden = !it.fill || it.fill === 'none';
    if (!panel.hidden) med.refresh();
    for (const e of glassRows()) e.row.hidden = it.wall === 'clear';
  };
  const fill = selectRow('Fill', Object.entries(FILLS).map(([k2, f]) => [k2, f.label]), () => it.fill || 'none',
    (v) => applyFill(it, v), () => { refresh(); overlayDirty = true; });
  fill.row.title = 'Choosing a kind loads its default parameters';
  const wall = selectRow('Wall', [['glass', 'Glass (refracts, reflects)'], ['clear', 'None (clear: just a region of medium)']],
    () => it.wall || 'glass', (v) => { it.wall = v; }, () => { refresh(); overlayDirty = true; });
  box.append(fill.row, wall.row, panel);
  const med = mediumPanel(panel, () => it, { lo: 4, hi: 5000, size: () => sizeOf(it), glass: () => it.wall !== 'clear' });
  return { refresh };
}
let inspFill = null;

// Scene panel: room medium and display weights.
let syncMedia = () => {};
function initMediaControls() {
  const fogBox = $('fogBox'), disp = $('displayBox');
  const fogOn = $('fogOn');
  fogOn.onchange = () => { edit({}, false, () => { scene.fog.on = fogOn.checked; }); syncMedia(); };
  const kind = selectRow('Kind', [...Object.entries(ROOM_FILLS).map(([k2, f]) => [k2, f.label]), ['custom', 'Custom']],
    () => (ROOM_FILLS[scene.fog.kind] ? scene.fog.kind : 'custom'), (v) => { if (ROOM_FILLS[v]) applyRoomFill(scene.fog, v); else scene.fog.kind = 'custom'; }, () => syncMedia());
  kind.row.title = 'Choosing a kind loads its default parameters';
  fogBox.appendChild(kind.row);
  const fogPanel = mediumPanel(fogBox, () => scene.fog, { lo: 100, hi: 30000, size: () => [DESIGN_H, DESIGN_W], glass: () => false });
  let lastDirect = 1;
  const vac = sliderRow({ label: 'Brightness of rays outside media', min: 0, max: 2, step: 0.01,
    title: 'Display only: draw weight of light in vacuum (dim it to make media stand out)',
    get: () => scene.display.vacuum, set: (v) => { scene.display.vacuum = v; } });
  const dir = sliderRow({ label: 'Unscattered light (direct beams)', min: 0, max: 1, step: 0.01,
    title: 'Display only: draw weight of light that has not scattered in a medium yet. Lower it when the glow of a medium is lost next to the bright beam.',
    get: () => scene.display.direct, set: (v) => { scene.display.direct = v; if (v > 0) lastDirect = v; }, changed: () => syncMedia() });
  const only = checkRow('Scattered light only', 'Hide light that has not scattered yet (direct weight 0)',
    () => scene.display.direct === 0, (v) => { scene.display.direct = v ? 0 : lastDirect || 1; }, () => syncMedia());
  disp.append(vac.row, dir.row, only.row);
  syncMedia = () => {
    fogOn.checked = !!scene.fog.on;
    fogBox.hidden = !scene.fog.on;
    kind.refresh();
    if (scene.fog.on) fogPanel.refresh();
    vac.refresh(); dir.refresh(); only.refresh();
  };
}

// Scene-level controls.
function bindPair(rangeId, numId, get, set) {
  const r = $(rangeId), n = $(numId);
  r.oninput = () => { n.value = r.value; set(Number(r.value), true); };
  r.onchange = () => set(Number(r.value), false);
  n.onchange = () => { r.value = n.value; set(Number(n.value), false); };
  return () => { r.value = get(); n.value = get(); };
}
let syncAlbedo = () => {};
function syncSceneControls() {
  $('walls').checked = !!scene.walls;
  syncAlbedo();
  syncMedia();
  syncCamera();
  $('baseNote').hidden = !scene.base;
  $('baseNote').textContent = scene.base ? `Background: the built-in "${scene.base}" scene (fixed; add items on top).` : '';
}
function initSceneControls() {
  initMediaControls();
  $('walls').onchange = () => { pushUndo(); scene.walls = $('walls').checked; sceneChanged(false); };
  let started = false;
  syncAlbedo = bindPair('wallAlbedo', 'wallAlbedoN', () => scene.wallAlbedo ?? 0.04, (v, inter) => {
    if (!started) { pushUndo(); started = true; }
    scene.wallAlbedo = v; sceneChanged(inter);
    if (!inter) started = false;
  });
  const postExposure = () => worker && worker.postMessage({ type: 'exposure', auto: $('autoExp').checked, ev: Number($('ev').value) });
  $('autoExp').onchange = postExposure;
  bindPair('ev', 'evN', () => 0, postExposure);
  const postDecay = (v) => worker && worker.postMessage({ type: 'settings', settings: { decay: v } });
  bindPair('decay', 'decayN', () => initialDecay, postDecay)();
  const lim = $('limit');
  const opts = [1e6, 2e6, 4e6, 8e6, 16e6, 32e6, 64e6, 128e6, 256e6, 1e9];
  if (initialLimit > 0 && !opts.includes(initialLimit)) opts.push(initialLimit);
  opts.sort((a, b) => a - b);
  for (const v of opts) lim.add(new Option(`${v >= 1e9 ? v / 1e9 + 'G' : v / 1e6 + 'M'} rays${v === DEFAULT_LIMIT ? ' (default)' : ''}`, String(v)));
  lim.add(new Option('Unlimited', '0'));
  lim.value = String(initialLimit);
  lim.onchange = () => worker && worker.postMessage({ type: 'settings', settings: { limit: Number(lim.value) } });
  document.addEventListener('visibilitychange', () => worker && worker.postMessage({ type: 'visible', visible: !document.hidden }));
  $('outlines').onchange = () => (overlayDirty = true);
  $('hudOn').onchange = drawHud;
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  const ps = $('preset');
  ps.add(new Option('Presets…', ''));
  for (const [name, p] of Object.entries(PRESETS)) ps.add(new Option(p.label, name));
  ps.onchange = () => { if (ps.value) loadPreset(ps.value); ps.value = ''; };
  $('save').onclick = () => {
    const blob = new Blob([JSON.stringify({ zpgEditor: 1, ...scene }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'zpg-scene.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('load').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const f = $('file').files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!Array.isArray(j.items)) throw new Error('not a scene file');
      pushUndo();
      delete j.zpgEditor;
      restore(JSON.stringify(j));
      lookDirty = true;
      toast(`loaded ${f.name}`);
    } catch (e) { toast(`load failed: ${e.message}`); }
    $('file').value = '';
  };
}

// --- camera scenes -------------------------------------------------------------------------------------------
// Shown when scene.camera is set (see editor-scene.js: rig parts, paraxial
// optics). Focus moves the visible lens group along the axis; Aperture sets
// the stop's opening; Lens switches variants (hidden items). Everything goes
// through `edit` (one undo step per gesture, interactive while dragging).
// The sensor inset shows the worker's sensor readout (type 'sensor').
let bodyUnlocked = false;
const isLocked = (it) => !bodyUnlocked && it.rig === 'body';
const camLabel = (it) => it.name || TYPES[it.type].label.toLowerCase();
const fmtDist = (L) => (!isFinite(L) || L > 1e5 ? '∞' : L < 0 ? 'beyond ∞' : `${Math.round(L)} px`);
function drawCameraOverlay(c, showAll) {
  const cam = scene.camera, ax = { x: Math.cos(cam.rot), y: Math.sin(cam.rot) }, n = { x: -ax.y, y: ax.x };
  const at = (t, h = 0) => ({ x: cam.x + ax.x * t + n.x * h, y: cam.y + ax.y * t + n.y * h });
  const px = paraxial(scene);
  c.save();
  if (showAll) {
    // The optical axis (dash-dot), out to the sensor.
    const a = at(-2000), b = at(px ? px.sensorT : cam.tube[1]);
    c.setLineDash([10 / k, 4 / k, 2 / k, 4 / k]);
    c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 1 / k;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    for (const v of viewRects(scene)) { // the view region(s)
      c.setLineDash([3 / k, 5 / k]);
      c.strokeStyle = 'rgba(120,255,170,0.22)';
      c.save(); c.translate(v.x, v.y); c.rotate(v.rot); c.strokeRect(-v.w / 2, -v.h / 2, v.w, v.h); c.restore();
    }
  }
  if (px && isFinite(px.L) && px.L > 0 && px.L < 4000) {
    // The plane of focus (paraxial), across the object field.
    const t = px.focusT, a = at(t, -260), b = at(t, 260);
    c.setLineDash([6 / k, 5 / k]);
    c.strokeStyle = 'rgba(255,214,90,0.6)'; c.lineWidth = 1.3 / k;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255,214,90,0.9)';
    c.font = `${11 / k}px ui-sans-serif, system-ui`;
    c.textAlign = 'center';
    const lp = at(t, 274);
    c.fillText('plane of focus', lp.x, lp.y + 8 / k);
  }
  c.restore();
}

let syncCamera = () => {};
let camUi = null;
function initCameraControls() {
  const box = $('cameraBox');
  const hint = (cls = 'hint') => mk('div', cls);
  // Focus: the lens group's position along the axis (custom row: its range
  // follows the tube and the parts' positions).
  const fRow = mk('div', 'row'), fLab = mk('label', null, 'Focus — lens position (moves the whole lens)'), fRange = mk('input'), fNum = mk('input');
  fLab.htmlFor = fRange.id = 'camFocus';
  Object.assign(fRange, { type: 'range', step: 0.1 }); Object.assign(fNum, { type: 'number', step: 0.5 });
  fNum.setAttribute('aria-label', 'Lens position (px from the sensor)');
  fNum.title = 'Distance from the lens group to the sensor (design px)';
  fRow.append(fLab, fRange, fNum);
  const focusKey = {};
  const setGroup = (pos, inter) => {
    const r = groupRange(scene);
    if (!r || !isFinite(pos)) return;
    pos = Math.min(r.max, Math.max(r.min, pos));
    edit(focusKey, inter, () => shiftGroup(scene, pos - r.pos));
    refreshInspectorValues();
    refresh();
  };
  // The slider runs from far (lens near the sensor) to near: right = nearer focus.
  fRange.oninput = () => setGroup(-Number(fRange.value), true);
  fRange.onchange = () => setGroup(-Number(fRange.value), false);
  fNum.onchange = () => { const px = paraxial(scene), r = groupRange(scene); if (px && r) setGroup(r.pos + (px.sensorT - r.pos) - Number(fNum.value), false); };
  const fHint = hint();
  const btns = mk('div', 'focus-btns');
  const dof = mk('div', 'dof');
  box.append(fRow, fHint, btns, dof);
  // Aperture: the stop's opening (log slider).
  const apKey = {};
  const stops = () => scene.items.filter((it) => it.type === 'aperture' && it.rig === 'lens' && !it.hidden);
  const ap = sliderRow({ label: 'Aperture — stop opening (diameter, px)', min: 1, max: 600, step: 'any',
    map: { to: (v) => { const [lo, hi] = scene.camera.aperture || [4, 120]; return Math.log(v / lo) / Math.log(hi / lo); }, from: (u) => { const [lo, hi] = scene.camera.aperture || [4, 120]; return lo * Math.pow(hi / lo, u); } },
    title: 'Opening of the aperture stop. Small: more depth of field, dimmer image; wide: shallow focus, brighter.',
    get: () => (stops()[0] ? stops()[0].hole : 0), set: (v) => { for (const s of stops()) s.hole = Math.min(s.size - 1, v); }, changed: () => { refreshInspectorValues(); refresh(); } });
  void apKey;
  const apHint = hint();
  box.append(ap.row, apHint);
  // Lens variant.
  const lensSel = selectRow('Lens', [], () => scene.camera.lens, (v) => {
    // Keep the focus distance: refocus the new lens on the same plane.
    const before = paraxial(scene);
    setLensVariant(scene, v);
    if (before && isFinite(before.L)) { const pos = focusFor(scene, before.focusT), r = groupRange(scene); if (pos != null && r) shiftGroup(scene, pos - r.pos); }
    if (sel != null && byId(sel)?.hidden) sel = null;
  }, () => { buildInspector(); refresh(); });
  lensSel.row.title = 'Multi-element lens or a single lens of similar focal length (refocused on the same plane)';
  box.append(lensSel.row);
  // Display inside / outside the camera.
  const vw = sliderRow({ label: 'Brightness inside the camera (behind the stop)', min: 0, max: 20, step: 'any', map: weightMap,
    title: 'Display only: draw weight of light inside the camera body (the view region)',
    get: () => scene.view?.weight ?? 1, set: (v) => { if (scene.view) scene.view.weight = v; } });
  const vpre = sliderRow({ label: 'Brightness in the lens, in front of the stop', min: 0, max: 20, step: 'any', map: weightMap,
    title: 'Display only: draw weight of light between the first lens element and the stop (much brighter: not limited by the stop yet)',
    get: () => scene.view?.pre ?? 1, set: (v) => { if (scene.view) scene.view.pre = v; } });
  const vac = sliderRow({ label: 'Brightness outside', min: 0, max: 2, step: 0.01,
    title: 'Display only: draw weight of light outside the camera (Display → brightness of rays outside media)',
    get: () => scene.display.vacuum, set: (v) => { scene.display.vacuum = v; }, changed: () => syncMedia() });
  box.append(vw.row, vpre.row, vac.row);
  // Sensor image inset (UI state in scene.camera, no re-trace).
  const uiCheck = (label, title, key) => {
    const lab = mk('label', 'check'), cb = mk('input');
    cb.type = 'checkbox'; lab.append(cb, ' ' + label); lab.title = title;
    cb.onchange = () => { scene.camera[key] = cb.checked; saveLocal(); sensorDirty = true; layoutSensor(); };
    return { row: lab, refresh() { cb.checked = !!scene.camera[key]; } };
  };
  const sh = uiCheck('Show sensor image', 'Inset: the 1D image recorded by the sensor', 'show');
  const up = uiCheck('Upright (undo the lens’s inversion)', 'Flip the sensor image so it matches the scene', 'upright');
  const pl = uiCheck('Luminance plot', 'Plot the sensor image’s brightness beside the strip', 'plot');
  const sev = mk('div', 'row'), sevLab = mk('label', null, 'Sensor image exposure (EV)'), sevR = mk('input'), sevN = mk('input');
  sevLab.htmlFor = sevR.id = 'camSensorEv';
  Object.assign(sevR, { type: 'range', min: -4, max: 4, step: 0.1 }); Object.assign(sevN, { type: 'number', min: -4, max: 4, step: 0.1 });
  const setEv = (v) => { if (!isFinite(v)) return; scene.camera.ev = v; sevR.value = sevN.value = v; sensorDirty = true; saveLocal(); };
  sevR.oninput = () => setEv(Number(sevR.value)); sevN.onchange = () => setEv(Number(sevN.value));
  sev.append(sevLab, sevR, sevN);
  sev.title = 'Relative to the brightest part of the sensor image (auto)';
  const unl = mk('label', 'check'), unlCb = mk('input');
  unlCb.type = 'checkbox'; unl.append(unlCb, ' Unlock camera body and sensor');
  unl.title = 'The body and sensor ignore clicks and drags unless unlocked';
  unlCb.onchange = () => { bodyUnlocked = unlCb.checked; if (!bodyUnlocked && sel != null && byId(sel) && isLocked(byId(sel))) setSel(null); };
  const h4 = mk('h4', null, 'Sensor image');
  box.append(h4, sh.row, up.row, pl.row, sev, unl);
  const help = mk('div', 'hint', 'Drag a lens element or the stop to move it along the axis. Drag the stop’s handle to change its opening.');
  box.append(help);

  let lastBtnKey = '';
  function refresh() {
    const cam = scene.camera, r = groupRange(scene), px = paraxial(scene);
    if (r) {
      fRange.min = -r.max; fRange.max = -r.min; fRange.value = -r.pos;
      fNum.value = px ? Math.round((px.sensorT - r.pos) * 10) / 10 : '';
    }
    fRange.disabled = !r;
    if (px) {
      const inf = !isFinite(px.L) || px.L > 1e5;
      fHint.textContent = `In focus: ${inf ? 'infinity' : px.L < 0 ? 'beyond infinity' : `${Math.round(px.L)} px in front of the lens`} · focal length ${Math.round(px.efl)} px · lens to sensor ${Math.round(px.S)} px`
        + (px.calibrated ? ' · calibrated to the traced best focus' : ' · paraxial');
      fHint.title = px.calibrated ? 'Paraxial optics corrected to the best focus found by tracing the design (spherical aberration and field curvature move it)' : 'Paraxial (first-order) optics: the traced best focus differs somewhat at wide apertures';
      // Blur of each object (axial point at its distance, paraxial).
      dof.textContent = '';
      const objs = scene.items.filter((it) => (it.type === 'paintblock' || it.type === 'paintdisc') && !it.hidden)
        .map((it) => ({ it, L: px.front - axialOf(cam, it) })).sort((a, b) => a.L - b.L);
      const seen = new Set();
      for (const { it, L } of objs) {
        const key = `${camLabel(it)}|${it.depth}|${Math.round(L)}`;
        if (seen.has(key)) continue; // one row per target (e.g. a group of bars)
        seen.add(key);
        const b = px.blur(L), sw = mk('span', 'sw'), sharp = b < 2.5;
        sw.style.background = it.color;
        const name = mk('span', null, `${camLabel(it)}${it.depth ? ` (${it.depth})` : ''} · ${Math.round(L)} px`);
        const bl = mk('span', sharp ? 'sharp' : null, sharp ? `sharp (${b.toFixed(1)} px)` : `blur ${b < 10 ? b.toFixed(1) : Math.round(b)} px`);
        bl.title = 'Paraxial blur-spot diameter on the sensor (design px) for a point at this distance';
        dof.append(sw, name, bl);
      }
      apHint.textContent = `≈ f/${px.fnum < 10 ? px.fnum.toFixed(1) : Math.round(px.fnum)} (paraxial, for distant objects)`;
    } else { fHint.textContent = 'No lens / sensor on the axis.'; dof.textContent = ''; apHint.textContent = ''; }
    ap.row.hidden = apHint.hidden = !stops().length;
    if (stops().length) ap.refresh();
    // Focus buttons: the tagged depths that exist, and infinity.
    const depths = DEPTHS.filter((d) => depthT(scene, d) != null);
    const key = depths.join();
    if (key !== lastBtnKey) {
      lastBtnKey = key;
      btns.textContent = '';
      for (const d of [...depths, 'inf']) {
        const b = mk('button', null, d === 'inf' ? '∞' : d[0].toUpperCase() + d.slice(1));
        b.title = d === 'inf' ? 'Focus at infinity' : `Focus on the ${d} objects`;
        b.onclick = () => {
          const pos = focusFor(scene, depthT(scene, d));
          if (pos == null) { toast(`can’t focus on ${d === 'inf' ? 'infinity' : `the ${d} objects`} within the tube`); return; }
          setGroup(pos, false);
        };
        btns.appendChild(b);
      }
    }
    const vs = lensVariants(scene);
    lensSel.row.hidden = vs.length < 2;
    if (vs.length >= 2 && lensSel.sel.options.length !== vs.length) {
      lensSel.sel.textContent = '';
      for (const v of vs) lensSel.sel.add(new Option((cam.labels && cam.labels[v]) || v, v));
    }
    lensSel.refresh();
    vw.row.hidden = !scene.view;
    if (scene.view) vw.refresh();
    vpre.row.hidden = !(scene.view && scene.view.pre != null);
    if (!vpre.row.hidden) vpre.refresh();
    vac.refresh();
    sh.refresh(); up.refresh(); pl.refresh();
    sevR.value = sevN.value = cam.ev ?? 0;
    unlCb.checked = bodyUnlocked;
  }
  camUi = { refresh };
  syncCamera = () => {
    const on = !!(scene && scene.camera);
    $('cameraSec').hidden = !on;
    if (on) refresh();
    if (!on) { lastSensor = null; }
    layoutSensor();
    sensorDirty = true;
  };
}
// Refresh the Camera panel's readouts after a drag (at most once per frame).
let camRefreshDirty = false;

// --- sensor inset ------------------------------------------------------------------------------------------------
let lastSensor = null, sensorDirty = false, sensorReset = 0, sensorPrevRays = 0, sensorK = 0;
// While dragging, each readout holds one frame (the wasm resets on every
// new scene): keep a ray-weighted trail of the last few frames (x0.8 per
// frame) so the strip isn't a barcode of single hits. Readouts of the same
// scene revision are cumulative, so only their increment is added.
let sensorRaw = null; // previous readout {rev, rays, data}
const SENSOR_TRAIL = 0.8;
function onSensor(m) {
  if (!m.bins) { lastSensor = null; sensorRaw = null; sensorDirty = true; return; }
  const now = performance.now();
  const same = sensorRaw && sensorRaw.data.length === m.data.length && sensorRaw.rev === m.rev && m.rays >= sensorRaw.rays;
  let data = m.data, rays = m.rays;
  if (m.dragging && lastSensor && lastSensor.bins === m.bins) {
    const inc = same ? m.data.map((v, i) => v - sensorRaw.data[i]) : m.data, incRays = same ? m.rays - sensorRaw.rays : m.rays;
    data = lastSensor.data.map((v, i) => SENSOR_TRAIL * v + inc[i]);
    rays = SENSOR_TRAIL * lastSensor.rays + incRays;
  }
  if (!lastSensor || (!m.dragging && (m.rays < sensorPrevRays || m.bins !== lastSensor.bins || lastSensor.dragging))) sensorReset = now;
  sensorPrevRays = m.rays;
  sensorRaw = { rev: m.rev, rays: m.rays, data: m.data };
  lastSensor = { bins: m.bins, rev: m.rev, dragging: m.dragging, rays, data, at: now };
  sensorDirty = true;
}
function layoutSensor() {
  const cam = scene && scene.camera, inset = $('sensorInset');
  inset.hidden = !(cam && cam.show && scene.items.some((it) => it.type === 'sensor' && !it.hidden));
  if (cam) {
    // Beside the camera: above or below its body, whichever has more room
    // (else the default, centred on the right edge).
    let top = Infinity, bot = -Infinity;
    for (const it of scene.items) {
      if (it.hidden || (it.rig !== 'body' && it.rig !== 'lens')) continue;
      const pts = it.type === 'sensor' ? segEnds(it) : it.type === 'block' ? rectVerts(it) : [{ y: it.y - (it.semi || it.size / 2 || 0) }, { y: it.y + (it.semi || it.size / 2 || 0) }];
      for (const q of pts) { top = Math.min(top, q.y); bot = Math.max(bot, q.y); }
    }
    const above = top, below = DESIGN_H - bot, pct = (v) => `${((100 * v) / DESIGN_H).toFixed(2)}%`;
    if (!isFinite(top) || Math.max(above, below) < 0.3 * DESIGN_H) { inset.style.top = '14%'; inset.style.bottom = '14%'; }
    else if (above >= below) { inset.style.top = '6px'; inset.style.bottom = `calc(${pct(DESIGN_H - top)} + 6px)`; }
    else { inset.style.top = `calc(${pct(bot)} + 6px)`; inset.style.bottom = '6px'; }
  }
  $('sensorPlot').hidden = !(cam && cam.plot);
  $('sensorSub').textContent = cam && cam.upright ? '1D, flipped upright' : '1D, inverted by the lens';
}
function drawSensor() {
  sensorDirty = false;
  const cam = scene && scene.camera;
  if (!cam || !cam.show) return;
  const m = lastSensor, strip = $('sensorStrip'), plot = $('sensorPlot'), meta = $('sensorMeta');
  const sensorIt = scene.items.find((it) => it.type === 'sensor' && !it.hidden);
  if (!m || !m.data || !sensorIt) {
    meta.textContent = info && !(info.sensor ?? true) ? 'this wasm has no sensor' : 'waiting for rays…';
    return;
  }
  const B = m.bins, d = m.data, rays = Math.max(1, m.rays);
  // Order along the strip: top to bottom as on the sensor in the scene (the
  // sensor's end nearer the top first); upright flips it.
  const [a, b] = segEnds(sensorIt);
  let flip = a.y > b.y + 1e-6 || (Math.abs(a.y - b.y) <= 1e-6 && a.x > b.x);
  if (cam.upright) flip = !flip;
  // Per-ray linear RGB; auto exposure on a robust max (98th percentile of
  // the brightest channel), eased in log space so noise doesn't flicker.
  const mx = new Float32Array(B);
  for (let i = 0; i < B; i++) mx[i] = Math.max(d[3 * i], d[3 * i + 1], d[3 * i + 2]) / rays;
  const sorted = Float32Array.from(mx).sort();
  const q = sorted[Math.min(B - 1, Math.floor(0.98 * B))] || sorted[B - 1];
  if (q > 0) sensorK = sensorK > 0 && Math.abs(Math.log(q / sensorK)) < 1.5 ? sensorK * Math.pow(q / sensorK, 0.35) : q;
  const scale = sensorK > 0 ? Math.pow(2, cam.ev || 0) / sensorK : 0;
  if (strip.height !== B) strip.height = B;
  strip.width = 1;
  const sc = strip.getContext('2d'), img = sc.createImageData(1, B), lum = new Float32Array(B);
  const g = (x) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, x)), 1 / 2.2));
  for (let i = 0; i < B; i++) {
    const j = flip ? B - 1 - i : i;
    let r = (d[3 * j] / rays) * scale, gr = (d[3 * j + 1] / rays) * scale, bl = (d[3 * j + 2] / rays) * scale;
    const L = 0.2126 * r + 0.7152 * gr + 0.0722 * bl;
    lum[i] = L;
    // Gamut: desaturate negative components towards the luminance, then clip.
    const mn = Math.min(r, gr, bl);
    if (mn < 0) { const t = L > 0 ? L / (L - mn) : 0; r = L + t * (r - L); gr = L + t * (gr - L); bl = L + t * (bl - L); }
    img.data[4 * i] = g(r); img.data[4 * i + 1] = g(gr); img.data[4 * i + 2] = g(bl); img.data[4 * i + 3] = 255;
  }
  sc.putImageData(img, 0, 0);
  if (cam.plot) {
    const cw = Math.max(1, Math.round(plot.clientWidth * dpr)), chh = Math.max(1, Math.round(plot.clientHeight * dpr));
    if (plot.width !== cw || plot.height !== chh) { plot.width = cw; plot.height = chh; }
    const pc = plot.getContext('2d');
    pc.clearRect(0, 0, cw, chh);
    pc.strokeStyle = 'rgba(255,255,255,0.12)'; pc.lineWidth = 1;
    pc.beginPath(); pc.moveTo(0.5, 0); pc.lineTo(0.5, chh); pc.stroke();
    pc.beginPath();
    for (let i = 0; i < B; i++) {
      const x = Math.min(1.05, lum[i]) / 1.05 * (cw - 2) + 1, y = ((i + 0.5) / B) * chh;
      if (i) pc.lineTo(x, y); else pc.moveTo(x, y);
    }
    pc.strokeStyle = 'rgba(235,240,245,0.9)'; pc.lineWidth = 1.2 * dpr; pc.stroke();
  }
  const age = (performance.now() - sensorReset) / 1000;
  meta.textContent = m.dragging ? `live · ${fmt(m.rays)} rays (last few frames)` : `${fmt(m.rays)} rays · ${age < 10 ? age.toFixed(1) : Math.round(age)} s`;
}
setInterval(() => { if (lastSensor && !lastSensor.dragging && scene && scene.camera && scene.camera.show) sensorDirty = true; }, 500);

// --- keyboard ------------------------------------------------------------------------------------------------
addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
  if (e.key === 'Escape') { setSel(null); return; }
  if (e.key === 'o' || e.key === 'O') { $('outlines').checked = !$('outlines').checked; overlayDirty = true; return; }
  if (e.key === 'h' || e.key === 'H') { $('hudOn').checked = !$('hudOn').checked; drawHud(); return; }
  const it = sel != null && byId(sel);
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (it && arrows[e.key]) {
    e.preventDefault();
    if (!e.repeat) pushUndo();
    const s = e.shiftKey ? 10 : 1;
    it.x += arrows[e.key][0] * s; it.y += arrows[e.key][1] * s;
    sceneChanged(e.repeat);
    refreshInspectorValues();
    return;
  }
  if (it && (e.key === '[' || e.key === ']')) {
    const key = 'rot' in it ? 'rot' : 'angle' in it ? 'angle' : 'dir' in it ? 'dir' : null;
    if (key) { pushUndo(); it[key] += (e.key === ']' ? 5 : -5) * D2R; sceneChanged(false); refreshInspectorValues(); }
    return;
  }
  for (const [type, t] of Object.entries(TYPES)) if (t.key === e.key) { insert(type, null); return; }
});
// A non-interactive edit once keys are released after a repeat.
addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') && sceneDirty) sceneChanged(false); });

// --- main loop (UI only) -------------------------------------------------------------------------------
function frame() {
  requestAnimationFrame(frame);
  if (worker && info && sceneDirty) {
    if (DEBUG && sel != null && byId(sel)) { const it = byId(sel); revPos.set(sceneRev + 1, [Math.round(it.x * 10) / 10, Math.round(it.y * 10) / 10]); if (revPos.size > 5000) revPos.delete(revPos.keys().next().value); }
    worker.postMessage({ type: 'scene', rev: ++sceneRev, desc: encode(scene, RW, RH, SCENE_NAMES), interactive: dirtyInteractive, look: lookDirty ? scene.look : undefined, resetExposure: lookDirty });
    sceneDirty = false;
    dirtyInteractive = true;
    lookDirty = false;
  }
  if (overlayDirty) { drawOverlay(); if (scene && scene.camera && camUi) camUi.refresh(); }
  if (sensorDirty) drawSensor();
}

// --- init ------------------------------------------------------------------------------------------------------
(async () => {
  buildToolbar();
  initCameraControls();
  initSceneControls();
  let restored = false;
  const want = params.get('preset');
  if (!want) {
    try {
      const s = localStorage.getItem('zpg-editor-scene');
      if (s) { scene = JSON.parse(s); restored = Array.isArray(scene.items); if (restored) { normalizeScene(scene); reId(scene.items); } }
    } catch (_) { restored = false; }
  }
  if (!restored) scene = normalizeScene(PRESETS[want && PRESETS[want] ? want : 'showcase'].build());
  syncSceneControls();
  updateUndoButtons();
  if (params.get('hud') === '0') $('hudOn').checked = false;
  resize();
  requestAnimationFrame(frame);
  await startWorker();
})().catch(fail);

// debug=1: record the frames the browser actually commits for the canvas
// (captureStream; Chrome's MediaStreamTrackProcessor, else a <video> +
// requestVideoFrameCallback) and decode the content marker each batch draws
// into the accumulation (top left, y 34-44: cell 0 always set, cells 1..24
// the revision bits; set cells saturate). Returns [{t, rev, ref, mixed}]
// per frame (`mixed`: cells neither dark nor saturated).
async function recordFrames(ms) {
  const cv = $('render'), track = cv.captureStream().getVideoTracks()[0];
  const oc = new OffscreenCanvas(RW, RH), c2 = oc.getContext('2d', { willReadFrequently: true });
  const out = [];
  const decode = (src) => {
    c2.drawImage(src, 0, 0, RW, RH);
    const d = c2.getImageData(0, 39, 4 + 25 * 12, 1).data;
    const cell = (c) => Math.min(d[(4 + 12 * c + 5) * 4], d[(4 + 12 * c + 5) * 4 + 1], d[(4 + 12 * c + 5) * 4 + 2]);
    const ref = cell(0);
    let rev = 0, mixed = 0;
    for (let c = 1; c <= 24; c++) {
      const v = cell(c);
      rev = (rev << 1) | (v > 240 ? 1 : 0);
      if (v > 120 && v <= 240) mixed++;
    }
    out.push({ t: Math.round(performance.now()), rev, ref, mixed });
  };
  const until = performance.now() + ms;
  if (self.MediaStreamTrackProcessor) {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (performance.now() < until) {
      const { value: f, done } = await reader.read();
      if (done) break;
      decode(f);
      f.close();
    }
  } else {
    const v = document.createElement('video');
    v.muted = true; v.srcObject = new MediaStream([track]); await v.play();
    await new Promise((res) => {
      const cb = () => { decode(v); if (performance.now() < until) v.requestVideoFrameCallback(cb); else res(); };
      v.requestVideoFrameCallback(cb);
    });
  }
  track.stop();
  return out;
}

// The tone-mapped frame as shown, as a PNG Blob (automation, screenshots).
// 'direct' present: the canvas belongs to the worker's OffscreenCanvas, so
// read it through captureStream (Chrome: MediaStreamTrackProcessor) after
// asking the worker to re-present (an exposure message re-tone-maps, also
// when idle at the ray limit). 'bitmap' present: draw the canvas directly.
async function snapshotPNG() {
  const cv = $('render'), oc = document.createElement('canvas');
  oc.width = RW; oc.height = RH;
  const c2 = oc.getContext('2d');
  if (presentMode === 'bitmap' || !self.MediaStreamTrackProcessor) c2.drawImage(cv, 0, 0, RW, RH);
  else {
    const track = cv.captureStream().getVideoTracks()[0];
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    worker.postMessage({ type: 'exposure', auto: $('autoExp').checked, ev: Number($('ev').value) });
    const r = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('no frame in 3 s')), 3000))]);
    c2.drawImage(r.value, 0, 0, RW, RH);
    r.value.close();
    reader.cancel(); track.stop();
  }
  return new Promise((res) => oc.toBlob(res, 'image/png'));
}

// For automation: live stats and the scene model.
window.zpgEditor = { recordFrames, revPos: (r) => revPos.get(r), rev: () => sceneRev, settings: (o) => worker.postMessage({ type: 'settings', settings: o }), stats: () => lastStats, info: () => info, scene: () => scene, select: (id) => setSel(id), loadPreset, snapshot: snapshotPNG, worker: () => worker, presets: PRESETS,
  sensor: () => lastSensor, paraxial: () => scene && paraxial(scene), sceneChanged: () => sceneChanged(false) };
