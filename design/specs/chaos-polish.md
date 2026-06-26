# GOLF Z — Chaos Props + Visual Polish Spec

Scope: (1) destructible chaos props (explosive barrels + abandoned cars) with
ball-hit / chain-reaction / cart-ram detonation; (2) camera trauma screenshake +
hit-stop; (3) UnrealBloom post-processing via the vendored r160 addons;
(4) extra juice — flashes, embers/smoke, shot camera kick, sky/light drama,
color grade.

Hard constraints carried over: client-side only, fixed-timestep 60Hz, ZERO
allocations inside per-frame loops (reuse Vector3/Matrix4/Quaternion/Color),
pooling, low draw calls, everything procedural (no external runtime libs).

---

## 0. Files

New:
- `public/js/props.js` — `class Props` (the chaos prop subsystem).
- `public/js/postfx.js` — `class PostFX` (EffectComposer + bloom wrapper) and a
  tiny `class Shake` (camera trauma + hit-stop model). Keeping both small helpers
  in one file avoids two new imports in main.js; they are independent classes.

Modified:
- `public/index.html` — extend the import map with `"three/addons/"`.
- `public/js/config.js` — add `CONFIG.props`, `CONFIG.shake`, `CONFIG.bloom`,
  `CONFIG.grade`, two palette colors, and prop-related explosion tunables.
- `public/js/main.js` — instantiate `PostFX` + `Shake`, wire them into `ctx`,
  add `ctx.props`, apply trauma/hit-stop to camera + dt in the loop, swap
  `renderer.render` for `composer.render`, update resize, light/grade drama.
- `public/js/golf.js` — ball↔prop hit test inside the ball loop; route prop
  detonation through `ctx.props`; add a small camera-kick trauma on fire.
- `public/js/effects.js` — add `fireball()`, `embers()`, `smoke()`, `muzzle()`
  emitters and a couple more pooled flashes; have `explosion()` damage props
  via a callback hook (chain reactions). Optionally drive `Effects` to ask the
  scene for trauma through `ctx`.
- `public/js/player.js` — expose a cheap world-space collision query
  (`pos` + `heading` already public) used by Props for cart-ram.
- `public/js/zombies.js` — no change required; `damageArea` already exists and
  is reused by prop explosions.

---

## 1. CONFIG additions (concrete tuned numbers)

```js
// ---- Chaos props (street-level destructibles) ----
props: {
  barrelCount: 14,        // explosive barrels in the field
  carCount: 7,            // abandoned cars
  // placement: rings + clusters between perimeter (38) and spawn ring (96)
  ringMin: 46, ringMax: 90,
  clusterCount: 5,        // tight clusters of 2..4 props for chain-reaction lanes
  clusterSpread: 6,
  barrelRadius: 1.3,      // collision radius (xz)
  barrelHeight: 2.6,
  carRadius: 2.8,         // collision radius (xz), cars are bigger
  carHalf: [3.2, 1.4, 1.6], // half-extents for the box body
  // detonation
  barrelDmgRadius: 12,    // zombie-kill AoE for a barrel
  carDmgRadius: 16,       // cars are a bigger boom
  barrelTrauma: 0.55,     // screenshake added on detonation
  carTrauma: 0.8,
  barrelHitStop: 70,      // ms global time-dip
  carHitStop: 110,
  chainDelayMin: 60,      // ms before a caught prop cooks off (staggered chain)
  chainDelayMax: 180,
  debrisCount: 18,        // debris particles per barrel
  carDebrisCount: 30,
  fuseFlash: 0.12,        // s of pre-detonation glow ramp when fused by chain
  ramSpeedMin: 6,         // cart speed needed to ram-detonate a prop
  respawnFrac: 0.6,       // each wave break, refill destroyed props up to this frac of cap
  scorePerProp: 25,       // bonus for popping a prop (kills also score via damageArea)
},

// ---- Screen shake (camera trauma) + hit-stop ----
shake: {
  maxYaw: 0.06,           // rad — max angular kick at trauma=1
  maxPitch: 0.05,
  maxRoll: 0.07,
  maxOffset: 0.9,         // world units of positional shake at trauma=1
  decay: 1.7,             // trauma units/sec linear decay
  freq: 22,               // noise frequency (Hz-ish) for the shake oscillation
  traumaMax: 1.0,
  shotKick: 0.12,         // trauma added per shot fired (scaled by power)
  bigShotKick: 0.28,      // explosive/multiball fire
  minHitStopScale: 0.05,  // lowest timeScale during a hit-stop (near-freeze)
},

// ---- Bloom post-processing (UnrealBloomPass) ----
bloom: {
  strength: 0.85,         // overall bloom intensity (tuned NOT to wash the scene)
  radius: 0.55,           // blur spread across the mip chain
  threshold: 0.78,        // luminance cutoff — only bright/emissive/additive blooms
  pixelRatioCap: 1.5,     // composer render-target pixel ratio cap (matches renderer)
  exposureBoostOnBoom: 0.12, // transient toneMappingExposure bump on big booms
},

// ---- Color grade (OutputPass handles tonemap+sRGB; this is the scene-side push) ----
grade: {
  fogBoomColor: 0xff7a3a, // fog tint flash when a big explosion fires
  fogBoomAmount: 0.0,     // (runtime lerp target; baseline 0)
},
```

