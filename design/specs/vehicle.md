# Cart Ground-Driving + Run-Over Carnage — Design Spec

Extends `public/js/player.js` (Player class), adds a ramp to `public/js/world.js`,
adds `runOver()` + run-over book-keeping to `public/js/zombies.js`, adjusts the chase
camera in `public/js/golf.js`, adds boost/recover inputs to `public/js/input.js`, and
adds a cart-health + damage-flash path to `main.js` / `hud.js`. All tunables go in
`public/js/config.js`.

This is the authority for: the **surface-height-by-region** function, **arcade cart
physics** (momentum, speed-scaled steering, reverse, BOOST, drift, suspension lean/pitch),
**cart-vs-zombie run-over** (broadphase, impulse math, per-zombie i-frames, blood + score +
screenshake), the **seamless roof↔street** transition (no mode switch), the **ground-vs-roof
camera** behavior, **cart/player damage** from clawing zombies, and all CONFIG additions.

It matches the existing `ctx` wiring and code style: shared `ctx` object, fixed 60 Hz
`step(dt)`, **zero allocations in per-frame loops** (reuse `Vector3`/`Matrix4`/`Quaternion`),
`z.x`/`z.zz` zombie ground coords, `clamp`/`lerp`/`damp` from `utils.js`, pooled `effects`,
`pbrMaterial(THREE, set, opts)` materials.

---

## 0. Coordinate / world facts (frozen)

- Street = `y 0`. Rooftop structural top (the drivable roof slab top face) = `rooftopHeight + 1.2 = 9.2`.
  The Player's `pos.y` is the **cart root origin** = top of the surface it stands on; wheels are
  modeled at local `y 0.62`, body at `1.05`. Current code sets `pos.y = roofTop = rooftopHeight + 1.2 = 9.2`.
- Rooftop slab is `towerFootprint = rooftopSize + 4 = 34` wide, centered at origin → roof spans `±17` in X/Z.
  The parapet walls sit at `±(half+2) = ±17` and are `0.8` thick; current drivable clamp is `rooftopSize/2 - 1.6 = 13.4`.
- Perimeter ring (zombies stop & attack) radius `38` = `CONFIG.buildingRadius`. Spawn ring `96`. Ground half-extent `380`.
- Zombies live on the street at `y 0`; `z.x`/`z.zz` are their ground coords, center of mass ~`y 2.2`,
  collision radius `1.8` (`CONFIG.zombieRadius`), visual height `4.4`.
- Gravity world constant `24` (`CONFIG.gravity`). Cart never leaves the ground plane in Z-up sense —
  its Y is **driven by the surface-height function**, not by a physics fall (except a small ramp-edge
  snap), so no air/jump physics is required.

---

## 1. The RAMP (world.js geometry + placement)

A single straight ramp bridges the rooftop slab (top `9.2`) down to the street (`0`) on the
**+Z edge** of the tower (the side the cart already spawns toward — player spawns at
`z = rooftopSize*0.28 ≈ +8.4`, facing `-Z`; so the ramp behind/under the +Z edge is natural and
keeps the city skyline view unobstructed when on the roof). We cut one parapet segment to open it.

### 1.1 CONFIG (ramp dims)

```
ramp: {
  width: 8,            // drivable lane width (X)
  topZ: 19,            // ramp top abuts roof edge just outside the slab (half+2 = 17, +2 overlap → 19 outer)
  // run/length derived from height + slope; see below
  slopeRise: 9.2,      // = rooftopHeight + 1.2  (roof top → street)
  slopeRun: 22,        // horizontal length of the incline (gentle ~22.7° ramp, drivable at speed)
  apronZ: 4,           // flat top "lip" length overlapping the roof edge for a seamless seam
  side: 1,             // +Z side (sign on Z); flip to -1 to move it
  curbH: 0.35,         // low side curbs so you don't slide off the ramp edges
}
```

Derived: ramp incline occupies Z from `rampTopZ = half+2 = 17` (roof edge, surface y `9.2`)
outward to `rampFootZ = 17 + slopeRun = 39` (surface y `0`). The flat **apron** spans the seam
`Z ∈ [17 - apronZ, 17]` so the cart is already level before the lip. `tan(angle) = 9.2/22 → ~22.7°`.

> Note `rampFootZ ≈ 39 ≈ buildingRadius (38)` is a happy accident: the ramp foot lands essentially
> AT the defense perimeter, so driving down the ramp drops you right into the kill zone. If you want a
> safety gap, shorten `slopeRun` to `~18` (foot at Z 35, steeper ~27°). Keep at 22 for the "drive into
> the horde" feel; the perimeter ring visual will straddle the ramp foot.

### 1.2 Meshes (added inside `buildWorld`, returned in the world object)

All static, so plain `BoxGeometry` + existing `pbrMaterial(THREE, assets.roof, …)` (matches the slab look).
Build the inclined slab as a thin box rotated about X so its top face is the driving surface.

```
const R = CONFIG.ramp;
const half = CONFIG.rooftopSize / 2;            // 15
const edgeZ = half + 2;                         // 17 (outer roof edge / parapet line)
const ang = Math.atan2(R.slopeRise, R.slopeRun); // incline angle
const inclineLen = Math.hypot(R.slopeRise, R.slopeRun);
const slabT = 1.2;                              // match roof slab thickness

// incline deck (rotated thin box). Center it along the incline.
const incline = new THREE.Mesh(
  new THREE.BoxGeometry(R.width, slabT, inclineLen),
  pbrMaterial(THREE, assets.roof, { repeat: [2, Math.round(inclineLen / 4)], roughness: 0.95, aniso })
);
incline.rotation.x = -ang * R.side;             // tilt: top toward roof, foot toward +Z
// midpoint of incline in Z and Y:
const midZ = edgeZ + R.slopeRun / 2;            // 28
const midY = R.slopeRise / 2;                   // 4.6
incline.position.set(0, midY, midZ * R.side);
incline.receiveShadow = true; incline.castShadow = true; scene.add(incline);

// flat apron lip that overlaps the roof edge so the seam is level & gap-free
const apron = new THREE.Mesh(
  new THREE.BoxGeometry(R.width, slabT, R.apronZ + 2),
  pbrMaterial(THREE, assets.roof, { repeat: [2, 2], roughness: 0.95, aniso })
);
apron.position.set(0, CONFIG.rooftopHeight + 0.6, (edgeZ - R.apronZ/2) * R.side);
apron.receiveShadow = true; scene.add(apron);

// two side curbs along the incline (low boxes, rotated like the deck)
for (const sx of [-1, 1]) {
  const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, R.curbH + 0.5, inclineLen), parapetMat);
  curb.rotation.x = -ang * R.side;
  curb.position.set(sx * (R.width/2 + 0.2), midY + 0.3, midZ * R.side);
  curb.castShadow = true; scene.add(curb);
}
```

