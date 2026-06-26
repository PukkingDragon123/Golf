// =============================================================
// Survivors — rescue + tower-defense layer.
// Rescue caged civilians (clear zombies / hit cage with a ball / drive over),
// spend them to staff perimeter posts as auto-turrets / spotters / barricades.
// Instanced rendering, pooled projectiles, zero per-frame allocation.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeRNG, mergeGeometries, clamp, TAU } from './utils.js';
import { STR } from '../strings.js';

const S = CONFIG.surv;
const angDist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export class Survivors {
  constructor(scene, ctx) {
    this.ctx = ctx;
    this.rng = makeRNG(7777);
    this.buildMode = false;
    this.pendingBuild = 'turret';
    this.selectedPost = 0;
    this._selStepT = 0;

    // ---- geometries ----
    const M = (geo, x, y, z, ry) => { const m = new THREE.Matrix4(); const q = new THREE.Quaternion(); if (ry) q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry); m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)); return { geo, mat4: m }; };
    const bodyGeo = mergeGeometries(THREE, [
      M(new THREE.BoxGeometry(0.5, 0.85, 0.3), 0, 1.05, 0),                                      // torso
      M(new THREE.BoxGeometry(0.42, 0.12, 0.34), 0, 1.5, 0),                                      // collar/shoulders
      M(new THREE.SphereGeometry(0.21, 10, 8), 0, 1.7, 0),                                        // head
      M(new THREE.SphereGeometry(0.23, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.78, 0),        // cap dome
      M(new THREE.BoxGeometry(0.3, 0.04, 0.2), 0, 1.78, 0.2),                                      // cap brim
      M(new THREE.BoxGeometry(0.18, 0.8, 0.18), 0.16, 0.42, 0), M(new THREE.BoxGeometry(0.18, 0.8, 0.18), -0.16, 0.42, 0), // legs
      M(new THREE.BoxGeometry(0.2, 0.1, 0.32), 0.16, 0.03, 0.06), M(new THREE.BoxGeometry(0.2, 0.1, 0.32), -0.16, 0.03, 0.06), // feet
      M(new THREE.BoxGeometry(0.14, 0.72, 0.15), 0.34, 1.08, 0), M(new THREE.BoxGeometry(0.14, 0.72, 0.15), -0.34, 1.08, 0),   // arms
      M(new THREE.BoxGeometry(0.15, 0.15, 0.15), 0.34, 0.7, 0), M(new THREE.BoxGeometry(0.15, 0.15, 0.15), -0.34, 0.7, 0),     // hands
    ]);
    const cageGeo = mergeGeometries(THREE, [
      M(new THREE.BoxGeometry(0.1, 2.2, 0.1), 0.7, 1.1, 0.7), M(new THREE.BoxGeometry(0.1, 2.2, 0.1), -0.7, 1.1, 0.7),
      M(new THREE.BoxGeometry(0.1, 2.2, 0.1), 0.7, 1.1, -0.7), M(new THREE.BoxGeometry(0.1, 2.2, 0.1), -0.7, 1.1, -0.7),
      M(new THREE.BoxGeometry(1.5, 0.12, 1.5), 0, 2.2, 0),
    ]);
    const turretGeo = mergeGeometries(THREE, [
      M(new THREE.CylinderGeometry(0.85, 1.0, 0.6, 12), 0, 0.3, 0), M(new THREE.BoxGeometry(0.5, 1.3, 0.5), 0, 1.1, 0),
      M(new THREE.BoxGeometry(0.28, 0.28, 1.8), 0, 1.6, 0.7),
    ]);
    const wallGeo = new THREE.BoxGeometry(9, 2.2, 0.9);
    const padGeo = new THREE.CylinderGeometry(1.3, 1.3, 0.18, 14);

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcfe2ff, roughness: 0.6, metalness: 0.0 });
    const cageMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.6 });
    const turretMat = new THREE.MeshStandardMaterial({ color: CONFIG.col.turret, roughness: 0.4, metalness: 0.7 });
    const wallMat = new THREE.MeshStandardMaterial({ color: CONFIG.col.barricade, roughness: 0.8, metalness: 0.1 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x6a6f74, roughness: 0.5, metalness: 0.4, emissive: 0x223036, emissiveIntensity: 0.4 });
    const spotterMat = new THREE.MeshStandardMaterial({ color: CONFIG.col.spotter, emissive: CONFIG.col.spotter, emissiveIntensity: 0.8, roughness: 0.4 });
    const projMat = new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xffb030, emissiveIntensity: 1.4, roughness: 0.4 });
    const spotterGeo = mergeGeometries(THREE, [M(new THREE.CylinderGeometry(0.15, 0.15, 2.4, 8), 0, 1.2, 0), M(new THREE.SphereGeometry(0.42, 12, 10), 0, 2.6, 0)]);

    const inst = (geo, mat, n, shadow) => { const m = new THREE.InstancedMesh(geo, mat, n); m.frustumCulled = false; m.castShadow = !!shadow; m.receiveShadow = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); return m; };
    this.bodyMesh = inst(bodyGeo, bodyMat, S.maxCages, false);
    this.cageMesh = inst(cageGeo, cageMat, S.maxCages, false);
    this.padMesh = inst(padGeo, padMat, S.postCount, false);
    this.turretMesh = inst(turretGeo, turretMat, S.postCount, true);
    this.wallMesh = inst(wallGeo, wallMat, S.postCount, true);
    this.spotterMesh = inst(spotterGeo, spotterMat, S.postCount, false);
    this.projMesh = inst(new THREE.SphereGeometry(S.projRadius, 8, 6), projMat, S.projMax, false);

    // selection ring
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(1.5, 2.1, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.selRing.rotation.x = -Math.PI / 2; this.selRing.visible = false; scene.add(this.selRing);

    // ---- pools ----
    this.surv = [];
    for (let i = 0; i < S.maxCages; i++) this.surv.push({ state: 'idle', x: 0, z: 0, cageHP: 0, freeT: 0, homeX: 0, homeZ: 0, threatened: false, clearT: 0, phase: 0, slot: i });
    this.posts = [];
    for (let i = 0; i < S.postCount; i++) {
      const ang = (i / S.postCount) * TAU;
      this.posts.push({ id: i, angle: ang, x: Math.sin(ang) * S.postRadius, z: Math.cos(ang) * S.postRadius, yaw: ang, build: 'empty', level: 0, manned: 0, target: null, cooldown: 0, heat: 0, retargetT: 0, hp: 0, maxHP: 0, spent: 0 });
    }
    this.proj = [];
    for (let i = 0; i < S.projMax; i++) this.proj.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, dmg: 0 });
    this.projCursor = 0;

    // scratch
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._v = new THREE.Vector3(); this._s = new THREE.Vector3(); this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._snap = {
      integrity: 0, turrets: 0, walls: 0, postLabel: '', status: '',
      options: [
        { key: 'turret', label: '', cost: 0, affordable: false, sel: false },
        { key: 'spotter', label: '', cost: 0, affordable: false, sel: false },
        { key: 'barricade', label: '', cost: 0, affordable: false, sel: false },
      ],
    };

    this.reset();
  }

  reset() {
    for (const s of this.surv) s.state = 'idle';
    for (const p of this.posts) { p.build = 'empty'; p.level = 0; p.manned = 0; p.hp = 0; p.target = null; p.spent = 0; }
    for (const p of this.proj) p.active = false;
    this.buildMode = false; this.pendingBuild = 'turret'; this.selectedPost = 0;
  }

  onWaveStart(wave) {
    let active = this.surv.filter((s) => s.state !== 'idle').length;
    for (let k = 0; k < S.cagesPerWave && active < S.maxActiveCages; k++) { if (this._spawnCage()) active++; }
  }
  _spawnCage() {
    const s = this.surv.find((x) => x.state === 'idle');
    if (!s) return false;
    const ang = this.rng() * TAU;
    const rad = this.rng() < S.nearCageChance ? this.rng.range(28, 40) : this.rng.range(S.cageRadMin, S.cageRadMax);
    s.x = Math.sin(ang) * rad; s.z = Math.cos(ang) * rad;
    s.state = 'caged'; s.cageHP = S.cageHP; s.threatened = false; s.clearT = 0; s.phase = this.rng() * TAU;
    return true;
  }

  // ---- rescue hooks ----
  ballHit(pos, r, explosive) {
    for (const s of this.surv) {
      if (s.state !== 'caged') continue;
      const dx = pos.x - s.x, dz = pos.z - s.z;
      if (dx * dx + dz * dz < (1.6 + r) * (1.6 + r)) {
        if (explosive) s.cageHP = 0; else s.cageHP -= S.ballCageDamage;
        if (s.cageHP <= 0) this._free(s);
        return true;
      }
    }
    return false;
  }
  blockAt(angle) {
    for (const p of this.posts) {
      if (p.build !== 'barricade' || p.hp <= 0) continue;
      if (angDist(angle, p.angle) < S.barricadeArc) return { blocked: true, slow: S.barricadeSlow[p.level], post: p };
    }
    return { blocked: false, slow: 1, post: null };
  }
  damageBarricade(post, amount) {
    if (post.build !== 'barricade' || post.hp <= 0) return;
    post.hp -= amount;
    if (post.hp <= 0) { post.hp = 0; post.build = 'empty'; post.level = 0; post.spent = 0; this.ctx.effects.dust(this._v.set(post.x, 1, post.z)); this.ctx.audio.hit(); }
  }

  _free(s) {
    s.state = 'freeing'; s.freeT = 0;
    this.ctx.effects.greenPuff(this._v.set(s.x, 1.6, s.z));
    this.ctx.audio.pickup();
  }
  _arrive(s) {
    s.state = 'idle';
    this.ctx.game.addSurvivors(1);
    this.ctx.game.addScore(S.scorePerRescue, false);
  }

  // ---- build / economy ----
  toggleBuild() { this.buildMode = !this.buildMode; }
  cycleBuild(dir) { const order = ['turret', 'spotter', 'barricade']; let i = order.indexOf(this.pendingBuild); i = (i + (dir < 0 ? -1 : 1) + order.length) % order.length; this.pendingBuild = order[i]; }
  pickBuild(i) { const order = ['turret', 'spotter', 'barricade']; if (order[i]) { this.pendingBuild = order[i]; this.confirmBuild(); } }
  stepPost(dir) { this.selectedPost = (this.selectedPost + (dir < 0 ? -1 : 1) + this.posts.length) % this.posts.length; this._selStepT = 3; }

  confirmBuild() {
    if (!this.buildMode) return;
    const post = this.posts[this.selectedPost];
    const type = this.pendingBuild;
    if (post.build === 'empty') {
      const cost = type === 'turret' ? S.turret[1].cost : type === 'spotter' ? S.spotterCost : S.barricadeCost;
      if (!this.ctx.game.spendSurvivors(cost)) { this.ctx.game.flashNoAmmo(); return; }
      post.build = type; post.level = 1; post.spent = cost;
      if (type === 'turret') post.manned = S.turret[1].manned;
      if (type === 'barricade') { post.hp = S.barricadeHP[1]; post.maxHP = S.barricadeHP[1]; }
      this.ctx.audio.pickup();
    } else if (post.build === type) {
      if (type === 'turret' && post.level < 3) {
        const cost = S.turret[post.level + 1].cost;
        if (!this.ctx.game.spendSurvivors(cost)) { this.ctx.game.flashNoAmmo(); return; }
        post.level++; post.spent += cost; post.manned = S.turret[post.level].manned; this.ctx.audio.pickup();
      } else if (type === 'barricade' && post.level < 3) {
        if (!this.ctx.game.spendSurvivors(S.barricadeUpgradeCost)) { this.ctx.game.flashNoAmmo(); return; }
        post.level++; post.spent += S.barricadeUpgradeCost; post.hp = S.barricadeHP[post.level]; post.maxHP = S.barricadeHP[post.level]; this.ctx.audio.pickup();
      }
    }
  }
  sellSelected() {
    const post = this.posts[this.selectedPost];
    if (post.build === 'empty') return;
    const refund = Math.floor(post.spent * S.sellRefundFrac);
    if (refund > 0) this.ctx.game.addSurvivors(refund);
    post.build = 'empty'; post.level = 0; post.manned = 0; post.hp = 0; post.spent = 0; post.target = null;
  }

  _aimedPostId() {
    const ay = this.ctx.golf.aimYaw;
    let best = 0, bestd = Infinity;
    for (const p of this.posts) { const d = angDist(ay, p.angle); if (d < bestd) { bestd = d; best = p.id; } }
    return best;
  }

  // ---- turrets ----
  _acquire(post) {
    const range = S.turret[post.level].range, rr = range * range;
    let best = null, bestScore = Infinity;
    for (const z of this.ctx.zombies.z) {
      if (!z.alive) continue;
      const dx = z.x - post.x, dz = z.zz - post.z, d2 = dx * dx + dz * dz;
      if (d2 > rr) continue;
      const score = d2 - S.perimeterBias * (CONFIG.spawnRadius - Math.hypot(z.x, z.zz));
      if (score < bestScore) { bestScore = score; best = z; }
    }
    post.target = best;
  }
  _fire(post) {
    const st = S.turret[post.level], t = post.target;
    const p = this.proj[this.projCursor]; this.projCursor = (this.projCursor + 1) % this.proj.length;
    const mx = post.x, my = S.muzzleY, mz = post.z;
    let dx = t.x - mx, dz = t.zz - mz; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    p.active = true; p.x = mx; p.y = my; p.z = mz; p.vx = dx * st.projSpeed; p.vy = 0; p.vz = dz * st.projSpeed;
    p.life = S.projLife; p.dmg = st.damage; post.heat = 1; post.yawTurret = Math.atan2(dx, dz);
    this.ctx.audio.turretShot ? this.ctx.audio.turretShot() : 0;
  }

  update(dt) {
    const zb = this.ctx.zombies, pl = this.ctx.player;
    // reset spotter slow each frame (zombies read it next frame)
    for (const z of zb.z) if (z.alive) z.slow = 1;

    // rescue
    for (const s of this.surv) {
      if (s.state === 'caged') {
        let near = 0;
        for (const z of zb.z) { if (!z.alive) continue; const dx = z.x - s.x, dz = z.zz - s.z; if (dx * dx + dz * dz < S.clearRadius * S.clearRadius) near++; }
        if (near > 0) { s.threatened = true; s.clearT = 0; }
        else if (s.threatened) { s.clearT += dt; if (s.clearT >= S.clearHold) this._free(s); }
        const cdx = pl.pos.x - s.x, cdz = pl.pos.z - s.z;
        if (s.state === 'caged' && cdx * cdx + cdz * cdz < S.cartRescueRadius * S.cartRescueRadius) this._free(s);
      } else if (s.state === 'freeing') {
        s.freeT += dt;
        if (s.freeT >= S.freeDur) { s.state = 'running'; const d = Math.hypot(s.x, s.z) || 1; const tgt = CONFIG.rooftopSize / 2 + 3; s.homeX = s.x / d * tgt; s.homeZ = s.z / d * tgt; this.ctx.game.flashSurvFreed?.(); }
      } else if (s.state === 'running') {
        s.phase += dt * 10;
        const dx = s.homeX - s.x, dz = s.homeZ - s.z, d = Math.hypot(dx, dz) || 1;
        const step = S.runSpeed * dt;
        if (d < 2) this._arrive(s);
        else { s.x += dx / d * step; s.z += dz / d * step; }
      }
    }

    // turrets + spotters
    for (const post of this.posts) {
      if (post.build === 'turret') {
        post.cooldown -= dt; post.heat = Math.max(0, post.heat - dt * 4); post.retargetT -= dt;
        const t = post.target;
        const valid = t && t.alive && (t.x - post.x) * (t.x - post.x) + (t.zz - post.z) * (t.zz - post.z) <= S.turret[post.level].range * S.turret[post.level].range;
        if (!valid && post.retargetT <= 0) { this._acquire(post); post.retargetT = S.retargetInterval; }
        if (post.target && post.target.alive && post.cooldown <= 0) {
          this._fire(post);
          if (post.level >= 3) this._fire(post);
          post.cooldown = 1 / S.turret[post.level].rate;
        }
      } else if (post.build === 'spotter') {
        for (const z of zb.z) { if (!z.alive) continue; const dx = z.x - post.x, dz = z.zz - post.z; if (dx * dx + dz * dz < S.spotterRadius * S.spotterRadius) z.slow = Math.min(z.slow, S.spotterSlow); }
      }
    }

    // projectiles
    for (const p of this.proj) {
      if (!p.active) continue;
      p.life -= dt; if (p.life <= 0) { p.active = false; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const hit = zb.hitTestAt(p.x, p.z, S.projRadius);
      if (hit) { const died = zb.damage(hit, p.dmg); if (died) this.ctx.game.addScore(CONFIG.scorePerKill, false); this.ctx.effects.hit(this._v.set(p.x, p.y, p.z)); p.active = false; }
    }

    // selection
    if (this.buildMode) { if (this._selStepT > 0) this._selStepT -= dt; else this.selectedPost = this._aimedPostId(); }

    this._render();
  }

  _render() {
    // survivors (caged/freeing/running) + cages
    for (let i = 0; i < this.surv.length; i++) {
      const s = this.surv[i];
      const show = s.state === 'caged' || s.state === 'freeing' || s.state === 'running';
      if (!show) { this.bodyMesh.setMatrixAt(i, this._hidden); this.cageMesh.setMatrixAt(i, this._hidden); continue; }
      const yaw = s.state === 'running' ? Math.atan2(s.homeX - s.x, s.homeZ - s.z) : 0;
      const bob = s.state === 'running' ? Math.abs(Math.sin(s.phase)) * 0.12 : 0;
      this._q.setFromEuler(this._e.set(0, yaw, 0));
      this._m.compose(this._v.set(s.x, bob, s.z), this._q, this._s.set(1, 1, 1));
      this.bodyMesh.setMatrixAt(i, this._m);
      if (s.state === 'caged') { this._m.compose(this._v.set(s.x, 0, s.z), this._q.identity(), this._s.set(1, 1, 1)); this.cageMesh.setMatrixAt(i, this._m); }
      else this.cageMesh.setMatrixAt(i, this._hidden);
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true; this.cageMesh.instanceMatrix.needsUpdate = true;

    // posts
    for (let i = 0; i < this.posts.length; i++) {
      const p = this.posts[i];
      this._q.setFromEuler(this._e.set(0, p.yaw, 0));
      this._m.compose(this._v.set(p.x, 0.1, p.z), this._q, this._s.set(1, 1, 1));
      this.padMesh.setMatrixAt(i, this._m);
      this.turretMesh.setMatrixAt(i, p.build === 'turret' ? this._composePost(p, 1 + p.level * 0.12) : this._hidden);
      this.spotterMesh.setMatrixAt(i, p.build === 'spotter' ? this._composePost(p, 1) : this._hidden);
      this.wallMesh.setMatrixAt(i, p.build === 'barricade' ? this._composeWall(p) : this._hidden);
    }
    this.padMesh.instanceMatrix.needsUpdate = true; this.turretMesh.instanceMatrix.needsUpdate = true;
    this.spotterMesh.instanceMatrix.needsUpdate = true; this.wallMesh.instanceMatrix.needsUpdate = true;

    // projectiles
    for (let i = 0; i < this.proj.length; i++) {
      const p = this.proj[i];
      if (!p.active) { this.projMesh.setMatrixAt(i, this._hidden); continue; }
      this._m.compose(this._v.set(p.x, p.y, p.z), this._q.identity(), this._s.set(1, 1, 1));
      this.projMesh.setMatrixAt(i, this._m);
    }
    this.projMesh.instanceMatrix.needsUpdate = true;

    // selection ring
    if (this.buildMode) { const p = this.posts[this.selectedPost]; this.selRing.visible = true; this.selRing.position.set(p.x, 0.2, p.z); }
    else this.selRing.visible = false;
  }
  _composePost(p, scl) { const yaw = (p.build === 'turret' && p.yawTurret != null) ? p.yawTurret : Math.atan2(-p.x, -p.z); this._q.setFromEuler(this._e.set(0, yaw, 0)); this._m.compose(this._v.set(p.x, 0.2, p.z), this._q, this._s.set(scl, scl, scl)); return this._m; }
  _composeWall(p) { this._q.setFromEuler(this._e.set(0, p.angle, 0)); this._m.compose(this._v.set(Math.sin(p.angle) * CONFIG.buildingRadius, 1.1, Math.cos(p.angle) * CONFIG.buildingRadius), this._q, this._s.set(1, 1, 1)); return this._m; }

  snapshotBuild() {
    let walls = 0, turrets = 0, hpSum = 0, hpMax = 0;
    for (const p of this.posts) { if (p.build === 'barricade') { walls++; hpSum += p.hp; hpMax += p.maxHP; } if (p.build === 'turret') turrets++; }
    const snap = this._snap;
    snap.integrity = hpMax > 0 ? hpSum / hpMax : 0; snap.turrets = turrets; snap.walls = walls;
    if (!this.buildMode) { snap.postLabel = ''; return snap; }
    const post = this.posts[this.selectedPost];
    const sv = this.ctx.game.survivors;
    const costs = [S.turret[1].cost, S.spotterCost, S.barricadeCost];
    const labels = [STR.buildTurret, STR.buildSpotter, STR.buildBarricade];
    const keys = ['turret', 'spotter', 'barricade'];
    for (let i = 0; i < 3; i++) { const o = snap.options[i]; o.cost = costs[i]; o.label = labels[i] + ' ' + costs[i] + '🧍'; o.affordable = sv >= costs[i]; o.sel = this.pendingBuild === keys[i]; }
    let status = 'EMPTY';
    if (post.build === 'turret') status = 'TURRET Lv' + post.level;
    else if (post.build === 'barricade') status = 'BARRICADE Lv' + post.level + ' · ' + Math.round(post.hp) + 'hp';
    else if (post.build === 'spotter') status = 'SPOTTER';
    snap.status = status; snap.postLabel = STR.buildPost + ' ' + (this.selectedPost + 1) + ' · ' + status;
    return snap;
  }
}
