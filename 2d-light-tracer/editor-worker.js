// Scene editor render worker (see editor.html / editor.js).
//
// Owns everything heavy: the tracer (a zpg_web wasm build, with its
// wasm-bindgen-rayon pool in the threaded builds) and the raster (pkg-gpu's
// EditorView on the page canvas's OffscreenCanvas: WebGPU, or WebGL2; else
// the CPU raster into a 2D context). The page's main thread only does UI.
//
// Frame loop, driven by requestAnimationFrame in this worker:
//   rAF tick:   poll the GPU (retire rounds, collect timestamps), submit the
//               batch traced during the previous tick into its target, and
//               tone-map to the canvas.
//   next task:  apply the newest scene edit, trace the next batch (the rayon
//               pool runs while this worker waits; the GPU rasterizes the
//               batch just submitted meanwhile).
// So frame N+1 is traced while frame N is rasterized, and the frame is
// committed before tracing starts.
//
// Accumulation targets (4, on the GPU or CPU alike): a static scene
// accumulates in one. While dragging, each frame goes into its own target
// and older frames fade by `decay` per frame (0: none shown), normalised
// by their decayed rays. When the scene stops changing, the newest frame's
// target simply becomes the accumulation (no copy, no reset); a discrete
// edit resets.
//
// Ray limit: once a static scene has `limit` rays the loop stops tracing and
// submitting, and goes idle (no rAF) until a message needs it. It also
// idles while the page is hidden.
//
// in:  {type:'init', canvas, variant, threads, raster, width, height, desc, look, settings}
//      {type:'scene', desc, interactive}   interactive: a drag frame (decay blend) instead of reset
//      {type:'exposure', auto, ev}
//      {type:'settings', settings}         see `settings`
//      {type:'visible', visible}
// out: {type:'ready', ...} | {type:'stats', ...} | {type:'error', error}
//      {type:'sensor', bins, rays, data, rev, dragging}   camera scenes (see sensorTick)

let trace = null, demo = null, mem = null, gpuMem = null;
let gpu = null, raster = '', ctx2d = null;
let W = 1280, H = 720;
const settings = {
  decay: 0, // history kept per frame while dragging (0: the current frame only)
  limit: 2e6, // rays per static scene, then idle (0: unlimited)
  headroom: 0.75, // share of the frame the tracer may use (adapted)
  // Dense media trace hundreds of lines per ray (milk ~95; a trapping disc
  // ~800), so the floor is low.
  minRays: 16,
  maxRays: 1 << 21,
  // Caps per traced batch (Demo.set_frame_caps): lines (28 bytes each in
  // the words buffer, and again in the GPU module's copy) and trace ms (as a
  // share of the frame: the controller's own budget, so it binds only when
  // the per-ray estimate is stale, e.g. right after vacuum -> milk). The
  // traced rays stay whole rays chosen before tracing: no bias.
  maxLines: 1e6,
  traceCap: 1.0,
  // Segment cap per ray in drag frames (the scene's own, 65536 with media,
  // otherwise): one ray at 65536 segments costs ~100 ms in wasm. Cut paths
  // lose their light, so a still image that starts from a drag frame with
  // cut rays starts over instead (see prepare('settle')). 0: no drag cap.
  dragSegments: 2048,
  fixedRays: 0, // >0: no controller
  debug: false, // barcode of the scene revision / frame in the image; log backwards presents
  lag: 0, // ms a traced batch is held before it is drawn (latency test)
  // Frames queued on the GPU before the next is submitted. Each present
  // queues behind them, so a deep queue adds latency and lets a browser's
  // canvas texture pool turn over while presents are pending.
  maxInFlight: 2,
  alwaysPresent: false, // tone-map every tick, not only when the image changed
  presentWait: false, // present only once the previous present's GPU work is done
  targetMs: 1000 / 60,
};
const look = { percentile: 0.995, gain: 1.0 };
const exposure = { auto: true, ev: 0 };