Palette additions in `CONFIG.col`:
```js
barrel:     0xc24a2a,   // weathered rust-red drum
barrelBand: 0xf0c020,   // hazard band (slightly emissive when fused)
carBody:    0x6a6e72,   // dead-grey abandoned sedan
```

Existing reused: `explosionRadius: 13` (still the ball-explosive radius),
`scorePerKill`, `comboBonus`, `col.explosive`, `col.pickup`.

---

## 2. Props subsystem — data model, placement, detonation, chain logic

### Data model
Props are a **small pooled set** rendered as **two InstancedMeshes** (one for
barrels, one for cars) → 2 extra draw calls total, regardless of count. Per-prop
state lives in a plain-object pool array (mirrors the zombies pattern):

```
prop = {
  kind: 'barrel'|'car',
  x, z, yaw,            // world placement (props sit on street, y baked per kind)
  alive: bool,          // standing & dangerous
  cooking: bool,        // fused, counting down to detonation (chain/fuse)
  cookT: 0,             // s elapsed while cooking
  cookDelay: 0,         // s until it blows (set when fused)
  scale: 1,             // 1 standing; ignored once detonated (instance hidden)
  i: instanceIndex,     // slot in its kind's InstancedMesh
};
```

Two geometries, built once and baked with `mergeGeometries(THREE, parts)` (same
helper zombies use) so each kind is a single instanced geometry:
- **Barrel**: `CylinderGeometry(r, r, h, 14)` body + two thin torus/cylinder
  hazard bands. Bands use a second material? No — keep ONE material per
  InstancedMesh. Bake band color into the procedural `crate`-style canvas, OR
  use per-instance color (InstancedMesh `setColorAt`) to vary rust. Use the
  existing `pbrMaterial(THREE, assets.crate, {roughness:.7})` cloned with
  `emissive` set so the band area can bloom when fused (emissive driven globally
  via material.emissiveIntensity during the fuse — cheap, affects all instances,
  acceptable because only ~1 frame window). Simpler: give barrels a dedicated
  emissive overlay handled by the fuse flash mesh (see below), keep the
  instanced material non-emissive.
- **Car**: a boxy sedan from 3–4 boxes (`carHalf` body + cabin box + 4 dark
  wheel cylinders) merged. One `MeshStandardMaterial({color: col.carBody,
  metalness:.4, roughness:.5})`. Per-instance color jitter for variety.

