// =============================================================
// Procedural textures — canvas-generated color + normal + roughness maps.
// Tileable value-noise + 2D drawing. Embeds the locked golden-hour palette.
// =============================================================
import { CONFIG } from './config.js';

const C = CONFIG.col;
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

// ---- tileable value-noise field, normalized 0..1 ----
function noiseFn(period, seed) {
  const g = new Float32Array(period * period);
  let s = seed >>> 0;
  for (let i = 0; i < g.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; g[i] = s / 4294967296; }
  const at = (x, y) => g[((y % period) + period) % period * period + (((x % period) + period) % period)];
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}
// fbm height field of given pixel size, periodic (tileable)
function fbmField(size, octaves) {
  const out = new Float32Array(size * size);
  const fns = octaves.map((o) => ({ f: noiseFn(o.period, o.seed), p: o.period, a: o.amp }));
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (const o of fns) v += o.a * o.f((x / size) * o.p, (y / size) * o.p);
    out[y * size + x] = v;
    if (v < min) min = v; if (v > max) max = v;
  }
  const inv = 1 / (max - min || 1);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) * inv;
  return out;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
function canvasHeight(canvas) {
  const s = canvas.width;
  const d = canvas.getContext('2d').getImageData(0, 0, s, s).data;
  const h = new Float32Array(s * s);
  for (let i = 0; i < h.length; i++) h[i] = d[i * 4] / 255;
  return h;
}