const post = (m, t) => postMessage(m, t || []);
const fail = (e) => post({ type: 'error', error: String((e && e.stack) || e) });
addEventListener('error', (e) => fail(e.error || e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

// --- scene / accumulation state ----------------------------------------------
let pendingDesc = null, pendingInteractive = false, forceReset = false, pendingRev = 0;
let curDesc = null;
let outCanvas = null, bitmapMode = false;
// 'bitmap' mode: hand the frame just rendered to the page, as a snapshot
// (createImageBitmap: Firefox's WebGPU context is lost after
// transferToImageBitmap). Snapshots resolve asynchronously, so they carry a
// sequence number and the page drops any older than one it has shown.
let bitmapSeq = 0, bitmapsPending = 0;
function postBitmap() {
  if (!bitmapMode) return;
  const seq = ++bitmapSeq;
  bitmapsPending++;
  createImageBitmap(outCanvas).then((bmp) => {
    bitmapsPending--;
    post({ type: 'frame', bitmap: bmp, seq }, [bmp]);
  }, (e) => { bitmapsPending--; fail(e); });
}
// Scene revisions (the page numbers its edits): of the scene being traced,
// of the newest batch drawn, and of the last frame presented. Batches are
// traced, drawn and presented in order, so these must never go backwards.
let curRev = 0, drawnRev = 0, presentedRev = 0, presents = 0, backwards = 0;
function checkPresent() {
  presents++;
  if (drawnRev < presentedRev) {
    backwards++;
    if (settings.debug) post({ type: 'debug', msg: `backwards present: rev ${drawnRev} after ${presentedRev} (frame ${presents})` });
  }
  presentedRev = drawnRev;
  if (gpu) gpu.set_debug(drawnRev, settings.debug ? presents : -1);
}
let power = 0; // total light power of the current scene
let accRays = 0; // rays in the displayed image (decay-weighted while dragging)
let totalRays = 0; // rays traced since load
let K = 0; // exposure constant: display scale = K * power / accRays * 2^ev
let frameNo = 0;
// The batch traced for the next tick: {rays, lines, ptr, len, kind}
let batch = null;
let traceScheduled = false;
let dirty = true; // needs a present
let done = false, doneAt = 0; // ray limit reached (static scene)
let paused = false; // page hidden
let running = false; // rAF loop active

// Targets: the raster draws into `cur`; the image is sum(weights[i] * target i).
// A still scene accumulates in one target. While dragging, each frame goes
// into a fresh target and the previous frame is folded into a decayed
// history target (hist = decay * (hist + previous frame)), so the image is
// frame + decay * frame_-1 + decay^2 * frame_-2 + ... (decay 0: the current
// frame only). Rays are tracked the same way and normalise the exposure, so
// brightness does not jump. When the scene stops changing, the newest frame
// becomes the accumulation (no reset, no ghosts).
const T = 4;
const tg = { cur: 0, mode: 'accum', rays: new Array(T).fill(0), weights: [1, 0, 0, 0], hist: -1, prev: -1, cut: new Array(T).fill(false) };
const R = {
  select(i) { if (raster === 'cpu') demo.select(i); else gpu.select(i); tg.cur = i; },
  clear() { if (raster === 'cpu') demo.clear(); else gpu.clear(); tg.rays[tg.cur] = 0; tg.cut[tg.cur] = false; },
  fold(dst, src, d) { if (raster === 'cpu') demo.fold(dst, src, d); else gpu.fold(dst, src, d); },
  weights(w) { tg.weights = w; if (raster !== 'cpu') gpu.set_weights(new Float32Array(w)); },
};
const sumRays = () => tg.weights.reduce((a, w, i) => a + w * tg.rays[i], 0);
const only = (i) => tg.weights.map((_, j) => (j === i ? 1 : 0));
// Set up the target for a batch of kind 'reset' | 'drag' | 'settle' | 'plain'.
function prepare(kind) {
  if (kind === 'reset') {
    tg.mode = 'accum';
    R.clear();
    R.weights(only(tg.cur));
  } else if (kind === 'drag') {
    const d = Math.max(0, Math.min(0.95, settings.decay));
    if (tg.mode !== 'drag') { tg.mode = 'drag'; tg.hist = -1; tg.prev = -1; }
    else if (d > 0 && tg.prev >= 0) {
      if (tg.hist < 0) {
        tg.hist = [0, 1, 2, 3].find((i) => i !== tg.prev);
        R.select(tg.hist);
        R.clear();
      }
      R.fold(tg.hist, tg.prev, d);
      tg.rays[tg.hist] = d * (tg.rays[tg.hist] + tg.rays[tg.prev]);
    }
    const i = [0, 1, 2, 3].find((j) => j !== tg.hist && j !== tg.prev);
    R.select(i);
    R.clear();
    tg.prev = i;
    R.weights(tg.weights.map((_, j) => (j === i || (j === tg.hist && d > 0) ? 1 : 0)));
  } else if (kind === 'settle' && tg.mode === 'drag') {
    // Released without a further change: the newest frame (same scene)
    // becomes the accumulation; the trail is dropped. If the drag segment
    // cap cut rays in it, it starts over (unbiased still image).
    tg.mode = 'accum';
    if (tg.cut[tg.cur]) R.clear();
    R.weights(only(tg.cur));
  }
  // ('plain' while dragging: the scene did not change since the last frame,
  // so the rays add to the current frame and the trail stays.)
  accRays = sumRays();
}
function added(rays, cut) { tg.rays[tg.cur] += rays; if (cut) tg.cut[tg.cur] = true; accRays = sumRays(); }

// --- adaptive ray budget -------------------------------------------------------
const ctl = {
  n: 16384,
  cTrace: 0, // EMA ms per ray (trace + pack)
  cGpu: 0, // EMA ms per ray (GPU timestamps)
  cDraw: 0, // EMA ms per ray of the line upload in the tick (gpu.draw)
  lastDrop: 0,
  misses: [],
  // Per-ray costs: EMA of each batch's ms/ray, each sample clamped to
  // 0.5-2x the estimate (one hitch must not collapse the budget). Every
  // batch counts, however small: an estimate that stopped updating at a low
  // budget would pin it there.
  ema(c0, c) { return c0 ? c0 + 0.25 * (Math.min(2 * c0, Math.max(0.5 * c0, c)) - c0) : c; },
  observeTrace(ms, rays, capped) {
    if (!(rays > 0) || !(ms > 0)) return;
    // A batch the trace cap cut short measured the new cost directly (it
    // used the whole cap): take it at once, so the budget follows a jump in
    // cost (vacuum -> milk) within a frame instead of 2x per frame.
    // (At most 8x per batch: one hitch of a loaded machine shouldn't
    // collapse the budget for long.)
    if (capped) this.cTrace = this.cTrace ? Math.max(this.cTrace, Math.min(8 * this.cTrace, ms / rays)) : ms / rays;
    else if (rays >= 16) this.cTrace = this.ema(this.cTrace, ms / rays);
  },
  observeDraw(ms, rays) {
    if (rays < 16 || !(ms >= 0)) return;
    this.cDraw = this.cDraw ? this.cDraw + 0.25 * (Math.min(2 * this.cDraw, Math.max(0.5 * this.cDraw, ms / rays + 1e-6)) - this.cDraw) : ms / rays + 1e-6;
  },
  observeGpu(ms, rays) {
    if (rays < 16 || !(ms > 0)) return;
    this.cGpu = this.ema(this.cGpu, ms / rays);
  },
  limit: Infinity, // AIMD cap from late frames (covers costs the model can't see, e.g. WebGL)
  update(now) {
    if (settings.fixedRays > 0) { this.n = settings.fixedRays; return; }
    const F = settings.targetMs;
    // Model: the tracer may use `headroom` of the frame, the GPU 80% of it.
    // (The tick's line upload counts with the tracer: same thread, and its
    // cost per ray grows with lines per ray like tracing does.)
    let target = this.cTrace ? (settings.headroom * F) / (this.cTrace + this.cDraw) : this.n * 1.5;
    if (this.cGpu) target = Math.min(target, (0.8 * F) / this.cGpu);
    // Feedback: two late frames in a row (> 1.3 intervals) cap the budget at
    // 80% of the current one and trim the tracer's share; after 1.5 s on
    // time the cap rises 2% per frame (until it no longer binds).
    // `misses`: recent ticks, 1 = no new frame (GPU backlog or trace not
    // done) or late by > 30%. Two in a row, or 4 of the last 30, count.
    const ms = this.misses, nm = ms.reduce((a, b) => a + b, 0);
    if ((ms.length >= 2 && ms[ms.length - 1] && ms[ms.length - 2]) || nm >= 4) {
      this.limit = Math.max(settings.minRays, Math.min(this.limit, this.n) * 0.8);
      settings.headroom = Math.max(0.5, settings.headroom * 0.97);
      this.lastDrop = now;
      ms.length = 0;
    } else if (now - this.lastDrop > 1500) {
      if (this.limit < Infinity) this.limit = this.limit > 4 * target ? Infinity : this.limit * 1.02;
      if (settings.headroom < 0.75 && now - this.lastDrop > 3000) settings.headroom = Math.min(0.75, settings.headroom + 0.002);
    }
    target = Math.min(target, this.limit);
    const r = target / this.n;
    // Grow gently (10%/frame), cut fast (to the target at once: the cost
    // samples are already clamped, except a capped batch's); ignore +-5%
    // wobble.
    if (r > 1.05) this.n *= Math.min(r, 1.1);
    else if (r < 0.95) this.n *= r;
    this.n = Math.round(Math.min(settings.maxRays, Math.max(settings.minRays, this.n)));
  },
};

// --- stats -----------------------------------------------------------------------
// Per-tick log for automation (web/editor-perf.py): [interval ms, drew 0/1,
// rays, lines, trace ms, draw ms, set_scene ms, capped, tick ms], flattened,
// posted with the stats.
const tickLog = [], TL = 9;
const st = { capped: 0, frames: 0, rays: 0, traceMs: 0, gpuMs: 0, gpuN: 0, doneMs: 0, lines: 0, steps: 0, t0: performance.now(), frameMs: 0, presentMs: 0, maxIv: 0 };
function postStats(now, final = false) {
  const dt = (now - st.t0) / 1000;
  if (dt < 0.25 && !final) return;
  post({
    type: 'stats',
    done,
    idle: final,
    rayLimit: settings.limit,
    dragging: tg.mode === 'drag',
    rev: presentedRev,
    presents,
    backwards,
    fps: st.frames / dt,
    raysPerFrame: st.frames ? st.rays / st.frames : 0,
    raysPerSec: st.rays / dt,
    traceMs: st.frames ? st.traceMs / st.frames : 0,
    gpuMs: st.gpuN ? st.gpuMs / st.gpuN : 0,
    doneMs: st.gpuN ? st.doneMs / st.gpuN : 0,
    linesPerSec: st.lines / dt,
    gpxPerSec: (2 * st.steps) / dt,
    maxIv: st.maxIv,
    budget: ctl.n,
    limit: ctl.limit,
    presentMs: st.presentMs,
    headroom: settings.headroom,
    cTrace: ctl.cTrace,
    cGpu: ctl.cGpu,
    accRays,
    totalRays,
    K,
    scale: currentScale(),
    auto: exposure.auto,
    inFlight: lastInFlight,
    ticks: tickLog.splice(0),
    capped: st.capped,
    cDraw: ctl.cDraw,
    memMB: mem ? mem.buffer.byteLength / 1048576 : 0,
    gpuMemMB: gpuMem ? gpuMem.buffer.byteLength / 1048576 : 0,
  });
  Object.assign(st, { capped: 0, frames: 0, rays: 0, traceMs: 0, gpuMs: 0, gpuN: 0, doneMs: 0, lines: 0, steps: 0, t0: now, maxIv: 0 });
}

function currentScale() {
  if (!(accRays > 0) || !(power > 0) || !(K > 0)) return 0;
  return ((K * power) / accRays) * 2 ** exposure.ev;
}

// --- exposure ------------------------------------------------------------------
// Auto exposure maps the luminance `percentile` of the image to `gain`:
// K_target = gain * accRays / (q * power), smoothed in log space with a
// dead band, so it neither flickers with noise nor jumps on edits. Both the
// probe and the display use the same (decay-weighted) rays,
// so brightness does not jump between drag and release.
let probeAt = 0, probeRays = 0, probePending = false, expSettled = false;
function exposureTick(now) {
  if (!exposure.auto && K > 0) return;
  // Held while dragging: single (noisy) frames must not make it flicker;
  // the ray normalisation keeps the brightness right meanwhile.
  if (tg.mode === 'drag' && K > 0) return;
  if (raster === 'cpu') {
    if (now - probeAt < 250 || !(accRays > 0)) return;
    probeAt = now;
    feedQuantile(demo.quantile_sum(look.percentile, new Float32Array(tg.weights)), accRays);
    return;
  }
  if (probePending) {
    const r = gpu.probe_result(new Float32Array([look.percentile]));
    if (r.length) {
      probePending = false;
      feedQuantile(r[0], probeRays);
    }
  } else if (now - probeAt >= 150 && accRays > 0) {
    probeAt = now;
    if (gpu.probe_start()) { probePending = true; probeRays = accRays; }
  }
}
function feedQuantile(q, rays) {
  if (!(q > 0) || !(power > 0)) return;
  const kTarget = (look.gain * rays) / (q * power);
  if (!(K > 0)) { K = kTarget; dirty = true; expSettled = false; return; }
  const d = Math.log(kTarget / K);
  // Fast while far off (a new preset), slow and dead-banded near the target.
  expSettled = Math.abs(d) < 0.04;
  if (expSettled) return;
  const a = Math.abs(d) > 1 ? 0.5 : 0.12;
  K *= Math.exp(a * d);
  dirty = true;
}

// --- frame loop ------------------------------------------------------------------
const raf = self.requestAnimationFrame ? (f) => self.requestAnimationFrame(f) : (f) => setTimeout(() => f(performance.now()), 16);
const ch = new MessageChannel();
ch.port1.onmessage = () => { traceScheduled = false; try { traceTask(); } catch (e) { fail(e); } };
const scheduleTrace = () => { if (!traceScheduled) { traceScheduled = true; ch.port2.postMessage(0); } };

// Start the loop if it is idle (a message needs a frame).
function wake() {
  if (running || paused || !demo) return;
  running = true;
  lastTick = 0;
  st.t0 = performance.now(); st.frames = 0; st.rays = 0;
  raf(tick);
}

let lastTick = 0, lastInFlight = 0, lastPresent = 0;
const gpuRays = [];
let drawMs = 0, drawnBatch = null;
function tick(now) {
  try {
    drawnBatch = null;
    if (paused) { running = false; postStats(now, true); return; }
    // At most ~60 frames/s on faster displays.
    if (lastTick && now - lastTick < settings.targetMs * 0.75) { raf(tick); return; }
    const iv = lastTick ? now - lastTick : 0;
    lastTick = now;
    frameNo++;
    let drew = false;
    const held = !!(batch && settings.lag > 0 && now - batch.t < settings.lag); // lag= test hold: not a miss
    if (raster !== 'cpu') {
      const p = gpu.poll();
      lastInFlight = p[0];
      if (p[1] > 0) {
        st.gpuN += p[1]; st.gpuMs += p[2]; st.doneMs += p[4]; st.lines += p[5]; st.steps += p[6];
        // GPU time per ray of the rounds just finished (their rays are in
        // `gpuRays`, oldest first).
        let rays = 0;
        for (let i = 0; i < p[1] && gpuRays.length; i++) rays += gpuRays.shift();
        if (gpu.timestamps()) ctl.observeGpu(p[2], rays);
      }
      exposureTick(now);
      if (batch && lastInFlight < settings.maxInFlight && !(settings.lag > 0 && now - batch.t < settings.lag)) {
        prepare(batch.kind);
        drawnRev = Math.max(drawnRev, batch.rev);
        if (batch.rev < drawnRev && settings.debug) post({ type: 'debug', msg: `stale batch: rev ${batch.rev} < ${drawnRev}` });
        const td = performance.now();
        if (batch.len) {
          gpu.draw(new Uint32Array(mem.buffer, batch.ptr, batch.len));
          gpuRays.push(batch.rays);
        }
        drawMs = performance.now() - td;
        ctl.observeDraw(drawMs, batch.rays);
        drawnBatch = batch;
        // debug=1: the batch marks its revision into its own target, weighted
        // by its rays, so the presented pixels show which batches they hold
        // (set cells at 2x white: saturated, robust to stray light; see
        // EditorView.mark).
        if (settings.debug && K > 0 && power > 0 && batch.rays > 0) gpu.mark(batch.rev & 0xffffff, (batch.rays * 2) / (K * power * 2 ** exposure.ev));
        added(batch.rays, batch.cut > 0);
        st.frames++; st.rays += batch.rays;
        if (iv) st.maxIv = Math.max(st.maxIv, iv);
        drew = true;
        batch = null;
        dirty = true;
      }
      if ((dirty || settings.alwaysPresent) && !(settings.presentWait && !gpu.present_done())) {
        checkPresent();
        gpu.present(currentScale());
        postBitmap();
        dirty = false;
      }
    } else {
      exposureTick(now);
      if (batch) {
        st.frames++; st.rays += batch.rays;
        if (iv) st.maxIv = Math.max(st.maxIv, iv);
        drew = true;
        batch = null;
        dirty = true;
      }
      // The CPU tone map is slow at 720p: at most ~20 presents/s if it costs > 4 ms.
      if (dirty && (now - lastPresent >= (st.presentMs > 4 ? 48 : 0) || done)) {
        const t = performance.now();
        if (accRays > 0) {
          const rgba = demo.rgba_sum(currentScale(), new Float32Array(tg.weights));
          ctx2d.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), W, H), 0, 0);
        } else { ctx2d.fillStyle = '#000'; ctx2d.fillRect(0, 0, W, H); }
        checkPresent();
        if (settings.debug) barcode2d(drawnRev, presents);
        postBitmap();
        st.presentMs = performance.now() - t;
        lastPresent = now;
        dirty = false;
      }
    }
    const b = drawnBatch;
    if (iv) tickLog.push(iv, b ? 1 : 0, b ? b.rays : 0, b ? b.lines : 0, b ? b.ms : 0, b ? drawMs : 0, b ? b.setMs : 0, b ? b.capped : 0, performance.now() - now);
    if (tickLog.length > TL * 2000) tickLog.splice(0, TL * 1000);
    if (iv && !done && !held) { ctl.misses.push(!drew || iv > 1.3 * settings.targetMs ? 1 : 0); if (ctl.misses.length > 30) ctl.misses.shift(); }
    ctl.update(now);
    if (!batch && !done) scheduleTrace();
    // Idle once the limit is reached and nothing else needs a frame (the
    // GPU drained, the exposure settled, the last image presented).
    // (Auto exposure gets up to 3 s more to settle on the final image.)
    const busy = !done || batch || dirty || traceScheduled || lastInFlight > 0 || probePending
      || (exposure.auto && !expSettled && now - doneAt < 3000);
    if (busy) {
      postStats(now);
      raf(tick);
    } else {
      running = false;
      postStats(now, true);
    }
  } catch (e) {
    running = false;
    fail(e);
  }
}

