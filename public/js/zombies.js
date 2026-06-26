// =============================================================
// Zombies — the whole horde is ONE InstancedMesh (one draw call).
// Wave spawning, shuffle toward the tower, hit-tests, area damage, death.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRNG, mergeGeometries } from './utils.js';
import { pbrMaterial } from './textures.js';

function buildZombieGeometry() {
  const parts = [];
  const push = (geo, x, y, z, rx = 0) => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
    parts.push({ geo, mat4: m });
  };
  // legs (feet at y=0)
  push(new THREE.BoxGeometry(0.5, 1.8, 0.5), 0.42, 0.9, 0);
  push(new THREE.BoxGeometry(0.5, 1.8, 0.5), -0.42, 0.9, 0);
  // torso
  push(new THREE.BoxGeometry(1.4, 1.7, 0.8), 0, 2.6, 0);
  // head
  push(new THREE.SphereGeometry(0.5, 12, 10), 0, 3.85, 0.05);
  // arms reaching forward (+Z)
  push(new THREE.BoxGeometry(0.36, 1.5, 0.36), 0.92, 3.0, 0.45, -1.25);
  push(new THREE.BoxGeometry(0.36, 1.5, 0.36), -0.92, 3.0, 0.45, -1.15);
  return mergeGeometries(THREE, parts); // height ~4.35
}

export class Zombies {
  constructor(scene, ctx) {
    this.ctx = ctx; // {game, audio, effects}
    this.max = CONFIG.zombieMaxAlive;
    this.rng = makeRNG(1337);

    const geo = buildZombieGeometry();
    const mat = pbrMaterial(THREE, ctx.assets.zombie, { roughness: 0.88, metalness: 0 });
    mat.color = new THREE.Color(0xffffff);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    this.z = [];
    const col = new THREE.Color();
    for (let i = 0; i < this.max; i++) {
      this.z.push({ alive: false, dying: false, deathT: 0, x: 0, zz: 0, yaw: 0, speed: 0, phase: 0, atBase: false, scale: 1 });
      const v = 0.8 + this.rng() * 0.5;
      col.setRGB(v, v * (0.9 + this.rng() * 0.2), v * 0.8);
      this.mesh.setColorAt(i, col);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.waveActive = false;
    this.toSpawn = 0;
    this.spawnTimer = 0;
    this.spawnInterval = 1;
    this.waveSpeed = CONFIG.zombieBaseSpeed;
  }

  get aliveCount() { let n = 0; for (const z of this.z) if (z.alive) n++; return n; }

  startWave(wave) {
    const surge = wave % CONFIG.surgeEvery === 0;
    let count = CONFIG.waveBaseCount + CONFIG.waveCountPerWave * wave;
    if (surge) count = Math.round(count * 1.5);
    this.toSpawn = count;
    this.spawnInterval = Math.max(CONFIG.spawnIntervalMin, CONFIG.spawnIntervalBase - wave * 0.05);
    this.waveSpeed = CONFIG.zombieBaseSpeed + CONFIG.zombieSpeedPerWave * wave + (surge ? 1.2 : 0);
    this.spawnTimer = 0;
    this.waveActive = true;
    return { count, surge };
  }

  _spawnOne() {
    const slot = this.z.find((z) => !z.alive && !z.dying);
    if (!slot) return;
    const ang = this.rng() * Math.PI * 2;
    const rad = CONFIG.spawnRadius + this.rng.range(-12, 12);
    slot.alive = true; slot.dying = false; slot.deathT = 0; slot.scale = 1; slot.atBase = false;
    slot.x = Math.cos(ang) * rad;
    slot.zz = Math.sin(ang) * rad;
    slot.speed = this.waveSpeed * this.rng.range(0.85, 1.15);
    slot.phase = this.rng() * Math.PI * 2;
    slot.yaw = Math.atan2(-slot.x, -slot.zz);
    this.toSpawn--;
  }

  hitTest(p, ballR) {
    const rr = ballR + CONFIG.zombieRadius;
    if (p.y > 5.2) return null;
    for (const z of this.z) {
      if (!z.alive) continue;
      const dx = p.x - z.x, dz = p.z - z.zz;
      if (dx * dx + dz * dz < rr * rr) return z;
    }
    return null;
  }

  damageArea(pos, r) {
    let killed = 0;
    const rr = r * r;
    for (const z of this.z) {
      if (!z.alive) continue;
      const dx = pos.x - z.x, dz = pos.z - z.zz;
      if (dx * dx + dz * dz < rr) { this.kill(z); killed++; }
    }
    return killed;
  }

  kill(z) {
    if (!z.alive) return;
    z.alive = false; z.dying = true; z.deathT = 0;
    this.ctx.effects.greenPuff(this._p.set(z.x, 1.4, z.zz));
  }

  reset() {
    for (const z of this.z) { z.alive = false; z.dying = false; }
    this.waveActive = false; this.toSpawn = 0;
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    // spawn
    if (this.waveActive && this.toSpawn > 0 && this.aliveCount < this.max) {
      this.spawnTimer += dt;
      if (this.spawnTimer >= this.spawnInterval) { this.spawnTimer = 0; this._spawnOne(); }
    }

    let attacking = 0;
    const bRad = CONFIG.buildingRadius;
    for (let i = 0; i < this.max; i++) {
      const z = this.z[i];
      if (z.alive) {
        z.phase += dt * (3 + z.speed * 0.3);
        const dist = Math.hypot(z.x, z.zz);
        if (dist > bRad) {
          const inv = z.speed * dt / (dist || 1);
          z.x -= z.x * inv; z.zz -= z.zz * inv;
          z.yaw = Math.atan2(-z.x, -z.zz);
        } else {
          attacking++;
          z.atBase = true;
        }
        const bob = Math.sin(z.phase) * 0.14;
        const lean = Math.sin(z.phase * 0.5) * 0.12;
        this._p.set(z.x, bob, z.zz);
        this._e.set(0, z.yaw, lean);
        this._q.setFromEuler(this._e);
        this._s.set(1, 1, 1);
        this._m.compose(this._p, this._q, this._s);
        this.mesh.setMatrixAt(i, this._m);
      } else if (z.dying) {
        z.deathT += dt;
        const t = z.deathT / 0.7;
        if (t >= 1) { z.dying = false; this.mesh.setMatrixAt(i, this._hidden); }
        else {
          const fall = t * (Math.PI / 2);
          const sink = -t * 0.4;
          const sc = 1 - t * 0.15;
          this._p.set(z.x, sink, z.zz);
          this._e.set(-fall, z.yaw, 0);
          this._q.setFromEuler(this._e);
          this._s.set(sc, sc, sc);
          this._m.compose(this._p, this._q, this._s);
          this.mesh.setMatrixAt(i, this._m);
        }
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    if (attacking > 0) {
      this.ctx.game.damageTower(attacking * CONFIG.zombieDamage * dt);
      if (Math.random() < dt * 1.5) this.ctx.audio.groan();
    } else if (this.aliveCount > 0 && Math.random() < dt * 0.6) {
      this.ctx.audio.groan();
    }

    // wave cleared?
    if (this.waveActive && this.toSpawn === 0 && this.aliveCount === 0) {
      this.waveActive = false;
      this.ctx.game.onWaveCleared();
    }
  }
}
