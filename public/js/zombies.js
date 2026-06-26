// =============================================================
// Zombies — articulated horde rendered as INSTANCED BODY PARTS.
// 11 part InstancedMeshes + 1 debris mesh = 12 draw calls for any count.
// Per-frame forward kinematics over a tiny per-zombie skeleton; 3 types;
// multi-hit HP; ragdoll death; dismemberment. Zero per-frame allocation.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRNG, clamp, damp, angleDelta } from './utils.js';
import { pbrMaterial } from './textures.js';

const HIP = 2.05;            // rest hip-pivot height @ scale 1
const ONE = new THREE.Vector3(1, 1, 1);
const HALF_PI = Math.PI / 2;

// part slot indices
const HEAD = 0, TORSO = 1, PELVIS = 2, UARML = 3, UARMR = 4, LARML = 5, LARMR = 6, ULEGL = 7, ULEGR = 8, LLEGL = 9, LLEGR = 10;

function makePose() {
  return { spineBend: 0.42, headYaw: 0, headPitch: -0.25, shLp: -1.15, shLr: -0.18, shRp: -1.15, shRr: 0.18,
    elbowL: 0.55, elbowR: 0.55, hipLp: 0, hipRp: 0, kneeL: 0.15, kneeR: 0.15, bob: 0, lean: 0 };
}

