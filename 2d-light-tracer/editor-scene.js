// Scene model for the editor: item types, their inspector properties,
// encoding to the flat f32 description the wasm side builds a trace::Scene
// from (web/src/editor.rs), hit-testing geometry, handles, and presets.
//
// Scene space is a 1280x720 design canvas (+y down, angles in radians,
// positive = clockwise on screen); `encode` scales it to the render size.

export const DESIGN_W = 1280, DESIGN_H = 720;
const TAU = Math.PI * 2, D2R = Math.PI / 180;

// Spectra: code + parameter for the wasm side.
export const SPECTRA = {
  white: { label: 'White (flat)', code: 0 },
  daylight: { label: 'Daylight (6500 K)', code: 2, param: 6500 },
  warm: { label: 'Incandescent (2800 K)', code: 2, param: 2800 },
  mono: { label: 'Single wavelength', code: 1 },
  sodium: { label: 'Sodium lamp', code: 3 },
  mercury: { label: 'Mercury lamp', code: 4 },
};

// Participating media (MEDIA.md; web/src/editor.rs). A medium is
// {mfp, g, albedo, spectral, ink, vis, glow} in design pixels:
//   mfp       mean free path at 550 nm (scattering + absorption)
//   g         phase asymmetry (2D Henyey-Greenstein; > 0 forward)
//   albedo    scattered fraction at each collision (0 = pure absorber)
//   spectral  scattering ~ (550 / λ)^spectral (0 white haze .. 4 Rayleigh)
//   ink       absorption colour ('#rrggbb': the colour white light takes
//             after one mfp of a pure absorber; '' = grey)
//   vis       display weight of segments inside (1 = physical fluence)
//   glow      draw with weight ∝ σ_s(λ) instead (light scattered out of the
//             plane: what a camera above would see)
// Closed glass shapes (circle, prism, lens, glass block) carry `fill` (a
// FILLS key, 'none' = vacuum) plus these fields, and `wall` ('glass' or
// 'clear': no refracting boundary). The room medium is scene.fog
// ({on, ...medium}); scene.display = {vacuum, direct} weights (direct 0:
// scattered light only).
// `tint`: the overlay's fill colour for the kind (UI only).
export const FILLS = {
  none: { label: 'Vacuum (empty)' },
  milk: { label: 'Milk', mfp: 12, g: 0.6, albedo: 0.996, spectral: 2, ink: '', tint: '#f2f0e6' },
  smoke: { label: 'Smoke', mfp: 140, g: 0.5, albedo: 0.6, spectral: 1, ink: '', tint: '#9a9a9a' },
  ink: { label: 'Coloured ink (absorbs)', mfp: 120, g: 0, albedo: 0, spectral: 0, ink: '#2a5cff', tint: '#2a5cff' },
  sky: { label: 'Sky (Rayleigh, λ⁻⁴)', mfp: 350, g: 0, albedo: 0.9995, spectral: 4, ink: '', tint: '#7fb2ff' },
  fog: { label: 'Fog', mfp: 600, g: 0.7, albedo: 0.99, spectral: 0, ink: '', tint: '#c8d2dc' },
};
// Room media (scene.fog): the same kinds at room scale (thin enough that a
// beam crosses the 1280 px room).
export const ROOM_FILLS = {
  fog: { label: 'Fog', mfp: 2500, g: 0.7, albedo: 0.995, spectral: 0, ink: '' },
  smoke: { label: 'Smoke', mfp: 1500, g: 0.5, albedo: 0.6, spectral: 1, ink: '' },
  sky: { label: 'Haze (Rayleigh, λ⁻⁴)', mfp: 3000, g: 0, albedo: 0.9995, spectral: 4, ink: '' },
  milk: { label: 'Milky water', mfp: 900, g: 0.6, albedo: 0.995, spectral: 2, ink: '' },
};
// Overlay tint of a filled item / medium (UI only): its ink, else its kind's.
export const fillTint = (m) => (m.ink && /^#[0-9a-f]{6}$/i.test(m.ink) ? m.ink : (FILLS[m.fill] || FILLS.fog).tint);
export const MEDIUM_KEYS = ['mfp', 'g', 'albedo', 'spectral', 'ink', 'vis', 'glow'];
export const FOG_DEFAULT = { on: false, mfp: 2500, g: 0.7, albedo: 0.995, spectral: 0, ink: '', vis: 1, glow: false };
export const DISPLAY_DEFAULT = { vacuum: 1, direct: 1 };
export const FILLABLE = new Set(['circle', 'prism', 'lens', 'glassblock']);
// Load a fill kind's parameters into a glass item (or the fog object).
export function applyFill(it, kind) {
  it.fill = kind;
  const f = FILLS[kind];
  if (f && kind !== 'none') for (const k of ['mfp', 'g', 'albedo', 'spectral', 'ink']) it[k] = f[k];
  it.vis ??= 1;
  it.glow ??= false;
  return it;
}
const fillDefaults = () => { const { label, tint, ...m } = FILLS.milk; return { fill: 'none', wall: 'glass', ...m, vis: 1, glow: false }; };
// Load a room-medium kind into scene.fog (keeps on / vis / glow).
export function applyRoomFill(fog, kind) {
  const f = ROOM_FILLS[kind];
  fog.kind = kind;
  if (f) for (const k of ['mfp', 'g', 'albedo', 'spectral', 'ink']) fog[k] = f[k];
  return fog;
}
// Fill in fields that scenes saved before media existed (or by older
// pages) lack: no fill, glass walls, no fog, default display weights.
export function normalizeScene(s) {
  s.fog = { ...FOG_DEFAULT, ...(s.fog || {}) };
  s.display = { ...DISPLAY_DEFAULT, ...(s.display || {}) };
  if (s.camera) s.camera = { ...CAMERA_DEFAULT, ...s.camera };
  if (s.view) s.view = { ...VIEW_DEFAULT, ...s.view };
  const d = fillDefaults();
  for (const it of s.items || []) {
    if (!FILLABLE.has(it.type)) continue;
    for (const [k, v] of Object.entries(d)) if (it[k] === undefined) it[k] = v;
    if (!FILLS[it.fill]) it.fill = 'none';
  }
  return s;
}

// Inspector property kinds: num (slider + number), angle (degrees in the UI),
// spectrum, wl (wavelength slider, only for mono).
const P = {
  x: { key: 'x', label: 'x', kind: 'num', min: -200, max: 1480, step: 1 },
  y: { key: 'y', label: 'y', kind: 'num', min: -200, max: 920, step: 1 },
  power: { key: 'power', label: 'Intensity', kind: 'num', min: 0, max: 5, step: 0.01 },
  spec: { key: 'spec', label: 'Spectrum', kind: 'spectrum' },
  wl: { key: 'wl', label: 'Wavelength (nm)', kind: 'wl', min: 380, max: 720, step: 1 },
  ior: { key: 'ior', label: 'Refractive index', kind: 'num', min: 1.0, max: 2.5, step: 0.005 },
  disp: { key: 'disp', label: 'Dispersion (Cauchy B, µm²)', kind: 'num', min: 0, max: 0.06, step: 0.0005 },
  rot: { key: 'rot', label: 'Rotation', kind: 'angle' },
  color: { key: 'color', label: 'Colour (reflectance)', kind: 'color' },
};

export const TYPES = {
  point: {
    label: 'Point light', group: 'light', key: '1',
    defaults: { power: 1, spec: 'white', wl: 550, dir: 0, spread: Math.PI },
    props: [P.x, P.y, P.power, P.spec, P.wl, { key: 'dir', label: 'Direction', kind: 'angle' },
      { key: 'spread', label: 'Cone half-angle (180 = all round)', kind: 'angle', min: 0.5, max: 180 }],
  },
  beam: {
    label: 'Collimated beam', group: 'light', key: '2',
    defaults: { angle: 0, width: 60, power: 1, spec: 'white', wl: 550 },
    props: [P.x, P.y, P.power, P.spec, P.wl, { key: 'angle', label: 'Direction', kind: 'angle' },
      { key: 'width', label: 'Width', kind: 'num', min: 1, max: 600, step: 1 }],
  },
  laser: {
    label: 'Laser', group: 'light', key: '3',
    defaults: { angle: 0, width: 2, power: 1, spec: 'mono', wl: 532 },
    props: [P.x, P.y, P.power, P.spec, P.wl, { key: 'angle', label: 'Direction', kind: 'angle' },
      { key: 'width', label: 'Beam width', kind: 'num', min: 0.5, max: 20, step: 0.5 }],
  },
  circle: {
    label: 'Glass circle', group: 'glass', key: '4',
    defaults: { r: 70, ior: 1.5, disp: 0.01, ...fillDefaults() },
    props: [P.x, P.y, { key: 'r', label: 'Radius', kind: 'num', min: 3, max: 400, step: 1 }, P.ior, P.disp],
  },
  prism: {
    label: 'Prism', group: 'glass', key: '5',
    defaults: { size: 160, rot: 0, ior: 1.5, disp: 0.02, ...fillDefaults() },
    props: [P.x, P.y, P.rot, { key: 'size', label: 'Side', kind: 'num', min: 10, max: 600, step: 1 }, P.ior, P.disp],
  },
  lens: {
    label: 'Lens', group: 'glass', key: '6',
    defaults: { rot: 0, R: 240, thick: 50, ior: 1.5, disp: 0.005, ...fillDefaults() },
    props: [P.x, P.y, { key: 'rot', label: 'Axis', kind: 'angle' },
      { key: 'R', label: 'Surface radius', kind: 'num', min: 20, max: 1500, step: 1 },
      { key: 'thick', label: 'Thickness', kind: 'num', min: 2, max: 300, step: 1 }, P.ior, P.disp],
  },
  glassblock: {
    label: 'Glass block', group: 'glass', key: '7',
    defaults: { w: 200, h: 90, rot: 0, ior: 1.5, disp: 0.01, ...fillDefaults() },
    props: [P.x, P.y, P.rot, { key: 'w', label: 'Width', kind: 'num', min: 2, max: 1200, step: 1 },
      { key: 'h', label: 'Height', kind: 'num', min: 2, max: 700, step: 1 }, P.ior, P.disp],
  },
  mirror: {
    label: 'Mirror', group: 'surface', key: '8',
    defaults: { len: 200, rot: -Math.PI / 4, refl: 0.95 },
    props: [P.x, P.y, P.rot, { key: 'len', label: 'Length', kind: 'num', min: 2, max: 1400, step: 1 },
      { key: 'refl', label: 'Reflectance', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  arc: {
    label: 'Curved mirror', group: 'surface', key: '9',
    defaults: { rot: Math.PI, R: 300, span: 0.45, refl: 0.95 },
    props: [P.x, P.y, { key: 'rot', label: 'Facing', kind: 'angle' },
      { key: 'R', label: 'Radius of curvature', kind: 'num', min: 20, max: 2000, step: 1 },
      { key: 'span', label: 'Half-angle', kind: 'angle', min: 1, max: 180 },
      { key: 'refl', label: 'Reflectance', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  splitter: {
    label: 'Beam splitter', group: 'surface', key: '0',
    defaults: { len: 150, rot: -Math.PI / 4, refl: 0.5, trans: 0.5 },
    props: [P.x, P.y, P.rot, { key: 'len', label: 'Length', kind: 'num', min: 2, max: 1400, step: 1 },
      { key: 'refl', label: 'Reflected', kind: 'num', min: 0, max: 1, step: 0.01 },
      { key: 'trans', label: 'Transmitted', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  wall: {
    label: 'Diffuse wall', group: 'surface', key: '-',
    defaults: { len: 260, rot: Math.PI / 2, albedo: 0.8 },
    props: [P.x, P.y, P.rot, { key: 'len', label: 'Length', kind: 'num', min: 2, max: 1400, step: 1 },
      { key: 'albedo', label: 'Albedo', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  block: {
    label: 'Absorbing block', group: 'surface', key: '=',
    defaults: { w: 90, h: 90, rot: 0, albedo: 0 },
    props: [P.x, P.y, P.rot, { key: 'w', label: 'Width', kind: 'num', min: 2, max: 1200, step: 1 },
      { key: 'h', label: 'Height', kind: 'num', min: 2, max: 700, step: 1 },
      { key: 'albedo', label: 'Albedo (0 = black)', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  // Coloured diffuse objects: albedo × a smooth reflectance spectrum
  // through the colour (Kind 14 / 19 with trailing linear r, g, b).
  paintblock: {
    label: 'Coloured block', group: 'surface', key: '',
    defaults: { w: 70, h: 70, rot: 0, albedo: 0.9, color: '#d83a2a' },
    props: [P.x, P.y, P.rot, { key: 'w', label: 'Width', kind: 'num', min: 2, max: 1200, step: 1 },
      { key: 'h', label: 'Height', kind: 'num', min: 2, max: 700, step: 1 }, P.color,
      { key: 'albedo', label: 'Albedo', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  paintdisc: {
    label: 'Coloured disc', group: 'surface', key: '',
    defaults: { r: 36, albedo: 0.9, color: '#2a9a3a' },
    props: [P.x, P.y, { key: 'r', label: 'Radius', kind: 'num', min: 2, max: 400, step: 1 }, P.color,
      { key: 'albedo', label: 'Albedo', kind: 'num', min: 0, max: 1, step: 0.01 }],
  },
  // Camera parts. A lens element is a general spherical singlet: signed
  // radii (r > 0: centre of curvature on the +axis side of that vertex,
  // 0 = flat), so biconvex is r1 > 0, r2 < 0. `rot` is the optical axis
  // (the direction light travels through it).
  lenselem: {
    label: 'Lens element', group: 'camera', key: '',
    defaults: { rot: 0, r1: 160, r2: -160, thick: 24, semi: 50, ior: 1.52, disp: 0.0042 },
    props: [P.x, P.y, { key: 'rot', label: 'Axis (light travels along)', kind: 'angle' },
      { key: 'r1', label: 'Front radius R1 (+ convex, − concave, 0 flat)', kind: 'num', min: -1000, max: 1000, step: 1 },
      { key: 'r2', label: 'Back radius R2 (− convex, + concave, 0 flat)', kind: 'num', min: -1000, max: 1000, step: 1 },
      { key: 'thick', label: 'Centre thickness', kind: 'num', min: 1, max: 200, step: 0.5 },
      { key: 'semi', label: 'Semi-diameter (half height)', kind: 'num', min: 2, max: 300, step: 1 }, P.ior, P.disp],
  },
  aperture: {
    label: 'Aperture stop', group: 'camera', key: '',
    defaults: { rot: 0, hole: 60, size: 140 },
    props: [P.x, P.y, { key: 'rot', label: 'Axis', kind: 'angle' },
      { key: 'hole', label: 'Opening (diameter)', kind: 'num', min: 1, max: 600, step: 1 },
      { key: 'size', label: 'Outer size', kind: 'num', min: 2, max: 800, step: 1 }],
  },
  sensor: {
    label: 'Sensor', group: 'camera', key: '',
    defaults: { len: 220, rot: Math.PI / 2, bins: 0 },
    props: [P.x, P.y, P.rot, { key: 'len', label: 'Length', kind: 'num', min: 4, max: 1400, step: 1 },
      { key: 'bins', label: 'Bins (0 = one per render pixel)', kind: 'num', min: 0, max: 4096, step: 1 }],
  },
};

// Toolbar entries for ready-filled shapes ('Media' group): a closed glass
// type with a fill kind and overrides.
export const INSERTS = {
  milkglass: { label: 'Glass of milk', type: 'circle', fill: 'milk', over: { r: 60, ior: 1.35, disp: 0.003, mfp: 16 } },
  inkcell: { label: 'Ink cell', type: 'glassblock', fill: 'ink', over: { w: 150, h: 90, ior: 1.33, disp: 0.003 } },
  fogpatch: { label: 'Fog patch (no wall)', type: 'glassblock', fill: 'fog', over: { w: 260, h: 180, wall: 'clear', mfp: 220 } },
};
export function makeInsert(name, x, y) {
  const t = INSERTS[name];
  const it = applyFill(makeItem(t.type, x, y), t.fill);
  return Object.assign(it, structuredClone(t.over));
}

let nextId = 1;
export function makeItem(type, x, y, over = {}) {
  return { id: nextId++, type, x, y, ...structuredClone(TYPES[type].defaults), ...over };
}
export function reId(items) {
  for (const it of items) { it.id = nextId++; }
  return items;
}

export const isLight = (it) => TYPES[it.type].group === 'light';

// --- geometry ----------------------------------------------------------------------
const v = (x, y) => ({ x, y });
const add = (a, b) => v(a.x + b.x, a.y + b.y);
const sub = (a, b) => v(a.x - b.x, a.y - b.y);
const mul = (a, s) => v(a.x * s, a.y * s);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const dirv = (t) => v(Math.cos(t), Math.sin(t));
const perp = (a) => v(-a.y, a.x);
export const angleOf = (a) => Math.atan2(a.y, a.x);

function distSeg(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
  return len(sub(p, add(a, mul(ab, t))));
}
function inPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function polyDist(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, distSeg(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}

export function segEnds(it) {
  const h = mul(dirv(it.rot), it.len / 2);
  return [sub(it, h), add(it, h)];
}
export function prismVerts(it) {
  const r = it.size / Math.sqrt(3);
  return [-90, 30, 150].map((d) => add(it, mul(dirv(it.rot + d * D2R), r)));
}
export function rectVerts(it) {
  const u = mul(dirv(it.rot), it.w / 2), w = mul(dirv(it.rot + Math.PI / 2), it.h / 2);
  return [sub(sub(it, u), w), sub(add(it, u), w), add(add(it, u), w), add(sub(it, u), w)];
}
// Lens: the two circle centres, the half-angle of each surface, the aperture.
export function lensGeom(it) {
  const R = Math.max(2, it.R), t = Math.min(it.thick, 1.98 * R);
  const d = R - t / 2, half = Math.acos(Math.max(-1, Math.min(1, d / R)));
  const ax = dirv(it.rot);
  return { R, t, d, half, ax, c1: add(it, mul(ax, d)), c2: sub(it, mul(ax, d)), aperture: R * Math.sin(half) };
}
// Curved mirror: (x, y) is the middle of the arc, `rot` the direction its
// concave side faces; the circle's centre is R along `rot`.
export function arcGeom(it) {
  const c = add(it, mul(dirv(it.rot), it.R));
  return { c, mid: it.rot + Math.PI, half: Math.max(0.01, Math.min(Math.PI, it.span)) };
}
// Lens element (Kind 17): the vertices, the axis frame and the semi-diameter
// clamped to the radii and to where the two surfaces meet (as the tracer).
const sag = (r, h) => (r ? r - Math.sign(r) * Math.sqrt(Math.max(0, r * r - h * h)) : 0);
export function lensElemGeom(it) {
  const ax = dirv(it.rot), n = perp(ax), t = Math.max(0.1, it.thick);
  let semi = Math.max(0.5, it.semi);
  if (it.r1) semi = Math.min(semi, Math.abs(it.r1));
  if (it.r2) semi = Math.min(semi, Math.abs(it.r2));
  const gap = (h) => t + sag(it.r2, h) - sag(it.r1, h);
  if (gap(semi) < 0) {
    let lo = 0, hi = semi;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (gap(m) >= 0) lo = m; else hi = m; }
    semi = lo;
  }
  return { ax, n, t, semi, v1: sub(it, mul(ax, t / 2)), v2: add(it, mul(ax, t / 2)) };
}
// Outline polygon: the front surface bottom to top, the back one top to bottom.
export function lensElemPoly(it, N = 28) {
  const g = lensElemGeom(it), pts = [];
  const at = (v, r, h) => add(add(v, mul(g.ax, sag(r, h))), mul(g.n, h));
  for (let i = 0; i <= N; i++) pts.push(at(g.v1, it.r1, -g.semi + (2 * g.semi * i) / N));
  for (let i = N; i >= 0; i--) pts.push(at(g.v2, it.r2, -g.semi + (2 * g.semi * i) / N));
  return pts;
}
// Aperture stop: two absorbing segments across the axis, leaving `hole` open.
export function apertureSegs(it) {
  const n = perp(dirv(it.rot)), a = Math.max(0, it.hole / 2), b = Math.max(a + 0.5, it.size / 2);
  return [[add(it, mul(n, a)), add(it, mul(n, b))], [sub(it, mul(n, a)), sub(it, mul(n, b))]];
}
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

// Distance from p to the item (0 inside solids), for hit-testing.
export function distance(it, p) {
  switch (it.type) {
    case 'point': case 'laser': return len(sub(p, it));
    case 'beam': {
      const h = mul(perp(dirv(it.angle)), it.width / 2);
      return Math.min(len(sub(p, it)), distSeg(p, sub(it, h), add(it, h)));
    }
    case 'circle': case 'paintdisc': return Math.max(0, len(sub(p, it)) - it.r);
    case 'lenselem': { const vs = lensElemPoly(it, 12); return inPoly(p, vs) ? 0 : polyDist(p, vs); }
    case 'aperture': return Math.min(...apertureSegs(it).map(([a, b]) => distSeg(p, a, b)));
    case 'prism': { const vs = prismVerts(it); return inPoly(p, vs) ? 0 : polyDist(p, vs); }
    case 'block': case 'glassblock': case 'paintblock': { const vs = rectVerts(it); return inPoly(p, vs) ? 0 : polyDist(p, vs); }
    case 'lens': {
      const g = lensGeom(it);
      const d = Math.max(len(sub(p, g.c1)) - g.R, len(sub(p, g.c2)) - g.R);
      return Math.max(0, d);
    }
    case 'mirror': case 'splitter': case 'wall': case 'sensor': { const [a, b] = segEnds(it); return distSeg(p, a, b); }
    case 'arc': {
      const g = arcGeom(it), q = sub(p, g.c);
      const da = Math.abs(angDiff(angleOf(q), g.mid));
      if (da <= g.half) return Math.abs(len(q) - it.R);
      const e1 = add(g.c, mul(dirv(g.mid + g.half), it.R)), e2 = add(g.c, mul(dirv(g.mid - g.half), it.R));
      return Math.min(len(sub(p, e1)), len(sub(p, e2)));
    }
  }
  return Infinity;
}

// Handles of an item: [{id, x, y, kind}] in scene space. kind: 'aim' | 'size' | 'rot' | 'end'.
export function handles(it) {
  // Lens parts of a camera move only along its axis (no handles), except
  // the stop's opening.
  if (it.rig === 'lens' && it.type !== 'aperture') return [];
  switch (it.type) {
    case 'point':
      return it.spread < Math.PI - 1e-3 ? [{ id: 'aim', kind: 'aim', ...add(it, mul(dirv(it.dir), 56)) }] : [];
    case 'beam': {
      const h = mul(perp(dirv(it.angle)), it.width / 2);
      return [{ id: 'aim', kind: 'aim', ...add(it, mul(dirv(it.angle), 64)) }, { id: 'w1', kind: 'size', ...add(it, h) }, { id: 'w2', kind: 'size', ...sub(it, h) }];
    }
    case 'laser': return [{ id: 'aim', kind: 'aim', ...add(it, mul(dirv(it.angle), 56)) }];
    case 'circle': case 'paintdisc': return [{ id: 'r', kind: 'size', ...add(it, v(it.r, 0)) }];
    case 'lenselem': {
      const g = lensElemGeom(it);
      return [{ id: 'rot', kind: 'rot', ...add(it, mul(g.ax, g.t / 2 + 30)) }, { id: 'semi', kind: 'size', ...add(it, mul(g.n, g.semi)) }];
    }
    case 'aperture': {
      const n = perp(dirv(it.rot)), hs = [{ id: 'hole', kind: 'size', ...add(it, mul(n, it.hole / 2)) }];
      if (!it.rig) hs.push({ id: 'size', kind: 'size', ...add(it, mul(n, it.size / 2)) }, { id: 'rot', kind: 'rot', ...sub(it, mul(dirv(it.rot), 30)) });
      return hs;
    }
    case 'prism': {
      const r = it.size / Math.sqrt(3), vs = prismVerts(it);
      return [{ id: 'rot', kind: 'rot', ...add(it, mul(dirv(it.rot - Math.PI / 2), r + 26)) }, { id: 'size', kind: 'size', ...vs[1] }];
    }
    case 'lens': {
      const g = lensGeom(it);
      return [{ id: 'rot', kind: 'rot', ...add(it, mul(g.ax, g.t / 2 + 30)) }, { id: 'size', kind: 'size', ...add(it, mul(perp(g.ax), g.aperture)) }];
    }
    case 'block': case 'glassblock': case 'paintblock': {
      const vs = rectVerts(it);
      return [{ id: 'rot', kind: 'rot', ...add(it, mul(dirv(it.rot - Math.PI / 2), it.h / 2 + 26)) }, { id: 'corner', kind: 'size', ...vs[2] }];
    }
    case 'mirror': case 'splitter': case 'wall': case 'sensor': {
      const [a, b] = segEnds(it);
      return [{ id: 'a', kind: 'end', ...a }, { id: 'b', kind: 'end', ...b }];
    }
    case 'arc': {
      const g = arcGeom(it);
      return [{ id: 'rot', kind: 'rot', ...sub(it, mul(dirv(it.rot), 30)) }, { id: 'span', kind: 'size', ...add(g.c, mul(dirv(g.mid + g.half), it.R)) }];
    }
  }
  return [];
}

const snapAng = (a, on) => (on ? Math.round(a / (15 * D2R)) * 15 * D2R : a);

// Apply a handle drag: `p` is the pointer in scene space, `orig` the item at
// drag start. Returns the changed fields.
export function dragHandle(orig, hid, p, snap) {
  const it = orig, q = sub(p, it);
  switch (it.type) {
    case 'point': return { dir: snapAng(angleOf(q), snap) };
    case 'beam': case 'laser':
      if (hid === 'aim') return { angle: snapAng(angleOf(q), snap) };
      return { width: Math.max(1, 2 * Math.abs(dot(q, perp(dirv(it.angle))))) };
    case 'circle': case 'paintdisc': return { r: Math.max(3, len(q)) };
    case 'lenselem':
      if (hid === 'rot') return { rot: snapAng(angleOf(q), snap) };
      return { semi: Math.max(2, Math.abs(dot(q, perp(dirv(it.rot))))) };
    case 'aperture': {
      if (hid === 'rot') return { rot: snapAng(angleOf(q) + Math.PI, snap) };
      const h = 2 * Math.abs(dot(q, perp(dirv(it.rot))));
      return hid === 'hole' ? { hole: Math.max(1, Math.min(it.size - 1, h)) } : { size: Math.max(it.hole + 1, h) };
    }
    case 'prism':
      if (hid === 'rot') return { rot: snapAng(angleOf(q) + Math.PI / 2, snap) };
      return { size: Math.max(10, len(q) * Math.sqrt(3)) };
    case 'lens': {
      if (hid === 'rot') return { rot: snapAng(angleOf(q), snap) };
      const g = lensGeom(it), a = Math.max(4, Math.abs(dot(q, perp(g.ax))));
      const f = a / g.aperture;
      return { R: Math.max(20, it.R * f), thick: Math.max(2, it.thick * f) };
    }
    case 'block': case 'glassblock': case 'paintblock': {
      if (hid === 'rot') return { rot: snapAng(angleOf(q) + Math.PI / 2, snap) };
      const lx = dot(q, dirv(it.rot)), ly = dot(q, dirv(it.rot + Math.PI / 2));
      return { w: Math.max(2, 2 * Math.abs(lx)), h: Math.max(2, 2 * Math.abs(ly)) };
    }
    case 'mirror': case 'splitter': case 'wall': case 'sensor': {
      const [a, b] = segEnds(it);
      const fixed = hid === 'a' ? b : a;
      let d = sub(p, fixed);
      if (snap) { const ang = snapAng(angleOf(d), true); d = mul(dirv(ang), len(d)); }
      const moving = add(fixed, d);
      const m = mul(add(fixed, moving), 0.5);
      const rot = hid === 'a' ? angleOf(sub(fixed, moving)) : angleOf(d);
      return { x: m.x, y: m.y, len: Math.max(2, len(d)), rot };
    }
    case 'arc': {
      if (hid === 'rot') return { rot: snapAng(angleOf(sub(it, p)), snap) };
      const g = arcGeom(it);
      return { span: Math.max(0.02, Math.min(Math.PI, Math.abs(angDiff(angleOf(sub(p, g.c)), g.mid)))) };
    }
  }
  return {};
}

// --- encoding -----------------------------------------------------------------------
const KIND = { point: 1, beam: 2, circle: 10, prism: 11, lens: 12, segment: 13, block: 14, arc: 15, glassblock: 16,
  lenselem: 17, paintdisc: 19, medium: 20, ambient: 21, visibility: 22, direct: 23, sensor: 24, view: 25, base: 99 };

const GREY_T = Math.exp(-1);
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function inkRGB(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [GREY_T, GREY_T, GREY_T];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => srgbToLinear(c / 255));
}
// Medium item parameters for a render scale `s` (render px per design px).
function mediumParams(m, s) {
  const mfp = Math.max(0.5, Number(m.mfp) || 1) * s;
  const albedo = Math.min(1, Math.max(0, m.albedo ?? 1));
  return [albedo / mfp, m.spectral ?? 0, (1 - albedo) / mfp, ...inkRGB(m.ink), Math.max(-0.95, Math.min(0.95, m.g ?? 0))];
}
const hasFill = (it) => FILLABLE.has(it.type) && it.fill && it.fill !== 'none' && FILLS[it.fill];
// Display weight items for medium number `n` (0 = vacuum), if non-default.
function visParams(m, vacuum) {
  const vis = Math.max(0, m.vis ?? 1);
  if (m.glow) return [vacuum, vis];
  return vis === 1 ? null : [vis, 0];
}

// Linear RGB reflectance of a '#rrggbb' colour (clamped to [0, 1]).
export function colorRGB(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => srgbToLinear(c / 255));
}
// Sensor bins: `bins`, or one per render pixel of its length.
export const sensorBins = (it, s) => Math.max(1, Math.min(4096, it.bins > 0 ? Math.round(it.bins) : Math.round(it.len * s)));

function spectrumOf(it) {
  const s = SPECTRA[it.spec] || SPECTRA.white;
  return [s.code, s.code === 1 ? it.wl : s.param || 0];
}

// Flat description for a `rw x rh` render (see web/src/editor.rs).
export function encode(scene, rw, rh, sceneNames) {
  const s = rw / DESIGN_W;
  const out = [1, scene.walls ? 1 : 0, scene.wallAlbedo ?? 0.04];
  const push = (kind, ...p) => out.push(kind, p.length, ...p);
  if (scene.base && sceneNames) {
    const i = sceneNames.indexOf(scene.base);
    if (i >= 0) push(KIND.base, i);
  }
  // Media: the room's first (number 1), then one per filled shape, each
  // just before its shape. Display weights go last.
  const display = { ...DISPLAY_DEFAULT, ...(scene.display || {}) };
  const vis = [];
  let media = 0;
  if (scene.fog && scene.fog.on) {
    push(KIND.medium, ...mediumParams(scene.fog, s));
    push(KIND.ambient, ++media);
    const v = visParams(scene.fog, display.vacuum);
    if (v) vis.push([media, ...v]);
  }
  const fillOf = (it) => {
    if (!hasFill(it)) return [0, it.wall === 'clear' ? 1 : 0];
    push(KIND.medium, ...mediumParams(it, s));
    const v = visParams(it, display.vacuum);
    if (v) vis.push([media + 1, ...v]);
    return [++media, it.wall === 'clear' ? 1 : 0];
  };
  for (const it of scene.items) {
    if (it.hidden) continue;
    const X = it.x * s, Y = it.y * s;
    switch (it.type) {
      case 'point': push(KIND.point, X, Y, it.power, ...spectrumOf(it), it.dir, it.spread); break;
      case 'beam': case 'laser': push(KIND.beam, X, Y, it.angle, it.width * s, it.power, ...spectrumOf(it)); break;
      case 'circle': push(KIND.circle, X, Y, it.r * s, it.ior, it.disp, ...fillOf(it)); break;
      case 'prism': push(KIND.prism, X, Y, it.size * s, it.rot, it.ior, it.disp, ...fillOf(it)); break;
      case 'lens': push(KIND.lens, X, Y, it.rot, it.R * s, it.thick * s, it.ior, it.disp, ...fillOf(it)); break;
      case 'glassblock': push(KIND.glassblock, X, Y, it.w * s, it.h * s, it.rot, it.ior, it.disp, ...fillOf(it)); break;
      case 'mirror': case 'splitter': case 'wall': {
        const [a, b] = segEnds(it);
        const m = it.type === 'mirror' ? [0, it.refl, 0] : it.type === 'splitter' ? [0, it.refl, it.trans] : [it.albedo, 0, 0];
        push(KIND.segment, a.x * s, a.y * s, b.x * s, b.y * s, ...m);
        break;
      }
      case 'block': push(KIND.block, X, Y, it.w * s, it.h * s, it.rot, it.albedo, 0, 0); break;
      // Camera scenes (CONTRACT: kinds 14 + rgb, 17, 19, 24, 25).
      case 'paintblock': push(KIND.block, X, Y, it.w * s, it.h * s, it.rot, it.albedo, 0, 0, ...colorRGB(it.color)); break;
      case 'paintdisc': push(KIND.paintdisc, X, Y, it.r * s, it.albedo, ...colorRGB(it.color)); break;
      case 'lenselem': push(KIND.lenselem, X, Y, it.rot, it.r1 * s, it.r2 * s, it.thick * s, it.semi * s, it.ior, it.disp); break;
      case 'aperture':
        for (const [a, b] of apertureSegs(it)) push(KIND.segment, a.x * s, a.y * s, b.x * s, b.y * s, 0, 0, 0);
        break;
      case 'sensor': {
        const [a, b] = segEnds(it);
        push(KIND.sensor, a.x * s, a.y * s, b.x * s, b.y * s, sensorBins(it, s));
        break;
      }
      case 'arc': {
        const g = arcGeom(it);
        push(KIND.arc, g.c.x * s, g.c.y * s, it.R * s, g.mid, g.half, 0, it.refl, 0);
        break;
      }
    }
  }
  // The camera's view region (display only): after every medium item, so
  // the media numbers above are unchanged.
  for (const vw of viewRects(scene)) push(KIND.view, vw.x * s, vw.y * s, vw.w * s, vw.h * s, vw.rot, Math.max(0, vw.weight));
  if (display.vacuum !== 1) vis.push([0, Math.max(0, display.vacuum), 0]);
  for (const v of vis) push(KIND.visibility, ...v);
  if (display.direct !== 1) push(KIND.direct, Math.max(0, display.direct));
  return new Float32Array(out);
}

// --- colour of a wavelength / spectrum (UI only) ------------------------------------
export function wavelengthRGB(nm) {
  let r = 0, g = 0, b = 0;
  if (nm < 440) { r = -(nm - 440) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = -(nm - 510) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = -(nm - 645) / 65; }
  else r = 1;
  const f = nm < 420 ? 0.3 + (0.7 * (nm - 380)) / 40 : nm > 700 ? 0.3 + (0.7 * (780 - nm)) / 80 : 1;
  const c = (x) => Math.round(255 * Math.pow(Math.max(0, x * f), 0.8));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
export function lightColor(it) {
  switch (it.spec) {
    case 'mono': return wavelengthRGB(it.wl);
    case 'sodium': return wavelengthRGB(589);
    case 'mercury': return 'rgb(190,200,255)';
    case 'warm': return 'rgb(255,200,140)';
    case 'daylight': return 'rgb(235,240,255)';
    default: return 'rgb(255,255,255)';
  }
}

// --- camera -----------------------------------------------------------------------------
// A camera scene has scene.camera = {x, y, rot, tube: [t0, t1], ...}: the
// optical axis through (x, y) along `rot` (the direction light travels, so
// objects lie at negative axial coordinates and the sensor at positive ones),
// and the axial range the lens parts must stay in. Items tagged rig: 'lens'
// (lens elements, the stop) move only along the axis; rig: 'body' (the
// black body, the sensor) are locked unless unlocked in the Camera panel.
// `variant` ('multi' / 'singlet') tags alternative lenses: the hidden one is
// skipped everywhere. scene.view is the display-only view region (Kind 25)
// over the camera interior: {on, x, y, w, h, rot, weight}.
// UI-only fields: show/upright/plot/ev (sensor inset), weight in view.
export const CAMERA_DEFAULT = { x: 0, y: 0, rot: 0, tube: [-1e4, 1e4], lens: 'multi', show: true, upright: false, plot: true, ev: 0 };
export const VIEW_DEFAULT = { on: true, x: 0, y: 0, w: 100, h: 100, rot: 0, weight: 1, fit: '', pre: null };
// The view region(s) as drawn. fit '' : the rectangle as stored. fit
// 'lens': its front edge follows the lens (just in front of the first
// visible lens part), so the bright light arriving in the hood isn't
// boosted. With `pre` set and a stop in the lens, the part in front of the
// stop gets weight `pre` (light there is much brighter: it isn't limited by
// the stop yet) and the rest `weight`.
export function viewRects(scene) {
  const vw = scene.view;
  if (!vw || !vw.on) return [];
  if (vw.fit !== 'lens' || !scene.camera) return [vw];
  const cam = scene.camera, parts = lensParts(scene);
  if (!parts.length) return [vw];
  const ax = dirv(cam.rot), nx = perp(ax), off = dot(sub(vw, cam), nx);
  const back = dot(sub(vw, cam), ax) + vw.w / 2;
  const front = Math.min(...parts.map((it) => axialOf(cam, it) - halfLen(it))) - 4;
  const rect = (a, b, weight) => {
    const w = Math.max(1, b - a), c = add(cam, add(mul(ax, a + w / 2), mul(nx, off)));
    return { ...vw, x: c.x, y: c.y, w, weight };
  };
  const stop = vw.pre != null && parts.find((it) => it.type === 'aperture');
  if (!stop) return [rect(front, back, vw.weight)];
  // (1 px apart: regions must not share an edge, or the medium a ray is in
  // after crossing it is ambiguous)
  const ts = axialOf(cam, stop) - 0.5;
  return [rect(front, ts - 1, vw.pre), rect(ts, back, vw.weight)];
}
export const axialOf = (cam, p) => dot(sub(p, cam), dirv(cam.rot));
export const lensParts = (scene, all = false) => scene.items.filter((it) => it.rig === 'lens' && (all || !it.hidden));
// Axial half-extent of a lens part (for the tube limits).
const halfLen = (it) => (it.type === 'lenselem' ? it.thick / 2 + Math.max(0, -sag(it.r1, it.semi), sag(it.r2, it.semi)) : 1);
// Axis-constrained move of a lens part: `orig` at drag start, pointer
// moved by (dx, dy). Returns the new position (inside the tube).
export function constrainToAxis(scene, orig, dx, dy) {
  const cam = scene.camera, ax = dirv(cam.rot), t0 = axialOf(cam, orig);
  const lo = cam.tube[0] + halfLen(orig), hi = cam.tube[1] - halfLen(orig);
  const t = Math.min(Math.max(t0 + dx * ax.x + dy * ax.y, Math.min(lo, t0)), Math.max(hi, t0));
  return add(orig, mul(ax, t - t0));
}
// The lens group's position (mean axial coordinate of the visible lens
// parts) and the range it can move in the tube.
export function groupRange(scene, tubeOnly = false) {
  const cam = scene.camera, parts = lensParts(scene);
  if (!cam || !parts.length) return null;
  const ts = parts.map((it) => axialOf(cam, it));
  const pos = ts.reduce((a, b) => a + b, 0) / ts.length;
  const lo = Math.min(...parts.map((it, i) => ts[i] - halfLen(it))), hi = Math.max(...parts.map((it, i) => ts[i] + halfLen(it)));
  let min = pos + Math.min(0, cam.tube[0] - lo), max = pos + Math.max(0, cam.tube[1] - hi);
  // The design's focus travel for the group origin (parts carry their offset `dx` from it).
  const o = groupOrigin(scene);
  if (cam.originRange && o != null && !tubeOnly) { min = Math.max(min, pos + cam.originRange[0] - o); max = Math.min(max, pos + cam.originRange[1] - o); }
  return { pos, min: Math.min(min, pos), max: Math.max(max, pos) };
}
// Axial position of the visible lens group's origin (design lenses: every
// part stores its offset `dx` from it), or null.
export function groupOrigin(scene) {
  const it = lensParts(scene).find((p) => p.dx != null);
  return it ? axialOf(scene.camera, it) - it.dx : null;
}
// Signature of the visible lens's shape (spacing, radii, glass; not the
// stop opening): the focus calibration applies only while it matches.
function lensSig(scene) {
  const parts = lensParts(scene).filter((it) => it.type === 'lenselem');
  if (!parts.length) return '';
  const t0 = axialOf(scene.camera, parts[0]), r = (x) => Math.round(x * 100) / 100;
  return parts.map((it) => [r(axialOf(scene.camera, it) - t0), r(it.r1), r(it.r2), r(it.thick), r(it.semi), r(it.ior), r(it.disp)].join(',')).join(';');
}
// Focus calibration (scene.camera.calib[variant] = {sig, pts: [[best, parax]]}):
// traced best-focus group origins vs the paraxial ones for the same targets.
// Paraxial focus misses the traced best focus (spherical aberration, field
// curvature), so `paraxial` evaluates the lens shifted by the interpolated
// difference: the plane of focus, blur readouts and focus buttons then
// agree with the traced optimum at the calibrated targets.
function calibShift(scene) {
  const cam = scene.camera, c = cam.calib && cam.calib[cam.lens];
  if (!c || !c.pts.length) return 0;
  const o = groupOrigin(scene);
  if (o == null || c.sig !== lensSig(scene)) return 0;
  // The calibration is for the full aperture. The spherical-aberration part
  // of the shift goes as the aperture squared (paraxial is exact for a small
  // stop); field curvature doesn't. The design's tables put about 2/3 of it
  // in the first: scale by 0.35 + 0.65 (hole / calibrated hole)².
  const stop = lensParts(scene).find((it) => it.type === 'aperture');
  const k = stop && c.hole ? 0.35 + 0.65 * Math.min(1, (stop.hole / c.hole) ** 2) : 1;
  const pts = c.pts, d = (i) => k * (pts[i][1] - pts[i][0]);
  if (o <= pts[0][0]) return d(0);
  for (let i = 1; i < pts.length; i++) if (o <= pts[i][0]) { const f = (o - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return d(i - 1) + f * (d(i) - d(i - 1)); }
  return d(pts.length - 1);
}
// Build the calibration of the visible variant from traced best origins
// {depth: origin} (paraxial positions solved here).
export function calibrate(scene, best) {
  const o0 = groupOrigin(scene), r = groupRange(scene);
  if (o0 == null || !r) return;
  const pts = [];
  for (const [depth, ob] of Object.entries(best)) {
    const t = depthT(scene, depth);
    if (t == null) continue;
    const pos = focusFor(scene, t, true);
    // (ob null: no traced value, e.g. infinity: no correction there)
    if (pos != null) pts.push([ob ?? o0 + (pos - r.pos), o0 + (pos - r.pos)]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  const stop = lensParts(scene).find((it) => it.type === 'aperture');
  scene.camera.calib = { ...(scene.camera.calib || {}), [scene.camera.lens]: { sig: lensSig(scene), pts, hole: stop ? stop.hole : 0 } };
}
// Move the visible lens parts together by `d` along the axis.
export function shiftGroup(scene, d) {
  const ax = dirv(scene.camera.rot);
  for (const it of lensParts(scene)) { it.x += ax.x * d; it.y += ax.y * d; }
}

// Paraxial optics of the visible lens (2D meridional = the 3D paraxial
// formulas). Surfaces sorted along the axis; (y, w = n·u) ray state; basis
// rays from the front vertex plane give the system matrix [[A, B], [C, D]]
// to the back vertex plane, plus each surface's / the stop's heights.
// n at 550 nm (Cauchy: ior + disp / 0.55²).
export function paraxial(scene, raw = false) {
  const cam = scene.camera;
  if (!cam) return null;
  const ev = [], shift = raw ? 0 : calibShift(scene);
  for (const it of lensParts(scene)) {
    const t = axialOf(cam, it) + shift;
    if (it.type === 'lenselem') {
      const g = lensElemGeom(it), n = it.ior + it.disp / 0.3025;
      ev.push({ t: t - g.t / 2, R: it.r1, n1: 1, n2: n, semi: g.semi }, { t: t + g.t / 2, R: it.r2, n1: n, n2: 1, semi: g.semi });
    } else if (it.type === 'aperture') ev.push({ t, stop: Math.max(0.01, it.hole / 2) });
  }
  const surf = ev.filter((e) => !e.stop);
  const sensor = scene.items.find((it) => it.type === 'sensor' && !it.hidden);
  if (!surf.length || !sensor) return null;
  ev.sort((a, b) => a.t - b.t);
  const front = Math.min(...surf.map((e) => e.t)), back = Math.max(...surf.map((e) => e.t));
  // Trace a basis ray from the front plane; heights at each event.
  const run = (y, w) => {
    let t = front, n = 1;
    const hs = [];
    for (const e of ev) {
      y += ((e.t - t) * w) / n; t = e.t;
      hs.push(y);
      if (!e.stop) { if (e.R) w -= (y * (e.n2 - e.n1)) / e.R; n = e.n2; }
    }
    y += ((back - t) * w) / n;
    return { y, w, hs };
  };
  const a = run(1, 0), b = run(0, 1);
  const S = axialOf(cam, sensor) - back;
  const efl = Math.abs(a.w) > 1e-12 ? -1 / a.w : Infinity;
  // Marginal-ray scale for an input ray (heights hA·p + hB·q): the largest
  // factor that keeps it inside every semi-diameter and the stop.
  const scaleFor = (p, q) => {
    let k = Infinity;
    ev.forEach((e, i) => { const h = Math.abs(a.hs[i] * p + b.hs[i] * q); if (h > 1e-12) k = Math.min(k, (e.stop ?? e.semi) / h); });
    return k;
  };
  // Object distance L (in front of the front vertex) imaged on the sensor.
  const den = a.y + S * a.w, L = Math.abs(den) > 1e-12 ? -(b.y + S * b.w) / den : Infinity;
  // Blur (diameter on the sensor, design px) of an axial point at distance Lo.
  const blur = (Lo) => {
    if (!isFinite(Lo)) return 2 * scaleFor(1, 0) * Math.abs(a.y + S * a.w);
    const p = Lo, q = 1, k = scaleFor(p, q);
    return 2 * k * Math.abs(a.y * p + b.y * q + S * (a.w * p + b.w * q));
  };
  // f-number for a distant object: efl / entrance pupil diameter.
  const stopI = ev.findIndex((e) => e.stop);
  const epd = stopI >= 0 && Math.abs(a.hs[stopI]) > 1e-12 ? (2 * ev[stopI].stop) / Math.abs(a.hs[stopI]) : 2 * scaleFor(1, 0);
  return { front, back, S, L, efl, blur, fnum: efl / epd, focusT: front - L, sensorT: axialOf(cam, sensor), sensor, calibrated: shift !== 0 };
}
// Group position that focuses an object at axial coordinate `tObj`
// (-Infinity: at infinity), or null if out of reach.
export function focusFor(scene, tObj, raw = false) {
  const r = groupRange(scene, raw);
  if (!r) return null;
  const at = (pos) => {
    shiftGroup(scene, pos - r.pos);
    const px = paraxial(scene, raw);
    shiftGroup(scene, r.pos - pos);
    if (!px) return NaN;
    // signed mismatch: in-focus plane minus target (in 1/distance, robust to ∞)
    const inv = (L) => (isFinite(L) ? 1 / L : 0);
    return inv(px.L) - inv(isFinite(tObj) ? px.front - tObj : Infinity);
  };
  // Sign changes of the mismatch, refined by bisection; a change across the
  // pole (plane of focus passing the lens: 1/L jumps) is rejected by
  // checking the mismatch at the root. Nearest root to the current position.
  const N = 96, roots = [];
  let prev = at(r.min), pp = r.min;
  for (let i = 1; i <= N; i++) {
    const pos = r.min + ((r.max - r.min) * i) / N, f = at(pos);
    if (isFinite(prev) && isFinite(f) && Math.sign(prev) !== Math.sign(f)) {
      let lo = pp, hi = pos, flo = prev;
      for (let j = 0; j < 50; j++) { const m = (lo + hi) / 2, fm = at(m); if (Math.sign(fm) === Math.sign(flo)) { lo = m; flo = fm; } else hi = m; }
      const root = (lo + hi) / 2;
      if (Math.abs(at(root)) < 1e-4) roots.push(root);
    }
    prev = f; pp = pos;
  }
  if (!roots.length) return null;
  return roots.reduce((a, b) => (Math.abs(b - r.pos) < Math.abs(a - r.pos) ? b : a));
}
// Show one lens variant ('multi' / 'singlet'), hiding the other.
export function setLensVariant(scene, v) {
  scene.camera.lens = v;
  for (const it of scene.items) if (it.variant) it.hidden = it.variant !== v;
}
export const lensVariants = (scene) => [...new Set(scene.items.filter((it) => it.variant).map((it) => it.variant))];

// --- presets ---------------------------------------------------------------------------
// Each returns {items, walls, wallAlbedo, base, look:{percentile, gain}}.

// The CLI's `default` scene (crates/trace/src/demo.rs), designed at
// 1024x768 and scaled non-uniformly to the image as there.
function presetDefault() {
  const sx = DESIGN_W / 1024, sy = DESIGN_H / 768, sm = Math.min(sx, sy);
  const p = (x, y) => ({ x: x * sx, y: y * sy });
  const items = [];
  const beam = (from, to, over) => {
    const a = p(...from), b = p(...to);
    items.push(makeItem('point', a.x, a.y, { dir: Math.atan2(b.y - a.y, b.x - a.x), spread: 0.012, ...over }));
  };
  beam([30, 160], [520, 400], { spec: 'mono', wl: 650 });
  beam([260, 750], [520, 390], { spec: 'mono', wl: 530 });
  beam([440, 20], [515, 395], { spec: 'mono', wl: 460, power: 2 });
  beam([1000, 560], [525, 405], { spec: 'sodium' });
  beam([30, 620], [760, 690], { spread: 0.01, power: 1.2 });
  items.push(makeItem('point', ...Object.values(p(880, 380)), { power: 0.05 }));
  beam([18, 436], [168, 500], { spread: 0.006, power: 1.5 });
  const seg = (type, a, b, over) => {
    const A = p(...a), B = p(...b), d = { x: B.x - A.x, y: B.y - A.y };
    items.push(makeItem(type, (A.x + B.x) / 2, (A.y + B.y) / 2, { len: Math.hypot(d.x, d.y), rot: Math.atan2(d.y, d.x), ...over }));
  };
  seg('splitter', [500, 330], [545, 470], { refl: 0.3, trans: 0.65 });
  seg('mirror', [640, 90], [860, 210], { refl: 0.95 });
  seg('mirror', [700, 720], [920, 600], { refl: 0.95 });
  const pc = p(200, 480);
  items.push(makeItem('prism', pc.x, pc.y, { size: 130 * sm, rot: Math.PI, ior: 1.5, disp: 0.03 }));
  const c = p(800, 420), r = 45 * sm;
  items.push(makeItem('block', c.x, c.y, { w: r * Math.SQRT2, h: r * Math.SQRT2, rot: 0.3 - Math.PI / 4, albedo: 0.8 }));
  // The ink slab (300,120) (380,100) (385,120) (305,140), as a rotated rectangle.
  const q = [p(300, 120), p(380, 100), p(385, 120), p(305, 140)];
  const ang = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
  const wv = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const hv = Math.abs(-(q[3].x - q[0].x) * Math.sin(ang) + (q[3].y - q[0].y) * Math.cos(ang));
  const mx = q.reduce((t, a) => t + a.x, 0) / 4, my = q.reduce((t, a) => t + a.y, 0) / 4;
  items.push(makeItem('block', mx, my, { w: wv, h: hv, rot: ang, albedo: 0 }));
  return { items, walls: true, wallAlbedo: 0.04, base: null, look: { percentile: 0.995, gain: 1.0 } };
}

// White beam -> dispersive prism (near minimum deviation) -> lens -> screen.
function presetDispersion() {
  const items = [];
  // Aim with the index at 550 nm (Cauchy: a + b / 0.55^2).
  const disp = 0.03, a = 1.5, n = a + disp / 0.3025, apex = 60 * D2R, inc = Math.asin(n * Math.sin(apex / 2));
  const inAngle = -0.18;
  const rot = inAngle + (inc - apex / 2); // as scenes::min_deviation_prism, bend = +1
  const pc = { x: 360, y: 300 }, side = 190, r = side / Math.sqrt(3);
  const entry = add(pc, mul(dirv(rot - 150 * D2R), r / 2));
  const exit = add(pc, mul(dirv(rot - 30 * D2R), r / 2));
  const exitAngle = inAngle + (2 * inc - apex);
  const src = sub(entry, mul(dirv(inAngle), 200));
  items.push(makeItem('beam', src.x, src.y, { angle: inAngle, width: 16, power: 1, spec: 'white' }));
  items.push(makeItem('prism', pc.x, pc.y, { size: side, rot, ior: a, disp }));
  // Lens (f = R / (2 (n - 1)) ~ 150) and a screen just past its focus.
  const lc = add(exit, mul(dirv(exitAngle), 250));
  items.push(makeItem('lens', lc.x, lc.y, { rot: exitAngle, R: 160, thick: 70, ior: 1.5, disp: 0.004 }));
  const sc = add(lc, mul(dirv(exitAngle), 190));
  items.push(makeItem('wall', sc.x, sc.y, { len: 260, rot: exitAngle + Math.PI / 2, albedo: 0.5 }));
  items.push(makeItem('laser', 90, 650, { angle: -0.01, spec: 'mono', wl: 640, power: 0.4 }));
  items.push(makeItem('circle', 1060, 640, { r: 50, ior: 1.6, disp: 0.02 }));
  return { items, walls: true, wallAlbedo: 0.04, base: null, look: { percentile: 0.995, gain: 1.0 } };
}

// Lasers, mirrors and glass: a playground.
function presetPlayground() {
  const items = [
    makeItem('laser', 110, 200, { angle: 0.12, spec: 'mono', wl: 650 }),
    makeItem('laser', 110, 360, { angle: 0, spec: 'mono', wl: 532 }),
    makeItem('laser', 110, 520, { angle: -0.12, spec: 'mono', wl: 450, power: 1.6 }),
    makeItem('circle', 520, 360, { r: 90, ior: 1.5, disp: 0.01 }),
    makeItem('mirror', 900, 180, { len: 220, rot: 1.0 }),
    makeItem('arc', 1120, 420, { rot: Math.PI, R: 420, span: 0.4 }),
    makeItem('point', 800, 600, { power: 0.25, spec: 'warm' }),
    makeItem('block', 980, 600, { w: 60, h: 60, rot: 0.4, albedo: 0 }),
  ];
  return { items, walls: true, wallAlbedo: 0.06, base: null, look: { percentile: 0.995, gain: 1.0 } };
}

// Sunlight into a water drop: the rainbow fans back out at ~42 degrees.
function presetRaindrop() {
  const items = [
    makeItem('beam', 140, 330, { angle: 0, width: 350, power: 1, spec: 'daylight' }),
    makeItem('circle', 760, 330, { r: 170, ior: 1.33, disp: 0.03 }),
  ];
  return { items, walls: false, wallAlbedo: 0, base: null, look: { percentile: 0.9, gain: 4 } };
}

function presetPool() {
  return { items: [], walls: false, wallAlbedo: 0, base: 'pool-rainbow', look: { percentile: 0.995, gain: 0.25 } };
}

function presetEmpty() {
  return { items: [makeItem('point', 640, 360, { power: 1 })], walls: true, wallAlbedo: 0.3, base: null, look: { percentile: 0.995, gain: 1.0 } };
}

// --- media presets ----------------------------------------------------------------------
// Each tuned to read at 720p within a few seconds. ZPG draws every ray as
// if the plane were dusty, so a medium only stands out when the light it
// scatters is weighted against the unscattered beam: display.direct < 1
// and/or glow (weight ∝ σ_s). Mean free paths stay >= ~4 design px, and
// media in lossless glass keep a little absorption (MEDIA.md).
const fog = (kind, over) => ({ ...FOG_DEFAULT, ...applyRoomFill({}, kind), on: true, ...over });
const filled = (type, x, y, kind, over) => Object.assign(applyFill(makeItem(type, x, y), kind), over);

// Sunlight slanting through a window into a foggy room: the bars of the
// window cast shadow shafts (god rays) that fade into the fog; drag the
// loose blocker through the beam to sweep a shadow across it.
function presetGodRays() {
  const ang = 0.42, src = { x: 90, y: 200 }, d = dirv(ang), n = perp(d);
  const items = [makeItem('beam', src.x, src.y, { angle: ang, width: 360, power: 1, spec: 'daylight' })];
  for (let i = -2; i <= 2; i++) {
    const c = add(add(src, mul(d, 150)), mul(n, i * 62 + 8));
    items.push(makeItem('block', c.x, c.y, { w: 14, h: 26, rot: ang, albedo: 0 }));
  }
  items.push(makeItem('block', 700, 330, { w: 36, h: 36, rot: 0.6, albedo: 0 }));
  return { items, walls: true, wallAlbedo: 0.1, base: null, fog: fog('fog', { mfp: 700, g: 0.6 }),
    display: { vacuum: 1, direct: 0.3 }, look: { percentile: 0.995, gain: 0.6 } };
}

// Sunset tank: a white beam through a long tank of Rayleigh scatterers
// (dilute milk / sky): blue glow sideways, the beam turns orange-red.
function presetSunsetTank() {
  const items = [
    makeItem('beam', 60, 360, { angle: 0, width: 10, power: 1, spec: 'daylight' }),
    filled('glassblock', 640, 360, 'sky', { w: 900, h: 220, rot: 0, ior: 1.33, disp: 0.003, mfp: 260, albedo: 0.995, glow: true, vis: 2 }),
  ];
  return { items, walls: true, wallAlbedo: 0.3, base: null, display: { vacuum: 1, direct: 0.4 }, look: { percentile: 0.995, gain: 1.0 } };
}

// Tyndall rod: a white beam down a long glass rod of dilute milk. Blue
// scatters out of the sides; light scattered at grazing angles stays
// trapped by total internal reflection and glows along the rod; what comes
// out of the far end is yellow-orange.
function presetTyndall() {
  const items = [
    makeItem('beam', 70, 362, { angle: 0.035, width: 26, power: 1, spec: 'daylight' }),
    filled('glassblock', 650, 360, 'sky', { w: 1000, h: 54, rot: 0, ior: 1.5, disp: 0.008, mfp: 420, g: 0.2, albedo: 0.998, glow: true, vis: 1.5 }),
    makeItem('wall', 1225, 360, { len: 300, rot: Math.PI / 2, albedo: 0.7 }),
  ];
  return { items, walls: true, wallAlbedo: 0.05, base: null, display: { vacuum: 1, direct: 0.35 }, look: { percentile: 0.995, gain: 1.0 } };
}

// A flashlight in a foggy room: a warm cone with a glass ball and a post
// casting shadows through the fog.
function presetFlashlight() {
  const items = [
    makeItem('point', 110, 470, { power: 1, spec: 'warm', dir: -0.16, spread: 15 * D2R }),
    makeItem('circle', 640, 340, { r: 60, ior: 1.5, disp: 0.01 }),
    makeItem('block', 470, 455, { w: 24, h: 90, rot: 0, albedo: 0 }),
  ];
  return { items, walls: true, wallAlbedo: 0.08, base: null, fog: fog('fog', { mfp: 2200, g: 0.75 }),
    display: { vacuum: 1, direct: 0.6 }, look: { percentile: 0.995, gain: 1.0 } };
}

// A white laser through a smoky room into a prism: the smoke shows the
// beam and the dispersed fan.
function presetLaserSmoke() {
  const disp = 0.03, a = 1.5, n = a + disp / 0.3025, apex = 60 * D2R, inc = Math.asin(n * Math.sin(apex / 2));
  const inAngle = -0.1, rot = inAngle + (inc - apex / 2);
  const pc = { x: 560, y: 380 }, side = 200, r = side / Math.sqrt(3);
  const entry = add(pc, mul(dirv(rot - 150 * D2R), r / 2));
  const src = sub(entry, mul(dirv(inAngle), 420));
  const items = [
    makeItem('laser', src.x, src.y, { angle: inAngle, width: 3, power: 1, spec: 'white' }),
    makeItem('prism', pc.x, pc.y, { size: side, rot, ior: a, disp }),
  ];
  return { items, walls: true, wallAlbedo: 0.3, base: null, fog: fog('smoke', { mfp: 1300 }),
    display: { vacuum: 1, direct: 0.4 }, look: { percentile: 0.995, gain: 1.0 } };
}

// --- showcase (the editor's default scene) ---------------------------------------------
// One picture in a hazy room: a white laser climbs into a flint-like prism
// (near minimum deviation) and fans out into a wide spectrum; a concave
// mirror on the right gathers the whole fan and refocuses it to a white
// point (Newton's recombination), after which the spectrum opens again,
// reversed, through a small glass ball. Below, a red and a green laser
// cross through a big glass ball (a ball lens). The room fog makes every
// beam visible; display.direct < 1 lifts the scattered glow. Tuned to look
// finished at the editor's default 2M-ray limit (720p, ~4 s with threads).
function presetShowcase() {
  // Prism at minimum deviation for 550 nm; the fan leaves at `exitAngle`.
  const disp = 0.045, a = 1.52, n = a + disp / 0.3025, apex = 60 * D2R, inc = Math.asin(n * Math.sin(apex / 2));
  const exitAngle = 0.04, inAngle = exitAngle - (2 * inc - apex), rot = inAngle + (inc - apex / 2);
  const pc = { x: 320, y: 330 }, side = 170, r = side / Math.sqrt(3);
  const entry = add(pc, mul(dirv(rot - 150 * D2R), r / 2));
  const exit = add(pc, mul(dirv(rot - 30 * D2R), r / 2));
  const src = sub(entry, mul(dirv(inAngle), 300));
  // Concave mirror `u` px down the fan, imaging the prism exit at `focus`
  // (1/u + 1/v = 2/R), its axis bisecting the incoming and outgoing rays.
  const u = 900, mv = add(exit, mul(dirv(exitAngle), u)), focus = { x: 640, y: 200 };
  const vd = len(sub(focus, mv)), back = angleOf(sub(focus, mv)), inv = exitAngle + Math.PI;
  const R = (2 * u * vd) / (u + vd);
  const items = [
    makeItem('laser', src.x, src.y, { angle: inAngle, width: 7, power: 1, spec: 'white' }),
    makeItem('prism', pc.x, pc.y, { size: side, rot, ior: a, disp }),
    makeItem('arc', mv.x, mv.y, { rot: inv + angDiff(back, inv) / 2, R, span: 200 / R, refl: 0.95 }),
    makeItem('circle', 470, 165, { r: 40, ior: 1.5, disp: 0.02 }),
    makeItem('circle', 820, 585, { r: 85, ior: 1.5, disp: 0.02 }),
    makeItem('laser', 1250, 560, { angle: Math.PI, width: 3, spec: 'mono', wl: 532, power: 0.08 }),
    makeItem('laser', 1250, 610, { angle: Math.PI, width: 3, spec: 'mono', wl: 650, power: 0.12 }),
  ];
  return { items, walls: true, wallAlbedo: 0.03, base: null, fog: fog('fog', { mfp: 2200, g: 0.6 }),
    display: { vacuum: 1, direct: 0.35 }, look: { percentile: 0.995, gain: 1.0 } };
}

// --- camera preset ------------------------------------------------------------------------
// Coloured objects at three distances lit by white spot lights, imaged by a
// multi-element lens (with a singlet as the alternative) through an aperture
// stop onto a sensor in a black camera body. Axial coordinates (dx, t) are
// along the axis from `axis`; element offsets are from the group position.
export const CAMERA_DESIGN = {
  axis: { x: 700, y: 360, rot: 0 },
  tube: [14, 400],
  // Black body (absorbing blocks): [x, y, w, h] centres in design px.
  body: [[911, 254, 422, 12], [911, 466, 422, 12], [1116, 360, 12, 224], [706, 279, 12, 38], [706, 441, 12, 38], [670, 295, 60, 6], [670, 425, 60, 6]],
  sensor: { x: 1100, y: 360, len: 190 },
  view: { x: 910, y: 360, w: 418, h: 200 },
  lenses: {
    multi: {
      label: 'Triplet (3 elements)',
      elements: [
        { dx: -30, r1: 84, r2: -280, thick: 18, semi: 55, ior: 1.6, disp: 0.007 },
        { dx: 0, r1: -98, r2: 91, thick: 7, semi: 45, ior: 1.6, disp: 0.0125 },
        { dx: 30, r1: 210, r2: -77, thick: 16, semi: 50, ior: 1.6, disp: 0.007 },
      ],
      stop: { dx: 14, hole: 70, size: 200 },
    },
    singlet: {
      label: 'Singlet',
      elements: [{ dx: 0, r1: 140, r2: -140, thick: 22, semi: 50, ior: 1.52, disp: 0.0042 }],
      stop: { dx: 18, hole: 70, size: 200 },
    },
  },
  group: 233, // initial group position (axial)
  focus: 'mid',
  aperture: [6, 110], // stop opening range (diameter)
  objects: [
    { type: 'paintblock', x: 470, y: 296, w: 46, h: 46, rot: 0.3, color: '#e03c28', depth: 'near', name: 'red block' },
    { type: 'paintdisc', x: 300, y: 446, r: 30, color: '#2fb84a', depth: 'mid', name: 'green disc' },
    { type: 'paintblock', x: 260, y: 300, w: 30, h: 60, rot: 0, color: '#f2c12e', depth: 'mid', name: 'yellow bar' },
    { type: 'paintblock', x: 90, y: 360, w: 50, h: 100, rot: 0, color: '#3a68e8', depth: 'far', name: 'blue block' },
    { type: 'paintdisc', x: 110, y: 470, r: 26, color: '#c040d0', depth: 'far', name: 'magenta disc' },
  ],
  lights: [
    { x: 600, y: 120, at: [470, 296], spread: 10, power: 1 },
    { x: 470, y: 640, at: [300, 446], spread: 9, power: 1 },
    { x: 420, y: 90, at: [260, 300], spread: 8, power: 0.8 },
    { x: 280, y: 60, at: [90, 360], spread: 12, power: 1.2 },
    { x: 300, y: 690, at: [110, 470], spread: 10, power: 1 },
  ],
  display: { vacuum: 0.35, direct: 1 },
  viewWeight: 3,
  look: { percentile: 0.995, gain: 1.0 },
};
export const DEPTHS = ['near', 'mid', 'far'];
// sRGB '#rrggbb' of a linear RGB triple (the colour pickers' format).
const linToHex = (rgb) => '#' + rgb.map((c) => {
  c = Math.min(1, Math.max(0, c));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255).toString(16).padStart(2, '0');
}).join('');
// The optics design ($SP/camera/optics/design.json, embedded below as
// OPTICS_DESIGN) in buildCamera's format: global x on the axis (axis
// origin x = 0), lens elements and the stop relative to the group origin
// g (the triplet's front vertex), linear RGB paint.
export function fromOptics(J, over = {}) {
  const cam = J.camera, Y = cam.axis_y, ll = J.lens_local, hIn = cam.interior_half_height ?? 62;
  const el = (e) => ({ dx: e.x, r1: e.r1, r2: e.r2, thick: e.thick, semi: e.semi, ior: e.a, disp: e.b });
  const stopFor = (els, sx) => {
    // Keep the stop out of the glass (just behind an element it would cut).
    for (const e of els) if (Math.abs(sx - e.x) < e.thick / 2 + 1) sx = e.x + e.thick / 2 + 2;
    return { dx: sx, hole: 2 * (ll.stop_half_max ?? 20), size: 2 * (hIn + 2) };
  };
  const lenses = { multi: { label: `Triplet (${ll.triplet.length} elements)`, elements: ll.triplet.map(el), stop: stopFor(ll.triplet, ll.stop_x_local) } };
  if (ll.singlet && ll.singlet.length) lenses.singlet = { label: 'Singlet', elements: ll.singlet.map(el), stop: stopFor(ll.singlet, ll.singlet_stop_x_local ?? ll.stop_x_local) };
  if (ll.singlet_dispersive && ll.singlet_dispersive.length) {
    lenses.dispersive = { label: 'Singlet, high-dispersion glass (strong colour fringes)', elements: ll.singlet_dispersive.map(el),
      stop: stopFor(ll.singlet_dispersive, ll.singlet_dispersive_stop_x_local ?? ll.singlet_stop_x_local ?? ll.stop_x_local) };
  }
  const s = cam.sensor, vr = cam.view_region;
  const objects = [];
  for (const o of J.objects) for (const b of o.blocks) {
    objects.push({ type: 'paintblock', x: b.x, y: b.y, w: b.w, h: b.h, rot: b.rot ?? 0, albedo: b.diffuse ?? 0.9, color: linToHex(b.rgb || [1, 1, 1]), depth: o.name, name: `${o.colour_name || o.name} target` });
  }
  const front = Math.min(...cam.blocks.map((b) => b.x - b.w / 2));
  return {
    axis: { x: 0, y: Y, rot: 0 },
    tube: [J.focus.tube_min ?? front, J.focus.tube_max ?? s.x1 - 4],
    body: cam.blocks,
    sensor: { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2, len: Math.hypot(s.x2 - s.x1, s.y2 - s.y1), rot: Math.atan2(s.y2 - s.y1, s.x2 - s.x1), bins: s.bins },
    view: { x: vr.x, y: vr.y, w: vr.w, h: vr.h, fit: 'lens', pre: over.viewPre ?? 1.2 },
    viewWeight: over.viewWeight ?? 4,
    lenses,
    origin: J.focus.g_infinity - (J.focus.default_extension ?? 0), // group origin (triplet front vertex)
    originRange: J.focus.slider_range ? [J.focus.g_infinity - J.focus.slider_range[1], J.focus.g_infinity - J.focus.slider_range[0]] : null,
    best: J.focus.best_extension ? Object.fromEntries(Object.entries({ multi: 'triplet', singlet: 'singlet', dispersive: 'singlet_dispersive' }).filter(([, k]) => J.focus.best_extension[k])
      .map(([v, k]) => [v, { ...Object.fromEntries(Object.entries(J.focus.best_extension[k]).map(([d, e]) => [d, J.focus.g_infinity - e])), inf: null }])) : null,
    focus: 'mid',
    aperture: [2 * (ll.stop_half_min ?? 2), 2 * (ll.stop_half_max ?? 25)],
    objects,
    lights: J.lights.map((l) => ({ x: l.x, y: l.y, dir: l.dir, spreadRad: l.spread, power: l.power, spec: l.spec || 'white' })),
    display: { vacuum: 0.35, direct: 1, ...(over.display || {}) },
    look: { percentile: 0.995, gain: 1.0, ...(over.look || {}) },
  };
}
// BEGIN OPTICS_DESIGN (generated from design.json by the camera optics agent's output; do not edit by hand)
export const OPTICS_DESIGN = {"version":1794033424,"units":"design px, canvas 1280x720, +y down, angles radians; axis 0 = light travels +x","camera":{"axis_y":360.0,"sensor":{"x1":1215.0,"y1":280.0,"x2":1215.0,"y2":440.0,"bins":160},"blocks":[{"name":"tube_top","x":1046.5,"y":272.0,"w":373.0,"h":10.0,"rot":0.0,"diffuse":0.0,"specular":0.0,"transmit":0.0},{"name":"tube_bottom","x":1046.5,"y":448.0,"w":373.0,"h":10.0,"rot":0.0,"diffuse":0.0,"specular":0.0,"transmit":0.0},{"name":"tube_back","x":1228.0,"y":360.0,"w":10.0,"h":166.0,"rot":0.0,"diffuse":0.0,"specular":0.0,"transmit":0.0},{"x":823.622,"y":262.158,"w":72.821,"h":10.0,"rot":0.279253,"name":"hood_top","diffuse":0.0,"specular":0.0,"transmit":0.0},{"x":823.622,"y":457.842,"w":72.821,"h":10.0,"rot":-0.279253,"name":"hood_bottom","diffuse":0.0,"specular":0.0,"transmit":0.0}],"interior_half_height":83.0,"view_region":{"x":1006.5,"y":360.0,"w":433.0,"h":166.0,"rot":0.0,"weight":12.0,"note":"drawn ray density behind the lens is ~12 (sum w*len/area, MC) vs ~200 in the open space in front of the camera and ~800-1000 at the lit object faces: weight ~12 (8-25) makes the focusing bundles inside the camera about as bright as the scene; optionally dim the vacuum (display.vacuum ~0.5)"}},"stop":{"half_open_max":33.3333,"half_open_min":3.0,"note":"two absorbing segments (kind 13, albedo 0): x = stop_x, y from Y0-H_IN-2 to Y0-half and Y0+half to Y0+H_IN+2"},"lens_local":{"triplet":[{"x":9.2655,"r1":212.493,"r2":-124.721,"thick":18.531,"semi":43.0,"a":1.5046,"b":0.02},{"x":31.9001,"r1":-80.1884,"r2":-219.864,"thick":11.7201,"semi":38.0,"a":1.58,"b":0.06},{"x":64.6167,"r1":-619.765,"r2":-91.4423,"thick":15.499,"semi":41.0,"a":1.5046,"b":0.02}],"singlet":[{"x":54.3872,"r1":125.775,"r2":-320.925,"thick":13.0,"semi":38.0,"a":1.5046,"b":0.02}],"stop_x_local":44.9885,"singlet_stop_x_local":46.3872,"singlet_dispersive":[{"x":54.3882,"r1":132.499,"r2":-380.84,"thick":13.0,"semi":38.0,"a":1.5046,"b":0.035}],"singlet_dispersive_stop_x_local":46.3882,"stop_half_max":33.3333,"stop_half_min":3.0,"crown":[1.5046,0.02],"flint":[1.58,0.06]},"focus":{"g_infinity":1000.1,"g_min":880.101,"efl":160.021,"h1_local":44.1217,"h2_local":54.8775,"extension_range":[0.0,120.0],"default_extension":43.3,"best_extension":{"triplet":{"near":89.75,"mid":43.3,"far":21.8},"singlet":{"near":63.31,"mid":37.62,"far":7.69},"singlet_dispersive":{"near":60.93,"mid":32.73,"far":6.01}},"best_rms_px":{"triplet":{"near":0.607,"mid":0.288,"far":0.464},"singlet":{"near":1.564,"mid":1.217,"far":1.278},"singlet_dispersive":{"near":2.317,"mid":1.901,"far":1.831}},"slider_range":[-5.0,110.0]},"objects":[{"name":"near","colour_name":"red","x_face":560.0,"y_range":[396.668,450.224],"bar_h":12.1718,"gap_h":8.52029,"blocks":[{"x":556.0,"y":402.754,"w":8.0,"h":12.1718,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.9,0.1,0.04]},{"x":556.0,"y":423.446,"w":8.0,"h":12.1718,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.92,0.92,0.92]},{"x":556.0,"y":444.138,"w":8.0,"h":12.1718,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.9,0.1,0.04]}],"g_focus_paraxial":863.881,"extension":136.22,"dist_from_front_vertex":303.881},{"name":"mid","colour_name":"green","x_face":330.0,"y_range":[319.375,400.625],"bar_h":18.466,"gap_h":12.9262,"blocks":[{"x":326.0,"y":328.608,"w":8.0,"h":18.466,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.06,0.8,0.12]},{"x":326.0,"y":360.0,"w":8.0,"h":18.466,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.92,0.92,0.92]},{"x":326.0,"y":391.392,"w":8.0,"h":18.466,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.06,0.8,0.12]}],"g_focus_paraxial":949.226,"extension":50.8753,"dist_from_front_vertex":619.226},{"name":"far","colour_name":"blue","x_face":60.0,"y_range":[104.711,243.017],"bar_h":31.4332,"gap_h":22.0032,"blocks":[{"x":56.0,"y":120.427,"w":8.0,"h":31.4332,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.08,0.3,0.95]},{"x":56.0,"y":173.864,"w":8.0,"h":31.4332,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.92,0.92,0.92]},{"x":56.0,"y":227.3,"w":8.0,"h":31.4332,"rot":0.0,"diffuse":1.0,"specular":0.0,"transmit":0.0,"rgb":[0.08,0.3,0.95]}],"g_focus_paraxial":967.764,"extension":32.3374,"dist_from_front_vertex":907.764}],"lights":[{"type":"point","x":699,"y":326,"dir":2.53016,"spread":0.164215,"power":0.226961,"spec":"white","aim":[560.0,423.446],"target":"near"},{"type":"point","x":699,"y":521,"dir":-2.52964,"spread":0.164104,"power":0.226974,"spec":"white","aim":[560.0,423.446],"target":"near"},{"type":"point","x":469,"y":262,"dir":2.52749,"spread":0.247467,"power":0.343309,"spec":"white","aim":[330.0,360.0],"target":"mid"},{"type":"point","x":469,"y":458,"dir":-2.52749,"spread":0.247467,"power":0.343309,"spec":"white","aim":[330.0,360.0],"target":"mid"},{"type":"point","x":199,"y":76,"dir":2.52815,"spread":0.437505,"power":0.606387,"spec":"white","aim":[60.0,173.864],"target":"far"},{"type":"point","x":199,"y":271,"dir":-2.53166,"spread":0.439076,"power":0.605576,"spec":"white","aim":[60.0,173.864],"target":"far"}]};
// END OPTICS_DESIGN
export function buildCamera(D = CAMERA_DESIGN) {
  const ax = dirv(D.axis.rot), nrm = perp(ax), items = [];
  const along = (t, h = 0) => add(add(D.axis, mul(ax, t)), mul(nrm, h));
  for (const L of D.lights) {
    const dir = L.dir ?? Math.atan2(L.at[1] - L.y, L.at[0] - L.x);
    items.push(makeItem('point', L.x, L.y, { power: L.power ?? 1, spec: L.spec || 'white', dir, spread: L.spreadRad ?? (L.spread ?? 10) * D2R }));
  }
  for (const o of D.objects) {
    const { type, depth, name, ...rest } = o;
    items.push(makeItem(type, o.x, o.y, { ...rest, albedo: o.albedo ?? 0.9, depth, name }));
  }
  for (const b of D.body) {
    const [x, y, w, h, rot] = Array.isArray(b) ? b : [b.x, b.y, b.w, b.h, b.rot];
    items.push(makeItem('block', x, y, { w, h, rot: rot ?? D.axis.rot, albedo: 0, rig: 'body', ...(b.name ? { name: b.name } : {}) }));
  }
  items.push(makeItem('sensor', D.sensor.x, D.sensor.y, { len: D.sensor.len, rot: D.sensor.rot ?? D.axis.rot + Math.PI / 2, bins: D.sensor.bins ?? 0, rig: 'body' }));
  for (const [variant, lens] of Object.entries(D.lenses)) {
    for (const e of lens.elements) {
      const { dx, ...rest } = e, p = along((D.origin ?? D.group) + dx);
      items.push(makeItem('lenselem', p.x, p.y, { ...rest, dx, rot: D.axis.rot, rig: 'lens', variant }));
    }
    if (lens.stop) {
      const p = along((D.origin ?? D.group) + lens.stop.dx);
      items.push(makeItem('aperture', p.x, p.y, { rot: D.axis.rot, hole: lens.stop.hole, size: lens.stop.size, dx: lens.stop.dx, rig: 'lens', variant }));
    }
  }
  const scene = {
    items, walls: false, wallAlbedo: 0, base: null, look: { ...D.look },
    display: { ...D.display },
    camera: { ...CAMERA_DEFAULT, ...D.axis, tube: [...D.tube], lens: 'multi', aperture: [...D.aperture], originRange: D.originRange || null, labels: Object.fromEntries(Object.entries(D.lenses).map(([k, l]) => [k, l.label])) },
    view: { ...VIEW_DEFAULT, ...D.view, rot: D.axis.rot, weight: D.viewWeight ?? 1 },
  };
  setLensVariant(scene, 'multi');
  // Start focused on the `focus` depth, per variant (each lens its own group position).
  for (const v of Object.keys(D.lenses)) {
    setLensVariant(scene, v);
    if (D.best && D.best[v]) calibrate(scene, D.best[v]);
    focusDepth(scene, D.focus);
  }
  setLensVariant(scene, 'multi');
  return scene;
}
// Axial coordinate of the objects tagged `depth` (their mean), or -Infinity.
export function depthT(scene, depth) {
  if (depth === 'inf') return -Infinity;
  const os = scene.items.filter((it) => it.depth === depth && !it.hidden);
  if (!os.length) return null;
  return os.reduce((a, it) => a + axialOf(scene.camera, it), 0) / os.length;
}
// Move the visible lens group to focus on `depth`; returns whether it could.
export function focusDepth(scene, depth) {
  const t = depthT(scene, depth);
  if (t == null) return false;
  const pos = focusFor(scene, t), r = groupRange(scene);
  if (pos == null || !r) return false;
  shiftGroup(scene, pos - r.pos);
  return true;
}

export const PRESETS = {
  showcase: { label: 'Showcase: prism, mirror and lasers in haze (default)', build: presetShowcase },
  camera: { label: 'Camera: lens, aperture, sensor (focus on near / mid / far)', build: () => buildCamera(OPTICS_DESIGN ? fromOptics(OPTICS_DESIGN) : CAMERA_DESIGN) },
  tyndall: { label: 'Media: Tyndall rod (milky glass)', build: presetTyndall },
  flashlight: { label: 'Media: flashlight in fog', build: presetFlashlight },
  'laser-smoke': { label: 'Media: laser through smoke into a prism', build: presetLaserSmoke },
  sunset: { label: 'Media: sunset tank (Rayleigh)', build: presetSunsetTank },
  godrays: { label: 'Media: god rays (drag a blocker through a beam in fog)', build: presetGodRays },
  default: { label: 'Demo (CLI default)', build: presetDefault },
  dispersion: { label: 'Prism + lens', build: presetDispersion },
  playground: { label: 'Lasers & mirrors', build: presetPlayground },
  raindrop: { label: 'Rainbow drop', build: presetRaindrop },
  pool: { label: 'Pool rainbow (fixed background)', build: presetPool },
  empty: { label: 'Clear (one light)', build: presetEmpty },
};
