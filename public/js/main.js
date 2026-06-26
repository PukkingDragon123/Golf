// =============================================================
// GOLF Z — bootstrap, Game state machine, fixed-timestep loop (v2 spine).
// Composer render + screenshake/hit-stop; subsystems added per build slice
// are called guarded (optional) so the game runs at every slice.
// =============================================================
import * as THREE from 'three';
import { CONFIG, POWERUPS } from './config.js';
import { STR } from '../strings.js';
import { IS_TOUCH } from './utils.js';
import { buildAssetCanvases } from './textures.js';
import { buildWorld } from './world.js';
import { AudioKit } from './audio.js';
import { Effects } from './effects.js';
import { Player } from './player.js';
import { Zombies } from './zombies.js';
import { PowerUps } from './powerups.js';
import { Golf } from './golf.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { PostFX, Shake } from './postfx.js';
import { Gore } from './gore.js';
import { Props } from './props.js';
import { Survivors } from './survivors.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.fov, innerWidth / innerHeight, 0.5, 2200);
camera.position.set(0, CONFIG.rooftopHeight + 12, 60);

const assets = buildAssetCanvases();
const world = buildWorld(scene, assets, renderer);

// subsystems share a context object (peers reached lazily at update time)
const ctx = { assets, scene, world };
ctx.audio = new AudioKit();
ctx.effects = new Effects(scene);
ctx.gore = new Gore(scene, ctx);
ctx.shake = new Shake();
ctx.postfx = new PostFX(renderer, scene, camera);
ctx.player = new Player(scene, ctx);
ctx.zombies = new Zombies(scene, ctx);
ctx.powerups = new PowerUps(scene, ctx);
ctx.golf = new Golf(scene, ctx);
ctx.survivors = new Survivors(scene, ctx);
ctx.props = new Props(scene, ctx);

const hud = new HUD();
const input = new Input(canvas);

class Game {
  constructor() {
    this.state = 'menu';
    this.best = parseInt(localStorage.getItem('golfz_best') || '0', 10) || 0;
    this.muted = false;
    this.menuAngle = 0;
    this._windOut = { x: 0, z: 0, mag: 0, angle: 0 };
    this._reset();

    input.setHandlers({
      chargeStart: () => { if (this.state === 'playing' && !ctx.survivors?.buildMode) ctx.golf.beginFire(); },
      chargeEnd: () => { if (this.state === 'playing') ctx.golf.endFire(); },
      useItem: () => { if (this.state === 'playing') this.cycleItem(); },
      buyWeapon: () => { if (this.state === 'playing') this.buyWeapon(); },
      cartAction: () => { if (this.state === 'playing') this.tryCart(); },
      pause: () => { if (this.state === 'playing' || this.state === 'paused') this.togglePause(); },
      mute: () => this.toggleMute(),
      cycleClub: () => { if (this.state === 'playing') { const c = ctx.golf.cycleClub(); hud.toast(`${c.icon} ${c.label}`, '#ffd9a0'); } },
      cycleSpin: () => { if (this.state === 'playing') { const m = ctx.golf.cycleSpin(); hud.toast('SPIN ' + (m === 'back' ? STR.spinBack : m === 'top' ? STR.spinTop : 'NEUTRAL'), '#39b6ff'); } },
      toRoof: () => { if (this.state === 'playing') ctx.player.returnToRoof?.(); },
      buildToggle: () => { if (this.state === 'playing') ctx.survivors?.toggleBuild(); },
      buildCycle: (d) => { if (this.state === 'playing') ctx.survivors?.cycleBuild(d); },
      buildConfirm: () => { if (this.state === 'playing') ctx.survivors?.confirmBuild(); },
      buildSell: () => { if (this.state === 'playing') ctx.survivors?.sellSelected(); },
      stepPost: (d) => { if (this.state === 'playing') ctx.survivors?.stepPost(d); },
      buildPick: (i) => { if (this.state === 'playing') ctx.survivors?.pickBuild(i); },
    });
    hud.setCallbacks({
      start: () => this.start(), resume: () => this.resume(),
      restart: () => this.start(), mute: () => this.toggleMute(),
    });
    hud.wireTouch(input);
    hud.setMuted(false);
    hud.showStart();

    addEventListener('blur', () => { if (this.state === 'playing') this.togglePause(); });
  }

