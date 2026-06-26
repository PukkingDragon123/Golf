# GOLF Z — v2 Upgrade: Unified Implementation Plan (single source of truth)

This plan reconciles six subsystem specs (golf-physics, zombies, gore, vehicle, survivors-td,
chaos-polish) into ONE conflict-free build the lead dev follows top to bottom. It is grounded in the
current code under `public/js/` (read: config.js, main.js, world.js, player.js, golf.js, zombies.js,
effects.js, powerups.js, hud.js, input.js, audio.js, textures.js, utils.js) and `public/index.html`.

Hard rules carried from the existing engine (DO NOT break):
- **Zero per-frame allocation** in any `update()/step()/render` path. All vectors/matrices/quats/euler/color
  are preallocated scratch on `this`; pools are ring-buffered or slot-found only on events.
- **Fixed 60 Hz sim** decoupled from render; seeded RNG for spawn determinism (gore/shake noise may use
  `Math.random` because they are cosmetic-only).
- **Draw-call discipline**: the horde and all crowds render as `InstancedMesh`. Budget tracked in §6.
- **Strings live in `strings.js`** (zero string literals in game logic).
- **Three.js r160**, vendored. Addons already exist at `public/vendor/three-addons/`.

---

## 1. Final module list, load order, init order

### 1.1 Files

NEW files:
- `public/js/gore.js` — `class Gore` (blood particles + persistent decal canvas + gore chunks).
- `public/js/props.js` — `class Props` (explosive barrels + cars; chain reactions).
- `public/js/postfx.js` — `class PostFX` (EffectComposer/bloom) + `class Shake` (trauma + hit-stop).
- `public/js/survivors.js` — `class Survivors` (rescue + turrets/spotters/barricades + economy).

REPLACED / heavily reworked existing files:
- `public/js/zombies.js` — articulated instanced zombies (11 part meshes + 1 debris mesh), multi-hit
  HP, ragdoll death, dismemberment, 3 types, `runOver`, barricade-aware pathing, cart-claw.
- `public/js/golf.js` — Magnus spin physics, clubs, wind, spin-aware bounce/roll, shared `_integrate`
  preview, ground-blended camera, prop/survivor hooks, shot screenshake.
- `public/js/player.js` — `Player(scene, ctx)`, arcade ground driving, ramp surface-follow, boost,
  run-over pass, suspension tilt, cart health.

MODIFIED existing files:
- `public/js/config.js` — one consolidated CONFIG block (§4).
- `public/js/main.js` — ctx wiring, `step()` order, composer render, screenshake + hit-stop, handlers,
  `snapshot()`, `_reset()`.
- `public/js/world.js` — ramp meshes + split +Z parapet; return `flash()`/`tick()`.
- `public/js/effects.js` — `bloodSpray` (delegates to gore conceptually, but lives as a thin pooled
  emitter), `blood`, `exhaust`, `muzzle`, `fireball`, `embers`, `smoke`, `debris`; cap 520→900, flash 6→8.
- `public/js/hud.js` — club/spin/wind readout, cart health + boost, survivor counter + build menu,
  integrity bar, td tallies, damage vignette.
- `public/js/input.js` — club/spin cycle, boost, recover-to-roof, build controls (desktop/touch/gamepad).
- `public/js/powerups.js` — unchanged.
- `public/index.html` — import map `three/addons/` prefix, new HUD DOM, touch buttons, build panel, CSS.
- `public/strings.js` — all new labels.
- `public/js/audio.js` — OPTIONAL `thud()`, `turretShot()`, `wallDown()` (else callers fall back to
  `hit()`/`explosion()`).
- `public/js/utils.js` — OPTIONAL `angleDist(a,b)` helper (else inline in survivors.js).

Spec docs already written under `design/specs/` (golf-physics.md, zombies.md, gore.md, vehicle.md,
survivors-td.md, chaos-polish.md) remain the per-subsystem deep references.

### 1.2 Load / construction order (main.js)

The current order is: `assets → world → audio → effects → player → zombies → powerups → golf`.
The v2 order (construction is synchronous; everything exists before the first `Game.step`):

```
assets  = buildAssetCanvases()
world   = buildWorld(scene, assets, renderer)         // now returns flash(), tick()
ctx = { assets, scene, world }                        // world added to ctx
ctx.audio    = new AudioKit()
ctx.effects  = new Effects(scene)
ctx.gore     = new Gore(scene, ctx)                   // after effects; no per-frame deps
ctx.shake    = new Shake()                            // pure state object, no scene
ctx.postfx   = new PostFX(renderer, scene, camera)    // builds composer
ctx.player   = new Player(scene, ctx)                 // NOW takes ctx (run-over reaches zombies lazily)
ctx.zombies  = new Zombies(scene, ctx)                // reads ctx.player.pos + ctx.survivors lazily
ctx.powerups = new PowerUps(scene, ctx)
ctx.golf     = new Golf(scene, ctx)
ctx.survivors= new Survivors(scene, ctx)              // after zombies/golf; zombies reads it guarded
ctx.props    = new Props(scene, ctx)                  // LAST: needs effects + zombies
const hud = new HUD(); const input = new Input(canvas);
const game = new Game(); ctx.game = game;
```

Cross-construction-time reads are forbidden; all inter-subsystem reads happen at `update()` time, by which
point every `ctx.*` is assigned. Zombies referencing `ctx.survivors` is **guarded** (`if (this.ctx.survivors)`)
so it works even mid-bringup and during the slice-by-slice build (§7).

---

## 2. Shared ctx API contract

`ctx` is the single shared object: `{ assets, scene, world, audio, effects, gore, shake, postfx, player,
zombies, powerups, golf, survivors, props, game }`. Every subsystem stores `this.ctx = ctx` and reaches
peers lazily at call time. Universal lifecycle convention: **constructor(scene, ctx)**, **reset()**,
**update(dt)** (golf is `update(dt, playing)`). No subsystem allocates in `update`.

### 2.1 Per-subsystem contract (constructor / lifecycle / reads / writes)

**Effects** `constructor(scene)` (unchanged signature) · `reset()` · `update(dt)`.
- New emitters (all via pooled `_emit`, one Points draw call): `blood(x,y,z,mag)`, `exhaust(x,y,z)`,
  `muzzle(p,dir)`, `fireball(p,big)`, `embers(p,n)`, `smoke(p,n)`, `debris(p,n)`, `bloodSpray(p,dx,dz)`.
- Reads: none from peers. Writes: none to Game.
- Pool cap 520→900; flash pool 6→8.

**Gore** `constructor(scene, ctx)` · `reset()` (clear decal canvas, park particles/chunks) · `update(dt)`.
- API: `burst(pos,amount,dir?)`, `splat(pos,size)`, `chunk(pos,vel)`, `killGore(pos,dir,severity)`,
  `dismemberGore(pos,dir)`.
- Reads: `scene` (ctor only), `CONFIG.gravity`, `CONFIG.gore.*`. Writes: NOTHING to Game/zombie state
  (cosmetic, uses `Math.random`, does not touch seeded RNG).
