# GOLF Z — Realistic Golf-Physics Overhaul

Spec for reworking `public/js/golf.js` + `public/js/config.js` (+ small hooks in
`input.js`, `main.js`, `hud.js`, `index.html`, `strings.js`).

Adds: **spin** (back/top/side via a Magnus force), **selectable clubs** (Driver /
9-Iron / Wedge), **wind** (slowly varying vector, HUD arrow), **spin- &
surface-aware bounce + roll**, and a **trajectory preview that simulates the
exact same forces** so it stays accurate.

Hard constraints honored throughout: client-side only, fixed 60 Hz step,
**zero allocations inside per-frame / per-preview-sample loops** (every vector
is a reused scratch on `this`), pooling preserved, draw calls unchanged
(1 trajectory Line + 1 marker Ring + the existing ball pool).

World scale recap (FROZEN): street `y=0`, rooftop perch ≈ `y 9.2`
(`shootOrigin = pos.y+3`), perimeter radius 38, spawn ring 96,
`gravity 24`, launch `16..52`, `ballRadius 0.95`.

---

## 1. Physics model

### 1.1 Forces per ball, per step

Acceleration is the sum of gravity, quadratic air drag (relative to the air,
i.e. wind-relative velocity), and the Magnus force from spin:

```
vRel   = vel - wind                       // ball velocity relative to moving air
speed  = |vRel|
aDrag  = -dragCoef * speed * vRel         // quadratic drag opposes air-relative motion
aMagnus=  kMagnus  * (spin × vRel)        // lift/curve; ⟂ to both spin axis and vRel
aGrav  =  (0, -gravity, 0)
a      =  aDrag + aMagnus + aGrav
vel   += a * dt
pos   += vel * dt
spin  *= (1 - spinDecay * dt)             // spin bleeds off in flight
```

`spin` is an **angular-velocity-like vector (rad/s-ish, game-tuned)** stored per
ball. The cross product `spin × vRel` gives the classic Magnus direction:

- **Backspin** → spin axis points *left* (perpendicular to the shot, horizontal).
  `spin × vRel` then points *up & back* → more lift (carry) + slight drag-back.
- **Topspin** → spin axis points *right* → Magnus points *down* → flatter, dives,
  longer roll.
- **Sidespin** → spin axis points *up/down (±Y)* → Magnus is horizontal → the
  ball curves left/right (draw/fade / slice/hook).

We build `spin` from three scalars chosen by club + player input
(`backspin`, in rad/s, signed: + = back, − = top; and `sidespin`, signed:
+ = curves right). The axis is constructed from the **aim basis** at fire time:

```
fwd   = aimVec(aimYaw, aimPitch)                  // unit launch direction
right = normalize( fwd × up )                     // up = (0,1,0); horizontal-ish right
// backspin axis is -right (so Magnus = spin×v points up for +backspin)
spin  =  right * (-backspinRPS)  +  up * (sidespinRPS)
```

> Using the launch `right` vector (not world X/Z) means backspin lifts along the
> shot plane and sidespin curves relative to the aim, exactly like real golf.

### 1.2 Why the cross product is correct & cheap

`spin × vRel` is computed once per step with `THREE.Vector3.crossVectors` into a
scratch vector — no allocation. Magnitude scales with both spin and speed, so a
hard-hit wedge with heavy backspin balloons and floats; a dying ball barely
curves. Spin decays (`spinDecay`) so late flight flattens out naturally.

### 1.3 Tuned constants (final numbers, world-scale calibrated)

Calibrated so a Driver at full power (`launch 52`) carries ≈ 150–190 world units
with a flat penetrating arc, a 9-Iron lands ≈ 70–110 with a clean stop, and a
Wedge lobs ≈ 30–55 and **stops dead or hops back**. These reach the perimeter
(38) and well across the lot, matching the existing camera framing.

```
gravity     : 24      (UNCHANGED)
dragCoef    : 0.0016  (UNCHANGED base; per-club multiplier below)
kMagnus     : 0.0042  // Magnus coefficient: a*(spin×v). With spin~6 & v~45 → ~1.1 u/s² lift bump
spinDecay   : 0.55    // per-second fractional spin loss in flight (~half gone in 1.25 s)
airSpinDecay: same as spinDecay (single knob)
```

