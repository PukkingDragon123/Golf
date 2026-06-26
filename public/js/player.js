// =============================================================
// Player — drivable golf cart + golfer. Arcade ground driving with boost,
// drift, speed-scaled steering, suspension lean/pitch, a surface-height
// function (roof / ramp / street), and cart-vs-zombie run-over carnage.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, damp } from './utils.js';

const C = CONFIG.col;

export class Player {
  constructor(scene, ctx) {
    this.ctx = ctx;
    this.roofTop = CONFIG.rooftopHeight + 1.2;
    this.heading = Math.PI;
    this.speed = 0;
    this.lateralVel = 0;
    this.pos = new THREE.Vector3(0, this.roofTop, CONFIG.rooftopSize * 0.28);
    this.swingT = -1;
    this.boostFuel = CONFIG.boostMax;
    this.boostActive = false;
    this.boostCooldown = 0;
    this.lean = 0; this.pitch = 0; this._prevSpeed = 0;
    this.region = 2;
    this.health = CONFIG.cartHealth;
    this.clawT = 0;
    this.hurt = false;
    this._fwd = new THREE.Vector3();
    this._lat = new THREE.Vector3();
    this._surf = { y: this.roofTop, region: 2, grade: 0 };
    this._so = new THREE.Vector3();
    this._exhaustT = 0;

    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    this.root = root; scene.add(root);
    const tilt = new THREE.Group(); root.add(tilt); this.bodyTilt = tilt;

    const white = new THREE.MeshStandardMaterial({ color: C.cartWhite, metalness: 0.1, roughness: 0.5 });
    const chrome = new THREE.MeshStandardMaterial({ color: C.chrome, metalness: 0.9, roughness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x222428, metalness: 0.4, roughness: 0.6 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b6b6b, metalness: 0.1, roughness: 0.7 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 4.2), white);
    body.position.y = 1.05; body.castShadow = true; body.receiveShadow = true; tilt.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 1.3), white);
    nose.position.set(0, 0.85, 2.4); nose.castShadow = true; tilt.add(nose);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.35, 1.0), seatMat);
    seat.position.set(0, 1.5, -0.4); seat.castShadow = true; tilt.add(seat);
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.0, 0.3), seatMat);
    seatBack.position.set(0, 2.0, -0.95); seatBack.castShadow = true; tilt.add(seatBack);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.18, 3.2), white);
    canopy.position.set(0, 3.5, 0.2); canopy.castShadow = true; tilt.add(canopy);
    for (const [x, z] of [[1.05, 1.5], [-1.05, 1.5], [1.05, -1.1], [-1.05, -1.1]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), chrome);
      post.position.set(x, 2.3, z); post.castShadow = true; tilt.add(post);
    }
    // wheels live on root (stay planted on the surface)
    this.wheels = [];
    const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.4, 16);
    for (const [x, z, front] of [[1.25, 1.5, true], [-1.25, 1.5, true], [1.25, -1.4, false], [-1.25, -1.4, false]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.rotation.z = Math.PI / 2; w.position.set(x, 0.62, z); w.castShadow = true;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.42, 8), chrome);
      hub.rotation.z = Math.PI / 2; w.add(hub);
      root.add(w); this.wheels.push({ mesh: w, front });
    }
    const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 1.6, 10), new THREE.MeshStandardMaterial({ color: 0x9a2b2b, roughness: 0.6 }));
    bag.position.set(0.7, 2.0, -1.7); bag.rotation.x = 0.25; bag.castShadow = true; tilt.add(bag);
    for (let i = 0; i < 4; i++) {
      const club = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), chrome);
      club.position.set(0.7 + (i - 1.5) * 0.12, 3.0, -1.85); club.rotation.x = 0.25; tilt.add(club);
    }

    // golfer
    const golfer = new THREE.Group();
    golfer.position.set(0.5, 1.7, 0.1);
    this.golfer = golfer; tilt.add(golfer);
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98d63, roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x36506b, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), shirt); torso.position.y = 0.95; torso.castShadow = true; golfer.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.5, 0.4), pants); hips.position.y = 0.4; golfer.add(hips);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skin); head.position.y = 1.66; head.castShadow = true; golfer.add(head);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: C.pickup, roughness: 0.5 }));
    cap.position.y = 1.74; golfer.add(cap);
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), shirt); armL.position.set(-0.45, 1.0, 0.05); golfer.add(armL);
    const armPivot = new THREE.Group(); armPivot.position.set(0.4, 1.25, 0.1); golfer.add(armPivot);
    this.armPivot = armPivot;
    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), shirt); armR.position.set(0, -0.35, 0.15); armPivot.add(armR);
    const club = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6), new THREE.MeshStandardMaterial({ color: 0x303030, metalness: 0.6, roughness: 0.4 }));
    club.position.set(0, -0.9, 0.5); club.rotation.x = 0.6; armPivot.add(club);
    const clubHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.28), chrome); clubHead.position.set(0, -1.55, 0.95); armPivot.add(clubHead);
    armPivot.rotation.x = -0.5;

    this.update(0, { throttle: 0, steer: 0, boost: false });
  }

  get shootOrigin() { return this._so.set(this.pos.x, this.pos.y + 3.0, this.pos.z); }
  get boost01() { return this.boostFuel / CONFIG.boostMax; }
  swing() { this.swingT = 0; }

  reset() {
    this.pos.set(0, this.roofTop, CONFIG.rooftopSize * 0.28);
    this.heading = Math.PI; this.speed = 0; this.lateralVel = 0;
    this.boostFuel = CONFIG.boostMax; this.boostActive = false; this.boostCooldown = 0;
    this.lean = 0; this.pitch = 0; this.region = 2; this.health = CONFIG.cartHealth; this.clawT = 0; this.hurt = false;
  }
  returnToRoof() {
    this.pos.set(0, this.roofTop, CONFIG.rooftopSize * 0.28);
    this.heading = Math.PI; this.speed = 0; this.lateralVel = 0; this.lean = this.pitch = 0; this.region = 2;
  }

  _surfaceAt(x, z) {
    const R = CONFIG.ramp;
    const half = CONFIG.rooftopSize / 2;
    const edgeZ = half + 2;
    const roofTopY = this.roofTop;
    const s = R.side;
    const zr = z * s;
    const onRampX = Math.abs(x) <= R.width / 2 + 0.1;
    const surf = this._surf;
    const inFootprint = Math.abs(x) <= edgeZ && Math.abs(z) <= edgeZ;
    if (inFootprint && !(onRampX && zr > half - 1)) { surf.y = roofTopY; surf.region = 2; surf.grade = 0; return surf; }
    const footZ = edgeZ + R.slopeRun;
    if (onRampX && zr >= half - 1 && zr <= footZ) {
      if (zr <= edgeZ) { surf.y = roofTopY; surf.region = 2; surf.grade = 0; return surf; }
      const t = (zr - edgeZ) / R.slopeRun;
      surf.y = roofTopY * (1 - t); surf.region = 1; surf.grade = roofTopY / R.slopeRun; return surf;
    }
    surf.y = 0; surf.region = 0; surf.grade = 0; return surf;
  }

  update(dt, drive) {
    const throttle = drive.throttle || 0;
    const steer = drive.steer || 0;

    // boost
    this.boostActive = false;
    if (this.boostCooldown > 0) this.boostCooldown -= dt;
    const wantBoost = drive.boost && throttle > 0 && this.boostFuel > 0 && this.boostCooldown <= 0;
    if (wantBoost) {
      this.boostActive = true; this.boostFuel = Math.max(0, this.boostFuel - dt);
      if (this.boostFuel <= 0) this.boostCooldown = CONFIG.boostCooldown;
    } else this.boostFuel = Math.min(CONFIG.boostMax, this.boostFuel + CONFIG.boostRegen * dt);

    const accel = CONFIG.cartAccel * (this.boostActive ? CONFIG.boostAccelMult : 1);
    const maxFwd = CONFIG.cartMaxSpeed * (this.boostActive ? CONFIG.boostSpeedMult : 1);
    if (throttle !== 0) this.speed += throttle * accel * dt;
    const fr = CONFIG.cartFriction * dt;
    if (this.speed > 0) this.speed = Math.max(0, this.speed - fr * (throttle <= 0 ? 1 : 0.2));
    else if (this.speed < 0) this.speed = Math.min(0, this.speed + fr * (throttle >= 0 ? 1 : 0.2));
    this.speed = clamp(this.speed, -CONFIG.cartReverseSpeed, maxFwd);

    // steering
    const spAbs = Math.abs(this.speed);
    const lowEnd = Math.min(1, spAbs / 3);
    const hiEnd = 1 - clamp((spAbs - CONFIG.cartTurnFalloff) / CONFIG.cartMaxSpeed, 0, 0.55);
    const turnAuth = lowEnd * hiEnd * Math.sign(this.speed || 1);
    this.heading += steer * CONFIG.cartTurnRate * dt * turnAuth;
    this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));

    // drift
    this._lat.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
    const skid = steer * turnAuth * spAbs * CONFIG.cartDriftGain;
    this.lateralVel = (this.lateralVel + skid * dt) * Math.max(0, 1 - CONFIG.cartGrip * dt);
    this.pos.x += (this._fwd.x * this.speed + this._lat.x * this.lateralVel) * dt;
    this.pos.z += (this._fwd.z * this.speed + this._lat.z * this.lateralVel) * dt;

    // bounds
    const surf = this._surfaceAt(this.pos.x, this.pos.z);
    if (surf.region === 2) {
      const lim = (CONFIG.rooftopSize / 2 + 2) - 0.9;
      if (this.pos.x > lim || this.pos.x < -lim) { this.pos.x = clamp(this.pos.x, -lim, lim); this.speed *= 0.4; this.lateralVel = 0; }
      const inGap = Math.abs(this.pos.x) <= CONFIG.ramp.width / 2;
      const sgn = CONFIG.ramp.side;
      if (this.pos.z * -sgn > lim) { this.pos.z = -sgn * lim; this.speed *= 0.4; }              // closed side
      if (!inGap && this.pos.z * sgn > lim) { this.pos.z = sgn * lim; this.speed *= 0.4; }        // ramp side except gap
    } else if (surf.region === 0) {
      const tb = CONFIG.rooftopSize / 2 + 2 + 1.5;
      const inGap = Math.abs(this.pos.x) <= CONFIG.ramp.width / 2 && this.pos.z * CONFIG.ramp.side > 0;
      if (!inGap && Math.abs(this.pos.x) < tb && Math.abs(this.pos.z) < tb) {
        const px = tb - Math.abs(this.pos.x), pz = tb - Math.abs(this.pos.z);
        if (px < pz) this.pos.x = Math.sign(this.pos.x || 1) * tb; else this.pos.z = Math.sign(this.pos.z || 1) * tb;
        this.speed *= 0.5; this.lateralVel = 0;
      }
      const r2 = this.pos.x * this.pos.x + this.pos.z * this.pos.z, R = CONFIG.groundPlayRadius;
      if (r2 > R * R) { const inv = R / Math.sqrt(r2); this.pos.x *= inv; this.pos.z *= inv; this.speed *= 0.5; }
    } else if (surf.region === 1) {
      // on the ramp: keep the cart between the curbs
      const rl = CONFIG.ramp.width / 2 - 0.5;
      if (this.pos.x > rl || this.pos.x < -rl) { this.pos.x = clamp(this.pos.x, -rl, rl); this.lateralVel = 0; }
    }

    // vertical follow
    const surfY = this._surfaceAt(this.pos.x, this.pos.z).y;
    this.pos.y = damp(this.pos.y, surfY, CONFIG.cartGroundFollow, dt);
    this.region = this._surf.region;
    this.root.position.copy(this.pos);

    // suspension tilt
    const rollTgt = clamp(-steer * turnAuth * spAbs * CONFIG.cartLeanGain - this.lateralVel * CONFIG.cartSkidLean, -CONFIG.cartLeanMax, CONFIG.cartLeanMax);
    const accelPitch = -clamp((this.speed - this._prevSpeed) / (dt || 0.016), -40, 40) * CONFIG.cartPitchGain;
    this._prevSpeed = this.speed;
    // ramp slope decomposed into the cart's local pitch+roll by heading (L2)
    const gradeMag = this._surf.region === 1 ? Math.atan2(this.roofTop, CONFIG.ramp.slopeRun) * CONFIG.ramp.side : 0;
    this.lean = damp(this.lean, rollTgt, CONFIG.cartTiltDamp, dt);
    this.pitch = damp(this.pitch, accelPitch, CONFIG.cartTiltDamp, dt);
    this.bodyTilt.rotation.z = this.lean + gradeMag * Math.sin(this.heading);
    this.bodyTilt.rotation.x = this.pitch + gradeMag * Math.cos(this.heading);
    this.root.rotation.set(0, this.heading, 0);

    // wheels
    const spin = (this.speed * dt) / 0.62;
    for (const w of this.wheels) { w.mesh.rotation.x += spin; w.mesh.rotation.y = w.front ? steer * 0.4 : 0; }

    // boost exhaust
    if (this.boostActive) {
      this._exhaustT += dt;
      if (this._exhaustT > 0.03) { this._exhaustT = 0; this.ctx.effects.exhaust?.(this.pos.x - this._fwd.x * 2, this.pos.y + 0.6, this.pos.z - this._fwd.z * 2); }
    }

    // cart hull regen when clear of zombies
    if (this.clawT > 0) this.clawT -= dt;
    else if (this.health < CONFIG.cartHealth) this.health = Math.min(CONFIG.cartHealth, this.health + CONFIG.cartHealthRegen * dt);
    this.hurt = this.clawT > 0;

    // swing
    if (this.swingT >= 0) {
      this.swingT += dt; const p = this.swingT / 0.4;
      if (p >= 1) { this.swingT = -1; this.armPivot.rotation.x = -0.5; }
      else this.armPivot.rotation.x = p < 0.4 ? -0.5 - p * 2.2 : -1.4 + (p - 0.4) * 3.0;
    }
  }

  // cart-vs-zombie run-over (called after update from Game.step)
  runOverPass(dt) {
    if (this.region === 2) return;
    const z = this.ctx.zombies;
    const sp = this.speed;                 // forward run-overs only (reverse is slow & safe)
    if (sp < CONFIG.runOverMinSpeed) return;
    const rr = CONFIG.zombieRadius + CONFIG.cartHitRadius, rr2 = rr * rr;
    const nx = this.pos.x + this._fwd.x * CONFIG.cartNoseOffset;
    const nz = this.pos.z + this._fwd.z * CONFIG.cartNoseOffset;
    for (const zz of z.z) {
      if (!zz.alive || zz.dying || zz.hitT > 0) continue;
      const dx = zz.x - nx, dz = zz.zz - nz;          // nose -> zombie (launch outward)
      if (dx * dx + dz * dz >= rr2) continue;
      const cx = zz.x - this.pos.x, cz = zz.zz - this.pos.z;
      if (cx * this._fwd.x + cz * this._fwd.z < -1.0) continue; // behind the cart
      this._runOver(zz, dx, dz, sp);
    }
  }

  _runOver(zz, dx, dz, spAbs) {
    const boost = this.boostActive ? CONFIG.runOverBoostMult : 1;
    const sp01 = clamp((spAbs - CONFIG.runOverMinSpeed) / (CONFIG.cartMaxSpeed - CONFIG.runOverMinSpeed), 0, 1);
    const mag = (CONFIG.runOverImpulseMin + sp01 * (CONFIG.runOverImpulseMax - CONFIG.runOverImpulseMin)) * boost;
    const dl = Math.hypot(dx, dz) || 1, rxn = dx / dl, rzn = dz / dl;
    const mixF = CONFIG.runOverForwardMix;
    let ix = this._fwd.x * mixF + rxn * (1 - mixF), iz = this._fwd.z * mixF + rzn * (1 - mixF);
    const il = Math.hypot(ix, iz) || 1; ix /= il; iz /= il;
    const lift = CONFIG.runOverLiftBase + sp01 * CONFIG.runOverLiftSpeed;
    this.ctx.zombies.runOver(zz, ix * mag, lift * boost, iz * mag);
    this.ctx.effects.blood?.(zz.x, 2.0, zz.zz, mag);
    (this.ctx.audio.thud ? this.ctx.audio.thud(sp01) : this.ctx.audio.hit());
    this.ctx.game.onRunOver(sp01, this.boostActive);
    this.speed *= (this.boostActive ? CONFIG.runOverDragBoost : CONFIG.runOverDrag);
    zz.hitT = CONFIG.runOverIFrame;
  }
}