### 1.3 Parapet gap (open the wall where the ramp meets the roof)

The current `+Z` parapet is one box `[0, …, half+2, towerFootprint, ph, pt]`. **Replace that single
+Z wall with two shorter segments** leaving a `R.width + 1` gap centered on X 0:

```
const gap = R.width + 1;                 // 9
const segW = (towerFootprint - gap) / 2; // (34 - 9)/2 = 12.5
for (const sx of [-1, 1]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(segW, ph, pt), parapetMat);
  wall.position.set(sx * (gap/2 + segW/2), roofY + 1.2 + ph/2, half + 2);
  wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
}
```

The other three parapet edges are unchanged.

### 1.4 World return additions

`buildWorld` returns extra fields so the surface-height function can be authored once from CONFIG
without re-reading meshes: nothing strictly needed at runtime (the height function below is analytic),
but expose `{ rampAng: ang, rampInclineLen: inclineLen }` for debug. The height function reads CONFIG only.

---

## 2. Surface-height function (where the cart's Y comes from)

A pure analytic `surfaceHeightAt(x, z) → { y, region, slopeDir }` keyed off CONFIG geometry.
Three regions: **on-roof** (clamped flat), **on-ramp** (interpolate down the incline), **on-ground** (free, y 0).
Lives as a method on Player (`_surfaceAt`) and is called every `update`. Zero allocation (returns into
a reused scratch object `this._surf = { y:0, region:0, grade:0 }`; region 0=ground,1=ramp,2=roof).

```
_surfaceAt(x, z) {
  const R = CONFIG.ramp;
  const half = CONFIG.rooftopSize / 2;          // 15
  const edgeZ = half + 2;                        // 17
  const roofTopY = CONFIG.rooftopHeight + 1.2;   // 9.2
  const s = R.side;                              // +1
  const zr = z * s;                              // ramp coord along its axis (so math is +Z)
  const onRampX = Math.abs(x) <= R.width / 2 + 0.1;
  const surf = this._surf;

  // --- ROOF: inside the slab footprint (incl. apron lip up to edgeZ) ---
  // roof is flat at roofTopY for the square footprint ±(half+2) MINUS the ramp mouth.
  const inFootprint = Math.abs(x) <= edgeZ && Math.abs(z) <= edgeZ;
  if (inFootprint && !(onRampX && zr > half - 1)) {
    // (interior of roof, away from the ramp mouth) → flat roof
    surf.y = roofTopY; surf.region = 2; surf.grade = 0; return surf;
  }

  // --- RAMP: within the lane in X, and Z between roof edge and foot ---
  const footZ = edgeZ + R.slopeRun;             // 39
  if (onRampX && zr >= half - 1 && zr <= footZ) {
    if (zr <= edgeZ) {                          // apron lip region: still flat at roof height
      surf.y = roofTopY; surf.region = 2; surf.grade = 0; return surf;
    }
    const t = (zr - edgeZ) / R.slopeRun;        // 0 at top .. 1 at foot
    surf.y = roofTopY * (1 - t);                // linear interpolate 9.2 → 0
    surf.region = 1;
    surf.grade = roofTopY / R.slopeRun;         // rise/run (used for pitch lean); positive = nose-down going out
    return surf;
  }

  // --- GROUND: everything else ---
  surf.y = 0; surf.region = 0; surf.grade = 0; return surf;
}
```

Notes / edge handling:
- The `half - 1` fudge makes the roof↔ramp handoff overlap by 1 unit so there is never a 1-frame
  hole at the seam; the apron lip keeps it flat through the seam.
- Off the side of the ramp (X beyond the lane) while Z is in the incline band = you've left the lane;
  the function returns **ground (y 0)**. The side curbs (1.2) physically block this, so practically the
  cart can't get there; if it ever does, it just sits on the street — acceptable.
- Y is applied with a **vertical follow damp** so transitions and the apron seam read as suspension travel,
  not teleport (see §3.4): `pos.y = damp(pos.y, surf.y, CONFIG.cartGroundFollow, dt)`. On a steep frame the
  damp also yields a tiny "drop off the lip" feel.

---

## 3. Arcade cart physics (rewrite of Player.update driving block)

Replaces the rooftop-only clamp logic. Keeps the existing `heading`/`speed`/`pos`/`_fwd` fields and the
wheel-spin + swing-animation code. Adds: reverse with its own cap, **speed-scaled steering**, **BOOST**,
**drift/grip lateral handling**, **suspension lean (roll) + pitch (from accel/brake AND ramp grade)**, and
the surface-height follow.

### 3.1 New Player state fields (constructor)

```
this.boostFuel = CONFIG.boostMax;     // seconds of boost available
this.boostActive = false;
this.boostCooldown = 0;               // lockout after depletion
this.lean = 0;                        // current visual roll (rad), damped
this.pitch = 0;                       // current visual pitch (rad), damped
this.bodyTilt = new THREE.Group();    // wrap chassis children so we can tilt the body w/o the wheels (see §3.5)
this.region = 2;                      // last surface region (2=roof)
this.health = CONFIG.cartHealth;      // cart hull integrity (separate from tower health)
this._lat = new THREE.Vector3();      // scratch: lateral (right) vector, no alloc
this._surf = { y: 0, region: 2, grade: 0 };
this.clawT = 0;                       // damage-flash timer for HUD feedback
```

### 3.2 Inputs consumed

`update(dt, drive)` where `drive = { throttle, steer, boost }` (boost is new — bool/0..1; see §8).

### 3.3 Longitudinal (throttle / reverse / boost / friction)