Spin magnitudes are in the **6..16 range** (see club table) so that
`kMagnus * spin * speed` produces accelerations of order `0.5 .. 3.5 u/s²` —
a clear but not silly curve next to `gravity 24`.

### 1.4 Bounce + rolling resistance (spin- & surface-aware)

On ground contact (`p.y <= ballRadius`, `vel.y < 0`) we now resolve a richer
bounce that reads the ball's spin:

```
// --- vertical restitution (surface) ---
vy   = vel.y
vel.y = -vy * restitution * surfaceRest      // surfaceRest: asphalt 1.0 (only surface here)

// --- spin-modified horizontal response on impact ---
// backspin (spin about -right) "grabs": kills forward speed, can kick backward.
// topspin adds forward speed (skid → run).
spinAlongShot = spin · rightAxisAtImpact     // signed: + ~ topspin contribution
// approximate using stored scalars carried on the ball:
//   b.backspin (signed rps), b.sidespin (signed rps)
horizScale = clamp(1 - b.backspin * backBiteK + (-min(0,b.backspin)) * 0 , minHoriz, 1)
            // heavy backspin → horizScale small (even <0 handled below)
vel.x *= horizScale ; vel.z *= horizScale

// backspin kick-back: if backspin strong AND this is the FIRST/early bounce,
// add a small impulse opposite the horizontal heading
if (b.backspin > backKickThresh && b.bounces < 2) {
  hmag = hypot(vel.x, vel.z)
  // reverse a fraction of horizontal travel
  kick = b.backspin * backKickK
  vel.x -= (vel.x / (hmag||1)) * kick
  vel.z -= (vel.z / (hmag||1)) * kick
}
b.bounces++
b.backspin *= bounceSpinLoss   // spin mostly dies on contact
b.sidespin *= bounceSpinLoss
```

Rolling resistance while grounded (replaces the old single `rollFriction`):

```
grounded if |vel.y| small after bounce (vel.y < groundedVyThresh)
while grounded:
  // topspin keeps it rolling (less friction), backspin/none rolls normally
  rr = rollFriction * (1 - clamp(b.topspinRoll, 0, rollSpinReduce))
  f  = max(0, 1 - rr * dt)
  vel.x *= f ; vel.z *= f
  // grounded balls feel gravity until settled; tiny wind push on the ground too (rollWindK)
stop when hypot(vel.x,vel.z) < ballStopSpeed
```

Net effect:
- **Backspin** → `horizScale` near 0 (or negative kick) → grabs / hops back / stops dead.
- **Topspin** → `horizScale` > 1 path (skids forward) + reduced roll friction → extra run.
- **No spin** → behaves like today.

### 1.5 Tuned bounce/roll constants

```
restitution     : 0.42    (UNCHANGED base)
rollFriction    : 1.9     (UNCHANGED base; now spin-scaled)
backBiteK       : 0.085   // per rps reduction of horizontal speed on bounce
minHoriz        : 0.02    // floor so horizScale doesn't invert via this term
backKickThresh  : 8.0     // backspin rps above which a kick-back impulse fires
backKickK       : 0.55    // world-units/s of reversal per rps over threshold (scaled)
bounceSpinLoss  : 0.35    // fraction of spin retained after a bounce
groundedVyThresh: 4.0     // |vel.y| below this after bounce => treat as grounded (was hardcoded 4)
rollSpinReduce  : 0.6     // max fractional roll-friction reduction from topspin
topspinRollK    : 0.07    // maps |negative backspin| (topspin) rps -> roll reduction 0..1
rollWindK       : 0.15    // wind acceleration multiplier applied to grounded balls
```

---

## 2. Clubs / shot types (≥3, selectable)

Each club sets a launch-speed band, a pitch (loft) bias added to the player's
aim, default spin, and a per-club drag multiplier. Defined in `CONFIG.CLUBS`
(array; index cycled with a key / on-screen control). Order = cycle order.

