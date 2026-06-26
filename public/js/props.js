// =============================================================
// Props — street-level destructibles: explosive barrels + abandoned cars.
// Two InstancedMeshes (2 draw calls). Ball/explosion/cart detonation with
// staggered chain reactions. Zero per-frame allocation.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRNG, mergeGeometries, TAU } from './utils.js';

const P = CONFIG.props;

export class Props {
  constructor(scene, ctx) {
    this.ctx = ctx;
    this.rng = makeRNG(4242);

    // ---- barrel mesh (rust cylinder, base at y=0) ----
    const bgeo = new THREE.CylinderGeometry(P.barrelRadius * 0.8, P.barrelRadius * 0.85, P.barrelHeight, 12);
    bgeo.translate(0, P.barrelHeight / 2, 0);
    const bmat = new THREE.MeshStandardMaterial({ color: CONFIG.col.barrel, metalness: 0.3, roughness: 0.6 });
    this.barrelMesh = new THREE.InstancedMesh(bgeo, bmat, P.barrelCount);
    this.barrelMesh.castShadow = false; this.barrelMesh.receiveShadow = false; this.barrelMesh.frustumCulled = false;
    this.barrelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.barrelMesh);

    // ---- car mesh (merged boxes + wheels, wheels at y≈0.6) ----
    const h = P.carHalf;
    const parts = [];
    const M = (geo, x, y, z) => { const m = new THREE.Matrix4().makeTranslation(x, y, z); parts.push({ geo, mat4: m }); };
    M(new THREE.BoxGeometry(h[0] * 2, h[1] * 1.1, h[2] * 2), 0, 0.6 + h[1] * 0.55, 0);
    M(new THREE.BoxGeometry(h[0] * 1.3, h[1] * 1.0, h[2] * 1.1), 0, 0.6 + h[1] * 1.3, -0.4);
    for (const [wx, wz] of [[h[0] - 0.4, h[2] - 0.5], [-(h[0] - 0.4), h[2] - 0.5], [h[0] - 0.4, -(h[2] - 0.5)], [-(h[0] - 0.4), -(h[2] - 0.5)]]) {
      const wg = new THREE.CylinderGeometry(0.6, 0.6, 0.5, 10); wg.rotateZ(Math.PI / 2);
      M(wg, wx, 0.6, wz);
    }
    const cgeo = mergeGeometries(THREE, parts);
    const cmat = new THREE.MeshStandardMaterial({ color: CONFIG.col.carBody, metalness: 0.45, roughness: 0.5 });
    this.carMesh = new THREE.InstancedMesh(cgeo, cmat, P.carCount);
    this.carMesh.castShadow = false; this.carMesh.receiveShadow = false; this.carMesh.frustumCulled = false;
    this.carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.carMesh);

    // pools
    this.barrels = []; this.cars = [];
    for (let i = 0; i < P.barrelCount; i++) this.barrels.push(this._mk('barrel', this.barrelMesh, i));
    for (let i = 0; i < P.carCount; i++) this.cars.push(this._mk('car', this.carMesh, i));
    this.all = this.barrels.concat(this.cars);

    // scratch
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._col = new THREE.Color();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._barrelDirty = false; this._carDirty = false;

    this.reset();
  }

  _mk(kind, mesh, i) { return { kind, mesh, i, x: 0, z: 0, yaw: 0, alive: false, cooking: false, cookT: 0, cookDelay: 0, scale: 1 }; }

  _write(prop) {
    const yBase = 0;
    if (!prop.alive) { prop.mesh.setMatrixAt(prop.i, this._hidden); }
    else {
      this._q.setFromEuler(this._e.set(0, prop.yaw, 0));
      this._m.compose(this._v.set(prop.x, yBase, prop.z), this._q, this._s.set(prop.scale, prop.scale, prop.scale));
      prop.mesh.setMatrixAt(prop.i, this._m);
    }
    if (prop.kind === 'barrel') this._barrelDirty = true; else this._carDirty = true;
  }

  _placeOne(prop, x, z) {
    prop.x = x; prop.z = z; prop.yaw = this.rng() * TAU;
    prop.alive = true; prop.cooking = false; prop.cookT = 0; prop.scale = 1;
    this._write(prop);
  }

  _scatter(prop) {
    // pick a spot in the field ring, away from the tower base and the ramp lane
    for (let tries = 0; tries < 12; tries++) {
      const a = this.rng() * TAU, rad = this.rng.range(P.ringMin, P.ringMax);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      if (Math.abs(x) < CONFIG.ramp.width && z * CONFIG.ramp.side > 20) continue; // keep ramp lane clear
      this._placeOne(prop, x, z); return;
    }
    this._placeOne(prop, Math.cos(this.rng() * TAU) * P.ringMax, Math.sin(this.rng() * TAU) * P.ringMax);
  }

  reset() {
    for (const p of this.all) { p.alive = false; p.cooking = false; this._write(p); }
    this.place();
  }

  place() {
    // clusters first (chain-reaction lanes), then ring scatter for the rest
    let bi = 0;
    const clusters = Math.min(P.clusterCount, Math.floor(P.barrelCount / 2));
    for (let c = 0; c < clusters && bi < this.barrels.length; c++) {
      const a = this.rng() * TAU, rad = this.rng.range(P.ringMin, P.ringMax);
      const cx = Math.cos(a) * rad, cz = Math.sin(a) * rad;
      const k = 2 + Math.floor(this.rng() * 2);
      for (let j = 0; j < k && bi < this.barrels.length; j++) {
        this._placeOne(this.barrels[bi++], cx + this.rng.range(-P.clusterSpread, P.clusterSpread), cz + this.rng.range(-P.clusterSpread, P.clusterSpread));
      }
    }
    for (; bi < this.barrels.length; bi++) this._scatter(this.barrels[bi]);
    for (const car of this.cars) this._scatter(car);
    this._flush();
  }

  respawn() {
    let budget = Math.floor((this.barrels.length + this.cars.length) * P.respawnFrac);
    for (const p of this.all) {
      if (budget <= 0) break;
      if (!p.alive) { this._scatter(p); budget--; }
    }
    this._flush();
  }

  _flush() {
    if (this._barrelDirty) { this.barrelMesh.instanceMatrix.needsUpdate = true; this._barrelDirty = false; }
    if (this._carDirty) { this.carMesh.instanceMatrix.needsUpdate = true; this._carDirty = false; }
  }

  hitTest(p, r) {
    if (p.y > 4) return null;
    for (const prop of this.all) {
      if (!prop.alive || prop.cooking) continue;
      const rad = (prop.kind === 'car' ? P.carRadius : P.barrelRadius) + r;
      const dx = p.x - prop.x, dz = p.z - prop.z;
      if (dx * dx + dz * dz < rad * rad) return prop;
    }
    return null;
  }

  igniteArea(pos, r) {
    const rr = r * r;
    for (const prop of this.all) {
      if (!prop.alive || prop.cooking) continue;
      const dx = prop.x - pos.x, dz = prop.z - pos.z;
      if (dx * dx + dz * dz < rr) this._cook(prop);
    }
  }

  cartTest(px, pz, speed) {
    if (speed < P.ramSpeedMin) return;
    for (const prop of this.all) {
      if (!prop.alive || prop.cooking) continue;
      const rad = (prop.kind === 'car' ? P.carRadius : P.barrelRadius) + 2.2;
      const dx = px - prop.x, dz = pz - prop.z;
      if (dx * dx + dz * dz < rad * rad) this.detonate(prop, 0);
    }
  }

  _cook(prop) {
    if (!prop.alive || prop.cooking) return;
    prop.cooking = true; prop.cookT = 0;
    prop.cookDelay = (P.chainDelayMin + Math.random() * (P.chainDelayMax - P.chainDelayMin)) / 1000;
  }

  detonate(prop, depth) {
    if (!prop.alive) return;
    prop.alive = false; prop.cooking = false; this._write(prop);
    const car = prop.kind === 'car';
    const dmgR = car ? P.carDmgRadius : P.barrelDmgRadius;
    this._v.set(prop.x, 1.4, prop.z);
    const killed = this.ctx.zombies.damageArea(this._v, dmgR, { dmg: CONFIG.explosionDamage, dismember: true });
    this.ctx.game.addScore(killed * CONFIG.scorePerKill + Math.max(0, killed - 1) * CONFIG.comboBonus + P.scorePerProp, killed > 1);
    this.ctx.effects.fireball(this._v, car);
    this.ctx.gore?.splat(this._v, car ? 2.4 : 1.6);
    this.ctx.audio.explosion();
    this.ctx.shake.addTrauma(car ? P.carTrauma : P.barrelTrauma);
    this.ctx.shake.hitStop(car ? P.carHitStop : P.barrelHitStop);
    this.ctx.postfx?.boomPulse?.();
    this.ctx.world?.flash?.(car ? 0.7 : 0.5);
    // chain: cook neighbours (staggered; the cooking flag prevents re-entrancy)
    for (const other of this.all) {
      if (!other.alive || other.cooking) continue;
      const dx = other.x - prop.x, dz = other.z - prop.z;
      if (dx * dx + dz * dz < dmgR * dmgR) this._cook(other);
    }
  }

  update(dt) {
    for (const prop of this.all) {
      if (!prop.cooking) continue;
      prop.cookT += dt;
      if (Math.random() < dt * 8) this.ctx.effects.embers(this._v.set(prop.x, P.barrelHeight, prop.z), 2); // telegraph
      if (prop.cookT >= prop.cookDelay) this.detonate(prop, 0);
    }
    const pl = this.ctx.player;
    if (pl.region !== 2) this.cartTest(pl.pos.x, pl.pos.z, Math.abs(pl.speed));
    this._flush();
  }
}