- Draw calls: +3 (blood Points, decal plane, chunk InstancedMesh).

**Shake** (in postfx.js) — pure state object, no scene.
- `addTrauma(amt)`, `hitStop(ms)`, `advance(realDtSec)→tScale`, `applyToCamera(camera)`, `reset()`.
- Reads: `CONFIG.shake`. Writes: `camera` transform only (in `applyToCamera`, called by main.js).

**PostFX** (in postfx.js) `constructor(renderer, scene, camera)`.
- `resize()`, `boomPulse()`, `render(dt)` (REPLACES `renderer.render`).
- Reads: `renderer.toneMapping/toneMappingExposure`, `CONFIG.bloom`. Writes: `renderer.toneMappingExposure`
  + `bloom.strength` transiently during a boom pulse.

**Player** `constructor(scene, ctx)` (CHANGED: now takes ctx) · `reset()` semantics via main `_reset()` (it
sets pos/heading/health/boost directly — see §3) · `update(dt, drive)` where `drive={throttle,steer,boost}`.
- New methods: `_surfaceAt(x,z)→this._surf{y,region,grade}` (zero-alloc), `runOverPass(dt)`,
  `_runOver(z,dx,dz,spAbs,dt)`, `returnToRoof()`. `get shootOrigin` unchanged (`pos+(0,3,0)`).
- Reads: `ctx.zombies.z[]` (x/zz/alive/dying/hitT), `ctx.effects`, `ctx.gore`, `ctx.audio`, `ctx.game`
  (onRunOver/addShake/score), `input.drive`. Writes: `this.pos.y`, `this.region`, `this.health`,
  `this.speed`, `this.lateralVel`, `this.lean/pitch`, `this.boostFuel/boostActive/clawT`; zombie ragdoll
  seeds via `ctx.zombies.runOver`; `ctx.game.{score,shake,roadkill}` via Game methods.

**Zombies** `constructor(scene, ctx)` · `reset()` · `update(dt)`.
- API: `get aliveCount`, `startWave(wave)→{count,surge}`, `spawn(type?)`, `hitTest(p,ballR)→z|null`,
  `hitTestAt(x,z,r)→z|null` (ground-plane, for projectiles), `hitBall(z,p,ballVel)→bool` (killed?),
  `damage(z,amount)→bool` (killed?), `damageArea(pos,r,opts)→killedCount`, `kill(z,opts)`,
  `runOver(z,vx,vy,vz)`, `_damage(z,dmg,dx,dz,opts)→bool` (internal router).
- Reads: `ctx.player.pos` (head-track + cart-claw) + `ctx.player.region`, `ctx.effects`, `ctx.gore`,
  `ctx.audio`, `ctx.game.damageTower/onWaveCleared/addShake/gameOver`, `ctx.survivors.blockAt/damageBarricade`
  (guarded). Writes: tower damage (via `game.damageTower`), wave-cleared signal, `player.health` decrement
  on cart-claw (via reading player + writing player.health), ragdoll/hit state on its own slots. Does NOT
  score (callers score, to preserve combo math — see §6).

**Golf** `constructor(scene, ctx)` · `reset()` · `update(dt, playing)` · `updateCamera(camera, dt)`.
- API additions: `get club`, `cycleClub()`, `cycleSpin()`, `addAim(dyaw,dpitch,dt)` (NOW takes dt),
  `_integrate(pos,vel,spin,dt,dragMul)` (shared core), `windInfo(out)`, `fire(power01)`,
  `updatePreview(visible)`, `explode(pos,ball)`.
- Reads: `ctx.player.shootOrigin`, `ctx.game` (ammo/armed/explosiveShots/multiballShots; useAmmo/afterFire/
  addScore/flashNoAmmo), `ctx.zombies` (hitTest/hitBall/damageArea), `ctx.props.hitTest/detonate/igniteArea`,
  `ctx.survivors.ballHit` (guarded), `ctx.shake.addTrauma`, `ctx.effects`, `ctx.gore`, `ctx.audio`.
  Writes: ball pool state; scoring on kill via `game.addScore`.

**Survivors** `constructor(scene, ctx)` · `reset()` · `onWaveStart(wave)` · `update(dt)`.
- API: `ballHit(pos,r,explosive)→bool`, `blockAt(angle)→{blocked,slow,post}`, `damageBarricade(post,amt)`,
  `toggleBuild()/cycleBuild(dir)/stepPost(dir)/confirmBuild()/sellSelected()`, `get buildMode`,
  `snapshotBuild()→{...}`.
- Reads: `ctx.zombies.z/.damage/.hitTestAt`, `ctx.golf.aimYaw`, `ctx.player.pos`, `ctx.effects`,
  `ctx.audio`, `ctx.game` (survivors currency, spendSurvivors/addSurvivors/addScore). Writes: survivor
  count + score via Game methods; zombie HP via `zombies.damage`.

**Props** `constructor(scene, ctx)` · `reset()` · `update(dt)` · `respawn()` (called by `onWaveCleared`).
- API: `place()`, `hitTest(p,r)→prop|null`, `igniteArea(pos,r)`, `detonate(prop,depth)`, `cartTest(px,pz,speed)`.
- Reads: `ctx.zombies.damageArea`, `ctx.effects`, `ctx.gore`, `ctx.audio`, `ctx.shake`, `ctx.postfx.boomPulse`,
  `ctx.world.flash`, `ctx.game.addScore`, `ctx.player.pos/speed`. Writes: `game.score`; transient
  exposure/bloom/fog via shake/postfx/world hooks.

### 2.2 What each subsystem reads / writes on Game state (authoritative table)

| Field on Game | Read by | Written by |
|---|---|---|
| `score` | hud | golf.fire-path, survivors (turret kills), props.detonate, player.onRunOver (all via `game.addScore`) |
| `ammo` | golf.fire, hud | golf (`useAmmo`), powerups (`addAmmo`) |
| `armed`/`explosiveShots`/`multiballShots` | golf.fire, hud | powerups, game.cycleItem, golf (decrement) |
| `health` (tower) | hud, gameOver | zombies (`damageTower`), powerups (`heal`) |
| `survivors` (NEW currency) | hud, survivors.confirmBuild | survivors (`addSurvivors`/`spendSurvivors`), `_reset` |
| `shake` (trauma 0..1 mirror — see note) | — | superseded by `ctx.shake`; Game keeps `addShake(a)→ctx.shake.addTrauma(a)` shim |
| `roadkill` / `_roadkillT` (run-over combo) | snapshot/scoring | player.onRunOver, game.step tick |
| cart health/boost | hud (via player) | player.update |

NOTE on screenshake ownership: the vehicle spec proposed a `game.shake` scalar; the chaos-polish spec owns
shake in a dedicated `Shake` class. **Resolution (§6): `ctx.shake` is the single owner.** `Game.addShake(a)`
becomes a one-line shim `=> ctx.shake.addTrauma(a)` so the vehicle code calls remain valid. No separate
`game.shake` scalar. `onRunOver`/claw/prop hits all funnel into `ctx.shake.addTrauma`/`hitStop`.

---