| Club    | launch band | loftBias (rad, added to aimPitch, clamped) | default backspin (rps) | drag× | feel |
|---------|-------------|--------------------------------------------|------------------------|-------|------|
| Driver  | 30 .. 52    | −0.06 (flatter)                            | 4   (light backspin)   | 0.85  | low loft, high speed, long, low spin, lots of roll |
| 9-Iron  | 22 .. 40    | +0.10 (mid)                                | 9   (moderate)         | 1.0   | mid distance, clean check on landing |
| Wedge   | 14 .. 30    | +0.30 (high lob)                           | 15  (heavy)            | 1.25  | short, high, **stops dead / hops back** |

```js
CLUBS: [
  { id:'driver', label:'DRIVER', icon:'🏌️', minLaunch:30, maxLaunch:52,
    loftBias:-0.06, backspin:4,  drag:0.85 },
  { id:'iron',   label:'9-IRON', icon:'⛳', minLaunch:22, maxLaunch:40,
    loftBias: 0.10, backspin:9,  drag:1.0  },
  { id:'wedge',  label:'WEDGE',  icon:'🥢', minLaunch:14, maxLaunch:30,
    loftBias: 0.30, backspin:15, drag:1.25 },
]
```

- The global `minLaunch/maxLaunch` (16/52) are kept for back-compat but the live
  band comes from the selected club.
- `loftBias` is added to `aimPitch` at fire time and re-clamped to
  `[pitchMin, pitchMax]`. The preview applies the same bias so the arc matches.
- Wedge's heavy `backspin` (15) drives `horizScale ≈ 1 − 15*0.085 ≈ −0.28` → the
  `min`/kick logic makes it grab and kick backward = "stops dead".

---

## 3. Spin selection by the player

Two layers, both reusing existing input with no new chords required:

1. **Per-club default backspin** (table above) is always applied.
2. **Aim-based spin trim** added on top, derived from the *vertical aim relative
   to the club's natural loft* PLUS an explicit modifier:
   - **Spin nudge** = a small extra `±backspin` and `±sidespin` the player dials
     in with the existing aim keys *while charging* is overkill; instead use a
     dedicated lightweight scheme:
   - **Sidespin** comes from **horizontal aim velocity at release** (how the
     player is flicking the aim when they let go) — captured as a smoothed
     `aimYawVel`. Flick right on release → fade/slice (curves right); flick left
     → draw/hook. This is the "second flick after charge" the brief suggested,
     implemented without new buttons.
   - **Backspin/topspin trim** comes from a **modifier key/control** that cycles
     `spinMode ∈ {default, +back, +top}` (the same control row as club, or
     Shift while charging). `+back` adds `+spinTrimBack` rps, `+top` subtracts
     `spinTrimTop` rps (i.e. negative backspin = topspin).

Final spin scalars at fire time:

```
backspinRPS = club.backspin + spinTrim          // spinTrim ∈ {+B, 0, -T}
sidespinRPS = clamp(aimYawVel * sideSpinK, -sideSpinMax, sideSpinMax)
```

```
spinTrimBack : 7      // rps added in +back mode
spinTrimTop  : 9      // rps subtracted in +top mode (→ topspin)
sideSpinK    : 22     // (rad/s of aim flick) -> rps sidespin
sideSpinMax  : 12     // clamp
aimYawVelDamp: 12     // smoothing lambda for the release-flick estimate
```

`aimYawVel` is updated every `addAim()` call (frame-rate-independent `damp`),
so at release we have a clean flick estimate with zero extra allocation.

> Input summary: **club + spin trim cycle** on one key (and an on-screen chip on
> touch); **sidespin = release flick** (free, emergent). Keeps the control
> surface tiny while satisfying "player chooses spin."

---

## 4. Wind

A slowly varying horizontal wind vector, integrated once per `Golf.update`
(not per ball), so it is shared by every ball and the preview.

```
// target wind wanders via a low-freq random walk; actual wind damps toward target
windTimer -= dt
if (windTimer <= 0) {
  windTimer = rand(windChangeMin, windChangeMax)
  windTarget = randomHorizontalVec(maxStrength = windMax)   // y = 0
}
wind = damp(wind, windTarget, windLerp, dt)                 // component-wise, scratch vec
```