Instance transform: `m.compose(_p.set(x, yBase, z), _q.setFromAxisAngle(UP,yaw),
_s.set(scale,scale,scale))`. Destroyed/asleep props are written with the shared
`_hidden = makeScale(0,0,0)` matrix (zombie pattern). `instanceMatrix` flagged
`DynamicDrawUsage`; `needsUpdate` set once per frame only if something changed
(track a `_dirty` flag — placement, respawn, ram-jostle, or hide events).

Both meshes: `castShadow=true`, `receiveShadow=true` (props are few & on the
street; shadows sell them). `frustumCulled=false` (small, always near play).

### Placement
`reset()` / `respawn()` uses the seeded `makeRNG(...)` (own seed, e.g. 4242) so
layout is deterministic across runs but distinct from zombie/crate RNGs.

Layout algorithm (run on initial `place()` and to refill on `respawn()`):
1. **Ring scatter**: distribute `barrelCount - clusterUsed` barrels + cars on
   rings between `ringMin..ringMax`, angle = `rng()*TAU`, radius =
   `rng.range(ringMin, ringMax)`, yaw random. Reject placements within
   `perimeter+4` (don't block the kill-ring) — clamp radius up if too close.
2. **Clusters**: pick `clusterCount` seed points (random ring positions); around
   each, place 2..4 barrels within `clusterSpread` so explosions chain down a
   lane. Clusters are the chain-reaction set-pieces.
3. Cars are placed mostly solo on the ring (they're big AoE anchors), a couple
   adjacent to barrel clusters for spectacular multi-pops.

Props never overlap the tower footprint or each other (simple
distance-reject loop, capped iterations).

`respawn()` (called from `main.onWaveCleared()` alongside the existing crate
drop): count currently-dead props, re-activate up to `cap * respawnFrac` of them
by re-running placement only for dead slots (so the field never goes empty but
also isn't instantly full — escalating chaos). Newly respawned props get a brief
scale-in pop (0→1 over ~0.25s) for readability.

### Collision queries (called by golf.js + player.js)
- `hitTest(p, r) -> prop|null` — ball↔prop. `p.y` gate: only when
  `p.y < kind-height + r` (cars are low, barrels mid). XZ circle test against
  `barrelRadius`/`carRadius`. Returns the first standing, non-cooking prop hit.
  Zero alloc (scalar math over the pool).
- `cartTest(px, pz, speed) -> void` — called each frame from `Props.update`
  using `ctx.player.pos`/`ctx.player.speed`; if `speed >= ramSpeedMin` and the
  cart center is within `carRadius/barrelRadius + cartHalf(~2)`, detonate that
  prop (cart ram). Cart is on the rooftop (y≈9) and props are on the street
  (y≈0), so a **ram only triggers for props within a few units of the tower
  base in XZ AND** … actually the cart can't reach street props (it's clamped to
  the 30-wide roof at height 8). Resolution: ram detonation applies to props
  that get close to the tower base — but since props are placed at radius ≥46
  and the roof half-width is 15, the cart physically cannot touch them. So
  **cart-ram is satisfied by the ball/explosion paths in normal play**; we still
  implement `cartTest` for completeness and future street-level play, gated by a
  2D distance check, but it will essentially never fire given current scale.
  (Documented as a known no-op under current world scale — see Risks.)

### Detonation + chain reaction
`detonate(prop, depth=0)`:
1. Guard: if `!prop.alive && !prop.cooking` return (already gone). Mark
   `prop.alive=false; prop.cooking=false`.
2. Pick radius/trauma/hitstop/debris by `kind`.
3. **Kill AoE**: `killed = ctx.zombies.damageArea(_pos.set(prop.x, 1.4, prop.z),
   dmgRadius)`. Score: `ctx.game.addScore(killed*scorePerKill +
   (killed-1)*comboBonus + scorePerProp, killed>1)`.
4. **Visuals**: `ctx.effects.fireball(_pos)` (big additive flash + ember burst +
   smoke + shock ring + debris); `ctx.audio.explosion()`.
5. **Juice**: `ctx.shake.addTrauma(traumaByKind)` and
   `ctx.shake.hitStop(hitStopByKind)`; transient
   `ctx.postfx.boomPulse()` (exposure + bloom-strength blip, decays in PostFX).
6. **Hide** the instance (write `_hidden` matrix, mark `_dirty`).
7. **Chain**: scan the pool; for every other standing prop within
   `dmgRadius` (use its own kind's chain check — cars reach further), if not
   already cooking, set `cooking=true`, `cookT=0`,
   `cookDelay = rng.range(chainDelayMin, chainDelayMax)/1000` (staggered, so
   chains ripple rather than pop in one frame and over-shake). `depth` is passed
   purely for an optional safety cap (depth < pool size) — the `cooking` flag
   already prevents re-entrancy, so recursion terminates.

`update(dt)`:
- Advance cooking props: `cookT += dt`; drive a fuse-glow on the fuse-flash
  helper (scale/opacity ramp on a tiny additive sphere at the prop, pooled like
  effects flashes) so the player sees it about to blow. When
  `cookT >= cookDelay`, call `detonate(prop)` (this triggers its own neighbors →
  ripple). Because detonations happen across frames via the cook timer, the
  shake/hit-stop from a big cluster is spread over ~0.2–0.4s = a satisfying
  rolling rumble instead of one spike.
- Run `cartTest` (see note above).
- Flush `instanceMatrix.needsUpdate` once if `_dirty`.

`Effects.explosion()` and the ball-explosive path also need to ignite props they
overlap: the ball-explosive `explode()` already calls `zombies.damageArea`; add
a parallel `ctx.props.igniteArea(pos, CONFIG.explosionRadius)` that sets nearby
props cooking (same staggered chain entry point). This is how a player's
explosive shot kicks off a barrel chain.

---

## 3. Screen shake (trauma model) + hit-stop — API + main-loop application

### `class Shake` (in postfx.js) — no per-frame allocation
State: `trauma` (0..1), `timeScale` (1), `hitStopT` (s remaining), plus a
private seeded noise sampler (3 independent `makeRNG`-seeded 1D value-noise
phases for yaw/pitch/roll/offset) and a running `time` accumulator.

Public API:
```js
addTrauma(amt)        // trauma = min(traumaMax, trauma + amt)
hitStop(ms)           // hitStopT = max(hitStopT, ms/1000); also sets a flag
get shake()           // recompute shake amounts from trauma^2 (see apply)
applyToCamera(camera, baseQuatBuilt) // adds rotational + positional shake AFTER golf.updateCamera
advance(realDtSec)    // decays trauma; ticks hit-stop; returns the dt SCALE to use this frame
reset()
```

Model (Nystrom "Math for Game Programmers: Juicing your camera with screenshake"):
- `shake = trauma * trauma` (quadratic → small traumas barely move, big ones
  slam, decay feels natural).
- per-frame, advance an internal `time += realDt`. Sample smooth noise
  `n(seed, time*freq)` in [-1,1] for each axis (value-noise from the seeded RNG,
  interpolated — reuse the `noiseFn`-style lerp; cheap, deterministic, no
  `Math.random` so it reads as coherent shake not white static).
- Angular kick added to the camera AFTER `golf.updateCamera` runs:
  - `camera.rotateZ(maxRoll * shake * nRoll)`
  - small yaw/pitch via rotating around camera-local axes:
    `camera.rotateX(maxPitch*shake*nPitch); camera.rotateY(maxYaw*shake*nYaw);`
  - positional: `camera.position.x += maxOffset*shake*nOffX` (+ y,z with other
    noise seeds), applied to the already-lerped position.
  This must run on the *render* path each visual frame (not the fixed step) so
  shake is smooth at display rate. `golf.updateCamera` writes position+lookAt;
  Shake then perturbs the resulting transform. Because lookAt rebuilds the quat
  fresh every frame from the smoothed position, the shake perturbation does not
  accumulate/drift — each frame is base transform + fresh offset.

### Hit-stop
- `hitStop(ms)` sets `hitStopT`. Each visual frame, `advance(realDt)`:
  - if `hitStopT > 0`: `hitStopT -= realDt`; the *simulation* timeScale for this
    frame = `lerp(minHitStopScale, 1, smoothstep(1 - hitStopT/origDur))` — but
    simpler and robust: while `hitStopT > 0` return scale `minHitStopScale`
    (hard freeze) then snap back; the brevity (≤110ms) makes a hard dip read as
    impact. We use the slightly nicer ramp: scale ramps back up over the last
    40% of the hit-stop.
  - returns `scale`.
- Decay trauma: `trauma = max(0, trauma - decay*realDt)`.

### Main-loop application (exact wiring in `frame(now)`)
The fixed-timestep accumulator must consume **scaled** time so hit-stop slows the
whole simulation (zombies, balls, props, particles) coherently:

```js
function frame(now) {
  requestAnimationFrame(frame);
  let elapsed = now - last; last = now;
  if (elapsed > 250) elapsed = STEP;
  const realDt = Math.min(0.05, elapsed / 1000);

  const tScale = shake.advance(realDt);   // ticks hit-stop + trauma decay
  if (game.state === 'playing') {
    acc += elapsed * tScale;              // <-- scaled accumulation = hit-stop
    let guard = 0;
    while (acc >= STEP && guard++ < 6) { game.step(STEP / 1000); acc -= STEP; }
  } else acc = 0;

  // camera
  if (game.state === 'menu') { /* unchanged orbit */ }
  else { ctx.golf.updateCamera(camera, realDt * (tScale*0.5 + 0.5)); } // cam eases too

  if (game.state === 'playing') shake.applyToCamera(camera);  // perturb AFTER base cam

  if (playing||paused) hud.update(game.snapshot());

  postfx.render();   // <-- replaces renderer.render(scene,camera)
  // dev overlay unchanged
}
```

Notes:
- `acc += elapsed * tScale` means during a hit-stop fewer/zero fixed steps run →
  the world visibly freezes for a beat, then catches up. Guard (`<6`) still
  prevents spiral-of-death on resume.
- Trauma decay + noise advance use **realDt** (shake should keep moving even
  while sim is frozen — the camera shakes during the freeze, which is the whole
  point of impact).
- `shake.addTrauma` / `shake.hitStop` are called from: props detonation, ball
  explosive `explode()`, golf `fire()` (small `shotKick`), big zombie multi-kill
  combos (optional: `addTrauma(0.15)` when `killed>3`).
- Expose via `ctx.shake = shake;` and `ctx.postfx = postfx;` after construction.

---

## 4. Bloom post-processing — exact composer chain + tuning + resize

### Import map (index.html)
```html
<script type="importmap">
{ "imports": {
  "three": "./vendor/three.module.js",
  "three/addons/": "./vendor/three-addons/"
} }
</script>
```
(The vendored addons import bare `'three'` and relative `./Pass.js` etc., so
only the `three/addons/` prefix mapping is needed for our imports; their internal
relative imports already resolve.)

### `class PostFX` (postfx.js)
```js
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from './config.js';

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.camera = camera;
    this.composer = new EffectComposer(renderer); // HalfFloat RT by default (good)
    this.composer.setPixelRatio(Math.min(devicePixelRatio||1, CONFIG.bloom.pixelRatioCap));
    this.composer.setSize(innerWidth, innerHeight);

    this.composer.addPass(new RenderPass(scene, camera));
    const res = new THREE.Vector2(innerWidth, innerHeight);
    this.bloom = new UnrealBloomPass(res, CONFIG.bloom.strength, CONFIG.bloom.radius, CONFIG.bloom.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass()); // tonemap (ACES) + sRGB happen HERE now

    this._boomT = 0;
  }
  resize() {
    this.composer.setSize(innerWidth, innerHeight);
    this.composer.setPixelRatio(Math.min(devicePixelRatio||1, CONFIG.bloom.pixelRatioCap));
    this.bloom.resolution.set(innerWidth, innerHeight); // UnrealBloom internal mip sizes
  }
  boomPulse() { this._boomT = 1; }                  // called on big detonations
  render(dt) {
    if (this._boomT > 0) {                            // transient bloom/exposure bump
      this._boomT = Math.max(0, this._boomT - (dt||0.016) * 3);
      this.bloom.strength = CONFIG.bloom.strength + this._boomT * 0.5;
      this.renderer.toneMappingExposure = 1.06 + this._boomT * CONFIG.bloom.exposureBoostOnBoom;
    }
    this.composer.render();
  }
}
```

### Critical tonemapping ordering
Right now `main.js` sets `renderer.toneMapping = ACESFilmic` and
`outputColorSpace = SRGB`, and calls `renderer.render` (which applies both).
With a composer, **OutputPass** is what applies tonemapping + sRGB at the end of
the chain. To avoid double-tonemapping/double-encoding:
- Keep `renderer.toneMapping = ACESFilmicToneMapping` and
  `renderer.toneMappingExposure` (OutputPass reads `renderer.toneMapping` &
  exposure and applies them — this is the r160 OutputPass contract).
- The intermediate render targets are linear HDR (EffectComposer default
  `HalfFloatType`), so bloom thresholding operates in a sensible range and
  OutputPass does the final ACES + sRGB. `renderer.outputColorSpace` no longer
  governs the final blit (OutputPass writes sRGB to the default framebuffer);
  leaving it set is harmless.
- RenderPass must render the scene in linear space (default). Do NOT also let the
  renderer tonemap mid-chain — RenderPass uses `renderer.render` internally but
  EffectComposer renders into a target; the OutputPass at the end is the single
  tonemap/encode step. (This is the standard r160 EffectComposer+OutputPass
  setup.)

### Tuning rationale (NOT washing the scene)
- `threshold: 0.78` — the golden-hour scene's lit surfaces tonemap below ~0.78
  luminance, so diffuse asphalt/facades/zombies do **not** bloom. What blooms:
  the additive perimeter rings (`AdditiveBlending`), crate emissive lids
  (`emissiveIntensity 0.9–1.3`) + beams (additive), explosion flash spheres
  (additive), fireballs/embers (additive Points), and the new fuse glow. These
  are exactly the "hero" lights we want glowing.
- `strength: 0.85` — visible halo without halation over the whole frame.
- `radius: 0.55` — medium spread; explosions feel hot, small emissives stay tight.
- `boomPulse()` briefly lifts strength to ~1.35 and exposure +0.12 for ~0.33s on
  a big detonation = a punchy flash-bloom that settles back.

### Where main.js swaps render
- Construct after camera + world: `const postfx = new PostFX(renderer, scene,
  camera); ctx.postfx = postfx;`
- In `frame()`, replace `renderer.render(scene, camera)` with
  `postfx.render(realDt)`.
- In `resize()`, after `renderer.setSize(...)`, add `postfx.resize()`.
  (`renderer.setPixelRatio` and `composer.setPixelRatio` both capped at 1.5.)
- Menu state also renders via `postfx.render()` (bloom on the title-screen orbit
  looks great with the perimeter ring).

---

## 5. Extra juice

### Effects.js additions (all pooled, additive, zero per-frame alloc)
- `muzzle(p, dir)` — tiny bright additive flash sphere + 6 fast forward embers at
  the shoot origin on `fire()` (sells the "swing impact"). Reuse the flash pool;
  add 2 more flash slots (8 total) since explosions + muzzle can overlap.
- `fireball(p, big)` — the prop/explosive detonation visual: 50–80 additive
  embers (`r1,g0.45,b0.12`), 16 hot-white core sparks, 10 dark **smoke** puffs
  (new low-speed, upward, long-life, dark-grey particles that *fade in then out*
  and are NOT additive-bright — use a separate non-additive smoke Points? To keep
  ONE Points draw call, fake smoke as low-brightness additive that the bloom
  threshold ignores; acceptable for arcade), a shock ring (existing pool, scaled
  by radius), debris (see below).
- `embers(p, n)` / `smoke(p, n)` — exposed helpers used by fireball and for
  ambient barrel idle (a rare ember from intact barrels for life).
- `debris(p, n)` — fast, gravity-heavy, longer-life chunky particles
  (`grav: 22, speed: 30, life: 1.0`) tinted prop-color; they bounce off the
  ground (existing y<0.1 bounce handles it). Same Points pool — just a hotter,
  heavier emit profile. Cap respected by the ring buffer cursor.
- Bump `Effects.cap` from 520 → 900 to absorb multi-prop chains without starving
  (still one Float32-backed Points draw call; cost is the per-frame update loop,
  see perf).

### Shot camera kick
- In `golf.fire()`: `ctx.shake.addTrauma(CONFIG.shake.shotKick * (0.4 + 0.6*power01))`,
  and `bigShotKick` instead when `explosive||multi`. Plus `ctx.effects.muzzle()`.
- A subtle per-shot FOV punch is optional (skip — trauma offset already kicks the
  frame; touching FOV fights the composer’s fixed projection less cleanly).

### Sky / light drama
- On big detonations: `world.sun` gets a 1-frame-ish warm intensity bump that
  decays (store target in main and `damp()` back to 2.5), and `scene.fog.color`
  lerps toward `CONFIG.grade.fogBoomColor` then back (driven in `game.step` or a
  tiny `world.tick(dt)` — add `world.flash(amount)` + `world.tick(dt)` returning
  to baseline). Keeps the golden-hour base but makes explosions feel like they
  light the haze. Implement as: `buildWorld` returns `{ sun, sky, roofY, half,
  flash(a){this._f=Math.max(this._f,a)}, tick(dt){ damp sun.intensity & fog.color
  back to base, _f decays } }`; call `ctx.world = world; ` and `world.tick(realDt)`
  in the loop (cheap, no alloc with a cached Color).

### Color grade
- Primary grade is the existing ACES tonemap (now via OutputPass) + the DOM
  vignette/grain overlays in index.html (unchanged, they sit above the canvas).
- Add a transient screen-edge "boom" reaction by nudging the DOM `#vignette`?
  Optional — keep it engine-side via `postfx.boomPulse()` exposure bump to avoid
  layout thrash. No new DOM required.

---

## 6. Integration summary (ctx wiring + read/write)

Constructed in main.js after existing subsystems:
```js
ctx.shake  = new Shake();
ctx.postfx = new PostFX(renderer, scene, camera);
ctx.world  = world;                 // expose for flash()/tick()
ctx.props  = new Props(scene, ctx); // after effects/zombies exist
```
`game.step(dt)` adds `ctx.props.update(dt)` (after zombies, before effects, so
chain detonations this step feed effects same frame). `game._reset()` adds
`ctx.props.reset()` and `ctx.shake.reset()`. `game.onWaveCleared()` adds
`ctx.props.respawn()`.

Reads/writes of Game state:
- Props → `ctx.zombies.damageArea` (kills), `ctx.game.addScore`,
  `ctx.effects.fireball/...`, `ctx.audio.explosion`, `ctx.shake.addTrauma/hitStop`,
  `ctx.postfx.boomPulse`, `ctx.world.flash`, `ctx.player.pos/speed` (ram test).
- Golf → `ctx.props.hitTest` (ball↔prop in ball loop), `ctx.props.igniteArea`
  (explosive shot chains), `ctx.shake.addTrauma` (shot kick), `ctx.effects.muzzle`.
- Shake → consumed only by the main render/step loop and camera.
- PostFX → replaces render; reads CONFIG.bloom; receives `boomPulse()`.

Golf ball loop edit (inside `for (const b of this.balls)`), after the zombie
hitTest block: a prop hitTest. A **normal** ball hitting a prop detonates it
(`ctx.props.detonate(prop)`) and the ball loses energy / despawns; an
**explosive** ball already routes through `explode()` whose AoE +
`props.igniteArea` lights props. Order: test props before/with zombies so a
barrel in front of the horde reads as the cause.

---

## 7. Perf notes

- **Draw calls**: +2 (barrel InstancedMesh, car InstancedMesh) + composer’s
  fullscreen passes. Bloom = RenderPass + UnrealBloom (≈5 blur passes over a mip
  chain at capped pixelRatio 1.5) + OutputPass. At 1.5x DPR this is the main new
  GPU cost; the mip-chain bloom is designed for exactly this and is cheap at
  1080p-class resolution. Pixel-ratio cap 1.5 keeps fill rate bounded on retina.
- **HalfFloat RT**: EffectComposer default; needed for correct HDR bloom +
  OutputPass tonemapping. Costs bandwidth but is the right call for one bloom.
- **Particles**: cap raised to 900 — still ONE Points draw call; per-frame cost
  is the O(cap) update loop. 900 floats×(pos/col/vel) is trivial; the loop early-
  `continue`s dead particles. No allocation (ring-buffer cursor, preallocated
  typed arrays — matches existing Effects).
- **Props update**: O(propCount≈21) per frame, scalar math, `instanceMatrix`
  uploaded only when `_dirty`. Chain scan is O(n²) but n≈21 and only runs on the
  detonation event (not per frame).
- **Shake**: a few noise samples + quaternion math per *visual* frame, no alloc
  (cached vectors). Hit-stop just scales the accumulator — free.
- **Zero-alloc discipline**: all new per-frame code reuses pre-created
  Vector3/Matrix4/Quaternion/Color/Euler on the instance (Props mirrors zombies’
  `_m/_q/_e/_p/_s`; Shake caches its sample temporaries; PostFX allocates only at
  construct/resize).
- **Shadows**: props cast/receive; few enough (21) that the existing
  2048 shadow map (frustum focused on roof radius 24) won’t cover street props —
  street props at radius 46–90 are OUTSIDE the shadow frustum, so they won’t cast
  real-time shadows anyway. Set `castShadow=false` on prop meshes to avoid paying
  for shadow draws that produce nothing; keep `receiveShadow=false` too (street
  already gets the wide ground). Net: props add 2 color draws only.

## 8. Risks / known limitations
- **Cart-ram never fires under current scale**: cart is clamped to the 15-half
  rooftop at y≈9; props live on the street at radius ≥46. `cartTest` is
  implemented and correct but is a practical no-op now. If a future mode lets the
  cart reach the street it works unchanged. (Could repurpose ram as "ball rolling
  through a prop on the ground" — covered by the grounded-ball hitTest already.)
- **Double-tonemapping** if OutputPass is added while RenderPass/renderer also
  tonemaps mid-chain — mitigated by relying on the r160 EffectComposer contract
  (intermediate targets linear, OutputPass is the only encode). Verify visually
  that the scene brightness matches the pre-bloom build; if washed, lower
  `toneMappingExposure` baseline slightly or raise bloom `threshold`.
- **Bloom on touch / low-end**: pixelRatio cap 1.5 + a single UnrealBloom is the
  budget; if FPS suffers on mobile, gate bloom behind a quality check (skip the
  bloom pass, `composer` falls back to RenderPass→OutputPass) — out of scope but
  the PostFX class makes it a one-line `composer.passes` swap.
- **Chain over-shake**: many barrels cooking off in one frame could spike trauma
  past 1 — clamped by `traumaMax` and spread over time by the randomized
  `cookDelay`, so a cluster reads as a rolling rumble, not one slam.
- **Emissive bloom tuning is content-coupled**: if crate/perimeter emissive
  values change later, re-check `threshold` so the base scene stays un-bloomed.