function traceTask() {
  if (batch) return;
  let setMs = 0;
  let kind = 'plain';
  if (pendingDesc) {
    const same = curDesc && curDesc.length === pendingDesc.length && curDesc.every((v, i) => v === pendingDesc[i]);
    if (!same) {
      const t0 = performance.now();
      power = demo.set_scene(pendingDesc);
      setMs = performance.now() - t0;
      curDesc = pendingDesc;
      curRev = pendingRev;
      kind = pendingInteractive ? 'drag' : 'reset';
    } else if (!pendingInteractive) kind = 'settle';
    pendingDesc = null;
  }
  if (forceReset) { kind = 'reset'; forceReset = false; }
  // The ray limit applies to a static (accumulating) scene.
  const limit = settings.limit > 0 ? settings.limit : Infinity;
  // Rays the static scene's accumulation will hold before this batch
  // (-1: a drag frame, never limited).
  let accumulating = -1;
  if (kind === 'reset') accumulating = 0;
  else if (kind === 'settle') accumulating = tg.mode === 'drag' ? (tg.cut[tg.cur] ? 0 : tg.rays[tg.cur]) : accRays;
  else if (kind === 'plain') accumulating = tg.mode === 'drag' ? -1 : accRays;
  let n = ctl.n;
  if (accumulating >= 0) {
    if (accumulating >= limit) { if (!done) { doneAt = performance.now(); sensorTick(true, false); } done = true; return; }
    n = Math.max(1, Math.min(n, Math.ceil(limit - accumulating)));
  }
  done = false;
  const t = performance.now();
  if (raster === 'cpu') {
    prepare(kind);
    const r = demo.render(n);
    const ms = performance.now() - t;
    added(r[2]); totalRays += r[2];
    ctl.observeTrace(ms, r[2]);
    st.traceMs += ms;
    drawnRev = Math.max(drawnRev, curRev); // CPU: rendered right here
    batch = { rays: r[2], rev: curRev, t: performance.now() };
    sensorTick(false, tg.mode === 'drag');
    return;
  }
  // Drag frames (and unchanged batches mid-drag) trace with the drag cap.
  const dragging = kind === 'drag' || (kind === 'plain' && tg.mode === 'drag');
  // The tick clears the target for this batch (prepare: a reset, or a
  // settle whose drag frame the segment cap cut); the sensor starts over
  // with it, so it holds the same rays as the image (set_scene already
  // reset it for a new scene).
  if (kind === 'reset' || (kind === 'settle' && tg.mode === 'drag' && tg.cut[tg.cur])) demo.clear_sensor?.();
  demo.set_segment_cap(dragging ? settings.dragSegments : 0);
  demo.set_frame_caps(settings.maxLines, settings.fixedRays > 0 ? 0 : settings.traceCap * settings.headroom * settings.targetMs);
  const r = demo.trace(n);
  const at = demo.words_at();
  const ms = performance.now() - t;
  st.capped += r[4] || 0;
  ctl.observeTrace(ms, r[1], r[4] > 0);
  st.traceMs += ms;
  totalRays += r[1];
  batch = { rays: r[1], lines: r[3], ptr: at[0], len: at[1], kind, rev: curRev, t: performance.now(), ms, cut: r[5] || 0, setMs, capped: r[4] || 0 };
  sensorTick(false, dragging);
}

