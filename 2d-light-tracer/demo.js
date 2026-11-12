// Live demo page: progressive pool render at 1280x720 (see demo.html).
// CPU methods render and tone-map in demo-worker.js and post RGBA frames.
// GPU methods trace in the worker (threaded) and post each round's packed
// lines here, where pkg-gpu (raster-gpu on WebGPU or WebGL2) draws them
// into a float texture and tone-maps it straight to the canvas.
//
// URL options: method=<id>, scene=<name>, round=<rays>.
const W = 1280, H = 720;
const HC = navigator.hardwareConcurrency || 4;
const FREEZE_RAYS = 4 * 131072; // as demo-worker.js
const $ = (id) => document.getElementById(id);

const METHODS = [
  { id: 'simd-1', label: 'wasm SIMD128, 1 thread', variant: 'simd', threads: 1, mode: 'cpu', needs: [] },
  { id: 'simd-mt', label: `wasm SIMD128, ${HC} threads`, variant: 'threads', threads: HC, mode: 'cpu', needs: ['threads'] },
  { id: 'relaxed-mt', label: `wasm relaxed-SIMD, ${HC} threads`, variant: 'threads-relaxed', threads: HC, mode: 'cpu', needs: ['threads', 'relaxed'] },
  { id: 'scalar-1', label: 'wasm scalar, 1 thread', variant: 'scalar', threads: 1, mode: 'cpu', needs: [] },
  { id: 'webgpu', label: `wasm trace (${HC} threads) + WebGPU raster`, variant: 'threads', threads: HC, mode: 'trace', gpu: 'webgpu', needs: ['threads', 'webgpu'] },
  { id: 'webgl', label: `wasm trace (${HC} threads) + WebGL2 raster`, variant: 'threads', threads: HC, mode: 'trace', gpu: 'webgl', needs: ['threads', 'webgl2'] },
];

// Exposure per scene, as the native stills (wt-pool screenshots/pool/options.txt):
// the luminance `percentile` maps to `gain`.
const LOOK = {
  'pool-rainbow': { percentile: 0.995, gain: 0.25 },
  'pool': { percentile: 0.995, gain: 0.3 },
  'pool-chop': { percentile: 0.995, gain: 0.4 },
  'pool-ripples': { percentile: 0.995, gain: 0.3 },
  'pool-shaft': { percentile: 0.6, gain: 0.05 },
};

const params = new URLSearchParams(location.search);
const status = $('status');
function setStatus(s, err = false) { status.textContent = s; status.classList.toggle('err', err); }
function fail(e) {
  const s = String((e && e.stack) || e);
  console.error('ZPG demo error:', s);
  setStatus(s, true);
}