  _reset() {
    this.score = 0; this.wave = 0;
    this.health = CONFIG.startHealth; this.ammo = CONFIG.startAmmo;
    this.shells = CONFIG.weaponShellsStart;
    this.ownedWeapons = new Set(CONFIG.WEAPONS.filter((w) => w.owned).map((w) => w.id));
    this.explosiveShots = 0; this.multiballShots = 0; this.armed = 'normal';
    this._ammoAcc = 0; this.betweenWaves = false; this.waveTimer = 0;
    this.survivors = CONFIG.surv.startSurvivors;
    this.roadkill = 0; this._roadkillT = 0;
    ctx.golf.reset(); ctx.zombies.reset(); ctx.powerups.reset(); ctx.effects.reset();
    ctx.shake.reset();
    ctx.gore?.reset(); ctx.props?.reset(); ctx.survivors?.reset();
    ctx.player.reset?.();
    ctx.player.pos.set(0, ctx.player.roofTop, CONFIG.rooftopSize * 0.28);
    ctx.player.heading = Math.PI; ctx.player.speed = 0;
  }

  start() {
    this._reset();
    this.state = 'playing';
    input.enabled = true;
    hud.startPlaying();
    ctx.audio.init();
    ctx.audio.startMusic();
    ctx.audio.setMuted(this.muted);
    if (!IS_TOUCH) input.requestLock();
    this.startWave(1);
    ctx.powerups.drop('supply');
  }

  startWave(w) {
    this.wave = w;
    this.betweenWaves = false;
    const { count, surge } = ctx.zombies.startWave(w);
    ctx.survivors?.onWaveStart(w);
    hud.banner(`${STR.waveIncoming} ${w}`, surge ? STR.waveSurge : `${count} incoming`, surge);
    ctx.audio.waveAlert(surge);
  }
  onWaveCleared() {
    hud.banner(STR.waveCleared, '', false);
    this.betweenWaves = true;
    this.waveTimer = CONFIG.waveBreak;
    ctx.powerups.drop();
    ctx.props?.respawn();
  }

  addScore(n, combo) { this.score += n; if (combo) hud.toast(`COMBO +${n}`, '#ff8a3a'); }
  addSurvivors(n) { this.survivors += n; }
  flashSurvFreed() { hud.toast(STR.survFreed, '#9cff5a'); }
  spendSurvivors(n) { if (this.survivors >= n) { this.survivors -= n; return true; } return false; }
  addShake(a) { ctx.shake.addTrauma(a); }
  onRunOver(sp01, boosted) {
    const n = Math.round(CONFIG.scoreRunOver + sp01 * CONFIG.scoreRunOverSpeedBonus);
    this.addScore(n, this.roadkill > 0);
    this.roadkill++; this._roadkillT = CONFIG.roadkillWindow;
  }
  useAmmo(n = 1) { this.ammo = Math.max(0, this.ammo - n); }
  addAmmo(n) { this.ammo = Math.min(CONFIG.maxAmmo, this.ammo + n); }
  buyWeapon() {
    const w = ctx.golf.nextLockedWeapon();
    if (!w) { hud.flashMsg(STR.allWeaponsOwned); return; }
    if (this.spendSurvivors(w.cost)) {
      this.ownedWeapons.add(w.id);
      if (w.id === 'bazu') this.shells = Math.min(CONFIG.weaponShellsMax, this.shells + CONFIG.weaponShellsPerCrate);
      ctx.golf.selectWeapon(w.id);
      hud.toast(`${STR.unlockedWeapon} ${w.icon} ${w.label}`, '#' + CONFIG.unlockToastColor.toString(16).padStart(6, '0'));
      ctx.audio.pickup();
    } else hud.flashMsg(`${w.label} — ${w.cost} ${STR.survivorsShort}`);
  }
  buyCart() {
    if (ctx.player.cartOwned) return false;
    if (!this.spendSurvivors(CONFIG.cart.cost)) { hud.flashMsg(STR.cartNoFunds); return false; }
    ctx.player.purchaseCart();
    hud.toast(STR.cartBought, '#' + CONFIG.col.pickup.toString(16).padStart(6, '0'));
    ctx.audio.pickup();
    return true;
  }
  // F / interact: buy+drive · enter the parked cart · exit on the roof
  tryCart() {
    const p = ctx.player;
    if (p.mode === 'cart') { if (!p.exitCart()) hud.flashMsg(STR.exitRoofOnly); return; }
    if (!p.cartOwned) { if (this.buyCart()) { if (p.mountCart()) hud.toast(STR.cartMounted, '#9cff5a'); } return; }
    if (p.mountCart()) hud.toast(STR.cartMounted, '#9cff5a'); else hud.flashMsg(STR.mountCartPrompt);
  }
  heal(n) { this.health = Math.min(CONFIG.startHealth, this.health + n); }
  damageTower(a) { this.health -= a; if (this.health <= 0) { this.health = 0; this.gameOver(); } }
  flashNoAmmo() { hud.flashMsg(STR.outOfAmmo); }