```
const throttle = drive.throttle || 0;
const steer = drive.steer || 0;

// boost gating
this.boostActive = false;
if (this.boostCooldown > 0) this.boostCooldown -= dt;
const wantBoost = drive.boost && throttle > 0 && this.boostFuel > 0 && this.boostCooldown <= 0;
if (wantBoost) {
  this.boostActive = true;
  this.boostFuel = Math.max(0, this.boostFuel - dt);
  if (this.boostFuel <= 0) this.boostCooldown = CONFIG.boostCooldown;   // forced lockout when empty
} else {
  this.boostFuel = Math.min(CONFIG.boostMax, this.boostFuel + CONFIG.boostRegen * dt);
}

const accel = CONFIG.cartAccel * (this.boostActive ? CONFIG.boostAccelMult : 1);
const maxFwd = CONFIG.cartMaxSpeed * (this.boostActive ? CONFIG.boostSpeedMult : 1);
if (throttle !== 0) this.speed += throttle * accel * dt;

// coast/brake friction (engine-braking heavier when reversing the input vs coasting)
const fr = CONFIG.cartFriction * dt;
if (this.speed > 0) this.speed = Math.max(0, this.speed - fr * (throttle <= 0 ? 1 : 0.2));
else if (this.speed < 0) this.speed = Math.min(0, this.speed + fr * (throttle >= 0 ? 1 : 0.2));
this.speed = clamp(this.speed, -CONFIG.cartReverseSpeed, maxFwd);
```

### 3.4 Steering (speed-scaled) + heading

Steering authority rises then **falls** at very high speed (twitchy at crawl is bad; floaty at top speed
reads as "fast"). Sign follows travel direction so reverse steers correctly (like a real cart).

```
const spAbs = Math.abs(this.speed);
// authority: 0 when stopped, ramps to 1 by ~3 u/s, eases off above cartTurnFalloff
const lowEnd = Math.min(1, spAbs / 3);
const hiEnd = 1 - clamp((spAbs - CONFIG.cartTurnFalloff) / CONFIG.cartMaxSpeed, 0, 0.55);
const turnAuth = lowEnd * hiEnd * Math.sign(this.speed || 1);
this.heading += steer * CONFIG.cartTurnRate * dt * turnAuth;

this._fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
```

### 3.5 Drift / lateral grip (the "feel")