export class Zombies {
  constructor(scene, ctx) {
    this.ctx = ctx;
    this.max = CONFIG.zombieMaxAlive;
    this.rng = makeRNG(1337);
    const mat = pbrMaterial(THREE, ctx.assets.zombie, { roughness: 0.9, metalness: 0 });
    mat.color = new THREE.Color(0xffffff);
    this.mat = mat;

    // ---- part geometries (local origin = proximal joint) ----
    const gHead = new THREE.SphereGeometry(0.5, 12, 10); gHead.translate(0, 0.32, 0);
    const gTorso = new THREE.BoxGeometry(1.30, 1.55, 0.78); gTorso.translate(0, 0.775, 0);
    const gPelvis = new THREE.BoxGeometry(1.15, 0.55, 0.72);
    const gUArm = new THREE.BoxGeometry(0.34, 0.98, 0.34); gUArm.translate(0, -0.49, 0);
    const gLArm = new THREE.BoxGeometry(0.30, 0.92, 0.30); gLArm.translate(0, -0.46, 0);
    const gULeg = new THREE.BoxGeometry(0.42, 1.10, 0.44); gULeg.translate(0, -0.55, 0);
    const gLLeg = new THREE.BoxGeometry(0.40, 1.05, 0.42); gLLeg.translate(0, -0.525, 0);
    const geos = [gHead, gTorso, gPelvis, gUArm, gUArm, gLArm, gLArm, gULeg, gULeg, gLLeg, gLLeg];

    this.parts = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, this.max);
      m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    });

    // ---- debris pool (one instanced mesh) ----
    const gChunk = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    this.debrisMesh = new THREE.InstancedMesh(gChunk, mat, CONFIG.maxDebris);
    this.debrisMesh.frustumCulled = false; this.debrisMesh.castShadow = false;
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.debrisMesh);
    this.debris = [];
    for (let i = 0; i < CONFIG.maxDebris; i++)
      this.debris.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, rx: 0, ry: 0, rz: 0, life: 0, s: CONFIG.gore.chunkScale });

    // ---- per-zombie state pool ----
    this.z = [];
    for (let i = 0; i < this.max; i++) {
      this.z.push({
        alive: false, dying: false, hidden: true, type: 0, scale: 1, speedMul: 1, gait: 0, weight: 0,
        x: 0, zz: 0, yaw: 0, speed: 0, phase: 0, atkT: 0, flinchT: 0, hitSign: 1, hitT: 0,
        atBase: false, hp: 2, hpMax: 2, slow: 1, detach: 0,
        pose: makePose(), frozen: makePose(),
        rag: { angle: 0, angVel: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: false, settleT: 0, fade: 1, age: 0 },
        limbLag: new Float32Array(8), limbVel: new Float32Array(8),
      });
    }
    this._rp = makePose();

    // scratch
    this._m = new THREE.Matrix4(); this._mRoot = new THREE.Matrix4(); this._mJoint = new THREE.Matrix4();
    this._mShL = new THREE.Matrix4(); this._mShR = new THREE.Matrix4(); this._mHipL = new THREE.Matrix4();
    this._mHipR = new THREE.Matrix4(); this._mLocal = new THREE.Matrix4();
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._v = new THREE.Vector3(); this._sv = new THREE.Vector3();
    this._col = new THREE.Color(); this._p = new THREE.Vector3();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);

    this.reset();

    this.waveActive = false; this.toSpawn = 0; this.spawnTimer = 0;
    this.spawnInterval = 1; this.waveSpeed = CONFIG.zombieBaseSpeed;
    this.runnerChance = 0.12; this.bruteChance = 0;
  }

  get aliveCount() { let n = 0; for (const z of this.z) if (z.alive) n++; return n; }
  _dyingCount() { let n = 0; for (const z of this.z) if (z.dying) n++; return n; }

  reset() {
    for (let i = 0; i < this.max; i++) {
      const z = this.z[i]; z.alive = false; z.dying = false; z.hidden = true; z.detach = 0;
      this._hideZombie(i);
    }
    for (const d of this.debris) { d.active = false; }
    for (let i = 0; i < CONFIG.maxDebris; i++) this.debrisMesh.setMatrixAt(i, this._hidden);
    this._flush();
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    this.waveActive = false; this.toSpawn = 0;
  }

  _hideZombie(i) { for (let s = 0; s < 11; s++) this.parts[s].setMatrixAt(i, this._hidden); }
  _flush() { for (let s = 0; s < 11; s++) this.parts[s].instanceMatrix.needsUpdate = true; }

  startWave(wave) {
    const surge = wave % CONFIG.surgeEvery === 0;
    let count = CONFIG.waveBaseCount + CONFIG.waveCountPerWave * wave;
    if (surge) count = Math.round(count * 1.5);
    this.toSpawn = count;
    this.spawnInterval = Math.max(CONFIG.spawnIntervalMin, CONFIG.spawnIntervalBase - wave * 0.05);
    this.waveSpeed = CONFIG.zombieBaseSpeed + CONFIG.zombieSpeedPerWave * wave;
    this.runnerChance = clamp(0.12 + wave * 0.04, 0, 0.45) + (surge ? 0.15 : 0);
    this.bruteChance = wave >= 3 ? clamp(0.04 + (wave - 3) * 0.025, 0, 0.22) : 0;
    this.spawnTimer = 0; this.waveActive = true;
    return { count, surge };
  }

  _pickType() {
    const r = this.rng();
    if (this.bruteChance > 0 && r < this.bruteChance) return 2;
    if (r < this.bruteChance + this.runnerChance) return 1;
    return 0;
  }

  spawn(typeName) {
    const z = this.z.find((s) => !s.alive && !s.dying);
    if (!z) return;
    const ti = typeName ? CONFIG.zombieTypes.findIndex((t) => t.name === typeName) : this._pickType();
    const t = CONFIG.zombieTypes[ti < 0 ? 0 : ti];
    const ang = this.rng() * Math.PI * 2;
    const rad = CONFIG.spawnRadius + this.rng.range(-12, 12);
    z.alive = true; z.dying = false; z.hidden = false; z.detach = 0;
    z.type = ti < 0 ? 0 : ti; z.scale = t.scale; z.speedMul = t.speedMul; z.gait = t.gait === 'run' ? 1 : 0; z.weight = t.weight;
    z.hpMax = t.health; z.hp = t.health; z.slow = 1; z.flinchT = 0; z.atkT = 0; z.atBase = false; z.hitT = 0;
    z.x = Math.cos(ang) * rad; z.zz = Math.sin(ang) * rad;
    z.speed = this.waveSpeed * t.speedMul * this.rng.range(0.9, 1.1);
    z.phase = this.rng() * Math.PI * 2;
    z.yaw = Math.atan2(-z.x, -z.zz);
    const i = this.z.indexOf(z);
    const v = 0.85 + this.rng() * 0.25;
    this._col.setRGB(t.tintR * v, t.tintG * v, t.tintB * v);
    for (let s = 0; s < 11; s++) this.parts[s].setColorAt(i, this._col);
    for (let s = 0; s < 11; s++) if (this.parts[s].instanceColor) this.parts[s].instanceColor.needsUpdate = true;
    this.toSpawn--;
  }

  // ---- collision API ----
  hitTest(p, ballR) {
    if (p.y > 7.2) return null;
    for (const z of this.z) {
      if (!z.alive) continue;
      const rr = ballR + CONFIG.zombieRadius * z.scale;
      const dx = p.x - z.x, dz = p.z - z.zz;
      if (dx * dx + dz * dz < rr * rr) return z;
    }
    return null;
  }
  // ground-plane test for projectiles (turrets)
  hitTestAt(x, z0, r) {
    for (const z of this.z) {
      if (!z.alive) continue;
      const rr = r + CONFIG.zombieRadius * z.scale;
      const dx = x - z.x, dz = z0 - z.zz;
      if (dx * dx + dz * dz < rr * rr) return z;
    }
    return null;
  }

  _damage(z, dmg, dx, dz, opts) {
    if (!z.alive) return false;
    z.hp -= dmg;
    const push = (opts.knockback != null ? opts.knockback : dmg * 0.4) * (1 - z.weight);
    z.x += dx * push * 0.15; z.zz += dz * push * 0.15;
    if (z.hp <= 0) {
      this.kill(z, { dirX: dx, dirZ: dz, impulse: opts.knockback != null ? opts.knockback : dmg * 1.2, dismember: opts.dismember, ragVel: opts.ragVel, flat: opts.flat });
      return true;
    }
    z.flinchT = 0.22;
    z.hitSign = (dx * Math.sin(z.yaw) + dz * Math.cos(z.yaw)) >= 0 ? 1 : -1;
    this.ctx.effects.hit(this._p.set(z.x, 2.0 * z.scale, z.zz));
    this.ctx.gore?.burst(this._p.set(z.x, 2.2 * z.scale, z.zz), 0.6, dx, dz);
    return false;
  }

  // golf ball / pellet (damage per-weapon; sever chance if fast)
  hitBall(z, p, ballVel, dmg = CONFIG.ballDamage) {
    const sp = ballVel.length();
    let dx = ballVel.x, dz = ballVel.z; const m = Math.hypot(dx, dz) || 1; dx /= m; dz /= m;
    return this._damage(z, dmg, dx, dz, { dismember: sp > CONFIG.dismemberBallSpeed, knockback: 3 });
  }
  // turret / generic fractional damage
  damage(z, amount) { return this._damage(z, amount, 0, 0, { knockback: 1 }); }

  damageArea(pos, r, opts) {
    let killed = 0; const rr = r * r; const dmg = (opts && opts.dmg) || CONFIG.explosionDamage;
    for (const z of this.z) {
      if (!z.alive) continue;
      const dx = z.x - pos.x, dz = z.zz - pos.z; const d2 = dx * dx + dz * dz;
      if (d2 < rr) {
        const d = Math.sqrt(d2) || 1;
        if (this._damage(z, dmg, dx / d, dz / d, { dismember: true, knockback: 14 })) killed++;
      }
    }
    return killed;
  }

  runOver(z, vx, vy, vz) {
    if (!z.alive) return;
    const m = Math.hypot(vx, vz) || 1;
    this._damage(z, CONFIG.runoverDamage, vx / m, vz / m, { dismember: true, knockback: 16, ragVel: { vx, vy, vz }, flat: true });
  }

  kill(z, opts = {}) {
    if (!z.alive) return;
    z.alive = false;
    const sc = z.scale;
    this.ctx.effects.greenPuff(this._p.set(z.x, 1.6 * sc, z.zz));
    const dx = opts.dirX || 0, dz = opts.dirZ || 0;
    this.ctx.gore?.killGore(this._p.set(z.x, 1.8 * sc, z.zz), dx, dz, opts.dismember ? 2 : 1);
    this.ctx.audio.groan();

    if (this._dyingCount() >= CONFIG.maxRagdolls) { z.dying = false; z.hidden = true; this._hideZombie(this.z.indexOf(z)); return; }

    z.dying = true;
    Object.assign(z.frozen, z.pose);
    const r = z.rag;
    r.x = z.x; r.z = z.zz; r.y = HIP * sc; r.angle = 0; r.onGround = false; r.settleT = 0; r.fade = 1; r.age = 0; r.lean = 0;
    const imp = (opts.impulse || 6) * (1 - z.weight);
    if (opts.ragVel) { r.vx = opts.ragVel.vx * (1 - z.weight); r.vy = opts.ragVel.vy; r.vz = opts.ragVel.vz * (1 - z.weight); }
    else { r.vx = dx * imp * 0.3; r.vz = dz * imp * 0.3; r.vy = (opts.flat ? 1.5 : 3 + this.rng() * 2); }
    const along = dx * Math.sin(z.yaw) + dz * Math.cos(z.yaw);
    r.angVel = (along >= 0 ? 1 : -1) * (2.2 + imp * 0.15) * (opts.flat ? 1.8 : 1);
    z.limbLag.fill(0); z.limbVel.fill(0);
    if (opts.dismember) this._dismember(z, dx, dz, opts.flat ? 2 : 1 + (this.rng() < 0.5 ? 1 : 0));
  }

  _dismember(z, dx, dz, count) {
    const leaves = [HEAD, LARML, LARMR, LLEGL, LLEGR, UARML, UARMR];
    let done = 0;
    for (let k = 0; k < leaves.length && done < count; k++) {
      const slot = leaves[k]; const bit = 1 << slot;
      if (z.detach & bit) continue;
      z.detach |= bit; done++;
      const d = this.debris.find((x) => !x.active);
      if (!d) continue;
      d.active = true; d.s = CONFIG.gore.chunkScale * z.scale * (slot === HEAD ? 1.0 : 1.4);
      d.x = z.x + (this.rng() - 0.5); d.y = 2.4 * z.scale; d.z = z.zz + (this.rng() - 0.5);
      const sp = 6 + this.rng() * 6;
      d.vx = dx * sp + (this.rng() - 0.5) * 5; d.vz = dz * sp + (this.rng() - 0.5) * 5; d.vy = 4 + this.rng() * 5;
      d.ax = (this.rng() - 0.5) * 12; d.ay = (this.rng() - 0.5) * 12; d.az = (this.rng() - 0.5) * 12;
      d.rx = d.ry = d.rz = 0; d.life = CONFIG.ragdollLife + this.rng();
      this.ctx.gore?.chunk(this._p.set(d.x, d.y, d.z), d.vx, d.vy, d.vz);
    }
    this.ctx.gore?.burst(this._p.set(z.x, 2.2 * z.scale, z.zz), 1.6, dx, dz);
  }

  // ---------- animation ----------
  _anim(z, dt) {
    const P = z.pose;
    const cycleRate = z.atBase ? 0 : (z.gait === 1 ? 8.5 + z.speed * 0.5 : 4.0 + z.speed * 0.35);
    z.phase += dt * cycleRate;
    const t = z.phase, s = Math.sin(t);

    if (z.atBase) {
      z.atkT += dt; const period = 1.1; if (z.atkT > period) z.atkT -= period;
      const u = z.atkT / period, lunge = Math.sin(u * Math.PI);
      P.bob = 0; P.lean = 0;
      P.spineBend = 0.40 + lunge * 0.45;
      const shB = -1.9 - lunge * 0.6; P.shLp = shB; P.shRp = shB; P.shLr = -0.1; P.shRr = 0.1;
      P.elbowL = 0.3 + (1 - lunge) * 0.8; P.elbowR = P.elbowL;
      P.hipLp = lunge * 0.25; P.hipRp = -lunge * 0.15; P.kneeL = 0.2; P.kneeR = 0.2;
      P.headPitch = damp(P.headPitch, lunge * 0.3, 8, dt);
    } else if (z.gait === 1) {
      P.bob = Math.abs(s) * 0.16 * z.scale; P.lean = Math.sin(t * 0.5) * 0.08;
      P.spineBend = 0.62 + Math.sin(t * 0.5) * 0.04;
      P.hipLp = s * 1.05; P.hipRp = Math.sin(t + Math.PI) * 1.05;
      P.kneeL = Math.max(0, -s) * 1.4 + 0.2; P.kneeR = Math.max(0, -Math.sin(t + Math.PI)) * 1.4 + 0.2;
      const shB = -0.6; P.shLp = shB + Math.sin(t + Math.PI) * 0.9; P.shRp = shB + s * 0.9;
      P.shLr = -0.12; P.shRr = 0.12; P.elbowL = 1.1; P.elbowR = 1.1;
    } else {
      P.bob = Math.abs(s) * 0.10 * z.scale - 0.05; P.lean = Math.sin(t * 0.5) * 0.10;
      P.spineBend = 0.42 + Math.sin(t * 0.5) * 0.05;
      P.hipLp = s * 0.55; P.hipRp = Math.sin(t + Math.PI) * 0.55;
      P.kneeL = Math.max(0, -s) * 0.9 + 0.15; P.kneeR = Math.max(0, -Math.sin(t + Math.PI)) * 0.9 + 0.15;
      const shB = -1.15; P.shLp = shB + Math.sin(t + Math.PI) * 0.18; P.shRp = shB + s * 0.18;
      P.shLr = -0.18; P.shRr = 0.18; P.elbowL = 0.55 + s * 0.10; P.elbowR = 0.55 + Math.sin(t + Math.PI) * 0.10;
    }

    // head tracking the rooftop player
    const pl = this.ctx.player.pos;
    const ang = Math.atan2(pl.x - z.x, pl.z - z.zz);
    const tgt = clamp(angleDelta(z.yaw, ang), -CONFIG.headTrackMax, CONFIG.headTrackMax);
    P.headYaw = damp(P.headYaw, tgt, 8, dt);
    if (!z.atBase) P.headPitch = damp(P.headPitch, -0.25, 8, dt);

    // flinch overlay
    if (z.flinchT > 0) {
      z.flinchT -= dt; const k = Math.max(0, z.flinchT / 0.22);
      P.spineBend += k * 0.5 * z.hitSign; P.headPitch += k * 0.4;
      P.shLp += k * 0.5; P.shRp += k * 0.5;
    }
  }

  // hoisted (no per-frame closure): write one part's instance matrix, hidden if detached
  _setPart(i, detach, slot, mtx) { this.parts[slot].setMatrixAt(i, (detach & (1 << slot)) ? this._hidden : mtx); }

  // write the 11 part matrices for zombie i from a pose P + root frame
  _writeFK(i, z, P, rx, ry, rz, rootX, rootY, rootZ, scl) {
    const detach = z.detach;
    this._q.setFromEuler(this._e.set(rx, ry, rz));
    this._mRoot.compose(this._v.set(rootX, rootY, rootZ), this._q, this._sv.set(scl, scl, scl));

    this._setPart(i, detach, PELVIS, this._mRoot);
    this._lm(0, 0.15, 0, P.spineBend, 0, 0); this._mJoint.multiplyMatrices(this._mRoot, this._mLocal); this._setPart(i, detach, TORSO, this._mJoint);
    this._lm(0, 1.55, 0, P.headPitch, P.headYaw, 0); this._m.multiplyMatrices(this._mJoint, this._mLocal); this._setPart(i, detach, HEAD, this._m);
    this._lm(0.62, 1.35, 0, P.shLp, 0, P.shLr); this._mShL.multiplyMatrices(this._mJoint, this._mLocal); this._setPart(i, detach, UARML, this._mShL);
    this._lm(0, -0.95, 0, P.elbowL, 0, 0); this._m.multiplyMatrices(this._mShL, this._mLocal); this._setPart(i, detach, LARML, this._m);
    this._lm(-0.62, 1.35, 0, P.shRp, 0, P.shRr); this._mShR.multiplyMatrices(this._mJoint, this._mLocal); this._setPart(i, detach, UARMR, this._mShR);
    this._lm(0, -0.95, 0, P.elbowR, 0, 0); this._m.multiplyMatrices(this._mShR, this._mLocal); this._setPart(i, detach, LARMR, this._m);
    this._lm(0.34, -0.20, 0, P.hipLp, 0, 0); this._mHipL.multiplyMatrices(this._mRoot, this._mLocal); this._setPart(i, detach, ULEGL, this._mHipL);
    this._lm(0, -1.05, 0, P.kneeL, 0, 0); this._m.multiplyMatrices(this._mHipL, this._mLocal); this._setPart(i, detach, LLEGL, this._m);
    this._lm(-0.34, -0.20, 0, P.hipRp, 0, 0); this._mHipR.multiplyMatrices(this._mRoot, this._mLocal); this._setPart(i, detach, ULEGR, this._mHipR);
    this._lm(0, -1.05, 0, P.kneeR, 0, 0); this._m.multiplyMatrices(this._mHipR, this._mLocal); this._setPart(i, detach, LLEGR, this._m);
  }
  _lm(ox, oy, oz, rx, ry, rz) {
    this._e.set(rx, ry, rz); this._q.setFromEuler(this._e); this._v.set(ox, oy, oz);
    this._mLocal.compose(this._v, this._q, ONE);
  }

  _ragStep(z, dt, i) {
    const r = z.rag, g = CONFIG.gravity, sc = z.scale;
    r.age += dt;
    r.vy -= g * dt; r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
    const floor = 0.6 * sc;
    if (r.y < floor) {
      if (!r.onGround) { this.ctx.effects.dust(this._p.set(r.x, 0.2, r.z)); r.onGround = true; }
      r.y = floor; r.vy *= -0.18; r.vx *= 0.6; r.vz *= 0.6; r.angVel *= 0.5;
    }
    r.angVel -= Math.sign(r.angVel) * (r.onGround ? 6 : 1.5) * dt;
    r.angle += r.angVel * dt; r.angle = clamp(r.angle, -HALF_PI * 1.05, HALF_PI * 1.05);
    for (let j = 0; j < 8; j++) {
      z.limbVel[j] += (r.angVel - z.limbVel[j]) * 8 * dt - z.limbLag[j] * 40 * dt;
      z.limbLag[j] += z.limbVel[j] * dt; z.limbLag[j] = clamp(z.limbLag[j], -0.7, 0.7);
    }
    if (r.onGround && Math.abs(r.angVel) < 0.15 && Math.abs(r.vy) < 0.4) r.settleT += dt;
    let scl = sc;
    if (r.settleT > CONFIG.ragdollSettle) {
      r.fade -= dt / CONFIG.ragdollFade; r.y -= dt * 0.5;
      if (r.fade <= 0) { z.dying = false; z.hidden = true; this._hideZombie(i); return; }
      scl = sc * Math.max(0, r.fade);
    }
    // build ragdoll pose = frozen + limb lag
    const F = z.frozen, P = this._rp;
    P.spineBend = F.spineBend + z.limbLag[0]; P.headYaw = F.headYaw; P.headPitch = F.headPitch + z.limbLag[1];
    P.shLp = F.shLp + z.limbLag[2]; P.shRp = F.shRp + z.limbLag[3]; P.shLr = F.shLr; P.shRr = F.shRr;
    P.elbowL = F.elbowL + z.limbLag[4]; P.elbowR = F.elbowR + z.limbLag[4];
    P.hipLp = F.hipLp + z.limbLag[5]; P.hipRp = F.hipRp + z.limbLag[6];
    P.kneeL = F.kneeL + z.limbLag[7]; P.kneeR = F.kneeR + z.limbLag[7];
    this._writeFK(i, z, P, r.angle, z.yaw, 0, r.x, r.y, r.z, scl);
  }

  _debrisStep(dt) {
    const g = CONFIG.gravity; let any = false;
    for (let i = 0; i < this.debris.length; i++) {
      const d = this.debris[i];
      if (!d.active) continue;
      any = true;
      d.vy -= g * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      if (d.y < CONFIG.gore.chunkGroundY) { d.y = CONFIG.gore.chunkGroundY; d.vy *= -0.25; d.vx *= 0.7; d.vz *= 0.7; d.ay *= 0.6; }
      d.rx += d.ax * dt; d.ry += d.ay * dt; d.rz += d.az * dt; d.life -= dt;
      if (d.life <= 0) { d.active = false; this.debrisMesh.setMatrixAt(i, this._hidden); continue; }
      this._e.set(d.rx, d.ry, d.rz); this._q.setFromEuler(this._e);
      this._m.compose(this._v.set(d.x, d.y, d.z), this._q, this._sv.set(d.s, d.s, d.s));
      this.debrisMesh.setMatrixAt(i, this._m);
    }
    if (any) this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    if (this.waveActive && this.toSpawn > 0 && this.aliveCount < this.max) {
      this.spawnTimer += dt;
      if (this.spawnTimer >= this.spawnInterval) { this.spawnTimer = 0; this.spawn(); }
    }

    const bRad = CONFIG.buildingRadius; let attacking = 0;
    for (let i = 0; i < this.max; i++) {
      const z = this.z[i];
      if (z.alive) {
        if (z.hitT > 0) z.hitT -= dt;
        const dist = Math.sqrt(z.x * z.x + z.zz * z.zz);
        if (dist > bRad) {
          let blk = null;
          if (this.ctx.survivors) blk = this.ctx.survivors.blockAt(Math.atan2(z.x, z.zz));
          if (blk && blk.blocked && dist < bRad + CONFIG.surv.wallStandoff + 2) {
            this.ctx.survivors.damageBarricade(blk.post, CONFIG.surv.zombieVsBarricade * dt);
            z.atBase = true; // play attack anim against the wall
          } else {
            const slowMul = (blk && blk.slow) ? blk.slow : 1;
            const step = z.speed * z.slow * slowMul * dt;
            const inv = step / (dist || 1);
            z.x -= z.x * inv; z.zz -= z.zz * inv; z.yaw = Math.atan2(-z.x, -z.zz); z.atBase = false;
          }
        } else z.atBase = true;
        if (z.atBase) attacking += (z.type === 2 ? CONFIG.bruteDamageMul : 1);
        this._anim(z, dt);
        this._writeFK(i, z, z.pose, 0, z.yaw, z.pose.lean, z.x, HIP * z.scale + z.pose.bob, z.zz, z.scale);
      } else if (z.dying) {
        this._ragStep(z, dt, i);
      }
    }
    this._flush();
    this._debrisStep(dt);

    if (attacking > 0) {
      this.ctx.game.damageTower(attacking * CONFIG.zombieDamage * dt);
      if (Math.random() < dt * 1.5) this.ctx.audio.groan();
    } else if (this.aliveCount > 0 && Math.random() < dt * 0.5) this.ctx.audio.groan();

    // cart-claw damage when the player is down on the street
    const pl = this.ctx.player;
    if (pl.region !== 2) {
      const cr2 = CONFIG.cartClawRadius * CONFIG.cartClawRadius; let clawing = 0;
      for (const z of this.z) { if (!z.alive) continue; const dx = z.x - pl.pos.x, dz = z.zz - pl.pos.z; if (dx * dx + dz * dz < cr2) clawing++; }
      if (clawing > 0) {
        pl.health -= clawing * CONFIG.cartClawDamage * dt; pl.clawT = 0.25;
        this.ctx.game.addShake(CONFIG.shake.shakeClaw * dt * clawing);
        if (pl.health <= 0) { pl.health = 0; this.ctx.game.gameOver(); }
        if (Math.random() < dt * 4) this.ctx.audio.hit();
      }
    }

    if (this.waveActive && this.toSpawn === 0 && this.aliveCount === 0) {
      this.waveActive = false; this.ctx.game.onWaveCleared();
    }
  }
}