// height field -> normal map canvas (tangent space, tileable wrap)
function normalCanvas(height, size, strength = 2.0) {
  const c = makeCanvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const at = (x, y) => height[((y % size) + size) % size * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const len = Math.hypot(dx, dy, 1);
    const i = (y * size + x) * 4;
    d[i] = (-dx / len * 0.5 + 0.5) * 255;
    d[i + 1] = (dy / len * 0.5 + 0.5) * 255;
    d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// height field -> grayscale roughness canvas (mapped lo..hi)
function roughCanvas(height, size, lo, hi) {
  const c = makeCanvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  for (let i = 0; i < height.length; i++) {
    const v = (lo + (hi - lo) * height[i]) * 255;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// tint a height field into an RGB color canvas between two colors
function colorFromHeight(height, size, darkHex, lightHex, speckle) {
  const c = makeCanvas(size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const dk = [(darkHex >> 16) & 255, (darkHex >> 8) & 255, darkHex & 255];
  const lt = [(lightHex >> 16) & 255, (lightHex >> 8) & 255, lightHex & 255];
  for (let i = 0; i < height.length; i++) {
    let t = height[i];
    if (speckle && Math.random() < 0.015) t = Math.min(1, t + 0.4); // bright aggregate
    const j = i * 4;
    d[j] = dk[0] + (lt[0] - dk[0]) * t;
    d[j + 1] = dk[1] + (lt[1] - dk[1]) * t;
    d[j + 2] = dk[2] + (lt[2] - dk[2]) * t;
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---- individual surfaces ----
function asphalt(size = 256) {
  const h = fbmField(size, [
    { period: 64, seed: 11, amp: 0.35 }, { period: 128, seed: 23, amp: 0.5 }, { period: 200, seed: 7, amp: 0.9 },
  ]);
  const color = colorFromHeight(h, size, 0x3a3835, C.asphalt, true);
  // a couple of cracks
  const ctx = color.getContext('2d');
  ctx.strokeStyle = 'rgba(20,18,16,0.6)'; ctx.lineWidth = 1.5;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath(); let x = Math.random() * size, y = 0;
    ctx.moveTo(x, y);
    for (; y < size; y += 8) { x += (Math.random() - 0.5) * 14; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return { color, normal: normalCanvas(h, size, 1.4), rough: roughCanvas(h, size, 0.82, 0.97) };
}
function roof(size = 256) {
  const h = fbmField(size, [
    { period: 48, seed: 91, amp: 0.4 }, { period: 96, seed: 5, amp: 0.5 }, { period: 220, seed: 61, amp: 0.8 },
  ]);
  const color = colorFromHeight(h, size, 0x6f6a61, C.concrete, true);
  const ctx = color.getContext('2d');
  ctx.strokeStyle = 'rgba(30,28,24,0.5)'; ctx.lineWidth = 3; // tar seams
  for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(0, (size / 4) * k); ctx.lineTo(size, (size / 4) * k + (Math.random() - .5) * 10); ctx.stroke(); }
  return { color, normal: normalCanvas(h, size, 1.2), rough: roughCanvas(h, size, 0.78, 0.95) };
}
function facade(size = 256) {
  const color = makeCanvas(size), ctx = color.getContext('2d');
  const hgt = makeCanvas(size), hc = hgt.getContext('2d');
  ctx.fillStyle = hex(C.concrete); ctx.fillRect(0, 0, size, size);
  hc.fillStyle = '#bbbbbb'; hc.fillRect(0, 0, size, size);
  // light concrete grain
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * size, y = Math.random() * size, a = Math.random() * 0.12;
    ctx.fillStyle = `rgba(${Math.random() < .5 ? '40,38,34' : '210,205,195'},${a})`;
    ctx.fillRect(x, y, 2, 2);
  }
  const cols = 4, rows = 4, pad = size * 0.06, cw = size / cols, ch = size / rows;
  for (let r = 0; r < rows; r++) for (let cI = 0; cI < cols; cI++) {
    const x = cI * cw + pad, y = r * ch + pad, w = cw - pad * 2, hh = ch - pad * 2;
    const broken = Math.random() < 0.22;
    const lit = !broken && Math.random() < 0.3;
    // window glass: dark, occasional warm dusk reflection
    const g = ctx.createLinearGradient(x, y, x + w, y + hh);
    if (lit) { g.addColorStop(0, '#3a2a18'); g.addColorStop(0.5, '#caa066'); g.addColorStop(1, '#241a10'); }
    else { g.addColorStop(0, broken ? '#0a0a0c' : '#23262b'); g.addColorStop(1, broken ? '#050507' : '#10141a'); }
    ctx.fillStyle = g; ctx.fillRect(x, y, w, hh);
    // recessed window in height map (darker = lower)
    hc.fillStyle = '#3a3a3a'; hc.fillRect(x, y, w, hh);
    hc.fillStyle = '#777'; hc.fillRect(x - 2, y - 2, w + 4, 2); hc.fillRect(x - 2, y + hh, w + 4, 2);
  }
  const h = canvasHeight(hgt);
  return { color, normal: normalCanvas(h, size, 2.4), rough: roughCanvas(h, size, 0.5, 0.85) };
}
function crate(size = 256) {
  const color = makeCanvas(size), ctx = color.getContext('2d');
  const hgt = makeCanvas(size), hc = hgt.getContext('2d');
  const planks = 5, pw = size / planks;
  for (let p = 0; p < planks; p++) {
    const base = 90 + Math.random() * 30;
    ctx.fillStyle = `rgb(${base + 30},${base},${base - 40})`;
    ctx.fillRect(p * pw, 0, pw, size);
    hc.fillStyle = '#b0b0b0'; hc.fillRect(p * pw, 0, pw, size);
    // grain streaks
    for (let i = 0; i < 60; i++) {
      const y = Math.random() * size, a = Math.random() * 0.18;
      ctx.fillStyle = `rgba(40,28,16,${a})`; ctx.fillRect(p * pw + 2, y, pw - 4, 1);
    }
    // plank gap
    ctx.fillStyle = 'rgba(20,12,6,0.9)'; ctx.fillRect(p * pw, 0, 2, size);
    hc.fillStyle = '#404040'; hc.fillRect(p * pw, 0, 3, size);
  }
  // rusty metal banding (top/bottom) — safety look
  ctx.fillStyle = hex(C.rust);
  ctx.fillRect(0, 0, size, size * 0.09); ctx.fillRect(0, size * 0.91, size, size * 0.09);
  hc.fillStyle = '#f0f0f0'; hc.fillRect(0, 0, size, size * 0.09); hc.fillRect(0, size * 0.91, size, size * 0.09);
  const h = canvasHeight(hgt);
  return { color, normal: normalCanvas(h, size, 2.0), rough: roughCanvas(h, size, 0.6, 0.9) };
}
function golfball(size = 256) {
  // height: flat-high with packed circular depressions = dimples
  const hgt = makeCanvas(size), hc = hgt.getContext('2d');
  hc.fillStyle = '#ffffff'; hc.fillRect(0, 0, size, size);
  const cells = 9, step = size / cells, rad = step * 0.46;
  for (let r = -1; r <= cells; r++) for (let cI = -1; cI <= cells; cI++) {
    const cx = cI * step + (r % 2 ? step * 0.5 : 0) + step * 0.5;
    const cy = r * step + step * 0.5;
    const g = hc.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, '#5a5a5a'); g.addColorStop(0.7, '#cfcfcf'); g.addColorStop(1, '#ffffff');
    hc.fillStyle = g; hc.beginPath(); hc.arc(cx, cy, rad, 0, Math.PI * 2); hc.fill();
  }
  const h = canvasHeight(hgt);
  const color = makeCanvas(size), cc = color.getContext('2d');
  cc.drawImage(hgt, 0, 0);                       // near-white with faint dimple shading
  cc.globalAlpha = 0.4; cc.fillStyle = '#f4f2ec'; cc.fillRect(0, 0, size, size); cc.globalAlpha = 1;
  return { color, normal: normalCanvas(h, size, 3.2), rough: roughCanvas(h, size, 0.32, 0.5) };
}
function zombieSkin(size = 128) {
  const h = fbmField(size, [{ period: 16, seed: 3, amp: 0.5 }, { period: 40, seed: 9, amp: 0.6 }, { period: 80, seed: 17, amp: 0.7 }]);
  const color = colorFromHeight(h, size, 0x4f5a38, C.zombieSkin, false);
  const ctx = color.getContext('2d');
  for (let i = 0; i < 30; i++) { // rot/wound blotches
    const x = Math.random() * size, y = Math.random() * size, rr = 3 + Math.random() * 8;
    ctx.fillStyle = Math.random() < 0.3 ? 'rgba(90,30,30,0.45)' : 'rgba(40,50,25,0.4)';
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
  }
  return { color, normal: normalCanvas(h, size, 1.0) };
}
function skyCanvas() {
  const w = 1024, hgt = 512, c = makeCanvas(2); c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, hgt);
  g.addColorStop(0, hex(C.skyTop));
  g.addColorStop(0.55, '#9a8478');
  g.addColorStop(0.8, hex(C.skyHorizon));
  g.addColorStop(1, '#caa06a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, hgt);
  // warm sun glow near horizon
  const sx = w * 0.7, sy = hgt * 0.78;
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 260);
  sg.addColorStop(0, 'rgba(255,240,200,0.95)'); sg.addColorStop(0.3, 'rgba(255,200,130,0.55)'); sg.addColorStop(1, 'rgba(255,200,130,0)');
  ctx.fillStyle = sg; ctx.fillRect(0, 0, w, hgt);
  // distant skyline silhouette along the bottom
  ctx.fillStyle = 'rgba(40,38,46,0.55)';
  let x = 0;
  while (x < w) {
    const bw = 18 + Math.random() * 46, bh = 30 + Math.random() * 150;
    ctx.fillRect(x, hgt - bh, bw, bh);
    // a few faint lit windows
    if (Math.random() < 0.5) {
      ctx.fillStyle = 'rgba(255,180,110,0.10)';
      for (let i = 0; i < 6; i++) ctx.fillRect(x + 4 + Math.random() * (bw - 8), hgt - bh + Math.random() * bh, 3, 3);
      ctx.fillStyle = 'rgba(40,38,46,0.55)';
    }
    x += bw + 3;
  }
  // smog haze band
  const hz = ctx.createLinearGradient(0, hgt * 0.6, 0, hgt);
  hz.addColorStop(0, 'rgba(216,168,120,0)'); hz.addColorStop(1, 'rgba(216,168,120,0.5)');
  ctx.fillStyle = hz; ctx.fillRect(0, hgt * 0.6, w, hgt * 0.4);
  return c;
}

// ---- public API ----
export function buildAssetCanvases() {
  return {
    asphalt: asphalt(), roof: roof(), facade: facade(), crate: crate(),
    golfball: golfball(), zombie: zombieSkin(), sky: skyCanvas(),
  };
}

export function tex(THREE, canvas, { srgb = false, repeat = [1, 1], aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// build a PBR MeshStandardMaterial from a {color,normal,rough} canvas set
export function pbrMaterial(THREE, set, { repeat = [1, 1], metalness = 0, roughness = 1, aniso = 8 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: tex(THREE, set.color, { srgb: true, repeat, aniso }),
    normalMap: set.normal ? tex(THREE, set.normal, { repeat, aniso }) : null,
    roughnessMap: set.rough ? tex(THREE, set.rough, { repeat, aniso }) : null,
    metalness, roughness,
  });
  if (set.normal) m.normalScale = new THREE.Vector2(1, 1);
  return m;
}