// Wasm aborts (e.g. a Rust panic in pkg-gpu) surface as uncaught errors.
addEventListener('error', (e) => fail(e.error || e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

// --- feature detection -----------------------------------------------------
async function detect() {
  const f = { threads: self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' };
  try {
    const bytes = await (await fetch('pkg-threads-relaxed/zpg_web_bg.wasm')).arrayBuffer();
    f.relaxed = WebAssembly.validate(bytes);
  } catch (_) { f.relaxed = false; }
  try { f.webgpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch (_) { f.webgpu = false; }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    f.webgl2 = !!(gl && gl.getExtension('EXT_color_buffer_float'));
  } catch (_) { f.webgl2 = false; }
  return f;
}

// --- state -----------------------------------------------------------------
let worker = null, workerKey = '', workerInfo = null;
let gen = 0;
let canvas = null, canvasKind = '', ctx2d = null;
let gpu = null, gpuBackend = '';
let gpuChain = Promise.resolve();
const gpuOp = (f) => (gpuChain = gpuChain.then(f).catch(fail));
let st = null; // per-run stats
let method = null;

function newStats() {
  return {
    t0: 0, total: 0, lines: 0, trace: 0, raster: 0, samples: [], percentile: 0.995, gain: 1,
    k: 0, scale: 0, frozen: false, presentPending: false, gpuPixels: 0, firstFrame: false,
  };
}

function newCanvas(kind) {
  if (canvas) canvas.remove();
  canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  $('stage').prepend(canvas);
  canvasKind = kind;
  ctx2d = kind === '2d' ? canvas.getContext('2d') : null;
}

function loadWorker(m) {
  return new Promise((resolve, reject) => {
    if (worker) worker.terminate();
    worker = new Worker('demo-worker.js', { type: 'module' });
    workerKey = '';
    worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'loaded') {
        workerKey = `${m.variant}:${m.threads}`;
        workerInfo = data;
        worker.onmessage = onWorker;
        worker.onerror = (e) => fail(e.message || 'worker error');
        resolve();
      } else if (data.type === 'error') reject(new Error(data.error));
    };
    worker.postMessage({ type: 'init', variant: m.variant, threads: m.threads });
  });
}

function onWorker({ data: m }) {
  if (m.type === 'error') return fail(m.error);
  if (m.gen !== gen) return;
  const now = performance.now();
  if (m.type === 'started') {
    st.t0 = now; st.percentile = m.percentile; st.gain = m.gain;
    setStatus(`rendering ${$('scene').value} with ${method.label}`);
  } else if (m.type === 'round') {
    st.total = m.total; st.lines += m.segments; st.trace += m.trace_s; st.raster += m.raster_s;
    st.samples.push([now, st.total, st.lines]);
  } else if (m.type === 'frame') {
    ctx2d.putImageData(new ImageData(new Uint8ClampedArray(m.rgba.buffer), W, H), 0, 0);
    st.scale = m.scale; st.frozen = m.fixed;
  } else if (m.type === 'words') {
    const g = m.gen;
    gpuOp(async () => {
      if (g !== gen) return;
      await gpu.retire(2);
      if (g !== gen) return;
      gpu.draw(m.words);
      worker.postMessage({ type: 'ack', gen: g });
      st.total = m.total; st.lines += m.lines; st.trace += m.trace_s;
      st.samples.push([performance.now(), st.total, st.lines]);
      if (!st.firstFrame) { st.firstFrame = true; presentGpu(); }
    });
  }
}

function presentGpu() {
  if (!gpu || !st || st.presentPending || st.total === 0) return;
  st.presentPending = true;
  const g = gen;
  gpuOp(async () => {
    try {
      if (g !== gen) return;
      if (!st.frozen) {
        const q = await gpu.quantile(st.percentile);
        if (g !== gen) return;
        st.scale = q > 0 ? st.gain / q : 0;
        if (st.total >= FREEZE_RAYS && q > 0) { st.k = st.scale * st.total; st.frozen = true; }
      } else st.scale = st.k / st.total;
      gpu.present(st.scale);
      const [, px] = gpu.counts();
      st.gpuPixels = px;
    } finally { st.presentPending = false; }
  });
}

// Serialised restarts (clicks during a slow load queue up; only the last wins).
let startChain = Promise.resolve();
function restart() { startChain = startChain.then(start).catch(fail); }

async function start() {
  const my = ++gen;
  method = METHODS.find((x) => x.id === $('method').value);
  const scene = $('scene').value, roundRays = Number($('round').value);
  st = newStats();
  const key = `${method.variant}:${method.threads}`;
  if (worker) worker.postMessage({ type: 'stop' });
  if (workerKey !== key) {
    setStatus(`loading ${method.label}…`);
    await loadWorker(method);
  } else setStatus('restarting (after the round in progress)…');
  if (my !== gen) return;
  if (method.mode === 'cpu') {
    if (canvasKind !== '2d') { await dropGpu(); newCanvas('2d'); }
    ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, W, H);
  } else {
    if (gpu && gpuBackend === method.gpu) {
      await gpuOp(() => gpu.reset());
    } else {
      await dropGpu();
      newCanvas(method.gpu);
      const pkg = await import('./pkg-gpu/web.js');
      await pkg.default();
      gpu = await pkg.GpuView.create(method.gpu, canvas, W, H);
      gpuBackend = method.gpu;
    }
    if (my !== gen) return;
  }
  st.adapter = gpu && method.mode === 'trace' ? gpu.adapter() : '';
  worker.postMessage({ type: 'start', gen: my, scene, width: W, height: H, roundRays, mode: method.mode, ...LOOK[scene] });
  const u = new URL(location);
  u.searchParams.set('method', method.id); u.searchParams.set('scene', scene); u.searchParams.set('round', roundRays);
  history.replaceState(null, '', u);
}

