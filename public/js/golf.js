// =============================================================
// Golf — aim, ping-pong power meter, realistic ball physics (gravity +
// wind-relative quadratic drag + Magnus spin), selectable clubs, wind,
// spin/surface-aware bounce & roll, and a preview that runs the SAME
// integrator. Elevated chase/aim camera. Zero per-frame allocation.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, damp, TAU } from './utils.js';
import { pbrMaterial } from './textures.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Golf {
  constructor(scene, ctx) {
    this.scene = scene;
    this.ctx = ctx;
    this.aimYaw = Math.PI;
    this.aimPitch = CONFIG.pitchDefault;
    this.aimYawVel = 0;
    this.charging = false;
    this.power = 0;
    this.powerDir = 1;
    this.clubIndex = CONFIG.defaultClub;
    this.spinMode = 'default';        // 'default' | 'back' | 'top'

    this.wind = new THREE.Vector3();
    this.windTarget = new THREE.Vector3();
    this.windTimer = 0;

    // scratch
    this.dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._vRel = new THREE.Vector3();
    this._cross = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camTgt = new THREE.Vector3();
    this._pPos = new THREE.Vector3();
    this._pVel = new THREE.Vector3();
    this._pSpin = new THREE.Vector3();
    this._g = 0; // smoothed ground factor for camera

    // ball pool
    const ballMat = pbrMaterial(THREE, ctx.assets.golfball, { roughness: 0.42, metalness: 0.0 });
    const expMat = ballMat.clone();
    expMat.emissive = new THREE.Color(CONFIG.col.explosive); expMat.emissiveIntensity = 0.8;
    this.ballMat = ballMat; this.expMat = expMat;
    const geo = new THREE.SphereGeometry(CONFIG.ballRadius, 18, 14);
    this.balls = [];
    for (let i = 0; i < CONFIG.maxBalls; i++) {
      const mesh = new THREE.Mesh(geo, ballMat);
      mesh.castShadow = true; mesh.visible = false;
      scene.add(mesh);
      this.balls.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), backspin: 0, sidespin: 0, drag: 1, bounces: 0, life: 0, active: false, explosive: false, grounded: false });
    }

    // trajectory preview line + landing marker
    const tp = CONFIG.trajPoints;
    this.trajArr = new Float32Array(tp * 3);
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(this.trajArr, 3));
    this.trajLine = new THREE.Line(tgeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    this.trajLine.frustumCulled = false;
    scene.add(this.trajLine);
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.0, 24),
      new THREE.MeshBasicMaterial({ color: CONFIG.col.pickup, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    this.marker.rotation.x = -Math.PI / 2;
    scene.add(this.marker);
  }

  get club() { return CONFIG.CLUBS[this.clubIndex]; }

  reset() {
    for (const b of this.balls) { b.active = false; b.mesh.visible = false; }
    this.charging = false; this.power = 0; this.powerDir = 1;
    this.aimYaw = Math.PI; this.aimPitch = CONFIG.pitchDefault; this.aimYawVel = 0;
    this.clubIndex = CONFIG.defaultClub; this.spinMode = 'default';
    this.wind.set(0, 0, 0); this.windTarget.set(0, 0, 0); this.windTimer = 0;
    this._g = 0;
  }

  cycleClub() { this.clubIndex = (this.clubIndex + 1) % CONFIG.CLUBS.length; return this.club; }
  cycleSpin() { this.spinMode = this.spinMode === 'default' ? 'back' : this.spinMode === 'back' ? 'top' : 'default'; return this.spinMode; }

  addAim(dyaw, dpitch, dt) {
    this.aimYaw -= dyaw;
    this.aimPitch = clamp(this.aimPitch - dpitch, CONFIG.pitchMin, CONFIG.pitchMax);
    const inst = dt > 0 ? dyaw / dt : 0;
    this.aimYawVel = damp(this.aimYawVel, inst, CONFIG.aimYawVelDamp, dt || 0.016);
  }

  aimVec(out, yaw = this.aimYaw, pitch = this.aimPitch) {
    const cp = Math.cos(pitch);
    return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  }

  _trimBackspin() {
    const t = this.spinMode === 'back' ? CONFIG.spinTrimBack : this.spinMode === 'top' ? -CONFIG.spinTrimTop : 0;
    return this.club.backspin + t;
  }
  _sideSpinRPS() { return clamp(this.aimYawVel * CONFIG.sideSpinK, -CONFIG.sideSpinMax, CONFIG.sideSpinMax); }

  // out = right*(-backRPS) + up*sideRPS, right = fwd × up (horizontal)
  _buildSpin(out, fwd, backRPS, sideRPS) {
    this._right.crossVectors(fwd, UP);
    if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
    this._right.normalize();
    // backspin must LIFT: for fwd=+z, _right=-x, spin=-x*back -> spin×v = +y (up). (H1)
    out.copy(this._right).multiplyScalar(backRPS);
    out.y += sideRPS;
    return out;
  }

  _updateWind(dt) {
    this.windTimer -= dt;
    if (this.windTimer <= 0) {
      this.windTimer = CONFIG.windChangeMin + Math.random() * (CONFIG.windChangeMax - CONFIG.windChangeMin);
      const a = Math.random() * TAU, m = Math.random() * CONFIG.windMax;
      this.windTarget.set(Math.cos(a) * m, 0, Math.sin(a) * m);
    }
    this.wind.x = damp(this.wind.x, this.windTarget.x, CONFIG.windLerp, dt);
    this.wind.z = damp(this.wind.z, this.windTarget.z, CONFIG.windLerp, dt);
  }
  windInfo(out) { out.x = this.wind.x; out.z = this.wind.z; out.mag = Math.hypot(this.wind.x, this.wind.z); out.angle = Math.atan2(this.wind.x, this.wind.z); return out; }

  // shared physics core for live balls AND preview (zero alloc)
  _integrate(pos, vel, spin, dt, dragMul) {
    this._vRel.copy(vel).sub(this.wind);
    const speed = this._vRel.length();
    this._a.set(0, -CONFIG.gravity, 0);
    this._a.addScaledVector(this._vRel, -CONFIG.dragCoef * dragMul * speed);
    this._cross.crossVectors(spin, this._vRel);
    this._a.addScaledVector(this._cross, CONFIG.kMagnus);
    vel.addScaledVector(this._a, dt);
    pos.addScaledVector(vel, dt);
    spin.multiplyScalar(1 - CONFIG.spinDecay * dt);
  }

  startCharge() {
    if (this.ctx.game.ammo <= 0) { this.ctx.game.flashNoAmmo(); return; }
    this.charging = true; this.power = 0; this.powerDir = 1;
  }
  releaseCharge() { if (!this.charging) return; this.charging = false; this.fire(this.power / 100); this.power = 0; }

  fire(power01) {
    const game = this.ctx.game;
    if (game.ammo <= 0) { game.flashNoAmmo(); return; }
    game.useAmmo();
    const club = this.club;
    const speed = lerp(club.minLaunch, club.maxLaunch, power01);
    const pitch = clamp(this.aimPitch + club.loftBias, CONFIG.pitchMin, CONFIG.pitchMax);
    const backRPS = this._trimBackspin();
    const sideRPS = this._sideSpinRPS();

    let explosive = false, multi = false;
    if (game.armed === 'explosive' && game.explosiveShots > 0) { explosive = true; game.explosiveShots--; }
    else if (game.armed === 'multiball' && game.multiballShots > 0) { multi = true; game.multiballShots--; }
    const n = multi ? CONFIG.multiballCount : 1;

    const origin = this.ctx.player.shootOrigin;
    for (let k = 0; k < n; k++) {
      const off = multi ? (k - (n - 1) / 2) * CONFIG.multiballSpread : 0;
      this.aimVec(this._fwd, this.aimYaw + off, pitch);
      const b = this.balls.find((x) => !x.active);
      if (!b) break;
      b.active = true; b.grounded = false; b.life = 0; b.explosive = explosive; b.bounces = 0; b.drag = club.drag;
      b.backspin = backRPS; b.sidespin = sideRPS;
      this._buildSpin(b.spin, this._fwd, backRPS, sideRPS);
      b.mesh.material = explosive ? this.expMat : this.ballMat;
      b.mesh.visible = true;
      b.mesh.position.copy(origin);
      b.vel.copy(this._fwd).multiplyScalar(speed);
    }
    this.ctx.player.swing();
    this.ctx.audio.swing(power01);
    this.ctx.effects.muzzle?.(origin, this._fwd);
    this.ctx.shake.addTrauma((explosive || multi) ? CONFIG.shake.bigShotKick : CONFIG.shake.shotKick * (0.4 + 0.6 * power01));
    game.afterFire();
  }

  explode(pos, ball) {
    const z = this.ctx.zombies, game = this.ctx.game;
    const killed = z.damageArea(pos, CONFIG.explosionRadius, { dmg: CONFIG.explosionDamage, dismember: true });
    this.ctx.effects.fireball ? this.ctx.effects.fireball(pos, false) : this.ctx.effects.explosion(pos);
    this.ctx.props?.igniteArea(pos, CONFIG.explosionRadius);
    this.ctx.gore?.splat(pos, 2.2); this.ctx.gore?.burst(pos, 2.4, 0, 0);
    this.ctx.audio.explosion();
    this.ctx.shake.addTrauma(0.35); this.ctx.postfx?.boomPulse?.(); this.ctx.world?.flash?.(0.5);
    if (killed > 0) game.addScore(killed * CONFIG.scorePerKill + (killed - 1) * CONFIG.comboBonus, killed > 1);
    if (ball) { ball.active = false; ball.mesh.visible = false; }
  }

  updatePreview(visible) {
    if (!visible) { this.trajLine.visible = false; this.marker.visible = false; return; }
    this.trajLine.visible = true;
    const club = this.club;
    const power01 = this.charging ? this.power / 100 : 0.6;
    const speed = lerp(club.minLaunch, club.maxLaunch, power01);
    const pitch = clamp(this.aimPitch + club.loftBias, CONFIG.pitchMin, CONFIG.pitchMax);
    this.aimVec(this._fwd, this.aimYaw, pitch);
    this._buildSpin(this._pSpin, this._fwd, this._trimBackspin(), this._sideSpinRPS());
    this._pPos.copy(this.ctx.player.shootOrigin);
    this._pVel.copy(this._fwd).multiplyScalar(speed);
    const dt = 1 / 60, sub = 3;   // match live integration; sub-step to cover range
    let landX = this._pPos.x, landZ = this._pPos.z, landed = false;
    for (let i = 0; i < CONFIG.trajPoints; i++) {
      if (landed) { this.trajArr[i * 3] = landX; this.trajArr[i * 3 + 1] = 0.12; this.trajArr[i * 3 + 2] = landZ; continue; }
      this.trajArr[i * 3] = this._pPos.x; this.trajArr[i * 3 + 1] = this._pPos.y; this.trajArr[i * 3 + 2] = this._pPos.z;
      for (let s2 = 0; s2 < sub; s2++) {
        this._integrate(this._pPos, this._pVel, this._pSpin, dt, club.drag);
        if (this._pPos.y <= CONFIG.ballRadius && this._pVel.y < 0) { landX = this._pPos.x; landZ = this._pPos.z; landed = true; break; }
      }
    }
    this.trajLine.geometry.attributes.position.needsUpdate = true;
    if (landed) {
      this.marker.visible = true; this.marker.position.set(landX, 0.15, landZ);
      this.marker.material.color.setHex(this.charging ? CONFIG.col.pickup : 0xffffff);
      this.trajLine.material.opacity = this.charging ? 0.85 : 0.4;
    } else this.marker.visible = false;
  }

  update(dt, playing) {
    if (this.charging) {
      this.power += this.powerDir * CONFIG.powerChargeRate * dt;
      if (this.power >= 100) { this.power = 100; this.powerDir = -1; }
      else if (this.power <= 0) { this.power = 0; this.powerDir = 1; }
    }
    this._updateWind(dt);

    const z = this.ctx.zombies, eff = this.ctx.effects, game = this.ctx.game;
    const C = CONFIG;
    for (const b of this.balls) {
      if (!b.active) continue;
      b.life += dt;
      const sp = b.vel.length();
      this._integrate(b.mesh.position, b.vel, b.spin, dt, b.drag);
      const decay = 1 - C.spinDecay * dt;
      b.backspin *= decay; b.sidespin *= decay;
      b.mesh.rotation.x += sp * dt * 0.3;
      const p = b.mesh.position;

      // prop collision (slice 5; guarded)
      if (this.ctx.props && (!b.grounded || sp > 4)) {
        const prop = this.ctx.props.hitTest(p, C.ballRadius);
        if (prop) {
          if (b.explosive) { this.explode(p, b); continue; }
          this.ctx.props.detonate(prop, 0);
          b.vel.multiplyScalar(0.3);
        }
      }

      // zombie collision
      if (!b.grounded || sp > 4) {
        const hit = z.hitTest(p, C.ballRadius);
        if (hit) {
          if (b.explosive) { this.explode(p, b); continue; }
          const died = z.hitBall(hit, p, b.vel);
          if (died) game.addScore(C.scorePerKill, false);
          this.ctx.audio.hit();
          b.vel.multiplyScalar(died ? 0.62 : 0.45);
        }
      }
      // survivor cage (slice 6; guarded)
      this.ctx.survivors?.ballHit(p, C.ballRadius, b.explosive);

      // ground collision (spin- & surface-aware)
      if (p.y <= C.ballRadius) {
        if (b.explosive) { p.y = C.ballRadius; this.explode(p, b); continue; }
        p.y = C.ballRadius;
        b.vel.y = -b.vel.y * C.restitution;
        const horizScale = clamp(1 - b.backspin * C.backBiteK, C.minHoriz, 1);
        b.vel.x *= horizScale; b.vel.z *= horizScale;
        if (b.backspin > C.backKickThresh && b.bounces < 2) {
          const hmag = Math.hypot(b.vel.x, b.vel.z) || 1, kick = b.backspin * C.backKickK;
          b.vel.x -= (b.vel.x / hmag) * kick; b.vel.z -= (b.vel.z / hmag) * kick;
        }
        b.bounces++;
        b.backspin *= C.bounceSpinLoss; b.sidespin *= C.bounceSpinLoss;
        b.grounded = b.vel.y < C.groundedVyThresh;
        if (Math.abs(b.vel.y) > 1.5) { eff.dust(p); this.ctx.gore?.dropSplat?.(p); }
      }
      if (b.grounded) {
        const topspin = Math.max(0, -b.backspin);
        const rr = C.rollFriction * (1 - clamp(topspin * C.topspinRollK, 0, C.rollSpinReduce));
        const f = Math.max(0, 1 - rr * dt);
        b.vel.x *= f; b.vel.z *= f;
        b.vel.x += this.wind.x * C.rollWindK * dt; b.vel.z += this.wind.z * C.rollWindK * dt;
        if (Math.hypot(b.vel.x, b.vel.z) < C.ballStopSpeed && Math.abs(b.vel.y) < 1.2) { b.active = false; b.mesh.visible = false; continue; }
      }

      if (b.life > C.ballMaxLife || (p.x * p.x + p.z * p.z) > C.despawnRadius * C.despawnRadius) {
        b.active = false; b.mesh.visible = false;
      }
    }

    this.updatePreview(playing);
  }

  updateCamera(camera, dt) {
    const o = this.ctx.player.shootOrigin;
    // ground factor: 0 on the roof, 1 at street level
    const groundTgt = clamp(1 - this.ctx.player.pos.y / (CONFIG.rooftopHeight + 1.2), 0, 1);
    this._g = damp(this._g, groundTgt, 6, dt);
    const g = this._g;
    const dist = lerp(CONFIG.camDistance, CONFIG.camDistanceGround, g);
    const height = lerp(CONFIG.camHeight, CONFIG.camHeightGround, g);
    const ahead = lerp(CONFIG.camLookAhead, CONFIG.camLookAheadGround, g);
    const lookDrop = lerp(CONFIG.camLookDrop, CONFIG.camLookDropGround, g);
    const hx = Math.sin(this.aimYaw), hz = Math.cos(this.aimYaw);
    const steep = -this.aimPitch * (1 - g * 0.6);
    this._camPos.set(o.x - hx * dist, o.y + height + steep * 5, o.z - hz * dist);
    const a = 1 - Math.exp(-CONFIG.camLerp * dt);
    camera.position.lerp(this._camPos, a);
    if (camera.position.y < this.ctx.player.pos.y + CONFIG.camMinAbove) camera.position.y = this.ctx.player.pos.y + CONFIG.camMinAbove;
    const drop = lookDrop + steep * 26;
    this._camTgt.set(o.x + hx * ahead, o.y - drop, o.z + hz * ahead);
    camera.lookAt(this._camTgt);
  }
}