// --- sensor readout (camera scenes; CONTRACT.md) ---------------------------------
// After a trace, post the sensor's bins (linear RGB sums since the wasm's
// last reset: set_scene / clear) at most every 50 ms (every frame while
// dragging), and once more when
// the ray limit is reached. While dragging, each frame is a new scene, so
// a readout holds that frame's rays only. Older wasm builds have no sensor.
let sensorAt = 0, sensorBinsWas = 0;
function sensorTick(force, dragging) {
  if (!demo || typeof demo.sensor_bins !== 'function') return;
  const bins = demo.sensor_bins();
  if (!bins) {
    if (sensorBinsWas) post({ type: 'sensor', bins: 0 });
    sensorBinsWas = 0;
    return;
  }
  const now = performance.now();
  if (!force && !dragging && sensorBinsWas === bins && now - sensorAt < 50) return; // every drag frame (the page keeps a short trail)
  sensorAt = now;
  sensorBinsWas = bins;
  const data = demo.sensor();
  post({ type: 'sensor', bins, rays: demo.sensor_rays(), data, rev: curRev, dragging }, data.buffer instanceof ArrayBuffer ? [data.buffer] : []);
}

// --- messages --------------------------------------------------------------------
onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'scene') {
      pendingDesc = m.desc;
      pendingRev = m.rev || 0;
      pendingInteractive = !!m.interactive;
      if (m.look) Object.assign(look, m.look);
      if (m.resetExposure) { K = 0; expSettled = false; }
      done = false;
      wake();
    } else if (m.type === 'exposure') {
      exposure.auto = m.auto;
      exposure.ev = m.ev;
      expSettled = false;
      if (done) doneAt = performance.now();
      dirty = true; // re-tone-map (no more tracing if the limit is reached)
      wake();
    } else if (m.type === 'settings') {
      Object.assign(settings, m.settings);
      if (m.settings.passSteps && gpu) gpu.set_pass_steps(m.settings.passSteps);
      done = false; // a raised limit resumes; traceTask re-checks
      wake();
    } else if (m.type === 'visible') {
      paused = !m.visible;
      if (!paused) wake();
    }
  } catch (e) {
    fail(e);
  }
};