async function dropGpu() {
  if (!gpu) return;
  await gpuChain;
  try { gpu.free(); } catch (_) {}
  gpu = null; gpuBackend = '';
}

// --- stats display ---------------------------------------------------------
const fmt = (x) => {
  if (!isFinite(x)) return '–';
  if (x >= 1e9) return (x / 1e9).toFixed(2) + ' G';
  if (x >= 1e6) return (x / 1e6).toFixed(2) + ' M';
  if (x >= 1e3) return (x / 1e3).toFixed(1) + ' K';
  return x.toFixed(0) + ' ';
};
function rate(samples, idx, now) {
  // From the newest sample at least 1 s old (or the oldest kept) to the
  // newest; rounds arrive in bursts on the GPU path, so need >= 0.5 s.
  while (samples.length > 2 && now - samples[1][0] >= 1000) samples.shift();
  if (samples.length < 2) return NaN;
  const a = samples[0], b = samples[samples.length - 1];
  return b[0] - a[0] >= 500 ? ((b[idx] - a[idx]) / (b[0] - a[0])) * 1000 : NaN;
}
function tick() {
  if (!st || !method) return;
  const now = performance.now();
  const el = st.t0 ? (now - st.t0) / 1000 : 0;
  $('s-now').textContent = fmt(rate(st.samples, 1, now)) + 'rays/s';
  $('s-avg').textContent = el > 0 && st.total ? fmt(st.total / el) + 'rays/s' : '–';
  $('s-total').textContent = st.total ? fmt(st.total) + 'rays' : '–';
  $('s-elapsed').textContent = el ? el.toFixed(1) + ' s' : '–';
  $('s-lines').textContent = fmt(rate(st.samples, 2, now)) + 'lines/s';
  if (method.mode === 'cpu') {
    $('s-split-k').textContent = 'trace / raster time';
    const t = st.trace + st.raster;
    $('s-split').textContent = t ? `${Math.round((100 * st.trace) / t)}% / ${Math.round((100 * st.raster) / t)}%` : '–';
  } else {
    $('s-split-k').textContent = 'GPU pixel updates/s';
    $('s-split').textContent = el > 0 && st.gpuPixels ? fmt(st.gpuPixels / el) + 'px/s' : '–';
  }
  $('s-method').textContent = method.label;
  $('s-method').title = method.label + (st.adapter ? ` (${st.adapter})` : '');
  const tn = workerInfo ? workerInfo.threads : method.threads;
  $('s-threads').textContent = method.mode === 'trace' ? `${tn} trace + GPU` : `${tn}`;
  $('s-exp').innerHTML = st.scale ? `${st.scale.toExponential(2)} <small>${st.frozen ? 'fixed' : 'auto'}</small>` : '–';
  $('overlay').textContent = `${$('scene').value} · ${st.total ? fmt(st.total) + 'rays' : ''}`;
  if (method.mode === 'trace') presentGpu();
}
setInterval(tick, 250);

// --- init ------------------------------------------------------------------
(async () => {
  const f = await detect();
  window.zpgFeatures = f;
  const sel = $('method');
  for (const m of METHODS) {
    const o = document.createElement('option');
    o.value = m.id;
    const missing = m.needs.filter((n) => !f[n]);
    o.textContent = m.label + (missing.length ? ` (unsupported: ${missing.join(', ')})` : '');
    o.disabled = missing.length > 0;
    sel.appendChild(o);
  }
  const want = params.get('method');
  const pick = METHODS.find((m) => m.id === want && !sel.querySelector(`option[value="${m.id}"]`).disabled)
    || METHODS.find((m) => m.id === 'simd-mt' && f.threads) || METHODS[0];
  sel.value = pick.id;
  if (params.get('scene')) $('scene').value = params.get('scene');
  if (params.get('round')) $('round').value = params.get('round');
  sel.onchange = restart;
  $('scene').onchange = restart;
  $('round').onchange = restart;
  $('restart').onclick = restart;
  restart();
})().catch(fail);

// For automation: window.zpgDemo() returns the live stats.
window.zpgDemo = () => ({ method: method && method.id, gen, ...st, samples: undefined, worker: workerInfo });