## 3. main.js changes (the spine)

### 3.1 `Game.step(dt)` — final call order

```
step(dt) {
  input.update(dt);
  ctx.golf.addAim(input.aim.dyaw, input.aim.dpitch, dt);   // dt added for flick→sidespin
  ctx.player.update(dt, input.drive);                       // sets region + pos.y; boost
  ctx.player.runOverPass(dt);                               // cart vs zombies (no-op on roof)
  ctx.golf.update(dt, true);                                // wind, balls, props/survivor hooks, preview
  ctx.zombies.update(dt);                                   // anim/FK, ragdolls, pathing, claw, tower dmg
  ctx.survivors.update(dt);                                 // rescue, turrets, projectiles, barricades
  ctx.props.update(dt);                                     // fuses → detonations (feed same-frame effects)
  ctx.powerups.update(dt);
  ctx.effects.update(dt);
  ctx.gore.update(dt);
  this._ammoAcc += CONFIG.ammoRegen * dt; ...               // unchanged
  if (this.betweenWaves) { this.waveTimer -= dt; ... }      // unchanged
  if (this._roadkillT > 0) { this._roadkillT -= dt; if (this._roadkillT <= 0) this.roadkill = 0; }
}
```
Ordering rationale: player moves → run-over launches ragdolls → golf integrates balls (may detonate props /
free survivors) → zombies march (consult survivors.blockAt this frame) → survivors fire at the just-moved
horde → props detonate (feeding effects + gore the same frame) → effects/gore integrate last so all spawns
this frame render. `survivors.update` after `zombies.update` is required (turrets target post-move
positions; barricade march consulted survivors which were laid out at construct time).

### 3.2 The render frame loop (`frame(now)`)

```
function frame(now) {
  requestAnimationFrame(frame);
  let elapsed = now - last; last = now;
  if (elapsed > 250) elapsed = STEP;
  const realDt = Math.min(0.05, elapsed / 1000);

  const tScale = ctx.shake.advance(realDt);            // decays trauma (realDt), ticks hit-stop → simScale
  if (game.state === 'playing') {
    acc += elapsed * tScale;                            // SCALED accumulation = hit-stop freezes the sim
    let guard = 0;
    while (acc >= STEP && guard++ < 6) { game.step(STEP/1000); acc -= STEP; }   // keep <6 guard
  } else acc = 0;

  if (game.state === 'menu') { /* unchanged orbit cam */ }
  else {
    ctx.golf.updateCamera(camera, realDt);             // ground-blended rig (§3.4)
    if (game.state === 'playing') ctx.shake.applyToCamera(camera);  // POST-lerp, doesn't fight smoothing
  }
  ctx.world.tick(realDt);                              // sun.intensity + fog.color damp back to baseline

  if (game.state === 'playing' || game.state === 'paused') hud.update(game.snapshot());

  ctx.postfx.render(realDt);                           // REPLACES renderer.render(scene, camera)

  /* dev overlay unchanged (reads renderer.info; now ~+14 draws expected) */
}
```
- `tScale` and trauma noise use **realDt** so the camera still shakes while the sim is frozen by hit-stop.
- The `<6` step guard is preserved to prevent a spiral-of-death when hit-stop releases.

### 3.3 Screenshake + hit-stop application
- Owner: `ctx.shake`. `advance(realDt)`: decays `trauma -= decay*realDt`; ticks `hitStopT`; returns a sim
  time-scale (`minHitStopScale..1`, ramping back over the last 40% of the freeze).
