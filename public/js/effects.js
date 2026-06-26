// =============================================================
// Effects — pooled particles (one Points draw call), explosion flashes
// with a brief light, and ground shock rings. Zero per-frame allocation.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';

function softSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.cap = 520;
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.vel = new Float32Array(this.cap * 3);
    this.life = new Float32Array(this.cap);
    this.maxLife = new Float32Array(this.cap);
    this.base = new Float32Array(this.cap * 3);
    this.grav = new Float32Array(this.cap);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setDrawRange(0, this.cap);
    const mat = new THREE.PointsMaterial({
      size: 1.5, map: softSprite(), vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    for (let i = 0; i < this.cap; i++) this.pos[i * 3 + 1] = -9999;
    scene.add(this.points);

    // flash spheres + lights pool
    this.flashes = [];
    const fgeo = new THREE.SphereGeometry(1, 16, 12);
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(fgeo, new THREE.MeshBasicMaterial({
        color: CONFIG.col.explosive, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      mesh.visible = false; scene.add(mesh);
      const light = new THREE.PointLight(0xff8030, 0, 60, 2); scene.add(light);
      this.flashes.push({ mesh, light, t: -1 });
    }
    // shock rings pool
    this.rings = [];
    const rgeo = new THREE.RingGeometry(0.7, 1, 28);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({
        color: 0xffcaa0, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
      this.rings.push({ mesh: m, t: -1 });
    }
  }

  _emit(x, y, z, n, { r, g, b, speed, spread, life, gravity, up = 0 }) {
    for (let k = 0; k < n; k++) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.cap;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.sin(phi) * Math.cos(theta) * sp * spread;
      this.vel[i * 3 + 1] = Math.cos(phi) * sp * 0.6 + up;
      this.vel[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * sp * spread;
      const vary = 0.7 + Math.random() * 0.3;
      this.base[i * 3] = r * vary; this.base[i * 3 + 1] = g * vary; this.base[i * 3 + 2] = b * vary;
      this.life[i] = this.maxLife[i] = life * (0.7 + Math.random() * 0.5);
      this.grav[i] = gravity;
    }
  }

  explosion(p) {
    this._emit(p.x, p.y, p.z, 40, { r: 1.0, g: 0.5, b: 0.18, speed: 26, spread: 1, life: 0.8, gravity: 16, up: 4 });
    this._emit(p.x, p.y, p.z, 14, { r: 1.0, g: 0.9, b: 0.5, speed: 34, spread: 1, life: 0.45, gravity: 6, up: 6 });
    const f = this.flashes.find((x) => x.t < 0) || this.flashes[0];
    f.t = 0; f.mesh.visible = true; f.mesh.position.copy(p);
    f.light.position.set(p.x, p.y + 2, p.z);
    const r = this.rings.find((x) => x.t < 0) || this.rings[0];
    r.t = 0; r.mesh.visible = true; r.mesh.position.set(p.x, 0.3, p.z);
  }
  hit(p) { this._emit(p.x, p.y, p.z, 12, { r: 1, g: 1, b: 0.9, speed: 14, spread: 1, life: 0.35, gravity: 10, up: 2 }); }
  greenPuff(p) { this._emit(p.x, p.y, p.z, 14, { r: 0.5, g: 0.8, b: 0.3, speed: 10, spread: 1, life: 0.6, gravity: 6, up: 3 }); }
  dust(p) { this._emit(p.x, p.y + 0.3, p.z, 6, { r: 0.7, g: 0.62, b: 0.5, speed: 6, spread: 1, life: 0.5, gravity: 2, up: 1 }); }
  blood(x, y, z, mag = 8) {
    const n = Math.min(28, 8 + Math.floor(mag));
    this._emit(x, y, z, n, { r: 0.65, g: 0.08, b: 0.06, speed: 8 + mag * 0.4, spread: 1, life: 0.55, gravity: 22, up: 3 });
  }
  exhaust(x, y, z) { this._emit(x, y, z, 3, { r: 0.55, g: 0.55, b: 0.6, speed: 5, spread: 1, life: 0.4, gravity: -2, up: 0.5 }); }

  reset() {
    for (let i = 0; i < this.cap; i++) { this.life[i] = 0; this.pos[i * 3 + 1] = -9999; }
    for (const f of this.flashes) { f.t = -1; f.mesh.visible = false; f.light.intensity = 0; }
    for (const r of this.rings) { r.t = -1; r.mesh.visible = false; }
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0; continue; }
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.1) { this.pos[i * 3 + 1] = 0.1; this.vel[i * 3 + 1] *= -0.3; }
      const f = this.life[i] / this.maxLife[i];
      this.col[i * 3] = this.base[i * 3] * f;
      this.col[i * 3 + 1] = this.base[i * 3 + 1] * f;
      this.col[i * 3 + 2] = this.base[i * 3 + 2] * f;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;

    for (const f of this.flashes) {
      if (f.t < 0) continue;
      f.t += dt; const p = f.t / 0.4;
      if (p >= 1) { f.t = -1; f.mesh.visible = false; f.light.intensity = 0; continue; }
      const s = 2 + p * CONFIG.explosionRadius * 0.9;
      f.mesh.scale.setScalar(s);
      f.mesh.material.opacity = (1 - p) * 0.8;
      f.light.intensity = (1 - p) * 9;
    }
    for (const r of this.rings) {
      if (r.t < 0) continue;
      r.t += dt; const p = r.t / 0.6;
      if (p >= 1) { r.t = -1; r.mesh.visible = false; continue; }
      r.mesh.scale.setScalar(2 + p * CONFIG.explosionRadius);
      r.mesh.material.opacity = (1 - p) * 0.7;
    }
  }
}
