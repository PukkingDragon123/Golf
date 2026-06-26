// =============================================================
// Player — JOHN. He walks the rooftop on foot and tees off; the golf cart is
// a PURCHASABLE upgrade he can mount to drive the street. Two rigs under the
// scene (cart + standing John), one logical position (`pos`) and a `mode`
// ('foot' | 'cart') that switches what WASD does. Cart physics = arcade
// driving with boost, drift, suspension tilt, ramp, run-over carnage.
// Zero per-frame allocation.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, damp, angleDelta, TAU } from './utils.js';

const C = CONFIG.col;

export class Player {
  constructor(scene, ctx) {
    this.ctx = ctx;
    this.roofTop = CONFIG.rooftopHeight + 1.2;

    // ---- master state ----
    this.mode = 'foot';            // 'foot' | 'cart'
    this.cartOwned = false;        // purchased this run?
    this.cartMounted = false;      // currently driving?
    this.heading = Math.PI;        // cart heading
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
    // foot locomotion
    this.footHeading = Math.PI;
    this.footSpeed = 0;
    this.walkPhase = 0;
    this._walkAmp = 0;
    this._hipY = 1.05;
    // parked-cart bookkeeping (owned but on foot)
    this.cartParkPos = new THREE.Vector3(9999, this.roofTop, 9999);
    this.cartParkHeading = 0;
    // scratch
    this._fwd = new THREE.Vector3();
    this._lat = new THREE.Vector3();
    this._surf = { y: this.roofTop, region: 2, grade: 0 };
    this._so = new THREE.Vector3();
    this._exhaustT = 0;

    this._buildCart(scene);
    this._buildJohn(scene);
    this._renderRigs(0);
  }

