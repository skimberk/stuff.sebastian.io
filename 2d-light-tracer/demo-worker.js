// Live demo worker: loads one wasm variant (with its rayon pool for the
// threaded builds) and renders progressively until told otherwise.
//
// in:  {type:'init', variant, threads}         load the module (once)
//      {type:'start', gen, scene, width, height, roundRays, mode}
//           mode 'cpu':   trace + CPU raster here; posts 'round' per round
//                         and a tone-mapped 'frame' about every 250 ms
//           mode 'trace': trace only; posts each round's packed lines as
//                         'words' (raster-gpu instance format) for the page
//                         to draw on the GPU; at most MAX_OUT unacked
//      {type:'ack', gen}                       one 'words' message drawn
//      {type:'stop'}
// out: {type:'loaded', features, threads} | 'started' | 'round' | 'frame' | 'words' | 'error'
let pkg = null;
let gen = 0;
let cfg = null;
let outstanding = 0;
let ackWaiter = null;
const MAX_OUT = 3;
const FRAME_MS = 250;
// Auto exposure until this many rays, then frozen (scale * rays constant).
const FREEZE_RAYS = 4 * 131072;

// A zero-delay yield to the event loop (so 'start'/'stop' messages get in).
const ch = new MessageChannel();
const yields = [];
ch.port1.onmessage = () => yields.shift()();
const yieldTask = () => new Promise((r) => { yields.push(r); ch.port2.postMessage(0); });

onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      pkg = await import(`./pkg-${m.variant}/zpg_web.js`);
      await pkg.default();
      if (pkg.initThreadPool) await pkg.initThreadPool(m.threads || navigator.hardwareConcurrency);
      postMessage({ type: 'loaded', features: pkg.features(), threads: pkg.threads() });
    } else if (m.type === 'start') {
      gen = m.gen;
      cfg = m;
      outstanding = 0;
      if (ackWaiter) { ackWaiter(); ackWaiter = null; }
      run(m.gen);
    } else if (m.type === 'ack') {
      if (m.gen === gen) outstanding--;
      if (ackWaiter) { ackWaiter(); ackWaiter = null; }
    } else if (m.type === 'stop') {
      gen = -1;
      if (ackWaiter) { ackWaiter(); ackWaiter = null; }
    }
  } catch (e) {
    postMessage({ type: 'error', error: String((e && e.stack) || e) });
  }
};

async function run(my) {
  // Let any earlier loop see the new generation and drop its renderer.
  await yieldTask();
  if (my !== gen) return;
  let demo;
  try {
    demo = new pkg.Demo(cfg.scene, cfg.width, cfg.height, 1);
  } catch (e) {
    postMessage({ type: 'error', error: String((e && e.stack) || e) });
    return;
  }
  const { mode, roundRays } = cfg;
  // Exposure: the page's per-scene look (as the native stills), else the scene's own.
  const percentile = cfg.percentile ?? demo.percentile(), gain = cfg.gain ?? demo.gain();
  postMessage({ type: 'started', gen: my, percentile, gain });
  let lastFrame = -Infinity, k = 0, round = 0;
  try {
    while (my === gen) {
      if (mode === 'trace') {
        if (outstanding >= MAX_OUT) {
          await new Promise((r) => { ackWaiter = r; });
          continue;
        }
        const [trace_s, rays, segments, lines] = demo.trace(roundRays);
        const words = demo.take_words();
        outstanding++;
        postMessage({ type: 'words', gen: my, words, rays, segments, lines, trace_s, total: demo.rays() }, [words.buffer]);
      } else {
        const [trace_s, raster_s, rays, segments] = demo.render(roundRays);
        round++;
        const total = demo.rays();
        postMessage({ type: 'round', gen: my, rays, segments, trace_s, raster_s, total });
        const now = performance.now();
        if (now - lastFrame >= FRAME_MS || round <= 2) {
          lastFrame = now;
          let scale, fixed = k > 0;
          if (fixed) scale = k / total;
          else {
            const q = demo.quantile(percentile);
            scale = q > 0 ? gain / q : 0;
            if (total >= FREEZE_RAYS && scale > 0) { k = scale * total; fixed = true; }
          }
          const rgba = demo.rgba(scale);
          postMessage({ type: 'frame', gen: my, rgba, total, scale, fixed, ms: performance.now() - now }, [rgba.buffer]);
        }
      }
      await yieldTask();
    }
  } finally {
    demo.free();
  }
}