  onPickup(type) {
    const labels = { supply: STR.pickSupply, explosive: STR.pickExplosive, multiball: STR.pickMultiball, health: STR.pickHealth };
    hud.toast(labels[type], '#' + POWERUPS[type].color.toString(16).padStart(6, '0'));
    if (type === 'explosive' && this.armed === 'normal') this.armed = 'explosive';
    if (type === 'multiball' && this.armed === 'normal') this.armed = 'multiball';
    if (type === 'supply' && this.ownedWeapons.has('bazu')) this.shells = Math.min(CONFIG.weaponShellsMax, this.shells + CONFIG.weaponShellsPerCrate);
  }
  cycleItem() {
    const modes = ['normal'];
    if (this.explosiveShots > 0) modes.push('explosive');
    if (this.multiballShots > 0) modes.push('multiball');
    const next = modes[(modes.indexOf(this.armed) + 1) % modes.length];
    this.armed = next;
    hud.toast(next === 'normal' ? 'ARMED: NORMAL' : 'ARMED: ' + POWERUPS[next].label,
      next === 'normal' ? '#ffffff' : '#' + POWERUPS[next].color.toString(16).padStart(6, '0'));
  }
  afterFire() {
    if (this.armed === 'explosive' && this.explosiveShots <= 0) this.armed = 'normal';
    if (this.armed === 'multiball' && this.multiballShots <= 0) this.armed = 'normal';
  }