- `applyToCamera(camera)` perturbs AFTER `updateCamera` (so smoothing isn't fought): rotate X/Y/Z and offset
  position by `max* * trauma^2 * coherentNoise(seed, time*freq)` (value-noise, deterministic-looking, not
  white static). Because `updateCamera` rebuilds the look quat fresh each frame, shake never accumulates drift.
- Hit-stop scales the **accumulator** (`acc += elapsed*tScale`) — when `tScale≈minHitStopScale`, the while-loop
  starves and the whole sim freezes for the beat, then resumes.
- Trauma sources funnel through `ctx.shake.addTrauma`: golf shot kick (`shotKick`/`bigShotKick*power`),
  run-over (`shakeRunOver`), cart-claw (`shakeClaw*dt*clawing`), prop detonation (`barrelTrauma`/`carTrauma`).
  Hit-stop sources: prop detonation (`barrelHitStop`/`carHitStop` ms). Run-over uses a small trauma only (no
  hit-stop, to keep driving fluid).

### 3.4 Camera behavior on roof vs ground (golf.updateCamera blend)
- A single damped factor `ground01 = clamp(1 - player.pos.y/9.2, 0, 1)` (smoothed into `this._g` at lambda 6)
  morphs the rig — **no mode switch**.
- Lerp `dist/height/lookDrop/ahead` between the roof CONFIG (`camDistance/camHeight/camLookDrop/camLookAhead`)
  and the ground CONFIG (`camDistanceGround/...`). Steep-pitch terms (`steep*5` height, `steep*26` drop) are
  multiplied by `(1 - _g*0.6)` so the carnage cam doesn't dive into the asphalt.
- After `camera.position.lerp`, clamp `camera.position.y = max(that, player.pos.y + camMinAbove)` so the cam
  never sinks below the cart.
- On the roof (`_g≈0`) this is byte-identical in feel to today's bird's-eye golf vantage; on the street
  (`_g≈1`) it becomes a behind-cart chase cam. The transition rides purely off `pos.y` while crossing the ramp.

### 3.5 Other main.js edits
- `_reset()`: also `ctx.gore.reset(); ctx.props.reset(); ctx.shake.reset(); ctx.survivors.reset();`
  `this.survivors = CONFIG.surv.startSurvivors; this.roadkill = 0; this._roadkillT = 0;`
  `ctx.player.health = CONFIG.cartHealth; player.boostFuel = CONFIG.boostMax; player.lateralVel = 0;
  player.lean = player.pitch = 0; player.region = 2;` Create `this._windOut = {x:0,z:0,mag:0,angle:0}` once
  in the Game constructor (reused by snapshot).
- `startWave(w)`: also `ctx.survivors.onWaveStart(w);`
- `onWaveCleared()`: also `ctx.props.respawn();`
- `addScore(n, combo)`: unchanged. New `addSurvivors(n)/spendSurvivors(n)→bool`, `addShake(a)` shim,
  `onRunOver(sp01, boosted)` (scores `scoreRunOver + sp01*scoreRunOverSpeedBonus`, opens/extends roadkill
  combo window).
- `chargeStart` handler early-returns when `ctx.survivors.buildMode` (build mode suppresses golf fire).
- `setHandlers` gains (all gated to `state==='playing'`): `cycleClub`, `cycleSpin`, `toRoof`,
  `buildToggle`, `buildCycle`, `buildConfirm`, `buildSell`.
- `snapshot()` adds: `club`, `clubIcon`, `spin`, `wind` (via `ctx.golf.windInfo(this._windOut)`),
  `cartHealth`, `boost` (0..1), `damage` (bool), `survivors`, `buildMode`, `buildInfo` (=snapshotBuild()).
- resize(): after `renderer.setSize`, call `ctx.postfx.resize()`.

---

## 4. ONE consolidated CONFIG block (all conflicts resolved)

Append/replace in `public/js/config.js`. Where specs disagreed, the **chosen** value is annotated. Existing
keys not listed here stay as-is (rooftop*, groundRadius, spawnRadius, despawnRadius, ammo*, crate*, fov,
col.* base palette, POWERUPS map).

### 4.1 Golf physics + clubs + wind (from golf-physics.md, current values kept)
```
gravity: 24, dragCoef: 0.0016, restitution: 0.42, rollFriction: 1.9,
ballRadius: 0.95, ballStopSpeed: 1.6, ballMaxLife: 9, maxBalls: 60, trajPoints: 64,
minLaunch: 16, maxLaunch: 52,              // legacy fallbacks; clubs own launch bands now
pitchMin: -0.7, pitchMax: 0.95, pitchDefault: 0.02,   // UNCHANGED
// Spin (Magnus)
kMagnus: 0.0042, spinDecay: 0.55, sideSpinK: 22, sideSpinMax: 12, aimYawVelDamp: 12,
spinTrimBack: 7, spinTrimTop: 9,
// Spin-aware bounce / roll
backBiteK: 0.085, minHoriz: 0.02, backKickThresh: 8.0, backKickK: 0.55,
bounceSpinLoss: 0.35, groundedVyThresh: 4.0, rollSpinReduce: 0.6, topspinRollK: 0.07, rollWindK: 0.15,
// Wind
windMax: 7.0, windChangeMin: 5.0, windChangeMax: 11.0, windLerp: 0.4,
// Clubs (index cycled in order)
CLUBS: [
  { id:'driver', label:'DRIVER', icon:'🏌️', minLaunch:30, maxLaunch:52, loftBias:-0.06, backspin:4,  drag:0.85 },
  { id:'iron',   label:'9-IRON', icon:'⛳', minLaunch:22, maxLaunch:40, loftBias: 0.10, backspin:9,  drag:1.0  },
  { id:'wedge',  label:'WEDGE',  icon:'🥢', minLaunch:14, maxLaunch:30, loftBias: 0.30, backspin:15, drag:1.25 },
],
defaultClub: 0,
```

### 4.2 Zombies (from zombies.md). **CONFLICT RESOLVED — `zombieMaxAlive`.**
- golf-physics + thresholds assume the legacy 70; the zombies refactor lowers it to 48 for articulated FK
  cost; the vehicle spec text references 70 in a couple of risk notes. **Chosen: `zombieMaxAlive: 48`** (the
  articulated cost is real and dominates). The vehicle run-over broadphase is O(alive)≤48 — fine. The dev
  HUD and verify harness iterate `ctx.zombies.z` by `.alive`, so a smaller pool is transparent.
```
zombieRadius: 1.8, zombieHeight: 4.4, zombieBaseSpeed: 3.1, zombieSpeedPerWave: 0.30,
zombieMaxAlive: 48,                         // CHANGED 70→48
zombieTypes: [
  { name:'shambler', speedMul:1.00, scale:1.00, health:2, gait:'walk', weight:0.0,  tintR:0.78, tintG:0.86, tintB:0.62 },
  { name:'runner',   speedMul:1.85, scale:0.82, health:1, gait:'run',  weight:0.0,  tintR:0.86, tintG:0.88, tintB:0.74 },
  { name:'brute',    speedMul:0.55, scale:1.55, health:6, gait:'walk', weight:0.85, tintR:0.62, tintG:0.55, tintB:0.45 },
],
maxRagdolls: 18, ragdollSettle: 1.6, ragdollFade: 1.2, maxDebris: 60,
ballDamage: 1, explosionDamage: 5, runoverDamage: 4, bruteDamageMul: 3,
dismemberBallSpeed: 30, headTrackMax: 0.7,
```
**CONFLICT RESOLVED — zombie HP model.** zombies.md uses small integer HP (shambler 2 / runner 1 / brute 6)
with `ballDamage:1`. survivors-td.md proposed a separate `zombieHP:34`/`zombieHPPerWave` scalar HP so turret
chip-damage works. **Chosen: ONE HP system = the integer type HP from `zombieTypes`** (`z.hp = type.health`,
no per-wave scaling of HP). Turrets deal **fractional** damage that accumulates against the same `z.hp`
(turret `damage` values are re-scaled to this small-HP economy — see §4.5). This avoids two HP scales. The
`zombieHP`/`zombieHPPerWave` keys are **dropped**; survivors turret stats are retuned to the 1–6 HP world.
**CONFLICT RESOLVED — `zombieDamage`.** thresholds.md says 5.5; config.js says 4.0. **Chosen: 4.0** (config is
authoritative and what the live build ships).

### 4.3 Gore (from gore.md) — `CONFIG.gore` sub-object (reuses top-level `gravity:24`)
```
gore: {
  particleCap: 360, particleSize: 1.1, bloodColor: 0x7a0a0a, groundY: 0.06, dropSplatChance: 0.04,
  burstBase: 9, burstSpeed: 16, decalRes: 1024, decalWorldSize: 220, decalY: 0.05,
  splatBaseRadiusPx: 18, inkFadeThreshold: 60, fadeInterval: 0.8, fadeAlpha: 0.045,
  chunkCap: 48, chunkScale: 0.5, chunkSpeed: 7, chunkLife: 2.2, chunkGroundY: 0.32,
  chunkColor: 0x8c1414, chunksPerKill: 2,
},
```

### 4.4 Vehicle / driving / ramp / run-over (from vehicle.md)
```
// driving
cartAccel: 34, cartMaxSpeed: 22, cartReverseSpeed: 9, cartTurnRate: 2.6, cartTurnFalloff: 12,
cartFriction: 3.0, cartDriftGain: 0.020, cartGrip: 6.0, cartGroundFollow: 14,
// boost
boostMax: 2.2, boostRegen: 0.5, boostAccelMult: 1.9, boostSpeedMult: 1.55, boostCooldown: 1.2,
// suspension/tilt
cartLeanGain: 0.010, cartSkidLean: 0.05, cartLeanMax: 0.22, cartPitchGain: 0.004, cartTiltDamp: 9,
// ramp + ground
ramp: { width: 8, slopeRise: 9.2, slopeRun: 22, apronZ: 4, side: 1, curbH: 0.35 }, groundPlayRadius: 150,
// run-over
cartHitRadius: 2.2, cartNoseOffset: 2.6, runOverMinSpeed: 4, runOverImpulseMin: 10, runOverImpulseMax: 30,
runOverBoostMult: 1.6, runOverForwardMix: 0.7, runOverLiftBase: 4, runOverLiftSpeed: 8,
runOverDrag: 0.92, runOverDragBoost: 0.97, runOverIFrame: 0.4, ragdollLife: 1.6,
// run-over scoring
scoreRunOver: 12, scoreRunOverSpeedBonus: 10, roadkillWindow: 1.5,
// cart health / street risk
cartHealth: 100, cartClawRadius: 5.0, cartClawDamage: 9.0, cartHealthRegen: 6.0,
// camera ground variants + clamp
camDistanceGround: 11, camHeightGround: 5.5, camLookDropGround: 1.5, camLookAheadGround: 16, camMinAbove: 2.5,
```
**CONFLICT RESOLVED — ragdoll death paths.** zombies.md (articulated) replaces `kill()` with a sprung
articulated ragdoll; vehicle.md described a simpler rigid `runOver` ragdoll on the old single-mesh horde.
**Chosen: the articulated ragdoll from zombies.md is the one ragdoll system.** `runOver(z,vx,vy,vz)` seeds the
articulated ragdoll's root velocity (`rag.vx/vy/vz`) + a fast flat topple + forced dismember — i.e. vehicle's
rigid integrator is dropped in favor of feeding the articulated ragdoll. The `runOver(z,vx,vy,vz)` signature
is kept exactly so player.js call sites are stable. The per-slot fields the vehicle spec named
(`rvx/rvy/rvz/ry/rrot/rspin/raxis`) are **superseded** by the articulated `rag` struct + `limbLag/limbVel`;
`hitT` (run-over i-frame) is **kept** and added to the articulated per-zombie struct.

**CONFLICT RESOLVED — surface height vs roof clamp.** zombies/golf assume the cart is clamped to the roof at
y≈9. The vehicle spec adds a ramp so the cart can reach the street. **Chosen: ship the ramp** (the whole
point of v2 driving). `cartGroundFollow` damps `pos.y` toward `_surfaceAt()`; the camera blends on `pos.y`.
Roof footprint bounds (with the ramp-mouth gap) and ground bounds (tower AABB + `groundPlayRadius` outer ring)
replace the old simple parapet clamp. The chaos-polish "cart-ram is a no-op" note is now **partly false** —
with the ramp the cart CAN reach street props; `props.cartTest` becomes live (low priority, but wire it).

### 4.5 Survivors / tower-defense (from survivors-td.md) — `CONFIG.surv` + col additions
Turret damage retuned to the integer-HP world (§4.2): a Lv1 turret kills a shambler (2 HP) in ~2–3 hits, a
runner (1 HP) in 1, and chips a brute (6 HP). Replace the old big `damage:12/16/22` with small values:
```
surv: {
  // rescue
  maxCages: 16, maxActiveCages: 6, cagesPerWave: 2,
  cageRadMin: 50, cageRadMax: 82, nearCageChance: 0.25,
  cageHP: 3, ballCageDamage: 1,                 // ~3 ball hits frees a cage (small-HP economy)
  clearRadius: 9, clearHold: 1.2, cartRescueRadius: 8,
  freeDur: 0.5, runSpeed: 9, scorePerRescue: 75,
  // posts / placement
  postCount: 12, postRadius: 40, startSurvivors: 1,
  // turret tiers ([0] unused) — damage in the 1–6 HP economy
  turret: [null,
    { range:26, rate:1.6, damage:1,   projSpeed:60, cost:2, manned:1 },
    { range:30, rate:2.2, damage:1.5, projSpeed:70, cost:2, manned:2 },
    { range:34, rate:2.8, damage:2,   projSpeed:80, cost:3, manned:3 } ],
  retargetInterval: 0.25, perimeterBias: 1.5, muzzleY: 2.2,
  spotterCost: 1, spotterRadius: 14, spotterSlow: 0.55, spotterBuff: 1.25,
  // projectiles
  projMax: 48, projRadius: 0.6, projLife: 1.4,
  // barricades ([0] unused)
  barricadeCost: 1, barricadeArc: 0.22, barricadeHP: [0,120,220,360], barricadeSlow: [1,0.6,0.45,0.3],
  barricadeUpgradeCost: 1, repairScoreCost: 200, wallStandoff: 2.5, zombieVsBarricade: 9,
  // economy
  sellRefundFrac: 0.5,
},
```
(Note: barricade HP stays large/absolute — it is chewed by `zombieVsBarricade*dt`, a separate economy from
zombie HP, which is fine.)

### 4.6 Chaos props + visual polish (from chaos-polish.md)
```
props: { barrelCount:14, carCount:7, ringMin:46, ringMax:90, clusterCount:5, clusterSpread:6,
  barrelRadius:1.3, barrelHeight:2.6, carRadius:2.8, carHalf:[3.2,1.4,1.6],
  barrelDmgRadius:12, carDmgRadius:16, barrelTrauma:0.55, carTrauma:0.8,
  barrelHitStop:70, carHitStop:110, chainDelayMin:60, chainDelayMax:180,
  debrisCount:18, carDebrisCount:30, fuseFlash:0.12, ramSpeedMin:6, respawnFrac:0.6, scorePerProp:25 },
shake: { maxYaw:0.06, maxPitch:0.05, maxRoll:0.07, maxOffset:0.9, decay:1.7, freq:22, traumaMax:1.0,
  shotKick:0.12, bigShotKick:0.28, minHitStopScale:0.05, shakeRunOver:0.28, shakeClaw:0.6 },
bloom: { strength:0.85, radius:0.55, threshold:0.78, pixelRatioCap:1.5, exposureBoostOnBoom:0.12 },
grade: { fogBoomColor:0xff7a3a, fogBoomAmount:0.0 },
```
**CONFLICT RESOLVED — `shakeRunOver`/`shakeClaw` location.** vehicle.md put them in a `shake:{}`-less list;
chaos-polish owns `CONFIG.shake`. **Chosen: both live in `CONFIG.shake`** (single shake config block).
Existing `explosionRadius:13, scorePerKill:10, comboBonus:5` reused unchanged. Effects cap 520→900, flash 6→8.

### 4.7 `CONFIG.col` additions (merge into existing `col`)
```
barrel: 0xc24a2a, barrelBand: 0xf0c020, carBody: 0x6a6e72,
survivor: 0x4dff7a, turret: 0xb8bcc2, barricade: 0x8a5a3a, spotter: 0x39b6ff,
```

---

## 5. HUD + index.html + input additions (desktop / touch / gamepad)

### 5.1 index.html DOM (one `importmap` change + new HUD nodes)
- **Import map** (required for vendored addons): add the `three/addons/` prefix:
  ```
  <script type="importmap">
  { "imports": { "three": "./vendor/three.module.js", "three/addons/": "./vendor/three-addons/" } }
  </script>
  ```
  Vendored Pass/shader files import bare `three` + relative paths, so only the prefix mapping is needed.
- **Loadout panel** (top-left, under topbar): `<div id="loadout"><span id="club-name">DRIVER</span>
  <span id="spin-mode">—</span></div>`.
- **Wind indicator**: `<div id="wind"><div id="wind-arrow"></div><span id="wind-str"></span></div>` —
  arrow is a CSS triangle rotated via inline `transform:rotate()`, color shifts calm→orange by magnitude.
- **Topbar SURVIVORS cell**: `<div><div class="label" id="lbl-survivors">Survivors</div>
  <div class="val" id="survivors">0</div></div>`.
- **Cart health bar** beside the existing TOWER `#health-wrap`: a second `#cart-wrap`/`#cart-track`/`#cart-bar`
  (same gradient logic). **Boost meter**: `#boost-wrap`/`#boost-bar` (mirrors `#power-wrap`/`#power-bar`).
- **Integrity bar** (aggregate barricade HP): thin `#integrity-track`/`#integrity-bar` under `#health-wrap`.
- **TD tally chips** in `#powerups` cluster: `#td-turrets` (🔫 ×n), `#td-walls` (🧱 ×n).
- **Build panel** (bottom-center, `pointer-events:auto`, `.on` when buildMode): `◀ POST n ▶` stepper, type
  chips `[TURRET 2🧍][SPOTTER 1🧍][BARRICADE 1🧍]` (greyed + `pointer-events:none` when unaffordable),
  selected-post status line, contextual `[UPGRADE n🧍][SELL +n🧍]`, device-aware hint line.
- **Touch chips** inside `#touch`: `#btn-club` (CLUB), `#btn-spin` (SPIN), `#btn-boost` (BOOST), `#btn-build`
  (BUILD), near the existing `#btn-item`/`#btn-swing`.
- **Damage vignette**: reuse existing `#vignette`; add a `.hurt` class (red radial pulse keyframe), toggled
  by `s.damage`.
- CSS reuses existing `--panel`/`--line`/`--warm`/`--accent` tokens and `.pu`/`.controls` patterns.

### 5.2 hud.js
- Constructor caches: `clubName,#spin-mode,#wind-arrow,#wind-str, survivors, cartBar, boostBar,
  integrityBar, tdTurrets, tdWalls`, build-panel els.
- `update(s)`: club label/icon; spin mode text+dot color (`back`=orange, `top`=blue, `default`=dim —);
  rotate `#wind-arrow` `transform:rotate(deg)` + strength text/color by `s.wind.mag`; cart-health bar width +
  gradient (green/amber/red like tower); boost bar width from `s.boost` (dim when 0/cooldown); survivors
  counter (+pulse on gain); integrity bar = `s.buildInfo.integrity*100`; td tallies; toggle `#vignette.hurt`
  by `s.damage`; then `this.updateBuild(s.buildInfo)`.
- `updateBuild(buildInfo)`: toggle `#build .on` by `s.buildMode`; render aimed post id/type/level/cost/
  affordability. HUD stays a pure renderer — all costs/affordability come from `snapshotBuild()`.
- `wireTouch(input)`: also wire `#btn-club→input.touchClub()`, `#btn-spin→input.touchSpin()`,
  `#btn-boost→input.touchBoost(down)` (touchstart/end, like SWING), `#btn-build→input.handlers.buildToggle`.
- `wireBuild()`: wire build chips (touch + click) → `cycleBuild/confirmBuild/sellSelected/stepPost(±1)`.
- `_fillText()`: append club/spin/boost/recover/build control-hint lines from strings.

### 5.3 input.js (desktop + touch + gamepad)
- `addAim(dyaw,dpitch,dt)` is now passed `dt` (from `Game.step`) for the release-flick→sidespin estimate.
- `drive` gains `.boost` (init false): `held.has('ShiftLeft') || this._touchBoost || gamepad LT(button6)/RB`.
- `_key()` additions (with `preventDefault` like other game keys): `KeyC→cycleClub`, `KeyV→cycleSpin`,
  `ShiftLeft→boost (held)`, `KeyR→toRoof`, `KeyB`/`Tab→buildToggle`, `BracketLeft/Right→buildCycle(∓1)`,
  `Enter→buildConfirm`, `KeyX→buildSell`.
- Mouse wheel → `buildCycle`. Left-click in build mode → `buildConfirm` (instead of charge).
- Touch wrappers: `touchClub()`, `touchSpin()`, `touchBoost(down){this._touchBoost=down}` mirroring `touchItem`.
- `_gamepad()` edge-detected: LB(button4)→cycleClub (`_padLB`), dpad-up(button12)→cycleSpin (`_padDU`),
  Y(button3)→buildToggle / toRoof (context: build vs play — toRoof on Y when not in build, toggle on Y in
  build... **resolution**: Y=buildToggle always; **recover-to-roof uses gamepad B-long or keep on KeyR +
  pad button... pick: dpad-down(button13)→toRoof** to avoid clashing), bumpers(4/5)→buildCycle while in
  build mode, A(button0)→buildConfirm in build else useItem, B(button1)→buildSell in build.
  *(Implementation note: gate build-vs-drive button meaning on `ctx.survivors.buildMode`.)*

### 5.4 main.js handler wiring (all gated `state==='playing'`)
`cycleClub`, `cycleSpin` → golf; `toRoof` → `ctx.player.returnToRoof()`; `buildToggle/buildCycle/
buildConfirm/buildSell` → survivors; `chargeStart` early-returns when `ctx.survivors.buildMode`.

### 5.5 strings.js additions
`hudClub, hudWind, spinBack, spinNeutral, spinTop, ctrlClub*, ctrlSpin*, hudCart, hudBoost, gameOverCart,
ctrlBoost*, ctrlRecover*, hudSurvivors, survFreed, survSafe, survLost, noSurvivors, builtTurret, wallDown,
build-menu labels (TURRET/SPOTTER/BARRICADE/UPGRADE/SELL + device-aware build hints)`.

---

## 6. Cross-subsystem conflict resolution (the load-bearing decisions)

**(A) The Zombies damage API shared by `vehicle.runOver` + `golf.explode` + turrets + ball hits.**
One central router: `_damage(z, dmg, dirX, dirZ, opts) → bool(killed)`. All entry points funnel through it:
- `hitBall(z,p,ballVel)` → `_damage(z, CONFIG.ballDamage=1, dir, {dismember: speed>dismemberBallSpeed})`.
- `damage(z, amount)` (turret chip) → `_damage(z, amount, 0,0, {})`.
- `damageArea(pos,r,opts)` → loops, `_damage(z, opts.dmg ?? explosionDamage, awayDir, {dismember:true})`,
  returns count that **died**.
- `runOver(z,vx,vy,vz)` → `_damage(z, runoverDamage=4, dir, {dismember:true, ragdollSeed:{vx,vy,vz}})`.
**Scoring rule (resolves the golf.js vs zombies.js vs survivors.js tug-of-war):** `kill()`/`_damage()` NEVER
score. The CALLER scores on a `true` return — golf adds `scorePerKill` on a lethal ball; golf.explode keeps
its combo math from the `damageArea` returned count; survivors adds `scorePerKill` when `damage()` returns
true; player.onRunOver adds run-over score. This preserves the existing combo formula and supports multi-hit
brutes (no score until the brute actually dies). Documented one-line edits in golf.js (`const died =
z.hitBall(...); if (died) game.addScore(CONFIG.scorePerKill,false);`).

**(B) Gore hooks (who calls what, no double-spawn).**
- `zombies.kill(z,opts)`: after the existing `effects.greenPuff`, call `ctx.gore.killGore(this._p, dir,
  severity)` (dir from `opts.dirX/dirZ` via a scratch `_dir`; severity from dismember count). `opts.dismember`
  → `dismemberGore`.
- `zombies._damage` non-lethal hit → `ctx.gore.burst(p, 0.6, dir)` (light spray).
- `player._runOver` → `ctx.gore.dismemberGore` + a directional smear `splat`.
- `golf.explode` (when `killed>0`) → `ctx.gore.splat(pos, 2.2)` + `ctx.gore.burst(pos, 2.5)` ONLY (the
  per-zombie chunks already come from each `kill→killGore`; do NOT also chunk in explode = no double-spawn).
- All gore calls reuse the caller's existing scratch vector (`this._p`, `this._dir`) — zero new alloc.
- Gore is guarded-optional everywhere (`ctx.gore?.`) so slices 1–2 run before gore exists (§7).

**(C) Instanced-parts draw-call budget vs bloom.**
Draw-call accounting (target stays well under a mid-mobile budget):
```
base scene (sky, ground, perim x2, tower, roof, parapet split→+1, ac, city, ramp ~4) ≈ 14–15
zombies: 11 part InstancedMeshes + 1 debris             = 12   (was 1; +11)
gore: blood Points + decal plane + chunk InstancedMesh  = 3
props: barrel + car InstancedMesh                       = 2
survivors: bodies + cage-bars + 4 post-rigs + projectiles + ~2 rings ≈ 9
golf: ball pool(1 batched? no — N meshes) — KEEP existing per-ball Mesh pool (≤60) + traj Line + marker Ring
effects: 1 Points + flash(8) + rings(6)
```
The single biggest jump is zombies (+11) and survivors (+9). All are constant regardless of crowd size.
Bloom cost is **fill-rate**, not draw-calls: RenderPass + UnrealBloomPass (≈5-pass mip blur) + OutputPass at
`pixelRatio ≤ 1.5`. The mitigation that protects the budget: **`threshold:0.78`** keeps the golden-hour
diffuse scene below the bloom cutoff so only additive/emissive heroes (perimeter rings, crate lids,
explosion flashes, fireball/ember Points, fuse glow, turret muzzle) bloom — the mip chain mostly operates on
near-black input = cheap. All instanced part/debris/prop/survivor meshes set `castShadow=false/
receiveShadow=false` (matches the existing horde) so the 2048 shadow pass stays focused on cart/golfer and
doesn't multiply with the +20 instanced meshes. If a low-end device drops frames, the documented fallbacks
(in order): (1) drop bloom to `RenderPass→OutputPass`, (2) run zombie anim at 30 Hz (alternate frames),
(3) lower `zombieMaxAlive`.

**(D) Barricades affecting zombie pathing.**
`zombies.update` inward-march branch consults `ctx.survivors?.blockAt(angle)` BEFORE moving inward (guarded;
no-op if survivors absent). `blockAt(ang)` returns `{blocked, slow, post}` by scanning barricade posts where
`angleDist(ang, post.angle) < barricadeArc`. If a standing wall blocks and the zombie is within
`buildingRadius + wallStandoff`, the zombie attacks the wall (`damageBarricade(post, zombieVsBarricade*dt)`)
and **does NOT** tick tower damage (`z.atBase=false`) while the wall stands. Otherwise it marches inward with
`speed * slow * z.slow` (spotter slow folded in). When a wall's HP hits 0 the arc opens (`build='empty'`,
dust). Cost: ≤48×12 angle ops/frame worst case — acceptable; the optional O(1) occupancy bitmap
(`_rebuildBlockMask` on build/destroy) is the documented escape hatch if profiling flags it. `z.slow` MUST be
reset to 1 at the top of each zombie's frame BEFORE spotters re-apply, or slows compound permanently.