Wind enters physics as part of `vRel = vel - wind` (so it pushes balls
downwind and skews drag), and lightly nudges grounded/rolling balls
(`rollWindK`). Updraft is omitted (kept horizontal) to stay readable.

```
windMax       : 7.0    // max horizontal wind speed (vs launch 16..52 → noticeable, not dominant)
windChangeMin : 5.0    // s between new gust targets
windChangeMax : 11.0
windLerp      : 0.4    // damp lambda toward the new target (slow, ~2.5 s to settle)
```

### HUD wind indicator

A compass-style arrow + strength readout, top-left under the topbar. The arrow
points in the direction the wind blows **toward** (downwind), rotated to match
the camera's yaw-relative-to-world so it reads intuitively from the chase cam.
Strength shown as 0–3 chevrons / a number in u/s. Updated each HUD frame from
`game.snapshot().wind = {x,z,mag,angle}`.

DOM (added to `index.html` `#hud`): `#wind` container with `#wind-arrow`
(a CSS triangle rotated by `transform: rotate()`), and `#wind-str` text.
Color shifts from calm (warm) to strong (orange) by magnitude.

---

## 5. Trajectory preview (must match real flight)

The preview is rewritten to run the **identical integrator** as live balls,
including wind and the spin the *current* selection would produce — so the line
and landing ring are honest.

```
updatePreview(visible):
  if !visible: hide line+marker; return
  club  = current club
  power01 = charging ? power/100 : 0.6
  speed = lerp(club.minLaunch, club.maxLaunch, power01)
  pitch = clamp(aimPitch + club.loftBias, pitchMin, pitchMax)
  fwd   = aimVec(_pFwd, aimYaw, pitch)
  // build the SAME spin the shot would get (uses live aimYawVel for sidespin preview)
  buildSpin(_pSpin, fwd, club.backspin + spinTrim, clamp(aimYawVel*sideSpinK,...))
  pos.copy(shootOrigin); vel.copy(fwd).multiplyScalar(speed)
  spin.copy(_pSpin)
  for i in trajPoints:
    write pos -> trajArr
    detect first ground crossing (pos.y<=ballRadius && vel.y<0) -> landX/landZ
    _stepFlight(pos, vel, spin, dtPreview)   // SAME function family as live step
  upload buffer; place marker at (landX, 0.15, landZ); recolor by charging
```

- A single shared core `_integrate(pos, vel, spin, dt, dragMul)` is used by both
  `update()` (live) and `_stepFlight()` (preview) so they can never drift apart.
- All preview scratch vectors (`_pFwd`, `_pVel`, `_pSpin`, `_pPos`) live on
  `this` — zero allocation across the 64-sample loop.
