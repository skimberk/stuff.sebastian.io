// Drives worker.js once per variant (a fresh Worker each, so each variant
// starts with a cold JIT). URL parameters fill the form; `auto=1` runs at
// load. Results: the table, `#log` (JSON lines), `window.zpgResults`, and
// console lines prefixed "ZPG ".
//
// Options: variants, scene, mode (rgb|mono), rays, reps, threads, single
// (one render call), raw (buffer hash), main=1 (main thread, not a Worker),
// yield=1, cal=1 (per-round CPU calibration), profile=1 (JS Self-Profiling
// of rep 1), events=1 (trace-event JSON from *-ev builds).
const form = document.getElementById('f');
const params = new URLSearchParams(location.search);
for (const [k, v] of params) {
  const el = form.elements[k];
  if (el) el.type === 'checkbox' ? (el.checked = v === '1') : (el.value = v);
}
const status = document.getElementById('status');
const tbody = document.querySelector('#results tbody');
const log = document.getElementById('log');
window.zpgResults = [];
window.zpgDone = false;

function record(m) {
  const { image, ...rest } = m;
  window.zpgResults.push(rest);
  log.textContent += JSON.stringify(rest) + '\n';
  console.log('ZPG ' + JSON.stringify(rest));
}

function draw(img) {
  const c = document.getElementById('c');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
}

function runVariant(o) {
  return new Promise((resolve) => {
    // `main=1`: run on this (main) thread instead of a Worker.
    const w = params.get('main') === '1' ? mainThread() : new Worker('worker.js', { type: 'module' });
    let info = {};
    w.onmessage = ({ data: m }) => {
      if (m.type === 'loaded') { info = m; record(m); status.textContent = `${o.variant}: loaded (${m.features}, ${m.threads} threads)`; }
      else if (m.type === 'rep') {
        if (m.image) draw(m.image);
        record(m);
        const r = m.rounds;
        const tr = document.createElement('tr');
        tr.innerHTML = [o.variant, info.features, info.threads, m.rep, m.trace.toFixed(3), m.raster.toFixed(3), m.total.toFixed(3),
          Math.round(m.raysPerSec).toLocaleString(), `${r[0].toFixed(0)} / ${r[r.length - 1].toFixed(0)}`, m.rawHash || ''].map((x) => `<td>${x}</td>`).join('');
        tbody.appendChild(tr);
        status.textContent = `${o.variant}: rep ${m.rep + 1}/${o.reps}`;
      } else if (m.type === 'profile') {
        record(m);
      } else if (m.type === 'events') {
        // Chrome trace-event JSON (trace-events builds): keep it and offer a download.
        window.zpgTrace = window.zpgTrace || {};
        window.zpgTrace[o.variant] = m.json;
        record({ type: 'events', variant: o.variant, bytes: m.json.length });
        if (m.json) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([m.json], { type: 'application/json' }));
          a.download = `zpg-${o.variant}-trace.json`;
          a.textContent = `${o.variant} trace (${(m.json.length / 1024).toFixed(0)} KiB, open in ui.perfetto.dev)`;
          a.style.display = 'block';
          document.getElementById('traces').appendChild(a);
        }
      } else if (m.type === 'error') { record(m); status.textContent = `${o.variant}: ${m.error}`; w.terminate(); resolve(); }
      else if (m.type === 'log') record(m);
      else if (m.type === 'done') { w.terminate(); resolve(); }
    };
    w.onerror = (e) => { record({ type: 'error', variant: o.variant, error: e.message }); w.terminate(); resolve(); };
    w.postMessage(o);
  });
}

// A Worker-like object that runs the benchmark on the main thread.
function mainThread() {
  const w = { onmessage: null, onerror: null, terminate() {} };
  w.postMessage = async (o) => {
    const { runBench } = await import('./runner.js');
    // Let the page repaint between messages.
    await runBench(o, (m) => setTimeout(() => w.onmessage({ data: m }), 0));
  };
  return w;
}

async function run() {
  const f = form.elements;
  window.zpgResults = []; window.zpgDone = false;
  record({ type: 'start', ua: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, isolated: crossOriginIsolated });
  for (const variant of f.variants.value.split(',').map((s) => s.trim()).filter(Boolean)) {
    await runVariant({ variant, scene: f.scene.value, mode: f.mode.value, width: 1024, height: 768,
      rays: Math.round(Number(f.rays.value)), reps: Number(f.reps.value), threads: Number(f.threads.value) || 0,
      single: f.single.checked, raw: f.raw.checked, yield: params.get('yield') === '1', cal: params.get('cal') === '1',
      events: params.get('events') === '1', profile: params.get('profile') === '1' });
  }
  status.textContent = 'done';
  window.zpgDone = true;
  record({ type: 'all-done' });
}

form.onsubmit = (e) => { e.preventDefault(); run(); };
if (params.get('auto') === '1') run();
