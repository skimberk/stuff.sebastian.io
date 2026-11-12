/* @ts-self-types="./zpg_web.d.ts" */

/**
 * A renderer for one scene and image size.
 */
export class Bench {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BenchFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_bench_free(ptr, 0);
    }
    /**
     * `scene` is a `zpg --scene` name; `mono` uses a 1-channel buffer.
     * @param {string} scene
     * @param {number} width
     * @param {number} height
     * @param {boolean} mono
     * @param {number} seed
     */
    constructor(scene, width, height, mono, seed) {
        const val2 = +width;
        const val3 = +height;
        const val4 = +mono;
        const val5 = +seed;
        const ptr0 = passStringToWasm0(scene, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.bench_new(ptr0, len0, val2, val3, val4, val5);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        BenchFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The raw accumulation buffer: `width * height * C` floats, row-major
     * (as `examples/dump_raw`), for bit-identity checks against native.
     * @returns {Float32Array}
     */
    raw() {
        const ret = wasm.bench_raw(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Trace `rays` more rays. Returns `[trace_s, raster_s, rays, segments]`.
     * @param {number} rays
     * @returns {Float64Array}
     */
    render(rays) {
        const ret = wasm.bench_render(this.__wbg_ptr, rays);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tone-mapped RGBA8 image (for `ImageData`).
     * @returns {Uint8Array}
     */
    rgba() {
        const ret = wasm.bench_rgba(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Bench.prototype[Symbol.dispose] = Bench.prototype.free;

/**
 * A progressive spectral renderer for the live demo.
 */
export class Demo {
    static __wrap(ptr) {
        const obj = Object.create(Demo.prototype);
        obj.__wbg_ptr = ptr;
        DemoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DemoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_demo_free(ptr, 0);
    }
    /**
     * The scene's auto exposure for the current buffer: `gain / q`, where
     * `q` is the scene's luminance percentile (0 if the buffer is black).
     * @returns {number}
     */
    auto_scale() {
        const ret = wasm.demo_auto_scale(this.__wbg_ptr);
        return ret;
    }
    /**
     * Empty the CPU buffer and the ray count.
     */
    clear() {
        wasm.demo_clear(this.__wbg_ptr);
    }
    /**
     * Start the sensor accumulation over (the GPU raster's targets are
     * cleared outside the renderer: the editor calls this with them).
     */
    clear_sensor() {
        wasm.demo_clear_sensor(this.__wbg_ptr);
    }
    /**
     * Objects (segments, arcs, shapes) and lights in the scene.
     * @returns {Float64Array}
     */
    counts() {
        const ret = wasm.demo_counts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * A renderer for the scene editor: `desc` is a flat scene description
     * (see `editor.rs`).
     * @param {Float32Array | number[]} desc
     * @param {number} width
     * @param {number} height
     * @param {number} seed
     * @returns {Demo}
     */
    static editor(desc, width, height, seed) {
        const val2 = +width;
        const val3 = +height;
        const val4 = +seed;
        const ptr0 = passArrayF32ToWasm0(desc, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.demo_editor(ptr0, len0, val2, val3, val4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Demo.__wrap(ret[0]);
    }
    /**
     * CPU raster: `target[dst] = d * (target[dst] + target[src])` (fold a
     * finished drag frame into the decayed history).
     * @param {number} dst
     * @param {number} src
     * @param {number} d
     */
    fold(dst, src, d) {
        wasm.demo_fold(this.__wbg_ptr, dst, src, d);
    }
    /**
     * @returns {number}
     */
    gain() {
        const ret = wasm.demo_gain(this.__wbg_ptr);
        return ret;
    }
    /**
     * Memory held by the tracer: `[chunk line capacity, chunks, packed
     * word capacity]` (lines, -, words).
     * @returns {Float64Array}
     */
    mem_stats() {
        const ret = wasm.demo_mem_stats(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @param {string} scene
     * @param {number} width
     * @param {number} height
     * @param {number} seed
     */
    constructor(scene, width, height, seed) {
        const val2 = +width;
        const val3 = +height;
        const val4 = +seed;
        const ptr0 = passStringToWasm0(scene, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.demo_new(ptr0, len0, val2, val3, val4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        DemoFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    percentile() {
        const ret = wasm.demo_percentile(this.__wbg_ptr);
        return ret;
    }
    /**
     * Total light power of the scene.
     * @returns {number}
     */
    power() {
        const ret = wasm.demo_power(this.__wbg_ptr);
        return ret;
    }
    /**
     * The luminance `p`-quantile of the current buffer.
     * @param {number} p
     * @returns {number}
     */
    quantile(p) {
        const ret = wasm.demo_quantile(this.__wbg_ptr, p);
        return ret;
    }
    /**
     * Luminance `p`-quantile of the weighted sum (every 7th pixel).
     * @param {number} p
     * @param {Float32Array | number[]} w
     * @returns {number}
     */
    quantile_sum(p, w) {
        const val2 = +p;
        const ptr0 = passArrayF32ToWasm0(w, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.demo_quantile_sum(this.__wbg_ptr, val2, ptr0, len0);
        return ret;
    }
    /**
     * Rays traced so far.
     * @returns {number}
     */
    rays() {
        const ret = wasm.demo_rays(this.__wbg_ptr);
        return ret;
    }
    /**
     * Trace and rasterize `rays` more rays on the CPU. Returns
     * `[trace_s, raster_s, rays, segments]`.
     * @param {number} rays
     * @returns {Float64Array}
     */
    render(rays) {
        const ret = wasm.demo_render(this.__wbg_ptr, rays);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tone-mapped RGBA8 image with exposure `scale` and gamma 2.2 (rows in
     * parallel).
     * @param {number} scale
     * @returns {Uint8Array}
     */
    rgba(scale) {
        const ret = wasm.demo_rgba(this.__wbg_ptr, scale);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Tone-mapped RGBA8 image of the weighted sum of the targets (as
     * `EditorView`'s tone map), rows in parallel.
     * @param {number} scale
     * @param {Float32Array | number[]} w
     * @returns {Uint8Array}
     */
    rgba_sum(scale, w) {
        const val2 = +scale;
        const ptr0 = passArrayF32ToWasm0(w, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.demo_rgba_sum(this.__wbg_ptr, val2, ptr0, len0);
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * CPU raster: render into target `i` (0..4) from now on; its contents
     * are kept (see [`Demo::clear`]).
     * @param {number} i
     */
    select(i) {
        wasm.demo_select(this.__wbg_ptr, i);
    }
    /**
     * The sensor's accumulated linear RGB, `bins * 3` sums (bin-major) in
     * the units of the image accumulation, since the last [`Demo::clear`]
     * or [`Demo::set_scene`] (both reset it). Empty without a sensor.
     * @returns {Float32Array}
     */
    sensor() {
        const ret = wasm.demo_sensor(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Bins of the scene's sensor (editor kind 24; 0: no sensor).
     * @returns {number}
     */
    sensor_bins() {
        const ret = wasm.demo_sensor_bins(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Rays traced since the sensor was last reset.
     * @returns {number}
     */
    sensor_rays() {
        const ret = wasm.demo_sensor_rays(this.__wbg_ptr);
        return ret;
    }
    /**
     * Caps for each later [`Demo::trace`] call: at most ~`max_lines` lines
     * (the packed words: 28 bytes per line) and ~`max_ms` of tracing (0:
     * no cap). A capped call traces fewer rays than asked: chunks stop
     * starting once a cap is reached (the rays traced are whole and chosen
     * before tracing, so the image stays unbiased). Overshoot: the chunks
     * already running (one per thread).
     * @param {number} max_lines
     * @param {number} max_ms
     */
    set_frame_caps(max_lines, max_ms) {
        wasm.demo_set_frame_caps(this.__wbg_ptr, max_lines, max_ms);
    }
    /**
     * Replace the scene with an edited description, keeping the renderer
     * (and its position in the sample sequence). Returns the lights' total
     * power. The buffer is kept: call [`Demo::clear`] to start over (the
     * sensor accumulation starts over here).
     * @param {Float32Array | number[]} desc
     * @returns {number}
     */
    set_scene(desc) {
        const ptr0 = passArrayF32ToWasm0(desc, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.demo_set_scene(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Segment cap per emitted ray for later traces, at most the scene's own
     * (0: the scene's: 1024, or 65536 with media). The editor lowers it for
     * drag frames, where one ray at the media cap (65536 segments, ~100 ms
     * in wasm) would stall a frame; cut paths lose their light (biased),
     * counted in [`Demo::trace`]'s truncated rays.
     * @param {number} cap
     */
    set_segment_cap(cap) {
        wasm.demo_set_segment_cap(this.__wbg_ptr, cap);
    }
    /**
     * The packed words of the last [`Demo::trace`] (a fresh, non-shared copy).
     * @returns {Uint32Array}
     */
    take_words() {
        const ret = wasm.demo_take_words(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Trace `rays` more rays without rasterizing; the lines are packed as
     * raster-gpu instance words, fetched with [`Demo::take_words`] or viewed
     * with [`Demo::words_at`]. Returns `[trace_s, rays, segments, lines,
     * capped (0/1), truncated rays]`; `rays` can be fewer than asked when
     * a [`Demo::set_frame_caps`] cap was reached.
     * @param {number} rays
     * @returns {Float64Array}
     */
    trace(rays) {
        const ret = wasm.demo_trace(this.__wbg_ptr, rays);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Where the last [`Demo::trace`]'s packed words are in this module's
     * memory (`[byte offset, words]`): view them with
     * `new Uint32Array(linear_memory().buffer, off, len)` instead of copying
     * them out with [`Demo::take_words`]. Valid until the next trace.
     * @returns {Float64Array}
     */
    words_at() {
        const ret = wasm.demo_words_at(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) Demo.prototype[Symbol.dispose] = Demo.prototype.free;

/**
 * The build's wasm features, e.g. `simd128,relaxed-simd,threads`.
 * @returns {string}
 */
export function features() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.features();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * This module's linear memory (shared in the threaded builds), for
 * [`Demo::words_at`] views.
 * @returns {any}
 */
export function linear_memory() {
    const ret = wasm.linear_memory();
    return ret;
}

/**
 * The named scenes (`zpg --scene`), comma-separated, in
 * `trace::scenes::SCENES` order (the editor's base-scene indices).
 * @returns {string}
 */
export function scene_names() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.scene_names();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Rayon threads in use (1 without the `threads` feature).
 * @returns {number}
 */
export function threads() {
    const ret = wasm.threads();
    return ret >>> 0;
}

/**
 * Chrome trace-event JSON of every span recorded so far (rounds, phases,
 * trace chunks, raster bands, idle gaps), for ui.perfetto.dev. Empty
 * string without the `trace-events` feature.
 * @returns {string}
 */
export function trace_json() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.trace_json();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_is_undefined_be5b34249ff1fc15: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_memory_17a1178bc3328ea3: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = arg0.now();
            return ret;
        },
        __wbg_performance_7e4e4494fdc9d07a: function(arg0) {
            const ret = arg0.performance;
            return ret;
        },
        __wbg_static_accessor_GLOBAL_THIS_003ee833af9699fc: function() {
            const ret = typeof globalThis === 'undefined' ? undefined : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_e4293fb22cbe77da: function() {
            const ret = typeof global === 'undefined' ? undefined : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_53bb20457401453d: function() {
            const ret = typeof self === 'undefined' ? undefined : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_b5e0810bfecb7feb: function() {
            const ret = typeof window === 'undefined' ? undefined : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./zpg_web_bg.js": import0,
    };
}

const BenchFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_bench_free(ptr, 1));
const DemoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_demo_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('zpg_web_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
