// =============================================================
// Gore — the visceral layer that complements Effects (which is purely
// additive sparks). Dark blood particle bursts (1 Points draw), a persistent
// ground blood-decal canvas (1 plane draw, fades to equilibrium), and flying
// gore chunks (1 InstancedMesh). 3 draw calls, constant. Zero per-frame alloc.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { TAU } from './utils.js';

const G = CONFIG.gore;

function bloodSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(120,12,12,1)');
  g.addColorStop(0.5, 'rgba(90,6,6,0.55)');
  g.addColorStop(1, 'rgba(70,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Gore {
  constructor(scene, ctx) {
    this.ctx = ctx;

    // ---- blood particles (normal-blended, dark) ----
    this.cap = G.particleCap;
    this.pos = new Float32Array(this.cap * 3);
    this.vel = new Float32Array(this.cap * 3);
    this.life = new Float32Array(this.cap);
    this.maxLife = new Float32Array(this.cap);
    this.cursor = 0;
    for (let i = 0; i < this.cap; i++) this.pos[i * 3 + 1] = -9999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const mat = new THREE.PointsMaterial({
      size: G.particleSize, map: bloodSprite(), color: G.bloodColor,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
      sizeAttenuation: true, opacity: 0.95,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // ---- persistent ground decal layer ----
    this.S = G.decalWorldSize; this.R = G.decalRes; this.half = this.S / 2;
    this.canvas = document.createElement('canvas'); this.canvas.width = this.canvas.height = this.R;
    this.dctx = this.canvas.getContext('2d');
    this.dctx.clearRect(0, 0, this.R, this.R);
    this.decalTex = new THREE.CanvasTexture(this.canvas);
    this.decalTex.colorSpace = THREE.SRGBColorSpace;
    const dmat = new THREE.MeshBasicMaterial({
      map: this.decalTex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true,
    });
    this.decalPlane = new THREE.Mesh(new THREE.PlaneGeometry(this.S, this.S, 1, 1), dmat);
    this.decalPlane.rotation.x = -Math.PI / 2;
    this.decalPlane.position.y = G.decalY;
    this.decalPlane.renderOrder = 2;
    this.decalPlane.frustumCulled = false;
    scene.add(this.decalPlane);
    this._dirty = true; this._ink = 0; this._fadeAcc = 0;

    // ---- flying gore chunks ----
    const N = G.chunkCap;
    const cmat = new THREE.MeshStandardMaterial({ color: G.chunkColor, roughness: 0.85, metalness: 0 });
    this.chunkMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.32, 0), cmat, N);
    this.chunkMesh.frustumCulled = false; this.chunkMesh.castShadow = false;
    this.chunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.chunkMesh);
    this.chunks = [];
    for (let i = 0; i < N; i++) this.chunks.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, ax: 0, ay: 0, az: 0, scale: 0.5, life: 0, splatted: false });
    this.chunkCursor = 0;

    // scratch
    this._cm = new THREE.Matrix4(); this._cq = new THREE.Quaternion(); this._ce = new THREE.Euler();
    this._cv = new THREE.Vector3(); this._cs = new THREE.Vector3(); this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) this.chunkMesh.setMatrixAt(i, this._hidden);
    this.chunkMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- emission ----
  burst(pos, amount = 1, dx = 0, dz = 0) {
    amount = Math.min(4, amount);
    const n = Math.round(G.burstBase * amount);
    const hasDir = (dx || dz);
    let ndx = dx, ndz = dz;
    if (hasDir) { const m = Math.hypot(dx, dz) || 1; ndx = dx / m; ndz = dz / m; }
    const speed = G.burstSpeed * (0.6 + amount * 0.2);
    for (let k = 0; k < n; k++) {
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.cap;
      this.pos[i * 3] = pos.x; this.pos[i * 3 + 1] = pos.y; this.pos[i * 3 + 2] = pos.z;
      const theta = Math.random() * TAU, phi = Math.acos(2 * Math.random() - 1);
      let bx = Math.sin(phi) * Math.cos(theta), by = Math.cos(phi), bz = Math.sin(phi) * Math.sin(theta);
      if (hasDir) { bx = bx * 0.4 + ndx * 0.6; bz = bz * 0.4 + ndz * 0.6; by = by * 0.5 + 0.4; }
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = bx * sp; this.vel[i * 3 + 1] = by * sp * 0.6 + 3; this.vel[i * 3 + 2] = bz * sp;
      this.life[i] = this.maxLife[i] = 0.5 * (0.7 + Math.random() * 0.5);
    }
    this.splatXZ(pos.x, pos.z, 0.4 * amount);
  }

  splat(pos, size = 1) { this.splatXZ(pos.x, pos.z, size); }
  dropSplat(pos) { if (Math.random() < 0.4) this.splatXZ(pos.x, pos.z, 0.3); }

  splatXZ(wx, wz, size) {
    if (wx < -this.half || wx > this.half || wz < -this.half || wz > this.half) return;
    const u = (wx + this.half) / this.S, v = (wz + this.half) / this.S;
    const px = u * this.R, py = (1 - v) * this.R;
    const r = G.splatBaseRadiusPx * size * (0.7 + Math.random() * 0.6);
    const d = this.dctx;
    const g = d.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(122,12,10,0.78)'); g.addColorStop(0.55, 'rgba(96,6,6,0.55)'); g.addColorStop(1, 'rgba(70,0,0,0)');
    d.fillStyle = g; d.beginPath(); d.arc(px, py, r, 0, TAU); d.fill();
    const sat = 2 + Math.floor(Math.random() * 3);
    d.fillStyle = 'rgba(92,5,5,0.5)';
    for (let k = 0; k < sat; k++) {
      const a = Math.random() * TAU, dd = r * (0.6 + Math.random() * 0.9), rr = r * (0.12 + Math.random() * 0.22);
      d.beginPath(); d.arc(px + Math.cos(a) * dd, py + Math.sin(a) * dd, rr, 0, TAU); d.fill();
    }
    this._dirty = true; this._ink += size;
  }

  chunk(pos, vx, vy, vz) {
    const i = this.chunkCursor; this.chunkCursor = (i + 1) % this.chunks.length;
    const c = this.chunks[i];
    c.active = true; c.x = pos.x; c.y = pos.y; c.z = pos.z;
    c.vx = vx + (Math.random() - 0.5) * 4; c.vy = vy + 2 + Math.random() * 3; c.vz = vz + (Math.random() - 0.5) * 4;
    c.rx = Math.random() * TAU; c.ry = Math.random() * TAU; c.rz = Math.random() * TAU;
    c.ax = (Math.random() - 0.5) * 12; c.ay = (Math.random() - 0.5) * 12; c.az = (Math.random() - 0.5) * 12;
    c.scale = G.chunkScale * (0.7 + Math.random() * 0.7); c.life = G.chunkLife * (0.8 + Math.random() * 0.5); c.splatted = false;
  }

  killGore(pos, dx = 0, dz = 0, severity = 1) {
    this.burst(pos, severity, dx, dz);
    this.splat(pos, 0.9 * severity);
    const n = Math.round(G.chunksPerKill * severity);
    const m = Math.hypot(dx, dz) || 1; const ndx = (dx / m), ndz = (dz / m);
    for (let k = 0; k < n; k++) {
      const sp = G.chunkSpeed * severity * (0.6 + Math.random() * 0.6);
      this.chunk(pos, (dx ? ndx : (Math.random() - 0.5) * 2) * sp, 4, (dz ? ndz : (Math.random() - 0.5) * 2) * sp);
    }
  }
  dismemberGore(pos, dx = 0, dz = 0) { this.killGore(pos, dx, dz, 1.5); }

  reset() {
    for (let i = 0; i < this.cap; i++) { this.life[i] = 0; this.pos[i * 3 + 1] = -9999; }
    this.points.geometry.attributes.position.needsUpdate = true;
    for (const c of this.chunks) c.active = false;
    for (let i = 0; i < this.chunks.length; i++) this.chunkMesh.setMatrixAt(i, this._hidden);
    this.chunkMesh.instanceMatrix.needsUpdate = true;
    this.dctx.clearRect(0, 0, this.R, this.R); this._ink = 0; this._fadeAcc = 0; this._dirty = true;
  }

  update(dt) {
    const g = CONFIG.gravity;
    // particles
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; continue; }
      this.vel[i * 3 + 1] -= g * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < G.groundY) {
        this.pos[i * 3 + 1] = G.groundY; this.vel[i * 3 + 1] *= -0.18; this.vel[i * 3] *= 0.55; this.vel[i * 3 + 2] *= 0.55;
        if (this.life[i] > 0.04 && Math.random() < G.dropSplatChance) this.splatXZ(this.pos[i * 3], this.pos[i * 3 + 2], 0.35);
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;

    // chunks
    let cdirty = false;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i]; if (!c.active) continue;
      cdirty = true; c.life -= dt;
      if (c.life <= 0) { c.active = false; this.chunkMesh.setMatrixAt(i, this._hidden); continue; }
      c.vy -= g * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      if (c.y < G.chunkGroundY) {
        c.y = G.chunkGroundY; c.vy *= -0.25; c.vx *= 0.6; c.vz *= 0.6; c.ax *= 0.5; c.ay *= 0.5; c.az *= 0.5;
        if (!c.splatted) { c.splatted = true; this.splatXZ(c.x, c.z, 0.5); }
      }
      c.rx += c.ax * dt; c.ry += c.ay * dt; c.rz += c.az * dt;
      this._ce.set(c.rx, c.ry, c.rz); this._cq.setFromEuler(this._ce);
      this._cm.compose(this._cv.set(c.x, c.y, c.z), this._cq, this._cs.set(c.scale, c.scale, c.scale));
      this.chunkMesh.setMatrixAt(i, this._cm);
    }
    if (cdirty) this.chunkMesh.instanceMatrix.needsUpdate = true;

    // decal fade toward equilibrium
    if (this._ink > G.inkFadeThreshold) {
      this._fadeAcc += dt;
      if (this._fadeAcc >= G.fadeInterval) {
        this._fadeAcc = 0;
        this.dctx.globalCompositeOperation = 'destination-out';
        this.dctx.fillStyle = `rgba(0,0,0,${G.fadeAlpha})`;
        this.dctx.fillRect(0, 0, this.R, this.R);
        this.dctx.globalCompositeOperation = 'source-over';
        this._ink *= (1 - G.fadeAlpha * 2); this._dirty = true;
      }
    }
    if (this._dirty) { this.decalTex.needsUpdate = true; this._dirty = false; }
  }
}
