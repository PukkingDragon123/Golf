// =============================================================
// PostFX — EffectComposer bloom wrapper, and Shake — camera trauma + hit-stop.
// Two small independent classes (one import in main.js).
// =============================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from './config.js';

const BASE_EXPOSURE = 1.06;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;
    const cap = Math.min(window.devicePixelRatio || 1, CONFIG.bloom.pixelRatioCap);
    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(cap);
    this.composer.setSize(innerWidth, innerHeight);
    this.composer.addPass(new RenderPass(scene, camera));
    const res = new THREE.Vector2(innerWidth, innerHeight);
    this.bloom = new UnrealBloomPass(res, CONFIG.bloom.strength, CONFIG.bloom.radius, CONFIG.bloom.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass()); // ACES tonemap + sRGB happen here now
    this._boomT = 0;
  }

  setCamera(camera) {
    this.camera = camera;
    for (const p of this.composer.passes) if (p.camera) p.camera = camera;
  }

  resize() {
    const cap = Math.min(window.devicePixelRatio || 1, CONFIG.bloom.pixelRatioCap);
    this.composer.setPixelRatio(cap);
    this.composer.setSize(innerWidth, innerHeight);
    this.bloom.resolution.set(innerWidth, innerHeight);
  }

  boomPulse() { this._boomT = 1; }

  render(dt) {
    if (this._boomT > 0) {
      this._boomT = Math.max(0, this._boomT - (dt || 0.016) * 3);
      this.bloom.strength = CONFIG.bloom.strength + this._boomT * 0.5;
      this.renderer.toneMappingExposure = BASE_EXPOSURE + this._boomT * CONFIG.bloom.exposureBoostOnBoom;
    }
    this.composer.render();
  }
}

// ---- coherent 1-D value noise (deterministic-looking, not white static) ----
function makeNoise1D(seed) {
  const N = 256, g = new Float32Array(N);
  let s = seed >>> 0;
  for (let i = 0; i < N; i++) { s = (s * 1664525 + 1013904223) >>> 0; g[i] = (s / 4294967296) * 2 - 1; }
  return (x) => {
    const i = Math.floor(x), f = x - i, a = g[i & 255], b = g[(i + 1) & 255];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

export class Shake {
  constructor() {
    this.trauma = 0;
    this.hitStopT = 0;
    this.hitStopDur = 0;
    this.time = 0;
    this.n = [makeNoise1D(1), makeNoise1D(7), makeNoise1D(31), makeNoise1D(101), makeNoise1D(257), makeNoise1D(523)];
  }
  reset() { this.trauma = 0; this.hitStopT = 0; this.hitStopDur = 0; this.time = 0; }
  addTrauma(amt) { this.trauma = Math.min(CONFIG.shake.traumaMax, this.trauma + amt); }
  hitStop(ms) { const d = ms / 1000; if (d > this.hitStopT) { this.hitStopT = d; this.hitStopDur = d; } }

  // ticks trauma decay + hit-stop using REAL dt; returns sim time-scale for this frame
  advance(realDt) {
    this.time += realDt;
    this.trauma = Math.max(0, this.trauma - CONFIG.shake.decay * realDt);
    let scale = 1;
    if (this.hitStopT > 0) {
      this.hitStopT = Math.max(0, this.hitStopT - realDt);
      const frac = this.hitStopDur > 0 ? this.hitStopT / this.hitStopDur : 0; // 1→0
      // hard dip, ramp back up over the last 40%
      scale = frac > 0.4 ? CONFIG.shake.minHitStopScale
        : CONFIG.shake.minHitStopScale + (1 - CONFIG.shake.minHitStopScale) * (1 - frac / 0.4);
    }
    return scale;
  }

  applyToCamera(camera) {
    if (this.trauma <= 0.0001) return;
    const s = this.trauma * this.trauma;
    const C = CONFIG.shake, t = this.time * C.freq;
    camera.rotateX(C.maxPitch * s * this.n[0](t));
    camera.rotateY(C.maxYaw * s * this.n[1](t + 13));
    camera.rotateZ(C.maxRoll * s * this.n[2](t + 29));
    camera.position.x += C.maxOffset * s * this.n[3](t + 53);
    camera.position.y += C.maxOffset * s * this.n[4](t + 71);
    camera.position.z += C.maxOffset * s * this.n[5](t + 97);
  }
}