  // ---------------------------------------------------------------
  // model builds
  // ---------------------------------------------------------------
  _buildCart(scene) {
    const cartGroup = new THREE.Group();
    cartGroup.rotation.order = 'YXZ';
    this.cartGroup = cartGroup; scene.add(cartGroup);
    const tilt = new THREE.Group(); cartGroup.add(tilt); this.bodyTilt = tilt;

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
    // grille + headlights for a touch more detail
    const grille = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 0.12), dark);
    grille.position.set(0, 0.85, 3.05); tilt.add(grille);
    for (const lx of [-0.8, 0.8]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10), new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffd98a, emissiveIntensity: 0.7, roughness: 0.4 }));
      lamp.rotation.x = Math.PI / 2; lamp.position.set(lx, 0.95, 3.07); tilt.add(lamp);
    }
    for (const [x, z] of [[1.05, 1.5], [-1.05, 1.5], [1.05, -1.1], [-1.05, -1.1]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), chrome);
      post.position.set(x, 2.3, z); post.castShadow = true; tilt.add(post);
    }
    // wheels live on cartGroup (stay planted on the surface)
    this.wheels = [];
    const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.4, 16);
    for (const [x, z, front] of [[1.25, 1.5, true], [-1.25, 1.5, true], [1.25, -1.4, false], [-1.25, -1.4, false]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.rotation.z = Math.PI / 2; w.position.set(x, 0.62, z); w.castShadow = true;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.42, 8), chrome);
      hub.rotation.z = Math.PI / 2; w.add(hub);
      cartGroup.add(w); this.wheels.push({ mesh: w, front });
    }
    const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 1.6, 10), new THREE.MeshStandardMaterial({ color: 0x9a2b2b, roughness: 0.6 }));
    bag.position.set(0.7, 2.0, -1.7); bag.rotation.x = 0.25; bag.castShadow = true; tilt.add(bag);
    for (let i = 0; i < 4; i++) {
      const club = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), chrome);
      club.position.set(0.7 + (i - 1.5) * 0.12, 3.0, -1.85); club.rotation.x = 0.25; tilt.add(club);
    }

    // seated driver (= John in the cart). Hidden when John is on foot.
    const golfer = new THREE.Group();
    golfer.position.set(0.5, 1.7, 0.1);
    this.golfer = golfer; tilt.add(golfer);
    const skin = new THREE.MeshStandardMaterial({ color: C.johnSkin, roughness: 0.65 });
    const shirt = new THREE.MeshStandardMaterial({ color: C.johnPolo, roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: C.johnSlacks, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), shirt); torso.position.y = 0.95; torso.castShadow = true; golfer.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.5, 0.4), pants); hips.position.y = 0.4; golfer.add(hips);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skin); head.position.y = 1.66; head.castShadow = true; golfer.add(head);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: C.johnCap, roughness: 0.5 }));
    cap.position.y = 1.74; golfer.add(cap);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.22), new THREE.MeshStandardMaterial({ color: C.johnCap, roughness: 0.5 }));
    brim.position.set(0, 1.72, 0.26); golfer.add(brim);
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), shirt); armL.position.set(-0.45, 1.0, 0.05); golfer.add(armL);
    const armPivot = new THREE.Group(); armPivot.position.set(0.4, 1.25, 0.1); golfer.add(armPivot);
    this.armPivot = armPivot;
    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), shirt); armR.position.set(0, -0.35, 0.15); armPivot.add(armR);
    const club = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6), new THREE.MeshStandardMaterial({ color: 0x303030, metalness: 0.6, roughness: 0.4 }));
    club.position.set(0, -0.9, 0.5); club.rotation.x = 0.6; armPivot.add(club);
    const clubHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.28), chrome); clubHead.position.set(0, -1.55, 0.95); armPivot.add(clubHead);
    armPivot.rotation.x = -0.5;
  }

  // detailed standing JOHN — articulated, ~3.4 tall, origin at the feet
  _buildJohn(scene) {
    const john = new THREE.Group(); john.rotation.order = 'YXZ';
    this.johnGroup = john; scene.add(john);

    const skin = new THREE.MeshStandardMaterial({ color: C.johnSkin, roughness: 0.65 });
    const polo = new THREE.MeshStandardMaterial({ color: C.johnPolo, roughness: 0.6 });
    const slacks = new THREE.MeshStandardMaterial({ color: C.johnSlacks, roughness: 0.7 });
    const capMat = new THREE.MeshStandardMaterial({ color: C.johnCap, roughness: 0.5 });
    const shoeMat = new THREE.MeshStandardMaterial({ color: C.johnShoe, roughness: 0.4 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: C.johnGlove, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.6 });
    const clubMat = new THREE.MeshStandardMaterial({ color: 0x2c2c2c, metalness: 0.6, roughness: 0.4 });
    const chrome = new THREE.MeshStandardMaterial({ color: C.chrome, metalness: 0.9, roughness: 0.25 });

    const hip = new THREE.Group(); hip.position.y = this._hipY; john.add(hip);
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.32, 0.34), slacks); pelvis.castShadow = true; hip.add(pelvis);

    const mkLeg = (sx) => {
      const leg = new THREE.Group(); leg.position.set(sx * 0.16, -0.12, 0); hip.add(leg);
      const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.55, 0.22), slacks); thigh.position.y = -0.275; thigh.castShadow = true; leg.add(thigh);
      const knee = new THREE.Group(); knee.position.y = -0.55; leg.add(knee);
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.52, 0.19), slacks); shin.position.y = -0.26; shin.castShadow = true; knee.add(shin);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.42), shoeMat); shoe.position.set(0, -0.55, 0.09); shoe.castShadow = true; knee.add(shoe);
      return { leg, knee };
    };
    const legL = mkLeg(-1), legR = mkLeg(1);

    const spine = new THREE.Group(); spine.position.y = 0.16; hip.add(spine);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.66, 0.40), polo); torso.position.y = 0.33; torso.castShadow = true; spine.add(torso);
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.42), polo); collar.position.y = 0.66; spine.add(collar);
    for (let b = 0; b < 3; b++) { const btn = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.04), dark); btn.position.set(0, 0.5 - b * 0.14, 0.205); spine.add(btn); }

    const mkArm = (sx, withClub) => {
      const sh = new THREE.Group(); sh.position.set(sx * 0.34, 0.5, 0); spine.add(sh);
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.46, 0.16), polo); up.position.y = -0.23; up.castShadow = true; sh.add(up);
      const el = new THREE.Group(); el.position.y = -0.46; sh.add(el);
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.14), skin); fore.position.y = -0.21; fore.castShadow = true; el.add(fore);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), gloveMat); hand.position.y = -0.42; el.add(hand);
      if (withClub) {
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.4, 6), clubMat);
        shaft.position.set(0, -0.78, 0.45); shaft.rotation.x = 0.6; el.add(shaft);
        const chd = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.30), chrome); chd.position.set(0, -1.36, 0.92); el.add(chd);
      }
      return { sh, el };
    };
    const armL = mkArm(-1, false), armR = mkArm(1, true);
    armL.sh.rotation.x = -0.25; armR.sh.rotation.x = -0.35;     // hands meet near the grip at rest

    const neck = new THREE.Group(); neck.position.y = 0.66; spine.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), skin); head.position.y = 0.12; head.castShadow = true; neck.add(head);
    // face
    for (const ex of [-0.09, 0.09]) { const eye = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.03), dark); eye.position.set(ex, 0.03, 0.22); head.add(eye); }
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.07), skin); nose.position.set(0, -0.03, 0.24); head.add(nose);
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.02), dark); mouth.position.set(0, -0.12, 0.22); head.add(mouth);
    for (const ex of [-0.23, 0.23]) { const ear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.08), skin); ear.position.set(ex, 0.02, 0); head.add(ear); }
    // cap (dome + brim)
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 8, 0, TAU, 0, Math.PI / 2), capMat); dome.position.y = 0.12; head.add(dome);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.24), capMat); brim.position.set(0, 0.12, 0.24); head.add(brim);

    this.j = { hip, legL: legL.leg, legR: legR.leg, kneeL: legL.knee, kneeR: legR.knee, spine, shoulderL: armL.sh, shoulderR: armR.sh, head: neck, restRshX: -0.35 };
  }

  // ---------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------
  get shootOrigin() {
    const h = (this.mode === 'cart') ? CONFIG.cart.shootY : CONFIG.walk.shootY;
    return this._so.set(this.pos.x, this.pos.y + h, this.pos.z);
  }
  get boost01() { return this.boostFuel / CONFIG.boostMax; }
  get onFoot() { return this.mode === 'foot'; }
  swing() { this.swingT = 0; }

  reset() {
    this.mode = 'foot'; this.cartOwned = false; this.cartMounted = false;
    this.pos.set(0, this.roofTop, CONFIG.rooftopSize * 0.28);
    this.heading = Math.PI; this.footHeading = Math.PI; this.footSpeed = 0; this.walkPhase = 0; this._walkAmp = 0;
    this.speed = 0; this.lateralVel = 0;
    this.boostFuel = CONFIG.boostMax; this.boostActive = false; this.boostCooldown = 0;
    this.lean = 0; this.pitch = 0; this.region = 2; this.health = CONFIG.cartHealth; this.clawT = 0; this.hurt = false;
    this.swingT = -1;
    this.cartParkPos.set(9999, this.roofTop, 9999); this.cartParkHeading = 0;
    this._renderRigs(0);
  }
  // recover key (R): on foot just re-centre John on the roof; in cart, snap the cart back up top
  returnToRoof() {
    this.pos.set(0, this.roofTop, CONFIG.rooftopSize * 0.28);
    this.heading = Math.PI; this.footHeading = Math.PI; this.speed = 0; this.lateralVel = 0; this.lean = this.pitch = 0; this.region = 2;
    if (this.mode === 'cart') { /* stays mounted, repositioned on the roof */ }
  }

  // ---- cart upgrade lifecycle ----
  purchaseCart() {
    if (this.cartOwned) return;
    this.cartOwned = true;
    const rx = Math.cos(this.footHeading), rz = -Math.sin(this.footHeading);   // John's right
    const off = CONFIG.cart.parkOffset;
    const lim = (CONFIG.rooftopSize / 2 + 2) - 1.5;
    this.cartParkPos.set(clamp(this.pos.x + rx * off, -lim, lim), this.roofTop, clamp(this.pos.z + rz * off, -lim, lim));
    this.cartParkHeading = this.footHeading;
  }
  mountCart() {
    if (!this.cartOwned || this.cartMounted || this.region !== 2) return false;
    const dx = this.pos.x - this.cartParkPos.x, dz = this.pos.z - this.cartParkPos.z;
    if (dx * dx + dz * dz > CONFIG.cart.mountRadius * CONFIG.cart.mountRadius) return false;
    this.pos.copy(this.cartParkPos); this.heading = this.cartParkHeading;
    this.mode = 'cart'; this.cartMounted = true; this.speed = 0; this.lateralVel = 0;
    this.ctx.audio?.pickup?.();
    return true;
  }
  exitCart() {
    if (this.mode !== 'cart') return false;
    if (this.region !== 2) return false;          // can only dismount on the roof (never strand John on the street)
    this.cartParkPos.set(this.pos.x, this.roofTop, this.pos.z); this.cartParkHeading = this.heading;
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading);
    const lim = (CONFIG.rooftopSize / 2 + 2) - CONFIG.walk.edgeMargin;
    this.pos.set(clamp(this.pos.x + rx * CONFIG.cart.parkOffset, -lim, lim), this.roofTop, clamp(this.pos.z + rz * CONFIG.cart.parkOffset, -lim, lim));
    this.mode = 'foot'; this.cartMounted = false; this.footHeading = this.heading; this.speed = 0; this.lateralVel = 0;
    return true;
  }
  get nearParkedCart() {
    if (!this.cartOwned || this.mode === 'cart') return false;
    const dx = this.pos.x - this.cartParkPos.x, dz = this.pos.z - this.cartParkPos.z;
    return dx * dx + dz * dz <= CONFIG.cart.mountRadius * CONFIG.cart.mountRadius;
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
    if (this.mode === 'cart') this._updateCart(dt, drive);
    else this._updateFoot(dt, drive);
    this._renderRigs(dt);
  }

  // ---------------------------------------------------------------
  // FOOT — walk John around the rooftop (region 2 only)
  // ---------------------------------------------------------------
  _updateFoot(dt, drive) {
    const W = CONFIG.walk;
    const ay = this.ctx.golf ? this.ctx.golf.aimYaw : this.footHeading;   // aim-relative movement
    const fx = Math.sin(ay), fz = Math.cos(ay), rxv = Math.cos(ay), rzv = -Math.sin(ay);
    const th = drive.throttle || 0, st = drive.steer || 0;
    let dx = fx * th + rxv * st, dz = fz * th + rzv * st;
    let inLen = Math.hypot(dx, dz);
    if (inLen > 1) { dx /= inLen; dz /= inLen; inLen = 1; }
    this.footSpeed = damp(this.footSpeed, inLen * W.speed, W.accel, dt);
    if (inLen > 0.05) {
      const tgt = Math.atan2(dx, dz);
      this.footHeading += angleDelta(this.footHeading, tgt) * (1 - Math.exp(-W.turn * dt));
    }
    if (inLen > 0.001) { const nx = dx / inLen, nz = dz / inLen; this.pos.x += nx * this.footSpeed * dt; this.pos.z += nz * this.footSpeed * dt; }

    // roof containment: clamp BOTH signs so John can never reach the ramp gap or fall off
    const lim = (CONFIG.rooftopSize / 2 + 2) - W.edgeMargin;
    this.pos.x = clamp(this.pos.x, -lim, lim);
    this.pos.z = clamp(this.pos.z, -lim, lim);
    // push out of the two solid rooftop fixtures (AC unit + water tank)
    this._pushOut(CONFIG.rooftopSize / 2 - 5, -(CONFIG.rooftopSize / 2 - 5), 3.4);
    this._pushOut(-(CONFIG.rooftopSize / 2 - 5), -(CONFIG.rooftopSize / 2 - 5), 2.6);
    this.pos.y = this.roofTop; this.region = 2;
    this.speed = 0; this.lateralVel = 0; this.boostActive = false;

    // procedural walk cycle + swing
    this.walkPhase = (this.walkPhase + this.footSpeed * W.cadence * dt) % TAU;
    this._poseJohn(dt);
  }

  _pushOut(cx, cz, r) {
    const dx = this.pos.x - cx, dz = this.pos.z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r && d2 > 1e-4) { const d = Math.sqrt(d2); this.pos.x = cx + dx / d * r; this.pos.z = cz + dz / d * r; }
  }

  _poseJohn(dt) {
    const W = CONFIG.walk, j = this.j;
    this._walkAmp = damp(this._walkAmp, clamp(this.footSpeed / W.speed, 0, 1), 8, dt);
    const amp = this._walkAmp, s = Math.sin(this.walkPhase), c = Math.cos(this.walkPhase);
    j.legL.rotation.x = s * W.legSwing * amp;
    j.legR.rotation.x = -s * W.legSwing * amp;
    j.kneeL.rotation.x = Math.max(0, -s) * W.kneeBend * amp;
    j.kneeR.rotation.x = Math.max(0, s) * W.kneeBend * amp;
    j.shoulderL.rotation.x = -0.25 - s * W.armSwing * amp;
    j.hip.position.y = this._hipY + Math.abs(c) * W.bob * amp;
    j.spine.rotation.x = W.lean * amp;
    j.spine.rotation.y = -s * W.torsoTwist * amp;
    j.head.rotation.x = -j.spine.rotation.x * 0.5;
    // right arm: golf swing overrides the walk swing
    if (this.swingT >= 0) {
      this.swingT += dt; const p = this.swingT / 0.4;
      if (p >= 1) { this.swingT = -1; j.shoulderR.rotation.x = j.restRshX; }
      else j.shoulderR.rotation.x = p < 0.45 ? j.restRshX - p * 3.4 : (j.restRshX - 1.53) + (p - 0.45) * 3.6;
    } else {
      j.shoulderR.rotation.x = j.restRshX - s * W.armSwing * 0.6 * amp;
    }
  }

  // ---------------------------------------------------------------
  // CART — arcade driving (verbatim v2 behaviour)
  // ---------------------------------------------------------------
  _updateCart(dt, drive) {
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
      const rl = CONFIG.ramp.width / 2 - 0.5;
      if (this.pos.x > rl || this.pos.x < -rl) { this.pos.x = clamp(this.pos.x, -rl, rl); this.lateralVel = 0; }
    }

    // vertical follow
    const surfY = this._surfaceAt(this.pos.x, this.pos.z).y;
    this.pos.y = damp(this.pos.y, surfY, CONFIG.cartGroundFollow, dt);
    this.region = this._surf.region;
    this.cartGroup.position.copy(this.pos);

    // suspension tilt
    const rollTgt = clamp(-steer * turnAuth * spAbs * CONFIG.cartLeanGain - this.lateralVel * CONFIG.cartSkidLean, -CONFIG.cartLeanMax, CONFIG.cartLeanMax);
    const accelPitch = -clamp((this.speed - this._prevSpeed) / (dt || 0.016), -40, 40) * CONFIG.cartPitchGain;
    this._prevSpeed = this.speed;
    const gradeMag = this._surf.region === 1 ? Math.atan2(this.roofTop, CONFIG.ramp.slopeRun) * CONFIG.ramp.side : 0;
    this.lean = damp(this.lean, rollTgt, CONFIG.cartTiltDamp, dt);
    this.pitch = damp(this.pitch, accelPitch, CONFIG.cartTiltDamp, dt);
    this.bodyTilt.rotation.z = this.lean + gradeMag * Math.sin(this.heading);
    this.bodyTilt.rotation.x = this.pitch + gradeMag * Math.cos(this.heading);
    this.cartGroup.rotation.set(0, this.heading, 0);

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

    // seated-golfer swing
    if (this.swingT >= 0) {
      this.swingT += dt; const p = this.swingT / 0.4;
      if (p >= 1) { this.swingT = -1; this.armPivot.rotation.x = -0.5; }
      else this.armPivot.rotation.x = p < 0.4 ? -0.5 - p * 2.2 : -1.4 + (p - 0.4) * 3.0;
    }
  }

  // visibility + parked-cart transform (called every frame after the mode update)
  _renderRigs(dt) {
    const cart = this.mode === 'cart';
    this.johnGroup.visible = !cart;
    this.cartGroup.visible = cart || this.cartOwned;
    this.golfer.visible = cart;                      // driver only present while driving
    if (!cart) {
      this.johnGroup.position.copy(this.pos);
      this.johnGroup.rotation.set(0, this.footHeading, 0);
      if (this.cartOwned) {
        this.cartGroup.position.copy(this.cartParkPos);
        this.cartGroup.rotation.set(0, this.cartParkHeading, 0);
        this.bodyTilt.rotation.set(0, 0, 0);
      }
    }
  }

  // cart-vs-zombie run-over (called after update from Game.step)
  runOverPass(dt) {
    if (this.mode !== 'cart') return;             // John on foot has no mass to flatten zombies
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
