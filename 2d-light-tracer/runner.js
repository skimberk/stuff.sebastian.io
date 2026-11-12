// Runs one wasm variant: load, (thread pool), then `reps` fresh renders.
// Used by worker.js (the default) and by bench.js directly (`main=1`).
// Each render is `rays / ROUND` calls of Bench.render(ROUND) (one renderer
// round each, timed per call to show tier-up), or one call (`single`).
export const ROUND = 131072;

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function measure(name, start, track) {
  // Custom track in the DevTools Performance panel ("Show custom tracks").
  try {
    performance.measure(name, { start, end: performance.now(), detail: { devtools: { track, trackGroup: 'zpg wasm', color: 'primary' } } });
  } catch (_) {}
}

/// Fixed CPU work (a JS xorshift loop, ~10 ms on an M1 P-core once
/// optimised): timed before each round, so slow rounds can be told apart
/// from slow cores (it slows too) vs. unoptimised wasm (it doesn't).
function calibrate() {
  const t = performance.now();
  let x = 1;
  for (let i = 0; i < 2e7; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; }
  return [performance.now() - t, x];
}

/// Self and inclusive sample counts per frame name from a Profiler trace.
function summarize(t) {
  const name = (f) => { const fr = t.frames[f]; return fr.name || `(anonymous ${t.resources[fr.resourceId] || ''}:${fr.line})`; };
  const self = new Map(), incl = new Map();
  for (const s of t.samples) {
    if (s.stackId === undefined) { self.set('(idle/none)', (self.get('(idle/none)') || 0) + 1); continue; }
    let id = s.stackId, first = true;
    const seen = new Set();
    while (id !== undefined) {
      const st = t.stacks[id], n = name(st.frameId);
      if (first) { self.set(n, (self.get(n) || 0) + 1); first = false; }
      if (!seen.has(n)) { incl.set(n, (incl.get(n) || 0) + 1); seen.add(n); }
      id = st.parentId;
    }
  }
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 15);
  return { samples: t.samples.length, frames: t.frames.length, self: top(self), inclusive: top(incl) };
}

export async function runBench(o, post) {
  try {
    const t0 = performance.now();
    const pkg = await import(`./pkg-${o.variant}/zpg_web.js`);
    const t1 = performance.now();
    await pkg.default();
    const t2 = performance.now();
    let poolMs = 0;
    if (pkg.initThreadPool) {
      const tp = performance.now();
      await pkg.initThreadPool(o.threads || navigator.hardwareConcurrency);
      poolMs = performance.now() - tp;
    }
    post({ type: 'loaded', variant: o.variant, features: pkg.features(), threads: pkg.threads(), importMs: t1 - t0, initMs: t2 - t1, poolMs, isolated: self.crossOriginIsolated });
    for (let rep = 0; rep < o.reps; rep++) {
      // `profile`: sample rep 1 (after the warm-up rep) with the JS
      // Self-Profiling API (needs `Document-Policy: js-profiling`; without it,
      // e.g. on static hosts, the constructor throws and profiling is skipped).
      let prof = null;
      if (o.profile && rep === 1 && typeof Profiler !== 'undefined') {
        try { prof = new Profiler({ sampleInterval: 1, maxBufferSize: 1e6 }); } catch (e) { post({ type: 'log', msg: `profile=1 unavailable: ${e}` }); }
      }
      const b = new pkg.Bench(o.scene, o.width, o.height, o.mode === 'mono', 1);
      const rounds = [], cal = [];
      let trace = 0, raster = 0, segments = 0;
      const t = performance.now();
      const calls = o.single ? [o.rays] : Array.from({ length: Math.ceil(o.rays / ROUND) }, (_, i) => Math.min(ROUND, o.rays - i * ROUND));
      for (const n of calls) {
        if (o.cal) cal.push(calibrate()[0]);
        const tr = performance.now();
        const [ts, rs, , segs] = b.render(n);
        measure(`rep ${rep} ${n} rays`, tr, o.variant);
        rounds.push(performance.now() - tr);
        trace += ts; raster += rs; segments += segs;
        // `yield`: return to the event loop between calls (tier-up test).
        if (o.yield) await new Promise((r) => setTimeout(r, 0));
      }
      const total = (performance.now() - t) / 1000;
      const r = { type: 'rep', variant: o.variant, rep, trace, raster, total, raysPerSec: o.rays / total, segments, rounds, cal };
      if (rep === 0 || rep === o.reps - 1) {
        const rgba = b.rgba();
        r.image = { width: o.width, height: o.height, rgba };
        if (o.raw) r.rawHash = fnv1a(new Uint8Array(b.raw().buffer));
      }
      b.free();
      if (prof) post({ type: 'profile', variant: o.variant, ...summarize(await prof.stop()) });
      post(r);
    }
    if (o.events) {
      const json = pkg.trace_json();
      post({ type: 'events', variant: o.variant, json });
    }
    post({ type: 'done', variant: o.variant });
  } catch (e) {
    post({ type: 'error', variant: o.variant, error: String(e && e.stack || e) });
  }
}