**(E) Ragdoll ownership (already decided in §4.4).** Articulated ragdoll is the one system; `runOver` seeds it.

**(F) Wind / aim-flick call-site change.** `addAim` now needs `dt`; the ONE call site in `Game.step` passes
it. No other caller exists. Sidespin emerges from the smoothed yaw-flick at release (no new button).

**(G) Explosive ball early-outs preserved.** Explosive balls keep their `if (b.explosive)` early-outs in BOTH
zombie and ground collision branches (detonate on contact) and must bypass the new spin-landing bounce code.
Multiball pellets each inherit the club spin.

---

## 7. Ordered build plan — vertical slices (each independently verifiable headless)

Each slice keeps the game booting and `tools/verify.mjs` (or an extended version) green. The harness boots
`?dev=1`, checks `window.GOLFZ`, drives `game.step` manually, asserts no console errors, and reads
`renderer.info.render.calls`. After each slice, run `npm run verify` (serve on the harness port) and confirm:
BOOT ok, no PAGEERROR, draw calls within budget, `game.state` reaches `playing`, sim advances without throw.

**Slice 0 — CONFIG + plumbing (no behavior change).**
Land the full §4 CONFIG block, the `three/addons/` import-map line, and `ctx.world = world`. Add the empty
`Shake`/`PostFX` classes wired into main.js with `postfx.render` replacing `renderer.render` (bloom can start
at strength 0 / passthrough). Verify: identical visuals to v1, BOOT ok, draws unchanged (±composer passes),
no errors. *This de-risks the renderer swap first.*

