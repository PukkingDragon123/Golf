// =============================================================
// Player — drivable golf cart + golfer. Arcade driving on the rooftop.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp } from './utils.js';

const C = CONFIG.col;

export class Player {
  constructor(scene) {
    this.roofTop = CONFIG.rooftopHeight + 1.2;
    this.heading = Math.PI;          // face toward -Z (out over the city) initially
    this.speed = 0;
    this.pos = new THREE.Vector3(0, this.roofTop, CONFIG.rooftopSize * 0.28);
    this.swingT = -1;
    this._fwd = new THREE.Vector3();

    const root = new THREE.Group();
    this.root = root;
    scene.add(root);

    const white = new THREE.MeshStandardMaterial({ color: C.cartWhite, metalness: 0.1, roughness: 0.5 });
    const chrome = new THREE.MeshStandardMaterial({ color: C.chrome, metalness: 0.9, roughness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x222428, metalness: 0.4, roughness: 0.6 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b6b6b, metalness: 0.1, roughness: 0.7 });

    // chassis
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.7, 4.2), white);
    body.position.y = 1.05; body.castShadow = true; body.receiveShadow = true; root.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 1.3), white);
    nose.position.set(0, 0.85, 2.4); nose.castShadow = true; root.add(nose);
    // seat
    const seat = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.35, 1.0), seatMat);
    seat.position.set(0, 1.5, -0.4); seat.castShadow = true; root.add(seat);
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.0, 0.3), seatMat);
    seatBack.position.set(0, 2.0, -0.95); seatBack.castShadow = true; root.add(seatBack);
    // canopy
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.18, 3.2), white);
    canopy.position.set(0, 3.5, 0.2); canopy.castShadow = true; root.add(canopy);
    for (const [x, z] of [[1.05, 1.5], [-1.05, 1.5], [1.05, -1.1], [-1.05, -1.1]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), chrome);
      post.position.set(x, 2.3, z); post.castShadow = true; root.add(post);
    }
    // wheels
    this.wheels = [];
    const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.4, 16);
    for (const [x, z, front] of [[1.25, 1.5, true], [-1.25, 1.5, true], [1.25, -1.4, false], [-1.25, -1.4, false]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.rotation.z = Math.PI / 2; w.position.set(x, 0.62, z); w.castShadow = true;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.42, 8), chrome);
      hub.rotation.z = Math.PI / 2; w.add(hub);
      root.add(w); this.wheels.push({ mesh: w, front });
    }
    // golf bag behind seat
    const bag = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 1.6, 10), new THREE.MeshStandardMaterial({ color: 0x9a2b2b, roughness: 0.6 }));
    bag.position.set(0.7, 2.0, -1.7); bag.rotation.x = 0.25; bag.castShadow = true; root.add(bag);
    for (let i = 0; i < 4; i++) {
      const club = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), chrome);
      club.position.set(0.7 + (i - 1.5) * 0.12, 3.0, -1.85); club.rotation.x = 0.25; root.add(club);
    }

    // ---- golfer ----
    const golfer = new THREE.Group();
    golfer.position.set(0.5, 1.7, 0.1);
    this.golfer = golfer; root.add(golfer);
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98d63, roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.6 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x36506b, roughness: 0.7 });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), shirt); torso.position.y = 0.95; torso.castShadow = true; golfer.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.5, 0.4), pants); hips.position.y = 0.4; golfer.add(hips);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), skin); head.position.y = 1.66; head.castShadow = true; golfer.add(head);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: C.pickup, roughness: 0.5 }));
    cap.position.y = 1.74; golfer.add(cap);
    // arms — the right arm holds the club and swings
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), shirt); armL.position.set(-0.45, 1.0, 0.05); golfer.add(armL);
    const armPivot = new THREE.Group(); armPivot.position.set(0.4, 1.25, 0.1); golfer.add(armPivot);
    this.armPivot = armPivot;
    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.8, 0.18), shirt); armR.position.set(0, -0.35, 0.15); armPivot.add(armR);
    const club = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 6), new THREE.MeshStandardMaterial({ color: 0x303030, metalness: 0.6, roughness: 0.4 }));
    club.position.set(0, -0.9, 0.5); club.rotation.x = 0.6; armPivot.add(club);
    const clubHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.28), chrome); clubHead.position.set(0, -1.55, 0.95); armPivot.add(clubHead);
    armPivot.rotation.x = -0.5;

    this.update(0, { throttle: 0, steer: 0 });
  }

  get shootOrigin() {
    return this._so ? this._so.set(this.pos.x, this.pos.y + 3.0, this.pos.z) : (this._so = new THREE.Vector3(this.pos.x, this.pos.y + 3.0, this.pos.z));
  }

  swing() { this.swingT = 0; }

  update(dt, drive) {
    // ---- driving ----
    const throttle = drive.throttle || 0;
    const steer = drive.steer || 0;
    if (throttle !== 0) this.speed += throttle * CONFIG.cartAccel * dt;
    // friction / coast-down
    const fr = CONFIG.cartFriction * dt;
    if (this.speed > 0) this.speed = Math.max(0, this.speed - fr * (throttle <= 0 ? 1 : 0.2));
    else if (this.speed < 0) this.speed = Math.min(0, this.speed + fr * (throttle >= 0 ? 1 : 0.2));
    this.speed = clamp(this.speed, -CONFIG.cartMaxSpeed * 0.6, CONFIG.cartMaxSpeed);

    const turnAuth = Math.min(1, Math.abs(this.speed) / 3) * Math.sign(this.speed || 1);
    this.heading += steer * CONFIG.cartTurnRate * dt * turnAuth;

    this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.pos.x += this._fwd.x * this.speed * dt;
    this.pos.z += this._fwd.z * this.speed * dt;

    // keep on the rooftop (inside the parapet)
    const lim = CONFIG.rooftopSize / 2 - 1.6;
    if (this.pos.x > lim || this.pos.x < -lim) { this.pos.x = clamp(this.pos.x, -lim, lim); this.speed *= 0.4; }
    if (this.pos.z > lim || this.pos.z < -lim) { this.pos.z = clamp(this.pos.z, -lim, lim); this.speed *= 0.4; }
    this.pos.y = this.roofTop;

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.heading;

    // wheels spin + steer
    const spin = (this.speed * dt) / 0.62;
    for (const w of this.wheels) {
      w.mesh.rotation.x += spin;
      w.mesh.rotation.y = w.front ? steer * 0.4 : 0;
    }

    // swing animation
    if (this.swingT >= 0) {
      this.swingT += dt;
      const p = this.swingT / 0.4;
      if (p >= 1) { this.swingT = -1; this.armPivot.rotation.x = -0.5; }
      else {
        // wind up then snap through
        this.armPivot.rotation.x = p < 0.4 ? -0.5 - p * 2.2 : -1.4 + (p - 0.4) * 3.0;
      }
    }
  }
}
