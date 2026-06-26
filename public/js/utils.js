// =============================================================
// Math + helper utilities (framework-free)
// =============================================================

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
// frame-rate-independent damping toward a target
export const damp = (cur, tgt, lambda, dt) => lerp(cur, tgt, 1 - Math.exp(-lambda * dt));
export const fmt = (n) => Math.floor(n).toLocaleString('en-US');
export const TAU = Math.PI * 2;

// shortest signed angular difference a->b
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// ---- Seeded RNG (mulberry32) — deterministic spawn placement ----
export function makeRNG(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(rng.range(lo, hi + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  return rng;
}

// ---- Geometry merge (no addons): bake a list of {geo, mat4} into one
// non-indexed BufferGeometry with position/normal/uv. Used for the zombie
// so the whole horde is one InstancedMesh = one draw call. ----
export function mergeGeometries(THREE, parts) {
  const baked = parts.map(({ geo, mat4 }) => {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (mat4) g.applyMatrix4(mat4);
    if (!g.attributes.uv) {
      const n = g.attributes.position.count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    return g;
  });
  let nPos = 0;
  for (const g of baked) nPos += g.attributes.position.count;
  const pos = new Float32Array(nPos * 3);
  const nor = new Float32Array(nPos * 3);
  const uv = new Float32Array(nPos * 2);
  let o3 = 0, o2 = 0;
  for (const g of baked) {
    pos.set(g.attributes.position.array, o3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o3);
    uv.set(g.attributes.uv.array, o2);
    o3 += g.attributes.position.array.length;
    o2 += g.attributes.uv.array.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

// Detect a touch-first device (drives whether on-screen controls show)
export const IS_TOUCH = (typeof window !== 'undefined') &&
  (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));
