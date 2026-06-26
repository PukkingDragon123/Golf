// =============================================================
// GOLF Z — bootstrap, Game state machine, and the fixed-timestep loop.
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

// subsystems share a context object
const ctx = { assets, scene };
ctx.audio = new AudioKit();
ctx.effects = new Effects(scene);
ctx.player = new Player(scene);
ctx.zombies = new Zombies(scene, ctx);
ctx.powerups = new PowerUps(scene, ctx);
ctx.golf = new Golf(scene, ctx);

const hud = new HUD();
const input = new Input(canvas);

class Game {
  constructor() {
    this.state = 'menu';
    this.best = parseInt(localStorage.getItem('golfz_best') || '0', 10) || 0;
    this.muted = false;
    this.menuAngle = 0;
    this._reset();

    input.setHandlers({
      chargeStart: () => { if (this.state === 'playing') ctx.golf.startCharge(); },
      chargeEnd: () => { if (this.state === 'playing') ctx.golf.releaseCharge(); },
      useItem: () => { if (this.state === 'playing') this.cycleItem(); },
      pause: () => { if (this.state === 'playing' || this.state === 'paused') this.togglePause(); },
      mute: () => this.toggleMute(),
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
    this.explosiveShots = 0; this.multiballShots = 0; this.armed = 'normal';
    this._ammoAcc = 0; this.betweenWaves = false; this.waveTimer = 0;
    ctx.golf.reset(); ctx.zombies.reset(); ctx.powerups.reset(); ctx.effects.reset();
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
    this._lastTs = performance.now();
  }

  startWave(w) {
    this.wave = w;
    this.betweenWaves = false;
    const { count, surge } = ctx.zombies.startWave(w);
    hud.banner(`${STR.waveIncoming} ${w}`, surge ? STR.waveSurge : `${count} incoming`, surge);
    ctx.audio.waveAlert(surge);
  }
  onWaveCleared() {
    hud.banner(STR.waveCleared, '', false);
    this.betweenWaves = true;
    this.waveTimer = CONFIG.waveBreak;
    ctx.powerups.drop(); // reward drop between waves
  }

  addScore(n, combo) { this.score += n; if (combo) hud.toast(`COMBO +${n}`, '#ff8a3a'); }
  useAmmo() { this.ammo = Math.max(0, this.ammo - 1); }
  addAmmo(n) { this.ammo = Math.min(CONFIG.maxAmmo, this.ammo + n); }
  heal(n) { this.health = Math.min(CONFIG.startHealth, this.health + n); }
  damageTower(a) { this.health -= a; if (this.health <= 0) { this.health = 0; this.gameOver(); } }
  flashNoAmmo() { hud.flashMsg(STR.outOfAmmo); }

  onPickup(type) {
    const labels = { supply: STR.pickSupply, explosive: STR.pickExplosive, multiball: STR.pickMultiball, health: STR.pickHealth };
    hud.toast(labels[type], '#' + POWERUPS[type].color.toString(16).padStart(6, '0'));
    if (type === 'explosive' && this.armed === 'normal') this.armed = 'explosive';
    if (type === 'multiball' && this.armed === 'normal') this.armed = 'multiball';
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
    this._lastTs = performance.now();
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
    ctx.golf.addAim(input.aim.dyaw, input.aim.dpitch);
    ctx.player.update(dt, input.drive);
    ctx.golf.update(dt, true);
    ctx.zombies.update(dt);
    ctx.powerups.update(dt);
    ctx.effects.update(dt);
    this._ammoAcc += CONFIG.ammoRegen * dt;
    if (this._ammoAcc >= 1) { if (this.ammo < CONFIG.maxAmmo) this.ammo++; this._ammoAcc -= 1; }
    if (this.betweenWaves) { this.waveTimer -= dt; if (this.waveTimer <= 0) this.startWave(this.wave + 1); }
  }

  snapshot() {
    return {
      score: this.score, wave: this.wave, best: Math.max(this.best, this.score),
      health: this.health, ammo: this.ammo,
      explosive: this.explosiveShots, multiball: this.multiballShots,
      armed: this.armed, charging: ctx.golf.charging, power: ctx.golf.power,
    };
  }
}

const game = new Game();
ctx.game = game;

// ---- resize ----
function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
}
addEventListener('resize', resize);
addEventListener('orientationchange', resize);
resize();

// ---- fixed-timestep loop ----
const STEP = 1000 / 60;
let acc = 0, last = performance.now();
const dev = new URLSearchParams(location.search).has('dev');
const devEl = document.getElementById('dev');
if (dev) devEl.style.display = 'block';
let frames = 0, fpsAt = last, fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let elapsed = now - last; last = now;
  if (elapsed > 250) elapsed = STEP; // tab was hidden / big stall
  const dtSec = Math.min(0.05, elapsed / 1000);

  if (game.state === 'playing') {
    acc += elapsed;
    let guard = 0;
    while (acc >= STEP && guard++ < 6) { game.step(STEP / 1000); acc -= STEP; }
  } else acc = 0;

  // camera
  if (game.state === 'menu') {
    game.menuAngle += dtSec * 0.12;
    const r = 64;
    camera.position.set(Math.cos(game.menuAngle) * r, CONFIG.rooftopHeight + 30, Math.sin(game.menuAngle) * r);
    camera.lookAt(0, CONFIG.rooftopHeight - 4, 0);
  } else {
    ctx.golf.updateCamera(camera, dtSec);
  }

  if (game.state === 'playing' || game.state === 'paused') hud.update(game.snapshot());

  renderer.render(scene, camera);

  if (dev) {
    frames++;
    if (now - fpsAt >= 500) { fps = Math.round(frames * 1000 / (now - fpsAt)); frames = 0; fpsAt = now; }
    let alive = 0; for (const z of ctx.zombies.z) if (z.alive) alive++;
    let balls = 0; for (const b of ctx.golf.balls) if (b.active) balls++;
    devEl.textContent = `${fps} fps · draws ${renderer.info.render.calls} · tris ${renderer.info.render.triangles} · zomb ${alive} · balls ${balls}`;
  }
}
requestAnimationFrame(frame);

// expose for quick console debugging
window.GOLFZ = { game, ctx, renderer, scene, camera };