**Slice 1 — Articulated zombies rendering (zombies.js replace).**
11 part InstancedMeshes + 1 debris mesh, FK walk/run/attack/flinch anim, 3 types, multi-hit `hp`,
`_damage`/`hitBall`/`damage`/`hitTestAt`, articulated ragdoll death + dismemberment + debris. Keep
`hitTest/damageArea/startWave/update/reset` contracts. Golf still calls `kill()`/`damageArea`; add the
one-line `hitBall` + score-on-death edit to golf.js. Gore/survivors hooks are guarded-absent. Verify: draws
== base+12; a wave spawns; `hitTest` finds a frozen zombie; `damageArea` kills; a ball kills a shambler in
1 hit and a brute survives ≥2; ragdolls appear and fade; no per-frame alloc (watch GC in a long run); no
errors.

**Slice 2 — Golf physics overhaul (golf.js + input/hud/main).**
Shared `_integrate` (drag-on-vRel + Magnus + gravity + spin decay) for live balls AND preview; clubs; wind;
spin-aware bounce/roll; club/spin cycle inputs; HUD club/spin/wind readout; `addAim(dt)` call-site change.
Verify: driver full-power carries ~150–190u, wedge ~30–55u with a dead/back stop, topspin runs farther;
preview line+ring track the live ball under spin/wind (sample the same `_integrate`); HUD shows club/spin/
wind; multiball + explosive paths still fire; no alloc; no errors.