- `dtPreview` stays `0.045` (coarse but matches today's look); the landing ring
  is found by the same `y<=ballRadius && vel.y<0` test, now correct under spin +
  wind (e.g. a wedge's arc curls and the ring sits short / under the apex).

---

## 6. Ball state — new fields

Per pooled ball object (added to the `{mesh,vel,life,active,explosive,grounded}`
created in the constructor):

```js
{
  // existing: mesh, vel, life, active, explosive, grounded
  spin:     new THREE.Vector3(),  // angular-velocity-like spin vector (set at fire)
  backspin: 0,   // signed rps scalar carried for bounce logic (+ back, − top)
  sidespin: 0,   // signed rps scalar (+ curves right)
  bounces:  0,   // bounce counter (gates the backspin kick-back)
}
```

`reset()` and the fire path clear/seed these. `spin` is reused (never
re-allocated) — set with `.copy()` / `.set()`.

---

## 7. CONFIG additions (final, copy-paste ready)

```js
// ---- Spin (Magnus) ----
kMagnus:        0.0042,
spinDecay:      0.55,
sideSpinK:      22,
sideSpinMax:    12,
aimYawVelDamp:  12,
spinTrimBack:   7,
spinTrimTop:    9,

// ---- Spin-aware bounce / roll ----
backBiteK:      0.085,
minHoriz:       0.02,
backKickThresh: 8.0,
backKickK:      0.55,
bounceSpinLoss: 0.35,
groundedVyThresh: 4.0,
rollSpinReduce: 0.6,
topspinRollK:   0.07,
rollWindK:      0.15,

// ---- Wind ----
windMax:        7.0,
windChangeMin:  5.0,
windChangeMax:  11.0,
windLerp:       0.4,

// ---- Clubs ----
CLUBS: [
  { id:'driver', label:'DRIVER', icon:'🏌️', minLaunch:30, maxLaunch:52, loftBias:-0.06, backspin:4,  drag:0.85 },
  { id:'iron',   label:'9-IRON', icon:'⛳', minLaunch:22, maxLaunch:40, loftBias: 0.10, backspin:9,  drag:1.0  },
  { id:'wedge',  label:'WEDGE',  icon:'🥢', minLaunch:14, maxLaunch:30, loftBias: 0.30, backspin:15, drag:1.25 },
],
defaultClub:    0,   // index into CLUBS
```

`minLaunch:16 / maxLaunch:52` stay as legacy fallbacks. `dragCoef`, `gravity`,
`restitution`, `rollFriction`, `ballRadius`, `trajPoints` UNCHANGED.

---

## 8. Golf API (new / changed)

```
class Golf
  // --- new state ---
  this.clubIndex   : number              // index into CONFIG.CLUBS
  this.spinTrim    : 'default'|'back'|'top'
  this.aimYawVel   : number              // smoothed yaw flick estimate (rps)
  this.wind        : THREE.Vector3       // live wind (y=0)
  this.windTarget  : THREE.Vector3
  this.windTimer   : number
  // scratch (reused): this._right, this._fwd, this._spinTmp, this._cross,
  //                    this._vRel, this._pPos, this._pVel, this._pSpin, this._pFwd

  get club()                 -> CONFIG.CLUBS[this.clubIndex]
  cycleClub()                -> advance clubIndex, toast label, return club
  cycleSpin()                -> cycle spinTrim default→back→top, toast
  addAim(dyaw, dpitch)       -> existing; ALSO updates aimYawVel via damp(dyaw/dt)
  aimVec(out, yaw, pitch)    -> UNCHANGED

  _trimBackspin()            -> club.backspin + (back?+spinTrimBack: top?-spinTrimTop:0)
  _sideSpinRPS()             -> clamp(aimYawVel*sideSpinK, ±sideSpinMax)
  _buildSpin(out, fwd, backRPS, sideRPS)  // out = right*(-back) + up*side ; uses _right
  _updateWind(dt)            // random-walk target + damp toward it
  _integrate(pos, vel, spin, dt, dragMul) // shared core: drag(vRel)+magnus+gravity, spin decay

  fire(power01)              // now: club band, loftBias, build spin, seed ball.spin/backspin/sidespin/bounces
  update(dt, playing)        // now: _updateWind first; per-ball uses _integrate + spin bounce/roll
  updatePreview(visible)     // now: simulates spin+wind via _integrate family
  reset()                    // also resets clubIndex=defaultClub, spinTrim='default', wind=0, aimYawVel=0

  // snapshot helper for HUD
  windInfo(out)              -> {x,z,mag,angle}  (angle = atan2(x,z), downwind dir)
```

### Lifecycle wiring (unchanged shapes)
- Constructor: `new Golf(scene, ctx)` — adds the new scratch vectors + ball
  fields; club/spin/wind initialized from CONFIG.
- `reset()` called by `Game._reset()` — already invoked; just extend it.
- `update(dt, playing)` called from `Game.step()` — same call site.
- `updateCamera(camera, dt)` — UNCHANGED.

---

## 9. Input / HUD wiring for club & spin

### Input (`input.js`)
Add two handlers to the `handlers` object, mapped onto **existing free keys**:

- `KeyC` (and gamepad **LB**, button 4) → `cycleClub`
- `KeyV` / `Shift` tap (and gamepad **dpad-up**, button 12) → `cycleSpin`

Wire in `_key()` alongside the existing `KeyQ/KeyE` → `useItem`:

```js
if (down && e.code === 'KeyC') this.handlers.cycleClub?.();
if (down && e.code === 'KeyV') this.handlers.cycleSpin?.();
```

Gamepad in `_gamepad()`: edge-detect buttons 4 (LB→club) and 12 (dpad-up→spin)
with `this._padLB`, `this._padDU` flags (mirrors existing `_padA` pattern).

Touch: two small chips in the HUD (`#btn-club`, `#btn-spin`) wired in
`HUD.wireTouch(input)` to call `input.handlers.cycleClub/cycleSpin` (add
`input.touchClub()/touchSpin()` thin wrappers, mirroring `touchItem()`).

`main.js` handler block adds:
```js
cycleClub: () => { if (this.state==='playing') ctx.golf.cycleClub(); },
cycleSpin: () => { if (this.state==='playing') ctx.golf.cycleSpin(); },
```

### HUD (`hud.js` + `index.html` + `strings.js`)
- **Club/spin readout**: a small panel (top-left, below topbar) showing the
  current club label+icon and the spin mode (BACK / — / TOP) with a colored dot.
  `#club-name`, `#spin-mode`. Updated in `HUD.update(s)` from
  `s.club` (label/icon) and `s.spin` (mode).
- **Wind indicator**: `#wind` with rotating `#wind-arrow` + `#wind-str`
  (described in §4). Arrow `transform: rotate(${angleDeg}deg)`, color by `mag`.
- `Game.snapshot()` extended:
  ```js
  club: ctx.golf.club.label, clubIcon: ctx.golf.club.icon,
  spin: ctx.golf.spinTrim,
  wind: ctx.golf.windInfo(this._windOut /* reused obj */),
  ```
  (`_windOut` is a reused plain object `{x,z,mag,angle}` on Game to avoid
  per-frame allocation.)
- `strings.js`: add `hudClub`, `hudWind`, `spinBack/spinNeutral/spinTop`,
  control-hint lines (`ctrlClubDesktop`, `ctrlSpinDesktop`, touch equivalents),
  and append them to the start-screen control list in `HUD._fillText()`.

---

## 10. Per-frame allocation audit (must stay zero)

- Wind: `_updateWind` writes into `this.wind` / `this.windTarget` via `.set()` /
  `damp()` on components — no new vectors.
- `_integrate`: uses `this._vRel`, `this._cross`, `this._a` scratch only.
- `_buildSpin`: uses `this._right` (cross of fwd×up via `crossVectors`) — scratch.
- Preview loop: `this._pPos/_pVel/_pSpin/_pFwd` scratch; `trajArr` reused.
- Ball `spin` is `.copy()`-ed, never re-`new`-ed.
- HUD wind object reused (`Game._windOut`).
- `crossVectors`/`addScaledVector`/`copy`/`set` are all in-place.

---

## 11. Risks / tuning notes

- **Magnus overshoot**: if `kMagnus` is too high a wedge can loop; `0.0042`
  with `spinDecay 0.55` keeps lift bounded. Tune `kMagnus` first if arcs feel
  off, then `spinDecay`.
- **Backspin kick-back** can look jumpy if `backKickK` too high; gate is
  `bounces < 2` + threshold `8 rps` so only genuinely heavy backspin reverses.
- **Preview cost**: still one 64-sample loop; adding Magnus is ~1 cross + a few
  mults per sample — negligible. `dtPreview 0.045` keeps it cheap; if curves
  look jagged drop to `0.035` (raise `trajPoints` if needed — costs draw verts
  only, still one Line).
- **Sidespin from flick** depends on `aimYawVel` smoothing; if it feels twitchy
  raise `aimYawVelDamp`. On touch, drag-aim flicks map naturally; on gamepad the
  right-stick yaw velocity feeds it too.
- **Explosive/multiball** unchanged: explosive ignores spin landing logic (it
  detonates on contact); multiball gives each pellet the same club spin (sidespin
  spread reads nicely). Confirm `afterFire()` / armed-mode path still runs after
  the club band change (it does — `fire()` keeps calling `game.useAmmo()` /
  `afterFire()`).
- **Wind vs aim readability**: wind ≤ 7 vs launch 16–52 means it bends shots a
  few units at range without making aiming feel random; raise `windMax` only if
  players want more challenge.