async function init(m) {
  W = m.width; H = m.height;
  Object.assign(settings, m.settings || {});
  Object.assign(look, m.look || {});
  const t0 = performance.now();
  trace = await import(`./pkg-${m.variant}/zpg_web.js`);
  await trace.default();
  let threads = 1;
  if (trace.initThreadPool) { await trace.initThreadPool(m.threads); threads = trace.threads(); }
  mem = trace.linear_memory();
  const tLoad = performance.now() - t0;
  demo = trace.Demo.editor(m.desc, W, H, 1);
  power = demo.power();
  // 'bitmap' presentation: render into our own OffscreenCanvas and post each
  // frame to the page as an ImageBitmap (see editor.js).
  bitmapMode = m.present === 'bitmap';
  outCanvas = bitmapMode ? new OffscreenCanvas(W, H) : m.canvas;
  // Raster: what the page asked for, falling back WebGPU -> WebGL2 -> CPU.
  // (The canvas can get only one kind of context, so check before creating.)
  let want = m.raster, note = '';
  if (want === 'webgpu' && !(await webgpuOk())) { note += 'WebGPU unavailable (or no float32-blendable); '; want = 'webgl'; }
  if (want === 'webgl' && !webglOk()) { note += 'WebGL2 float blending unavailable; '; want = 'cpu'; }
  let adapter = '';
  if (want !== 'cpu') {
    try {
      const g = await import('./pkg-gpu/web.js');
      gpuMem = (await g.default()).memory;
      gpu = await g.EditorView.create(want, outCanvas, W, H);
      adapter = gpu.adapter().replace(/^\S+\s*/, '').trim() || adapterName;
    } catch (e) {
      note += `${want} raster failed (${e}); `;
      throw new Error(note + ' (the canvas is taken; reload with raster=cpu)');
    }
  } else {
    outCanvas.width = W; outCanvas.height = H;
    ctx2d = outCanvas.getContext('2d');
  }
  raster = want;
  post({
    type: 'ready', raster, adapter, note, threads, ua: navigator.userAgent, features: trace.features(), variant: m.variant, sceneNames: trace.scene_names().split(','),
    timestamps: gpu ? gpu.timestamps() : false, loadMs: tLoad, rafWorker: !!self.requestAnimationFrame, sensor: typeof demo.sensor_bins === 'function',
  });
  curDesc = m.desc;
  if (m.visible === false) paused = true;
  wake();
}

// The debug barcode on the CPU raster's 2D canvas (as the GPU tone map's).
function barcode2d(rev, frame) {
  // The content marker row (rendered synchronously here, so the drawn
  // revision is the content's): cell 0 always, then the revision bits.
  for (let c = 0; c < 25; c++) {
    ctx2d.fillStyle = c === 0 || (rev >> (24 - c)) & 1 ? '#fff' : '#000';
    ctx2d.fillRect(4 + 12 * c, 34, 10, 10);
  }
  for (let row = 0; row < 2; row++) {
    const v = (row ? frame : rev) & 0xffffff;
    for (let c = 0; c < 24; c++) {
      ctx2d.fillStyle = (v >> (23 - c)) & 1 ? '#fff' : '#333';
      ctx2d.fillRect(4 + 12 * c, 4 + 12 * row, 10, 10);
    }
  }
}

let adapterName = '';
async function webgpuOk() {
  try {
    if (!navigator.gpu) return false;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const i = a && a.info;
    if (i) adapterName = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
    return !!a && a.features.has('float32-blendable');
  } catch (_) { return false; }
}
function webglOk() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    return !!(gl && gl.getExtension('EXT_color_buffer_float') && gl.getExtension('EXT_float_blend'));
  } catch (_) { return false; }
}
