// =============================================================
// Power-ups — supply crates drop on the rooftop with a color-coded glow
// beam; drive the cart over one to collect it.
// =============================================================
import * as THREE from 'three';
import { CONFIG, POWERUPS } from './config.js';
import { pbrMaterial } from './textures.js';
import { makeRNG } from './utils.js';

const WEIGHTED = ['supply', 'supply', 'supply', 'explosive', 'explosive', 'multiball', 'multiball', 'health'];

export class PowerUps {
  constructor(scene, ctx) {
    this.ctx = ctx; // {player, game, audio, effects, assets}
    this.rng = makeRNG(99);
    this.roofTop = CONFIG.rooftopHeight + 1.2;
    const crateMat = pbrMaterial(THREE, ctx.assets.crate, { roughness: 0.7, metalness: 0.1 });
    this.crates = [];
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), crateMat);
      box.castShadow = true; box.receiveShadow = true; g.add(box);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.25, 1.5),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.4 }));
      lid.position.y = 0.95; g.add(lid);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 10, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      beam.position.y = 5.5; g.add(beam);
      const light = new THREE.PointLight(0xffffff, 0, 14, 2); light.position.y = 1.5; g.add(light);
      g.visible = false; scene.add(g);
      this.crates.push({ group: g, lid, beam, light, active: false, type: 'supply', phase: 0, life: 0 });
    }
    this.spawnTimer = CONFIG.crateInterval * 0.5;
  }

  drop(type) {
    const c = this.crates.find((x) => !x.active);
    if (!c) return;
    type = type || this.rng.pick(WEIGHTED);
    c.type = type; c.active = true; c.life = CONFIG.crateLife; c.phase = this.rng() * Math.PI * 2;
    const lim = CONFIG.rooftopSize / 2 - 3;
    c.group.position.set(this.rng.range(-lim, lim), this.roofTop + 1.1, this.rng.range(-lim, lim));
    const col = POWERUPS[type].color;
    c.lid.material.color.setHex(col); c.lid.material.emissive.setHex(col);
    c.beam.material.color.setHex(col);
    c.light.color.setHex(col); c.light.intensity = 3;
    c.group.visible = true;
  }

  reset() {
    for (const c of this.crates) { c.active = false; c.group.visible = false; }
    this.spawnTimer = CONFIG.crateInterval * 0.5;
  }

  _collect(c) {
    const g = this.ctx.game, t = c.type;
    if (t === 'supply') g.addAmmo(CONFIG.ammoPerSupply);
    else if (t === 'explosive') g.explosiveShots += CONFIG.explosiveShotsPerPickup;
    else if (t === 'multiball') g.multiballShots += CONFIG.multiballShotsPerPickup;
    else if (t === 'health') g.heal(CONFIG.healthPerPack);
    this.ctx.audio.pickup();
    this.ctx.effects.greenPuff(c.group.position);
    g.onPickup(t);
    c.active = false; c.group.visible = false;
  }

  update(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) { this.spawnTimer = CONFIG.crateInterval; this.drop(); }

    const pp = this.ctx.player.pos;
    const cr2 = CONFIG.crateCollectRadius * CONFIG.crateCollectRadius;
    for (const c of this.crates) {
      if (!c.active) continue;
      c.life -= dt;
      c.phase += dt;
      c.group.rotation.y += dt * 0.8;
      c.group.position.y = this.roofTop + 1.1 + Math.sin(c.phase * 1.5) * 0.15;
      c.lid.material.emissiveIntensity = 0.9 + Math.sin(c.phase * 4) * 0.4;
      if (c.life < 3) c.group.visible = (Math.sin(c.life * 18) > -0.3); // blink before expiring
      if (c.life <= 0) { c.active = false; c.group.visible = false; continue; }
      const dx = pp.x - c.group.position.x, dz = pp.z - c.group.position.z;
      if (dx * dx + dz * dz < cr2) this._collect(c);
    }
  }
}