  togglePause() {
    if (this.state === 'playing') {
      this.state = 'paused'; hud.showPause();
      if (document.exitPointerLock) document.exitPointerLock();
    } else if (this.state === 'paused') this.resume();
  }
  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing'; hud.hidePause();
    if (!IS_TOUCH) input.requestLock();
  }
  gameOver() {
    if (this.state === 'over') return;
    this.state = 'over'; input.enabled = false;
    this.best = Math.max(this.best, this.score);
    localStorage.setItem('golfz_best', String(this.best));
    if (document.exitPointerLock) document.exitPointerLock();
    hud.showGameOver(this.score, this.wave);
  }
  toggleMute() { this.muted = !this.muted; ctx.audio.setMuted(this.muted); hud.setMuted(this.muted); }

  step(dt) {
    input.update(dt);
    ctx.golf.addAim(input.aim.dyaw, input.aim.dpitch, dt);
    ctx.player.update(dt, input.drive);
    ctx.player.runOverPass?.(dt);
    ctx.golf.update(dt, true);
    ctx.zombies.update(dt);
    ctx.survivors?.update(dt);
    ctx.props?.update(dt);
    ctx.powerups.update(dt);
    ctx.effects.update(dt);
    ctx.gore?.update(dt);
    this._ammoAcc += CONFIG.ammoRegen * dt;
    if (this._ammoAcc >= 1) { if (this.ammo < CONFIG.maxAmmo) this.ammo++; this._ammoAcc -= 1; }
    if (this.betweenWaves) { this.waveTimer -= dt; if (this.waveTimer <= 0) this.startWave(this.wave + 1); }
    if (this._roadkillT > 0) { this._roadkillT -= dt; if (this._roadkillT <= 0) this.roadkill = 0; }
  }

  snapshot() {
    const s = {
      score: this.score, wave: this.wave, best: Math.max(this.best, this.score),
      health: this.health, ammo: this.ammo,
      explosive: this.explosiveShots, multiball: this.multiballShots,
      armed: this.armed, charging: ctx.golf.charging, power: ctx.golf.power,
      survivors: this.survivors,
    };
    if (ctx.golf.weapon) {
      const w = ctx.golf.weapon;
      s.club = w.label; s.clubIcon = w.icon; s.spin = ctx.golf.spinMode;
      s.fireType = w.fireType; s.ammoKind = w.ammoKind; s.shells = this.shells;
    }
    if (ctx.golf.windInfo) { ctx.golf.windInfo(this._windOut); s.wind = this._windOut; }
    // cart bar only while driving; otherwise show the buy / enter prompt
    s.mode = ctx.player.mode; s.cartOwned = ctx.player.cartOwned; s.cartCost = CONFIG.cart.cost;
    if (ctx.player.mode === 'cart') { s.cartHealth = ctx.player.health; s.boost = ctx.player.boost01 ?? 0; s.damage = ctx.player.hurt || false; }
    else {
      s.canBuyCart = !ctx.player.cartOwned && this.survivors >= CONFIG.cart.cost;
      s.canMount = ctx.player.cartOwned && ctx.player.nearParkedCart;
    }
    if (ctx.survivors) { s.buildMode = ctx.survivors.buildMode; s.buildInfo = ctx.survivors.snapshotBuild(); }
    return s;
  }
}

const game = new Game();
ctx.game = game;

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  ctx.postfx.resize();
}
addEventListener('resize', resize);
addEventListener('orientationchange', resize);
resize();

const STEP = 1000 / 60;
let acc = 0, last = performance.now();
const dev = new URLSearchParams(location.search).has('dev');
const devEl = document.getElementById('dev');
if (dev) devEl.style.display = 'block';
let frames = 0, fpsAt = last, fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let elapsed = now - last; last = now;
  if (elapsed > 6 * STEP) elapsed = STEP;   // a long stall counts as one step (no post-stall fast-forward)
  const realDt = Math.min(0.05, elapsed / 1000);

  const tScale = ctx.shake.advance(realDt);
  if (game.state !== 'playing') input._gamepad(realDt);   // keep gamepad edges (pause/resume/menu) alive
  if (game.state === 'playing') {
    acc += elapsed * tScale;
    let guard = 0;
    while (acc >= STEP && guard++ < 6) { game.step(STEP / 1000); acc -= STEP; }
  } else acc = 0;

  if (game.state === 'menu') {
    game.menuAngle += realDt * 0.12;
    const r = 64;
    camera.position.set(Math.cos(game.menuAngle) * r, CONFIG.rooftopHeight + 30, Math.sin(game.menuAngle) * r);
    camera.lookAt(0, CONFIG.rooftopHeight - 4, 0);
  } else {
    ctx.golf.updateCamera(camera, realDt);
    if (game.state === 'playing') ctx.shake.applyToCamera(camera);
  }
  ctx.world.tick(realDt);

  if (game.state === 'playing' || game.state === 'paused') hud.update(game.snapshot());

  ctx.postfx.render(realDt);

  if (dev) {
    frames++;
    if (now - fpsAt >= 500) { fps = Math.round(frames * 1000 / (now - fpsAt)); frames = 0; fpsAt = now; }
    let alive = 0; for (const z of ctx.zombies.z) if (z.alive) alive++;
    let balls = 0; for (const b of ctx.golf.balls) if (b.active) balls++;
    devEl.textContent = `${fps} fps · draws ${renderer.info.render.calls} · tris ${renderer.info.render.triangles} · zomb ${alive} · balls ${balls}`;
  }
}
requestAnimationFrame(frame);

window.GOLFZ = { game, ctx, renderer, scene, camera, hud };