Pure arcade: we don't keep a full velocity vector, but we add a cheap **lateral skid** so hard turns at
speed slide a touch then grip. Maintain `this.lateralVel` (scalar along the cart's right axis), bleed it
each frame, and inject a fraction of the turn into it.

```
this._lat.set(Math.cos(this.heading), 0, -Math.sin(this.heading)); // cart right vector
// inject skid proportional to turn rate * speed, scaled down so it's subtle
const skid = steer * turnAuth * spAbs * CONFIG.cartDriftGain;
this.lateralVel = (this.lateralVel || 0) + skid * dt;
this.lateralVel *= Math.max(0, 1 - CONFIG.cartGrip * dt);  // grip bleeds it back to 0

// integrate position: forward + lateral skid
this.pos.x += (this._fwd.x * this.speed + this._lat.x * this.lateralVel) * dt;
this.pos.z += (this._fwd.z * this.speed + this._lat.z * this.lateralVel) * dt;
```

### 3.6 Collide with world bounds (replaces the rooftop-only clamp)

There is no hard playfield clamp on the street anymore — the cart roams the lot. We only:
- clamp inside the **roof footprint** when on the roof (so you can't drive through the 3 closed parapets),
  leaving the ramp mouth (+Z gap) open;
- clamp to a generous outer ring on the ground so you never drive to the skybox: `groundPlayRadius` (e.g. 150);
- keep the cart out of the tower **walls** on the ground (it's a solid 34×34 block from y0..9.2): a simple
  axis box reject when on ground and `region === 0` and inside footprint± a margin — push the cart out to the
  nearest face. Practically only matters near the base; cheap AABB push:

```
const surf = this._surfaceAt(this.pos.x, this.pos.z);

if (surf.region === 2) {
  // ON ROOF: clamp to footprint minus parapet thickness, but allow the ramp gap on +Z
  const lim = (CONFIG.rooftopSize/2 + 2) - 0.9;           // 16.1
  if (this.pos.x > lim || this.pos.x < -lim) { this.pos.x = clamp(this.pos.x, -lim, lim); this.speed *= 0.4; this.lateralVel = 0; }
  const inGap = Math.abs(this.pos.x) <= CONFIG.ramp.width/2;
  const zLim = lim * CONFIG.ramp.side;                    // the +Z edge that has the gap
  if (CONFIG.ramp.side > 0) { if (this.pos.z < -lim) { this.pos.z = -lim; this.speed *= 0.4; }
                              if (!inGap && this.pos.z > lim) { this.pos.z = lim; this.speed *= 0.4; } }
  // (mirror for ramp.side<0)
} else if (surf.region === 0) {
  // ON GROUND: reject the tower base AABB (34×34 centered at origin)
  const tb = CONFIG.rooftopSize/2 + 2 + 1.5;              // base half + cart margin = 18.5
  if (Math.abs(this.pos.x) < tb && Math.abs(this.pos.z) < tb) {
    // push out along the smaller penetration axis
    const px = tb - Math.abs(this.pos.x), pz = tb - Math.abs(this.pos.z);
    if (px < pz) this.pos.x = Math.sign(this.pos.x || 1) * tb; else this.pos.z = Math.sign(this.pos.z || 1) * tb;
    this.speed *= 0.5; this.lateralVel = 0;
  }
  // outer world ring
  const r2 = this.pos.x*this.pos.x + this.pos.z*this.pos.z, R = CONFIG.groundPlayRadius;
  if (r2 > R*R) { const inv = R / Math.sqrt(r2); this.pos.x *= inv; this.pos.z *= inv; this.speed *= 0.5; }
}
// NOTE: the ramp mouth on +Z is NOT rejected when region===0/1, so you flow down it.
```

### 3.7 Vertical follow (apply surface height)

```
const surfY = this._surfaceAt(this.pos.x, this.pos.z).y;
this.pos.y = damp(this.pos.y, surfY, CONFIG.cartGroundFollow, dt);
this.region = this._surf.region;
this.root.position.copy(this.pos);
this.root.rotation.y = this.heading;
```

### 3.8 Suspension lean (roll) + pitch — visual only

Body tilt is applied to a **`bodyTilt` group** that wraps the chassis/canopy/seat/golfer meshes but NOT the
wheels (wheels stay flat on the surface). Restructure the constructor so those meshes are added to
`this.bodyTilt` (added to `root`); wheels and the ramp-grade pitch go on `root` directly.

```
// target roll from cornering (lean OUT of the turn) + lateral skid
const rollTgt = clamp(-steer * turnAuth * spAbs * CONFIG.cartLeanGain
                      - this.lateralVel * CONFIG.cartSkidLean, -CONFIG.cartLeanMax, CONFIG.cartLeanMax);
// target pitch from accel/brake (squat/dive) + ramp grade
const accelPitch = -clamp((this.speed - (this._prevSpeed||0)) / dt, -40, 40) * CONFIG.cartPitchGain;
const gradePitch = this._surf.region === 1 ? Math.atan2(CONFIG.rooftopHeight + 1.2, CONFIG.ramp.slopeRun) * CONFIG.ramp.side : 0;
this._prevSpeed = this.speed;
this.lean  = damp(this.lean,  rollTgt, CONFIG.cartTiltDamp, dt);
this.pitch = damp(this.pitch, accelPitch, CONFIG.cartTiltDamp, dt);
this.bodyTilt.rotation.z = this.lean;
this.bodyTilt.rotation.x = this.pitch;
this.root.rotation.x = gradePitch;   // whole cart follows the ramp slope (wheels included)
```

`damp(a, b, lambda, dt)` is the existing `utils.js` exponential smoother.

### 3.9 Wheel spin/steer (unchanged, plus boost-blur optional)

Keep the existing wheel spin + front-wheel-steer block. Spin scales with `this.speed`. (Optional: when
`boostActive`, emit a `effects.dust`/exhaust burst behind the cart — see §6.)

---

## 4. Run-over carnage (cart-vs-zombie)

A new `Player` (or a thin `Vehicle` helper called from Player) collision pass runs **after** the cart's
position is finalized for the frame, every step. It is driven from `main.js` step order or, cleaner, from a
new `player.runOverPass(dt)` called right after `player.update` in `Game.step`. It only runs on the **street**
(when `this.region === 0`, plus the lower portion of the ramp) — on the roof there are no zombies.

### 4.1 Broadphase + gate

```
// in Player.runOverPass(dt), needs ctx -> store this.ctx = ctx in constructor (pass ctx to Player)
if (this.region === 2) return;                 // on the roof, nothing to hit
const z = this.ctx.zombies;
const spAbs = Math.abs(this.speed);
if (spAbs < CONFIG.runOverMinSpeed) return;    // must be moving to plow

const rr = CONFIG.zombieRadius + CONFIG.cartHitRadius;   // ~ 1.8 + 2.2 = 4.0
const rr2 = rr * rr;
// cart "nose" point = a bit forward of pos so you hit with the front
const nx = this.pos.x + this._fwd.x * CONFIG.cartNoseOffset;
const nz = this.pos.z + this._fwd.z * CONFIG.cartNoseOffset;
```

Loop `z.z[]` (the per-zombie array). Broadphase by squared distance from the nose point. Skip zombies that
are `!alive`, already `dying`, or under their per-zombie run-over i-frame (`z.hitT > 0`, see §4.3).

```
for (const zz of z.z) {
  if (!zz.alive || zz.dying) continue;
  if (zz.hitT > 0) { zz.hitT -= dt; continue; }     // i-frame ticking; can't be hit again yet
  const dx = nx - zz.x, dz = nz - zz.zz;
  const d2 = dx*dx + dz*dz;
  if (d2 >= rr2) continue;
  // confirm it's roughly in FRONT (dot with forward) so you don't vacuum zombies behind you
  if (dx * this._fwd.x + dz * this._fwd.z < -1.0) continue;
  // HIT:
  this._runOver(zz, dx, dz, spAbs, dt);
}
```

### 4.2 Impulse math

Impulse magnitude scales with current speed, boosted, with a floor so even a slow nudge tosses them a little.
Direction = blend of **cart forward** (plow forward) and the **radial push** from cart→zombie (so glancing
hits fling sideways). Vertical lift scales with speed so fast hits launch them up and over.

```
_runOver(zz, dx, dz, spAbs, dt) {
  const boost = this.boostActive ? CONFIG.runOverBoostMult : 1;
  // 0..1 over the speed band, eased
  const sp01 = clamp((spAbs - CONFIG.runOverMinSpeed) / (CONFIG.cartMaxSpeed - CONFIG.runOverMinSpeed), 0, 1);
  const mag = (CONFIG.runOverImpulseMin + sp01 * (CONFIG.runOverImpulseMax - CONFIG.runOverImpulseMin)) * boost;

  // direction: mostly forward, partly radial-from-nose
  const dl = Math.hypot(dx, dz) || 1;
  const rxn = dx / dl, rzn = dz / dl;                 // radial (cart→zombie)
  const mixF = CONFIG.runOverForwardMix;              // ~0.7 forward, 0.3 radial
  let ix = (this._fwd.x * mixF + rxn * (1 - mixF));
  let iz = (this._fwd.z * mixF + rzn * (1 - mixF));
  const il = Math.hypot(ix, iz) || 1; ix /= il; iz /= il;

  const lift = CONFIG.runOverLiftBase + sp01 * CONFIG.runOverLiftSpeed; // upward component
  // hand to zombies as a launch impulse (vx, vy, vz) — see §5 runOver signature
  this.ctx.zombies.runOver(zz, ix * mag, lift * boost, iz * mag);

  // feedback
  this.ctx.effects.blood(zz.x, 2.0, zz.zz, mag);      // new blood burst (§6)
  this.ctx.audio.thud ? this.ctx.audio.thud(sp01) : this.ctx.audio.hit();
  this.ctx.game.onRunOver(sp01, this.boostActive);    // score + screenshake (§7)

  // the cart bleeds a little speed per body (heavier bodies slow you; boost ignores most of it)
  this.speed *= (this.boostActive ? CONFIG.runOverDragBoost : CONFIG.runOverDrag);
  zz.hitT = CONFIG.runOverIFrame;                     // can't re-hit this zombie for a moment
}
```

### 4.3 Per-zombie i-frames

Add `hitT: 0` to each zombie slot object in `Zombies` constructor (alongside `deathT` etc.) and reset it in
`reset()`/`_spawnOne()`. The cart sets `zz.hitT = CONFIG.runOverIFrame` on contact; it decrements in the
run-over pass (above) AND should also be decremented harmlessly in `Zombies.update` so it ticks even when the
cart is far (so a tossed-but-not-killed zombie isn't permanently immune). i-frames mean one body isn't hit 60×
in the frames it's under the bumper. A run-over does **not** necessarily kill instantly (see §5): if it
survives the tumble it can get up — but most should die from `runOver` directly when `mag` is high.

---

## 5. Zombies API additions (`runOver` + ragdoll launch)

`zombies.js` currently kills with a fixed topple animation (`kill(z)` → `dying`, then `update` lerps a fall).
We add `runOver(z, vx, vy, vz)` that launches the zombie as a **ballistic ragdoll** rather than the canned
topple, then dies. This is forward-compatible with the planned articulated-ragdoll spec (`zombies.md`): if
that lands, `runOver` instead seeds per-limb velocities; until then we do a single rigid-body tumble.

### 5.1 Rigid-body fallback (works with the CURRENT single-InstancedMesh zombie)

Add launch state to each slot: `vx, vy, vz` (m/s) and a spin axis/rate; reuse `dying`/`deathT` but extend the
death duration and integrate position instead of just rotating in place.

```
// new fields per slot: rvx, rvy, rvz (ragdoll vel), rspin, ry (current y), rrot (tumble angle)
runOver(z, vx, vy, vz) {
  if (!z.alive && !z.dying) return;
  z.alive = false; z.dying = true; z.ragdoll = true; z.deathT = 0;
  z.rvx = vx; z.rvy = vy; z.rvz = vz;
  z.ry = 1.4;                                  // start at body center height
  z.rrot = 0;
  z.rspin = (this.rng() - 0.5) * 8 + Math.hypot(vx, vz) * 0.15;  // tumble rate from speed
  z.raxis = this.rng() < 0.5 ? 0 : 1;          // tumble about X or Z for variety
}
```

In `update`, branch on `z.ragdoll` inside the `z.dying` block:

```
else if (z.dying) {
  z.deathT += dt;
  if (z.ragdoll) {
    // ballistic integrate (reuses CONFIG.gravity)
    z.rvy -= CONFIG.gravity * dt;
    z.x  += z.rvx * dt;
    z.zz += z.rvz * dt;
    z.ry += z.rvy * dt;
    if (z.ry <= 0.3) {                         // hit the ground → bounce + bleed, settle
      z.ry = 0.3;
      z.rvy = -z.rvy * 0.32;
      z.rvx *= 0.5; z.rvz *= 0.5; z.rspin *= 0.5;
      if (Math.abs(z.rvy) < 1.5) z.rvy = 0;
      this.ctx.effects.blood(z.x, 0.3, z.zz, 6);   // skid splat
    }
    z.rrot += z.rspin * dt;
    const t = z.deathT / CONFIG.ragdollLife;   // ~1.6s then despawn
    if (t >= 1) { z.dying = false; z.ragdoll = false; this.mesh.setMatrixAt(i, this._hidden); }
    else {
      const sc = 1 - Math.max(0, t - 0.7) * 0.5;  // shrink only in the last 30%
      this._p.set(z.x, z.ry, z.zz);
      if (z.raxis === 0) this._e.set(z.rrot, z.yaw, 0); else this._e.set(0, z.yaw, z.rrot);
      this._q.setFromEuler(this._e);
      this._s.set(sc, sc, sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
  } else {
    /* existing canned topple (from golf-ball kills) unchanged */
  }
}
```

> If the articulated zombie spec is adopted, `runOver` should instead call its `_ragdollize(z, impulse)` and
> distribute `(vx,vy,vz)` + an angular impulse across the limb instances; the rigid path above is the interim.

### 5.2 Scoring hook from runOver vs kill

`runOver` does **not** call `addScore` itself (keeps Zombies decoupled from scoring, matching how `kill`/
`damageArea` already let `golf.js` award points). The Player awards the run-over score via
`ctx.game.onRunOver(...)` (§7). When a ragdoll's flight intersects OTHER zombies you may chain a kill —
optional stretch: in the ragdoll bounce, do a cheap `damageArea(this._p, 2.0)` once on first ground hit to
mow a small group (a "bowling" combo). Gate behind `CONFIG.runOverBowling`.

---

## 6. Effects additions (blood + boost exhaust)

Add to `effects.js` (pooled `_emit`, zero alloc — same as existing `hit`/`greenPuff`):

```
blood(x, y, z, mag) {
  const n = Math.min(28, 8 + Math.floor(mag));
  this._emit(x, y, z, n, { r: 0.55, g: 0.06, b: 0.05, speed: 8 + mag * 0.4, spread: 1, life: 0.6, gravity: 22, up: 3 });
  this._emit(x, y, z, Math.floor(n/2), { r: 0.30, g: 0.45, b: 0.15, speed: 6, spread: 1, life: 0.7, gravity: 14, up: 2 }); // green gore mix
}
exhaust(x, y, z) {   // boost trail behind the cart
  this._emit(x, y, z, 3, { r: 0.6, g: 0.6, b: 0.65, speed: 5, spread: 1, life: 0.4, gravity: -2, up: 0.5 });
}
```

Player calls `effects.exhaust` behind the cart each step while `boostActive` (at `pos - fwd*2`, y `0.6`).

Blood uses a warm-dark red + a green-gore secondary to match the zombie palette (`col.zombieSkin`).

---

## 7. Scoring, screenshake, cart damage feedback (main.js / hud.js)

### 7.1 Screenshake (new, lives in main.js camera section)

There is currently no shake. Add a tiny **trauma** accumulator on `Game` consumed in the `frame()` camera
block AFTER `ctx.golf.updateCamera(...)`:

```
// Game fields
this.shake = 0;                     // 0..1 trauma
addShake(a) { this.shake = Math.min(1, this.shake + a); }

// in frame(), after updateCamera:
if (game.shake > 0) {
  const s = game.shake * game.shake * CONFIG.shakeMax;     // quadratic falloff feels better
  camera.position.x += (Math.random()*2-1) * s;
  camera.position.y += (Math.random()*2-1) * s;
  camera.position.z += (Math.random()*2-1) * s;
  game.shake = Math.max(0, game.shake - CONFIG.shakeDecay * dtSec);
}
```

(Shake is applied post-lerp so it doesn't fight the smoothing; reset to 0 on state change.)

### 7.2 `Game.onRunOver(sp01, boosted)`

```
onRunOver(sp01, boosted) {
  const pts = CONFIG.scoreRunOver + Math.round(sp01 * CONFIG.scoreRunOverSpeedBonus);
  this.addScore(pts, false);
  this.roadkill = (this.roadkill || 0) + 1;
  // chain toast every few in quick succession
  this._roadkillT = CONFIG.roadkillWindow;
  if (this.roadkill >= 3) hud.toast(`ROADKILL x${this.roadkill}`, '#ff5a3a');
  this.addShake(CONFIG.shakeRunOver * (0.5 + sp01) * (boosted ? 1.3 : 1));
}
```

Tick `_roadkillT` down in `step`; when it expires reset `this.roadkill = 0`.

### 7.3 Cart / player damage from clawing zombies (RISK on the street)

The existing model: zombies at the perimeter damage the **tower** (`damageTower`). When the player is on the
**street near zombies**, they should also claw the **cart**. We add a second damage path so venturing down is
risky.

Driven from `Zombies.update` (it already loops every zombie and knows positions). After the existing
perimeter-attack accumulation, add a cart-proximity check using the player's ground pos — only when the
player is on the street (`ctx.player.region === 0` or `1`):

```
// inside Zombies.update, after computing attacking count:
const pl = this.ctx.player;
if (pl.region !== 2) {
  const cr = CONFIG.cartClawRadius, cr2 = cr*cr;
  let clawing = 0;
  for (const z of this.z) {
    if (!z.alive) continue;
    const dx = z.x - pl.pos.x, dz = z.zz - pl.pos.z;
    if (dx*dx + dz*dz < cr2) clawing++;
  }
  if (clawing > 0) {
    pl.health -= clawing * CONFIG.cartClawDamage * dt;
    pl.clawT = 0.25;                          // HUD red-flash window
    this.ctx.game.addShake(CONFIG.shakeClaw * dt * clawing);
    if (pl.health <= 0) { pl.health = 0; this.ctx.game.gameOver(); }   // cart destroyed = run over
    if (Math.random() < dt * 4) this.ctx.audio.hit();
  }
}
```

- Cart health is separate from tower health (`CONFIG.cartHealth`, e.g. 100). Both reaching 0 ends the run:
  tower at 0 = "OVERRUN" (existing); cart at 0 = "TORN APART" (add a `STR` line + pass a reason to
  `gameOver(reason)`; minimal change is to reuse the existing over screen).
- **Feedback**: `pl.clawT` drives a red damage **vignette/flash** on the HUD. The HUD already has a
  `#vignette` element — pulse a red overlay via a CSS class while `clawT > 0` (decrement in Player.update).
  Add `damage:` field to `snapshot()` and toggle a `.hurt` class on `#vignette` in `hud.update`.
- The cart can also **heal**: the `health` pickup currently heals the tower. Decide design: simplest is the
  health pack heals BOTH (`heal()` tops up tower AND cart). Keep tower as the primary loss condition; cart
  health regenerates slowly when away from zombies (`CONFIG.cartHealthRegen`) so a quick dash down isn't a
  death sentence — regenerate in Player.update when `region===0 && no clawing this frame`.

This makes the loop: **roof = safe golf vantage; street = high-risk, high-reward carnage.**

---

## 8. Input additions

### 8.1 Boost

- **Keyboard**: `ShiftLeft` (hold) → boost. Add `ShiftLeft` to the prevent-default set is unnecessary; just
  read it. In `Input.update`, set `this.drive.boost = this.held.has('ShiftLeft')`.
- **Gamepad**: right trigger is already charge/fire. Use the **right bumper RB (button 5)** or left trigger
  (button 6) for boost: `this.drive.boost ||= gp.buttons[6]?.pressed` (LT analog) in `_gamepad`.
- **Touch**: add a small "BOOST" button near the drive pad (new `.ui-btn` in index.html) wired like the
  SWING button: `input.touchBoost(down)` sets a sticky `this._touchBoost` flag merged into `drive.boost`.

`drive` object gains a `boost` field initialized `false`; merge all sources (`|| this._touchBoost || padBoost`).

### 8.2 "To-roof" helper (recover / flip-back)

Optional quality-of-life: a key (`KeyR`) that, when **stopped on the street near the ramp foot**, gives a
small assist, OR more simply a **respawn-to-roof** if stuck: set `player.pos` to the roof spawn and zero
velocity. Wire as `handlers.toRoof` in input → `Game` → `ctx.player.returnToRoof()`:

```
// Player
returnToRoof() {
  this.pos.set(0, this.roofTop, CONFIG.rooftopSize * 0.28);
  this.heading = Math.PI; this.speed = 0; this.lateralVel = 0;
  this.lean = this.pitch = 0; this.region = 2;
}
```

Gate it so it's not a free escape mid-swarm: only allow when `health > 0` and maybe with a short cooldown,
or only when `aliveCount` near the cart is 0. Bind in `_key` (`if (down && e.code === 'KeyR') handlers.toRoof?.()`),
gamepad `Y` (button 3), and a touch button if desired. Update `STR.ctrlDrive*` lines to mention boost (Shift)
and recover (R).

---

## 9. Camera changes (golf.js `updateCamera`)

Today the camera assumes the **rooftop perch**: it sits `camHeight (15)` above `shootOrigin` and looks out +
down at the street with `camLookDrop`. On the street that framing buries the camera in the ground / looks at
the cart's feet. Make the chase **adapt to surface height** with smooth blends keyed off the player's region
and `pos.y` — no hard switch.

### 9.1 Blend factor

Compute a `ground01 = clamp(1 - player.pos.y / (rooftopHeight+1.2), 0, 1)` (0 = on roof, 1 = on street),
smoothed. Use it to interpolate the camera rig parameters:

```
// in updateCamera(camera, dt)
const o = this.ctx.player.shootOrigin;
const roofY = CONFIG.rooftopHeight + 1.2;
this._g = damp(this._g || 0, clamp(1 - this.ctx.player.pos.y / roofY, 0, 1), 6, dt);  // 0 roof .. 1 street
const g = this._g;

const dist   = lerp(CONFIG.camDistance,  CONFIG.camDistanceGround, g);   // pull in a bit on the ground
const height = lerp(CONFIG.camHeight,    CONFIG.camHeightGround,   g);    // much lower over the street
const lookDrop = lerp(CONFIG.camLookDrop, CONFIG.camLookDropGround, g);   // ~0 on the ground (look level)
const ahead    = lerp(CONFIG.camLookAhead, CONFIG.camLookAheadGround, g);
```

### 9.2 Behind aim vs behind travel

On the roof the camera frames the **aim yaw** (you're a golfer picking a target). On the street, framing the
**travel heading** reads better for driving but you still need to aim. Compromise: keep framing **aim yaw**
(so shooting from the cart anywhere still works — requirement #6) but on the ground reduce the steep-pitch
drop term and lower the rig so the horizon and oncoming zombies are visible. The existing steep-pitch terms
(`steep * 5`, `steep * 26`) get multiplied by `(1 - g*0.6)` so aiming straight down on the street doesn't
slam the camera into the asphalt.

```
const hx = Math.sin(this.aimYaw), hz = Math.cos(this.aimYaw);
const steep = -this.aimPitch;
this._camPos.set(
  o.x - hx * dist,
  o.y + height + steep * 5 * (1 - g * 0.6),
  o.z - hz * dist
);
const a = 1 - Math.exp(-CONFIG.camLerp * dt);
camera.position.lerp(this._camPos, a);
// never let the camera sink below the surface near the cart
camera.position.y = Math.max(camera.position.y, this.ctx.player.pos.y + CONFIG.camMinAbove);
const drop = lookDrop + steep * 26 * (1 - g * 0.6);
this._camTgt.set(o.x + hx * ahead, o.y - drop, o.z + hz * ahead);
camera.lookAt(this._camTgt);
```

`camMinAbove` (e.g. 2.5) clamps the camera above the cart so the street view never clips through ground.
`shootOrigin` already tracks `pos.y` (it's `pos.y + 3`), so the whole rig naturally rides down the ramp with
the cart — only the *shape* of the rig changes via `g`.

### 9.3 Result

Driving down the ramp: `pos.y` falls 9.2→0, `g` eases 0→1, the rig lowers and flattens, the look-drop relaxes
to near-level — you transition from "bird's-eye golf vantage" to "behind-the-cart carnage cam" with **no mode
switch**, purely from `pos.y`. Driving back up reverses it.

---

## 10. Shooting from the cart anywhere (requirement #6)

No change to firing logic is required: `golf.fire` already uses `ctx.player.shootOrigin`, which is
`pos + (0,3,0)` and now rides at street level when you're down the ramp. The trajectory preview, landing
ring, and ball physics already key off ground `y = ballRadius`, so balls launched from the street behave
correctly (shorter falls, flatter shots). The only consideration: when on the street, the **golfer model**
is at street level firing into the horde at near-eye level — purely cosmetic, works as-is. Keep
`pitchDefault` as is.

---

## 11. CONFIG additions (all numbers in one place)

```
// ---- Cart / driving (extend existing block) ----
cartAccel: 34,              // was 30 — a touch punchier for ground
cartMaxSpeed: 22,           // was 19
cartReverseSpeed: 9,        // reverse cap
cartTurnRate: 2.6,          // rad/sec (was 2.5)
cartTurnFalloff: 12,        // speed above which steering authority eases off
cartFriction: 3.0,
cartDriftGain: 0.020,       // how much hard turns inject lateral skid
cartGrip: 6.0,              // lateral skid bleed-off per sec (higher = grippier)
cartGroundFollow: 14,       // vertical surface-follow damp lambda (suspension feel)

// boost
boostMax: 2.2,              // seconds of boost
boostRegen: 0.5,            // sec of fuel regained per real sec
boostAccelMult: 1.9,
boostSpeedMult: 1.55,       // top speed while boosting
boostCooldown: 1.2,         // lockout after fully draining

// suspension / tilt (visual)
cartLeanGain: 0.010,        // corner roll per (turn*speed)
cartSkidLean: 0.05,         // extra roll from lateral skid
cartLeanMax: 0.22,          // rad cap
cartPitchGain: 0.004,       // squat/dive per accel
cartTiltDamp: 9,            // tilt smoothing lambda

// ramp
ramp: { width: 8, slopeRise: 9.2, slopeRun: 22, apronZ: 4, side: 1, curbH: 0.35 },
groundPlayRadius: 150,      // outer drive limit on the street

// run-over
cartHitRadius: 2.2,         // cart bumper collision radius
cartNoseOffset: 2.6,        // forward offset of the hit point from cart center
runOverMinSpeed: 4,         // below this you just bump (no launch)
runOverImpulseMin: 10,      // launch speed at min run-over speed
runOverImpulseMax: 30,      // launch speed at top speed
runOverBoostMult: 1.6,      // impulse multiplier while boosting
runOverForwardMix: 0.7,     // 70% forward / 30% radial launch direction
runOverLiftBase: 4,         // base upward launch
runOverLiftSpeed: 8,        // extra upward launch at top speed
runOverDrag: 0.92,          // cart speed retained per body hit (coasting)
runOverDragBoost: 0.97,     // retained per body while boosting (plows through)
runOverIFrame: 0.4,         // sec a zombie can't be re-hit by the cart
ragdollLife: 1.6,           // sec a run-over ragdoll lives before despawn
runOverBowling: true,       // ragdoll first-ground-hit damages nearby zombies

// scoring (run-over)
scoreRunOver: 12,           // base points per roadkill
scoreRunOverSpeedBonus: 10, // + up to this at top speed
roadkillWindow: 1.5,        // sec to chain the ROADKILL combo toast

// screenshake
shakeMax: 0.9,              // max camera offset (world units) at trauma=1
shakeDecay: 2.2,            // trauma units shed per sec
shakeRunOver: 0.28,         // trauma added per roadkill
shakeClaw: 0.6,             // trauma/sec scaling while being clawed

// cart health / risk
cartHealth: 100,
cartClawRadius: 5.0,        // zombies within this of the cart claw it
cartClawDamage: 9.0,        // dmg/sec per clawing zombie (vs tower's 4/sec — street is riskier)
cartHealthRegen: 6.0,       // cart hull regenerates this/sec when clear of zombies

// camera (ground variants — extend existing camera block)
camDistanceGround: 11,
camHeightGround: 5.5,
camLookDropGround: 1.5,
camLookAheadGround: 16,
camMinAbove: 2.5,           // keep camera at least this far above the cart
```

---

## 12. Integration & step order (main.js)

`Game.step(dt)` order becomes:

```
input.update(dt);
ctx.golf.addAim(input.aim.dyaw, input.aim.dpitch);
ctx.player.update(dt, input.drive);      // drive now includes .boost; sets region, pos.y via surface fn
ctx.player.runOverPass(dt);              // NEW: cart-vs-zombie launch + cart speed bleed
ctx.golf.update(dt, true);
ctx.zombies.update(dt);                  // now also does cart-claw damage + ragdoll integration + hitT tick
ctx.powerups.update(dt);
ctx.effects.update(dt);
// ammo regen, wave timer (unchanged)
// tick this._roadkillT; reset roadkill combo when it expires
```

- **Player needs `ctx`**: change `new Player(scene)` → `new Player(scene, ctx)` and store `this.ctx = ctx`
  (so `runOverPass` can reach `zombies`/`effects`/`audio`/`game`). `ctx.player` is created before
  `ctx.zombies`; that's fine because `runOverPass` reads `this.ctx.zombies` lazily at call time.
- **Zombies needs player**: it already has `ctx`; reads `ctx.player.pos`/`.region` lazily in `update`.
- **`_reset`**: also reset `ctx.player.health = CONFIG.cartHealth`, `boostFuel`, `lateralVel`, `lean/pitch`,
  `region = 2`, and `game.shake = 0`, `game.roadkill = 0`.
- **`snapshot()`**: add `cartHealth: ctx.player.health`, `boost: ctx.player.boostFuel / CONFIG.boostMax`,
  `damage: ctx.player.clawT > 0` for the HUD.

### State read/written
- **Reads** from Game/ctx: `ctx.zombies.z[]` (positions, alive/dying/hitT), `ctx.player.pos/region/heading/speed`,
  `input.drive.{throttle,steer,boost}`, `game.armed/ammo` (unchanged firing).
- **Writes**: `ctx.player.{pos.y, region, health, speed, lateralVel, lean, pitch, boostFuel, clawT}`,
  zombie slot `{dying, ragdoll, rvx/rvy/rvz, ry, rrot, rspin, hitT}`, `game.{score, shake, roadkill, health}`,
  pooled `effects` particles, camera transform.

---

## 13. HUD additions (hud.js / index.html)

- **Boost meter**: a small bar near the ammo/power readout fed by `s.boost` (0..1); dim when on cooldown
  (`boostFuel <= 0`). Mirror the existing power-bar DOM pattern.
- **Cart health**: a second thin bar (or a "CART" readout) next to the existing "TOWER" bar, fed by
  `s.cartHealth / CONFIG.cartHealth`; same green→amber→red gradient logic.
- **Damage vignette**: toggle `#vignette.hurt` (a red radial pulse via CSS keyframe) while `s.damage` is true.
- **STR additions**: `hudCart: 'CART'`, `hudBoost: 'BOOST'`, control-line edits mentioning Shift (boost) and
  R (return to roof). New game-over reason string optional (`gameOverCart: 'Torn apart on the street.'`).

---

## 14. Risks / gotchas

- **Zero-alloc discipline**: the run-over loop, surface fn, and tilt math must reuse `this._fwd`, `this._lat`,
  `this._surf` and scalars only — no `new Vector3` per frame. The blood/exhaust calls go through the existing
  pooled `_emit`. Verified: no allocations introduced in `step`.
- **Ramp seam popping**: handled by the apron lip + the 1-unit roof/ramp overlap + the `cartGroundFollow`
  damp. If the cart visibly "floats" over the seam, raise `cartGroundFollow` (snappier) or widen `apronZ`.
- **Camera clipping the street**: `camMinAbove` clamp + the `g`-blended low rig prevent the bird's-eye terms
  from driving the camera underground when aiming down at street level.
- **Run-over vacuuming**: the forward-dot gate (`< -1.0` reject) plus `cartNoseOffset` keep hits to the front
  arc; without it, reversing through a crowd would mow zombies behind you.
- **Cart as a free turret on the street**: cart-claw damage (`cartClawDamage 9/sec`, higher than the tower's
  4/sec) + the lack of a parapet means parking in the horde is lethal — keeps the street risky as intended.
  Tune `cartClawRadius`/`cartClawDamage` if the street feels too safe or too punishing.
- **Two loss conditions**: tower-fell and cart-destroyed both call `gameOver`. Ensure `gameOver` is idempotent
  (it already early-returns if `state === 'over'`). The cart-destroyed path passes through the existing screen.
- **Ragdoll forward-compat**: when the articulated-zombie spec lands, swap `runOver`'s rigid integrator for the
  per-limb impulse seeding; the Player-side call signature `runOver(z, vx, vy, vz)` is designed to stay stable.
- **Surge waves on the street**: with `zombieMaxAlive 70`, a surge near the ramp foot can swarm the cart fast.
  The `returnToRoof` recover key (gated) is the escape valve; tune its gate so it isn't a free panic button.
- **Performance**: run-over broadphase is O(aliveZombies) once per step (≤70), trivial. Ragdolls reuse the
  existing single InstancedMesh write path — no new draw calls. Ramp adds ~4 static meshes (1–4 draw calls).