**Slice 3 — Gore (gore.js + effects/golf/zombies/main hooks).**
Blood Points, persistent decal canvas (fade equilibrium), gore chunks; `killGore`/`burst`/`splat`/`chunk`;
hooks in `zombies.kill`, `golf.explode`, `_damage` non-lethal. Verify: draws == prev+3; killing zombies
leaves bounded ground blood (decal fade engages above `inkFadeThreshold`); explosions splat+mist; no alloc in
`update`; canvas allocated once (4MB), never resized; no z-fighting (decalY 0.05 + polygonOffset).

**Slice 4 — Vehicle + ramp (player.js + world.js + zombies.runOver + camera + input boost).**
Ramp meshes + split parapet in world.js; `Player(scene,ctx)` arcade driving + boost + drift + suspension
tilt + `_surfaceAt` surface-follow + bounds; `runOverPass`/`_runOver`; `zombies.runOver` seeds the
articulated ragdoll + dismember; `golf.updateCamera` ground-blend by `pos.y`; cart health + claw; boost/recover
inputs; HUD cart bar + boost + damage vignette. Verify: cart drives down the ramp (pos.y interpolates 9.2→0
across the seam, region 2→1→0), camera morphs to chase cam, run-over launches ragdolls + scores + small
trauma; on the roof everything is byte-identical to slice-2 feel; cart-claw drains cart health on the street;
`returnToRoof` works; no alloc; no errors.

