// =============================================================
// Golf — aiming, the ping-pong power meter, ball physics & collisions,
// the live trajectory preview, and the chase/aim camera.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, damp } from './utils.js';
import { pbrMaterial } from './textures.js';

export class Golf {
  constructor(scene, ctx) {
    this.scene = scene;
    this.ctx = ctx; // {player, zombies, effects, audio, game}
    this.aimYaw = Math.PI;
    this.aimPitch = CONFIG.pitchDefault;
    this.charging = false;
    this.power = 0;
    this.powerDir = 1;

    this.dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._camTgt = new THREE.Vector3();

    // ball pool
    const ballMat = pbrMaterial(THREE, ctx.assets.golfball, { roughness: 0.42, metalness: 0.0 });
    const expMat = ballMat.clone();
    expMat.emissive = new THREE.Color(CONFIG.col.explosive); expMat.emissiveIntensity = 0.7;
    this.ballMat = ballMat; this.expMat = expMat;
    const geo = new THREE.SphereGeometry(CONFIG.ballRadius, 18, 14);
    this.balls = [];
    for (let i = 0; i < CONFIG.maxBalls; i++) {
      const mesh = new THREE.Mesh(geo, ballMat);
      mesh.castShadow = true; mesh.visible = false;
      scene.add(mesh);
      this.balls.push({ mesh, vel: new THREE.Vector3(), life: 0, active: false, explosive: false, grounded: false });
    }

    // trajectory preview line + landing marker
    const tp = CONFIG.trajPoints;
    this.trajArr = new Float32Array(tp * 3);
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(this.trajArr, 3));
    this.trajLine = new THREE.Line(tgeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: true }));
    this.trajLine.frustumCulled = false;
    scene.add(this.trajLine);
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.0, 24),
      new THREE.MeshBasicMaterial({ color: CONFIG.col.pickup, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    this.marker.rotation.x = -Math.PI / 2;
    scene.add(this.marker);
  }

  reset() {
    for (const b of this.balls) { b.active = false; b.mesh.visible = false; }
    this.charging = false; this.power = 0; this.powerDir = 1;
    this.aimYaw = Math.PI; this.aimPitch = CONFIG.pitchDefault;
  }

  addAim(dyaw, dpitch) {
    this.aimYaw -= dyaw;
    this.aimPitch = clamp(this.aimPitch - dpitch, CONFIG.pitchMin, CONFIG.pitchMax);
  }

  aimVec(out, yaw = this.aimYaw, pitch = this.aimPitch) {
    const cp = Math.cos(pitch);
    return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
  }

  startCharge() {
    if (this.ctx.game.ammo <= 0) { this.ctx.game.flashNoAmmo(); return; }
    this.charging = true; this.power = 0; this.powerDir = 1;
  }

  releaseCharge() {
    if (!this.charging) return;
    this.charging = false;
    this.fire(this.power / 100);
    this.power = 0;
  }

  fire(power01) {
    const game = this.ctx.game;
    if (game.ammo <= 0) { game.flashNoAmmo(); return; }
    game.useAmmo();
    const speed = lerp(CONFIG.minLaunch, CONFIG.maxLaunch, power01);
    // armed mode (cycled with the item key) decides what this shot does
    let explosive = false, multi = false;
    if (game.armed === 'explosive' && game.explosiveShots > 0) { explosive = true; game.explosiveShots--; }
    else if (game.armed === 'multiball' && game.multiballShots > 0) { multi = true; game.multiballShots--; }
    const n = multi ? CONFIG.multiballCount : 1;

    const origin = this.ctx.player.shootOrigin;
    for (let k = 0; k < n; k++) {
      const off = multi ? (k - (n - 1) / 2) * CONFIG.multiballSpread : 0;
      this.aimVec(this._tmp, this.aimYaw + off, this.aimPitch);
      const b = this.balls.find((x) => !x.active);
      if (!b) break;
      b.active = true; b.grounded = false; b.life = 0; b.explosive = explosive;
      b.mesh.material = explosive ? this.expMat : this.ballMat;
      b.mesh.visible = true;
      b.mesh.position.copy(origin);
      b.vel.copy(this._tmp).multiplyScalar(speed);
    }
    this.ctx.player.swing();
    this.ctx.audio.swing(power01);
    game.afterFire();
  }

  // simulate physics for the preview (pure, no side effects)
  _stepPreview(pos, vel, dt) {
    const sp = vel.length();
    this._a.copy(vel).multiplyScalar(-CONFIG.dragCoef * sp);
    this._a.y -= CONFIG.gravity;
    vel.addScaledVector(this._a, dt);
    pos.addScaledVector(vel, dt);
  }

  updatePreview(visible) {
    if (!visible) { this.trajLine.visible = false; this.marker.visible = false; return; }
    this.trajLine.visible = true;
    const power01 = this.charging ? this.power / 100 : 0.6;
    const speed = lerp(CONFIG.minLaunch, CONFIG.maxLaunch, power01);
    this.aimVec(this._tmp);
    const pos = this._camPos.copy(this.ctx.player.shootOrigin);
    const vel = this._camTgt.copy(this._tmp).multiplyScalar(speed);
    const dt = 0.045;
    let landX = pos.x, landZ = pos.z, landed = false;
    for (let i = 0; i < CONFIG.trajPoints; i++) {
      this.trajArr[i * 3] = pos.x; this.trajArr[i * 3 + 1] = pos.y; this.trajArr[i * 3 + 2] = pos.z;
      if (!landed && pos.y <= CONFIG.ballRadius && vel.y < 0) { landX = pos.x; landZ = pos.z; landed = true; }
      this._stepPreview(pos, vel, dt);
    }
    this.trajLine.geometry.attributes.position.needsUpdate = true;
    this.trajLine.geometry.computeBoundingSphere();
    if (landed) {
      this.marker.visible = true;
      this.marker.position.set(landX, 0.15, landZ);
      const c = this.charging ? CONFIG.col.pickup : 0xffffff;
      this.marker.material.color.setHex(c);
      this.trajLine.material.opacity = this.charging ? 0.85 : 0.4;
    } else this.marker.visible = false;
  }

  explode(pos, ball) {
    const z = this.ctx.zombies, eff = this.ctx.effects, game = this.ctx.game;
    const killed = z.damageArea(pos, CONFIG.explosionRadius, { dmg: CONFIG.explosionDamage, dismember: true });
    eff.explosion(pos);
    this.ctx.audio.explosion();
    if (killed > 0) game.addScore(killed * CONFIG.scorePerKill + (killed - 1) * CONFIG.comboBonus, killed > 1);
    if (ball) { ball.active = false; ball.mesh.visible = false; }
  }

  update(dt, playing) {
    // power meter ping-pong
    if (this.charging) {
      this.power += this.powerDir * CONFIG.powerChargeRate * dt;
      if (this.power >= 100) { this.power = 100; this.powerDir = -1; }
      else if (this.power <= 0) { this.power = 0; this.powerDir = 1; }
    }

    const z = this.ctx.zombies, eff = this.ctx.effects, game = this.ctx.game;
    for (const b of this.balls) {
      if (!b.active) continue;
      b.life += dt;
      // integrate
      const sp = b.vel.length();
      this._a.copy(b.vel).multiplyScalar(-CONFIG.dragCoef * sp);
      this._a.y -= CONFIG.gravity;
      b.vel.addScaledVector(this._a, dt);
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.x += sp * dt * 0.3;

      const p = b.mesh.position;

      // zombie collision
      if (!b.grounded || sp > 4) {
        const hit = z.hitTest(p, CONFIG.ballRadius);
        if (hit) {
          if (b.explosive) { this.explode(p, b); continue; }
          const died = z.hitBall(hit, p, b.vel);
          if (died) game.addScore(CONFIG.scorePerKill, false);
          this.ctx.audio.hit();
          b.vel.multiplyScalar(died ? 0.62 : 0.45); // plow through; brutes soak more
        }
      }

      // ground collision
      if (p.y <= CONFIG.ballRadius) {
        if (b.explosive) { p.y = CONFIG.ballRadius; this.explode(p, b); continue; }
        p.y = CONFIG.ballRadius;
        b.vel.y = -b.vel.y * CONFIG.restitution;
        const f = Math.max(0, 1 - CONFIG.rollFriction * dt);
        b.vel.x *= f; b.vel.z *= f;
        b.grounded = b.vel.y < 4;
        if (b.grounded && Math.hypot(b.vel.x, b.vel.z) < CONFIG.ballStopSpeed) {
          b.active = false; b.mesh.visible = false; continue;
        }
        if (Math.abs(b.vel.y) > 1) eff.dust(p);
      }

      // bounds / lifetime
      if (b.life > CONFIG.ballMaxLife || (p.x * p.x + p.z * p.z) > CONFIG.despawnRadius * CONFIG.despawnRadius) {
        b.active = false; b.mesh.visible = false;
      }
    }

    this.updatePreview(playing);
  }

  updateCamera(camera, dt) {
    // elevated chase: sits high and behind the horizontal aim, looks out + down
    const o = this.ctx.player.shootOrigin;
    const hx = Math.sin(this.aimYaw), hz = Math.cos(this.aimYaw);
    const steep = -this.aimPitch;                 // 0 (level) .. ~1.15 (straight down)
    this._camPos.set(
      o.x - hx * CONFIG.camDistance,
      o.y + CONFIG.camHeight + steep * 5,
      o.z - hz * CONFIG.camDistance
    );
    const a = 1 - Math.exp(-CONFIG.camLerp * dt);
    camera.position.lerp(this._camPos, a);
    const ahead = CONFIG.camLookAhead;
    const drop = CONFIG.camLookDrop + steep * 26;
    this._camTgt.set(o.x + hx * ahead, o.y - drop, o.z + hz * ahead);
    camera.lookAt(this._camTgt);
  }
}