**Slice 5 — Chaos props + bloom juice (props.js + postfx bloom on + effects emitters + world flash).**
Bring bloom to `strength:0.85, threshold:0.78`; props (barrels/cars) place + chain-detonate via
`hitTest/igniteArea/detonate`; golf ball detonates props; `effects.fireball/embers/smoke/debris/muzzle`;
shot kick trauma; hit-stop on detonation; `world.flash`/`tick`. Verify: draws == prev+2; a ball into a barrel
cluster triggers a staggered chain (rolling rumble, not one spike), AoE-kills nearby zombies, scores combo,
flashes + screenshakes + brief hit-stop; bloom lights the hero additives but the diffuse scene matches the
pre-bloom build (no global wash — check `threshold`); `<6` step guard holds on hit-stop release; no alloc.

**Slice 6 — Survivors / tower-defense (survivors.js + zombies pathing + golf.ballHit + hud/input/main).**
Rescue (clear/ball/cart), 12-post ring, turrets (acquire/fire pooled projectiles → `zombies.damage`),
spotters (slow/buff), barricades (block + slow + chew via `blockAt`/`damageBarricade`), economy (survivor
currency, build/upgrade/sell), build UI (desktop aim-at-post + key; touch BUILD + ◀▶ stepper; gamepad).
`golf.update` calls `ctx.survivors.ballHit` after `zombies.hitTest`. Verify: caged survivors spawn and free
by clearing/ball/cart, run home, increment currency + score; placing a turret thins the horde (turret kills
score); barricades block + slow + take damage and open when destroyed; build mode suppresses golf fire;
`z.slow` resets each frame (no permanent compounding); blockAt cost bounded; no alloc; no errors.

**Slice 7 — Polish + balance pass (no new systems).**
Tune CONFIG one knob at a time (kMagnus first, then spinDecay; run-over impulse band; claw vs tower damage;
bloom threshold; cookDelay spread). Strings + control-hint completeness for all three input methods. Final
draw-call/FPS check against the §6 budget; confirm fallbacks documented. Verify: a full play session (menu →
several waves incl. a surge → drive to street → run-over + props + survivors → game over → restart) with no
errors, stable FPS, bounded blood/ragdoll/debris/projectile pools.

---

## 8. Top risks + mitigations

1. **Renderer swap (composer) breaks brightness / double-tonemaps.** EffectComposer intermediate targets are
   linear HDR (HalfFloat); OutputPass is the SINGLE ACES+sRGB encode. Mitigation: land it in Slice 0 at
   passthrough (bloom strength 0) and confirm the scene matches v1 before turning bloom up; if washed, lower
   baseline `toneMappingExposure` or raise `bloom.threshold`. Keep the `RenderPass→OutputPass` fallback.

2. **Articulated zombie cost / FK correctness.** ~48 zombies × ~7 matrix mults + ~16 trig is fine at 60 Hz,
   but FK offsets MUST be authored UNSCALED (scale is baked into `mRoot`, inherited by children) or limbs
   distort. Mitigation: build the skeleton constants exactly per zombies.md §2; verify a single zombie pose
   in isolation first; cap ragdolls(18)/debris(60) to bound explosion spikes; 30 Hz anim fallback if needed.

3. **Zero-alloc regressions.** The biggest new hot loops (FK, ragdoll integrate, run-over broadphase,
   blockAt, projectile/particle integrators) must reuse preallocated scratch — a single `new THREE.Vector3()`
   per frame in any of them tanks GC. Mitigation: code review each `update` for `new`/closures/`Math.hypot`
   where `dx*dx+dz*dz` suffices; the verify harness should run a long step loop and watch for hitching.

4. **Magnus overshoot / spin-bounce jank.** Too-high `kMagnus` loops the wedge; backspin kick-back can pop.
   Mitigation: tune `kMagnus` (0.0042) then `spinDecay` (0.55); `horizScale` clamps to `minHoriz` (never
   inverts velocity — reversal is ONLY the capped explicit kick-back, gated by `backKickThresh`+`bounces<2`);
   keep the two mechanisms from double-counting; verify carry distances per slice 2.

5. **Two HP economies colliding (zombie HP vs barricade HP) + scoring double-count.** Mitigation: ONE zombie
   HP system (integer type HP, §4.2); turret damage retuned into it (§4.5); barricade HP is a separate
   absolute pool chewed by time-damage (no overlap). Scoring is caller-side only; `kill()` stays pure
   (documented) so no path double-counts.

6. **Ramp seam popping / camera clipping the street.** Mitigation: apron flat lip + 1-unit roof/ramp overlap
   + `cartGroundFollow` damp; camera `camMinAbove` clamp + steep-term `(1-_g*0.6)` multiply + ground-blended
   low rig. Raise the follow lambda / widen `apronZ` if it floats.

7. **Bloom fill-rate on low-end / mobile.** Mitigation: `pixelRatioCap:1.5`, single UnrealBloom, high
   `threshold` so most of the frame is near-black into the mip chain; one-line composer-passes fallback.

8. **Construction-order / guard correctness.** Zombies is built before survivors; player before zombies.
   All cross-reads happen at `update` time and survivors-dependent reads in zombies are guarded
   (`if (this.ctx.survivors)`). Mitigation: never read a peer in a constructor; verify each slice boots with
   later subsystems still absent (the slice order relies on this).

9. **Hit-stop spiral-of-death.** Freezing the accumulator must keep the `guard < 6` cap so a long freeze
   doesn't dump a burst of steps on resume. Mitigation: preserved in §3.2; verify with a forced long hit-stop.

10. **Determinism vs cosmetics.** Gore + shake noise use `Math.random` intentionally (cosmetic, must not be
    lockstep); they must NEVER write zombie positions, HP, or score. Mitigation: enforced by the contract in
    §2 (gore/shake write nothing to Game/zombie state); verify spawn placement stays seeded-deterministic.

---

This document is the single source of truth. Build in slice order (§7); resolve any new conflict by the
principles in §6 (one HP system, caller-side scoring, `ctx.shake` owns shake, articulated ragdoll is the one
ragdoll, guarded optional peers, zero per-frame alloc).
