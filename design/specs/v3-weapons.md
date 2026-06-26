# GOLF Z — v3 Weapons (Putter / Slingshot / BazuGolf)

Spec for extending the weapon system in `public/js/golf.js` + `public/js/config.js`
(+ small hooks in `input.js`, `main.js`, `hud.js`, `index.html`, `strings.js`,
`effects.js`).

Today the loadout is **CONFIG.CLUBS** = `driver / 9-iron / wedge`, cycled by **C**,
all firing the same `fire()` path (one charged ball, spin-aware physics) with
spinMode toggled by **V**. This spec promotes `CLUBS` → **`CONFIG.WEAPONS`**: the
three clubs stay, and three new entries are added with a richer schema and a
**`fireType`** that branches `fire()` per weapon. Spin mode (V) still applies, but
only matters for the golf-swing weapons (driver/iron/wedge/putter); slingshot and
bazugolf ignore it.

New weapons:

1. **PUTTER** — ground roller. Near-zero launch pitch, baked-in **topspin**, low
   drag, very low restitution: the ball skips the apex entirely, hits the street
   almost immediately and **rolls far** with little friction. Mows a line of
   zombies down the street. Starts **owned**.
2. **SLINGSHOT** — fast flat rapid-fire. Small steel ball, **high muzzle speed**,
   **reduced gravity** (`gravityMul`) so the short-range arc is nearly flat,
   **faster charge & short fire cooldown**, **lower per-hit** but you fire 2-3×
   as often. Feels like a slingshot, not a swing. Starts **locked / purchasable**.
3. **BAZUGOLF** — the golf bazooka. A **slow heavy explosive golf shell** that
   detonates on impact with a big AoE (reuses `golf.explode()` →
   `zombies.damageArea` + `props.igniteArea`). **Limited ammo** (its own reserve),
   heavy screenshake + knockback, big charge cost. The heavy hitter. Starts
   **locked / purchasable**.

Hard constraints honored throughout: client-side only, fixed 60 Hz step,
**zero allocations in per-frame / per-fire / per-preview loops** (all vectors are
reused scratch on `this`), ball pool unchanged (`maxBalls 60`), draw calls
unchanged (we re-skin / re-scale pooled balls, never add geometry per shot).

World scale recap (FROZEN): street `y=0`, rooftop perch `y≈9.2`
(`shootOrigin = pos.y+3`), perimeter radius **38**, spawn ring **96**,
`gravity 24`, `ballRadius 0.95`. The camera constraint (rooftop kept LOW at
height 8 so the chase cam sees the street past the building) is **unaffected** —
no weapon changes building/camera geometry.

---

## 1. Weapon schema (`CONFIG.WEAPONS`)

Each weapon is a plain object. The three clubs keep their existing fields
(`minLaunch / maxLaunch / loftBias / backspin / drag`) and gain the new ones so a
single `fire()` reads a uniform shape. New fields:

| field | meaning |
|---|---|
| `id`, `label`, `icon` | identity + HUD readout (icon is an emoji, procedural-safe) |
| `minLaunch`, `maxLaunch` | muzzle-speed band lerped by `power01` |
| `loftBias` | added to `aimPitch` (radians) before clamp — the **launch band** |
| `backspin` | baked backspin RPS (negative ⇒ topspin, drives the roll model) |
| `drag` | per-ball drag multiplier into `_integrate` |
| `gravityMul` | **NEW** per-ball gravity scale (1 = normal; <1 = flat/floaty) |
| `fireType` | **NEW** `'normal' \| 'rapid' \| 'explosive'` — branches `fire()` |
| `chargeRate` | **NEW** power-meter fill rate (overrides `powerChargeRate`) |
| `fireCooldown` | **NEW** seconds of lockout after a shot (rapid = small) |
| `ammoCost` | **NEW** ammo (or reserve) consumed per shot |
| `ammoKind` | **NEW** `'balls' \| 'shells'` — which reserve `ammoCost` draws from |
| `restitution` | **NEW** per-ball bounce override (putter ≈ 0, others fall back to global) |
| `ballScale` | **NEW** visual radius multiplier (slingshot = small steel, bazugolf = fat shell) |
| `look` | **NEW** `'ball' \| 'steel' \| 'shell'` — picks the projectile material |
| `owned` | **NEW** starts in the loadout if true |
| `cost` | **NEW** survivor-currency price to unlock when locked (`game.survivors`) |

`gravityMul`, `restitution`, `fireCooldown`, `chargeRate`, `ammoCost`, `ammoKind`,
`ballScale` are all read with `?? <fallback>` so the existing clubs need no new keys
if we want to keep their config terse — but for clarity we list them explicitly.

### 1.1 CONFIG additions (concrete tuned numbers, world scale 38/96/24)

```js
// rename CLUBS -> WEAPONS; defaultClub -> defaultWeapon
WEAPONS: [
  // ---- golf swings (fireType 'normal', look 'ball', ammoKind 'balls') ----
  { id:'driver', label:'DRIVER', icon:'🏌️', minLaunch:30, maxLaunch:52, loftBias:-0.06, backspin:4,  drag:0.85, gravityMul:1.0, fireType:'normal', chargeRate:150, fireCooldown:0.0, ammoCost:1, ammoKind:'balls', restitution:0.42, ballScale:1.0, look:'ball',  owned:true,  cost:0 },
  { id:'iron',   label:'9-IRON', icon:'⛳', minLaunch:22, maxLaunch:40, loftBias:0.10,  backspin:9,  drag:1.0,  gravityMul:1.0, fireType:'normal', chargeRate:150, fireCooldown:0.0, ammoCost:1, ammoKind:'balls', restitution:0.42, ballScale:1.0, look:'ball',  owned:true,  cost:0 },
  { id:'wedge',  label:'WEDGE',  icon:'🪓', minLaunch:14, maxLaunch:30, loftBias:0.30,  backspin:15, drag:1.25, gravityMul:1.0, fireType:'normal', chargeRate:150, fireCooldown:0.0, ammoCost:1, ammoKind:'balls', restitution:0.42, ballScale:1.0, look:'ball',  owned:true,  cost:0 },

  // ---- PUTTER: ground roller, baked topspin (negative backspin), near-zero loft & bounce ----
  { id:'putter', label:'PUTTER', icon:'🥍', minLaunch:26, maxLaunch:46, loftBias:-0.34, backspin:-14, drag:0.55, gravityMul:1.0, fireType:'normal', chargeRate:150, fireCooldown:0.10, ammoCost:1, ammoKind:'balls', restitution:0.08, ballScale:1.0, look:'ball', owned:true, cost:0 },

  // ---- SLINGSHOT: fast flat rapid-fire steel ball, low gravity, short range ----
  { id:'sling',  label:'SLINGSHOT', icon:'🔩', minLaunch:46, maxLaunch:64, loftBias:-0.02, backspin:0, drag:0.45, gravityMul:0.45, fireType:'rapid', chargeRate:420, fireCooldown:0.16, ammoCost:1, ammoKind:'balls', restitution:0.30, ballScale:0.45, look:'steel', owned:false, cost:6 },

  // ---- BAZUGOLF: slow heavy explosive shell, big AoE, own ammo reserve ----
  { id:'bazu',   label:'BAZUGOLF', icon:'🚀', minLaunch:18, maxLaunch:30, loftBias:0.06, backspin:0, drag:1.6, gravityMul:0.8, fireType:'explosive', chargeRate:110, fireCooldown:0.45, ammoCost:1, ammoKind:'shells', restitution:0.0, ballScale:1.8, look:'shell', owned:false, cost:10 },
],
defaultWeapon: 0,

// ---- v3 weapon-system knobs ----
weaponShellsStart: 0,        // bazugolf reserve at spawn (must buy + restock)
weaponShellsMax: 8,
weaponShellsPerCrate: 3,     // a supply crate also tops up shells when bazu owned
slingDamage: 0.6,            // per-hit (vs ballDamage 1) — quick but weak
putterMowDamage: 1,          // putter rolling hit damage (kept lethal-ish for runners)
bazuKnockback: 22,           // extra radial knockback on bazu detonation
bazuExplosionRadius: 17,     // bigger AoE than the 13 power-up explosion
bazuTrauma: 0.55,            // heavy screenshake on top of explode()'s 0.35
bazuHitStop: 120,            // ms hit-stop on detonation
slingTrauma: 0.05,           // tiny per-shot kick for rapid fire
unlockToastColor: 0x9cff5a,
```

Notes on the tuning:

- **Putter**: `loftBias -0.34` drives the launch pitch toward / below 0 even with a
  slightly raised aim, so the ball leaves nearly parallel to the street and reaches
  `y=ballRadius` within a few steps. `backspin -14` is **topspin** — the existing
  ground model (`§ golf.js update`) reads `topspin = max(0, -backspin)` and
  multiplies roll friction by `(1 - topspin*topspinRollK)` down to `rollSpinReduce`,
  so topspin = the ball **keeps rolling**. `restitution 0.08` kills the bounce so it
  hugs the ground; `drag 0.55` lets it carry. Net effect at full power from the roof:
  the ball pitches onto the street near the tower base and rolls out toward / past the
  perimeter (38), sweeping a lane.
- **Slingshot**: `gravityMul 0.45` halves the drop, `minLaunch 46` makes it fast, so
  inside ~60 units the trajectory is a shallow line — point-and-click, not lob. High
  `chargeRate 420` means the meter fills almost instantly (tap-fire feel), and
  `fireCooldown 0.16` caps it at ~6 shots/s. `slingDamage 0.6` per hit (< the golf
  ball's 1) makes each pellet weak but the volume kills runners fast.
- **BazuGolf**: slow (`maxLaunch 30`), heavy drag, `gravityMul 0.8` for a lobbed
  shell. `fireType 'explosive'` always detonates on first contact (zombie / prop /
  ground) regardless of the `game.armed` power-up. Draws from its **own `shells`
  reserve**, not the ball ammo, so it can't be spammed and must be bought/restocked.

---

## 2. Ownership, unlocking & the weapon cycle

### 2.1 Owned vs locked

`game` (in `main.js`) gains an **owned set**:

```js
this.ownedWeapons = new Set(
  CONFIG.WEAPONS.filter(w => w.owned).map(w => w.id)
); // -> {driver, iron, wedge, putter}
```

Reset in `_reset()` (purchases do NOT persist across a run — survivor currency is
per-run). `driver / iron / wedge / putter` start owned; `sling / bazu` are locked.

### 2.2 Cycle skips locked weapons (C)

`golf.cycleClub()` (kept name for input compat, or rename to `cycleWeapon`) advances
to the next **owned** index, wrapping, and is a no-op if only one is owned:

```js
cycleWeapon() {
  const W = CONFIG.WEAPONS, owned = this.ctx.game.ownedWeapons;
  let i = this.weaponIndex;
  for (let n = 0; n < W.length; n++) {
    i = (i + 1) % W.length;
    if (owned.has(W[i].id)) { this.weaponIndex = i; break; }
  }
  return this.weapon; // get weapon() => CONFIG.WEAPONS[this.weaponIndex]
}
```

Locked weapons are never reachable by C. They are unlocked through a **purchase**
action (see 2.3), after which they enter `ownedWeapons` and the cycle includes them.
If the currently-selected weapon were ever to leave the owned set (it can't today, but
guard anyway), `cycleWeapon()` snaps to `defaultWeapon`.

### 2.3 Purchasing (survivor currency)

Reuse the existing **survivor currency** (`game.survivors`, already spent via
`game.spendSurvivors(n)` for turrets/barricades). Add a buy action bound to a key
(proposed **G** = "gun shop", free in `input.js`) and a touch chip:

```js
buyWeapon() {  // on Game, called from input handler
  const w = ctx.golf.nextLockedWeapon();        // first locked weapon by cycle order
  if (!w) { hud.flashMsg(STR.allWeaponsOwned); return; }
  if (this.spendSurvivors(w.cost)) {
    this.ownedWeapons.add(w.id);
    if (w.id === 'bazu') this.shells = Math.min(CONFIG.weaponShellsMax, this.shells + 3);
    ctx.golf.selectWeapon(w.id);                 // jump straight to the new toy
    hud.toast(`UNLOCKED ${w.icon} ${w.label}`, '#9cff5a');
  } else hud.flashMsg(`${w.label} — ${w.cost} ${STR.survivorsShort}`);
}
```

`nextLockedWeapon()` returns sling before bazu (cycle order) so repeated buys unlock
in a sensible ramp. This keeps the purchase model identical to the turret economy and
needs **no new currency, store UI, or persistence** — the build menu already teaches
"spend survivors". (A future slice could add a proper shop panel; out of scope here.)

---

## 3. Ammo & cooldown

Two reserves on `game`:

- **balls** — existing `this.ammo` (start 18, max 40, regen 0.18/s). Used by all
  swing weapons + slingshot (`ammoKind:'balls'`).
- **shells** — new `this.shells` (start `weaponShellsStart` 0, max `weaponShellsMax`
  8). Used only by bazugolf (`ammoKind:'shells'`). Restocked on purchase and by
  supply crates (`weaponShellsPerCrate` when bazu owned). No passive regen.

Helper on `golf`:

```js
_reserve(w)        // returns current count for w.ammoKind
_spend(w)          // decrements the right reserve by w.ammoCost; returns true if paid
```

`startCharge()` is gated on the **selected weapon's** reserve, not just balls:

```js
startCharge() {
  const w = this.weapon;
  if (this._cooldown > 0) return;                     // still locked out
  if (this._reserve(w) < (w.ammoCost ?? 1)) { this.ctx.game.flashNoAmmo(); return; }
  this.charging = true; this.power = 0; this.powerDir = 1;
}
```

Cooldown is a single timer `this._cooldown` ticked down in `golf.update(dt)`. After a
shot it is set to `w.fireCooldown ?? 0`. While `>0`, `startCharge()` early-returns.

The **charge meter rate** uses `w.chargeRate ?? CONFIG.powerChargeRate` in
`golf.update()`:

```js
if (this.charging) {
  const rate = this.weapon.chargeRate ?? CONFIG.powerChargeRate;
  this.power += this.powerDir * rate * dt;
  // ...ping-pong clamp unchanged...
}
```

**Rapid fire (slingshot)**: with mouse/space held, after release we re-arm. Simplest
zero-state approach: on `releaseCharge()` for a `fireType:'rapid'` weapon, if the fire
button is still held (`input` exposes a `firing` flag), immediately `startCharge()`
again once `_cooldown` clears. Because `chargeRate 420` fills the meter in ~0.24 s and
`fireCooldown 0.16`, holding the button yields a steady ~5-6 shots/s stream at rising
power. Implementation: `golf.update()` checks `if (w.fireType==='rapid' && this._held
&& !this.charging && this._cooldown<=0 && this._reserve(w)>0) this.startCharge();`
where `this._held` is set by `_fire(true/false)` routed from input. No allocation, no
new timers beyond `_cooldown`.

---

## 4. `fire()` branches per `fireType`

`fire(power01)` reads `const w = this.weapon;` and branches. Shared prologue computes
speed/pitch/spin from the weapon, then per-type:

```js
fire(power01) {
  const game = this.ctx.game, w = this.weapon;
  if (this._cooldown > 0) return;
  if (this._reserve(w) < (w.ammoCost ?? 1)) { game.flashNoAmmo(); return; }
  this._spend(w);
  this._cooldown = w.fireCooldown ?? 0;

  const speed = lerp(w.minLaunch, w.maxLaunch, power01);
  const pitch = clamp(this.aimPitch + w.loftBias, CONFIG.pitchMin, CONFIG.pitchMax);
  const origin = this.ctx.player.shootOrigin;

  switch (w.fireType) {
    case 'explosive': this._fireExplosive(w, speed, pitch, origin, power01); break;
    case 'rapid':     this._fireRapid(w, speed, pitch, origin, power01);     break;
    default:          this._fireNormal(w, speed, pitch, origin, power01);    break;
  }
  this.ctx.player.swing();             // golfer arm anim (skip/abbreviate for sling? optional)
  game.afterFire();
}
```

### 4.1 `_fireNormal` (driver / iron / wedge / **putter**)

Identical to today's golf path, but reading per-weapon fields. Still honors the
`game.armed` power-ups (explosive/multiball) because these are golf swings:

- `backRPS = this._trimBackspin()` using `w.backspin` (so putter's −14 flows through
  as topspin; spinMode V still trims it).
- `sideRPS = this._sideSpinRPS()` (aim-velocity slice spin — unchanged).
- spawn 1 ball (or `multiballCount` if armed multiball), set `b.drag = w.drag`,
  `b.gravityMul = w.gravityMul ?? 1`, `b.restitution = w.restitution ?? CONFIG.restitution`,
  `b.dmg = (w.id==='putter') ? CONFIG.putterMowDamage : CONFIG.ballDamage`,
  `b.explosive = armed explosive`, look = ball, scale = `w.ballScale ?? 1`.
- screenshake `CONFIG.shake.shotKick * (0.4+0.6*power01)`.

Putter needs no special case beyond its config — the low loft + topspin + low
restitution + the **existing** ground/roll model produce the roller automatically.

### 4.2 `_fireRapid` (slingshot)

One small fast ball, **ignores spin and power-up arming**:

```js
this.aimVec(this._fwd, this.aimYaw, pitch);
const b = this.balls.find(x => !x.active); if (!b) return;
b.active = true; b.grounded = false; b.life = 0; b.bounces = 0;
b.explosive = false; b.drag = w.drag; b.gravityMul = w.gravityMul; // 0.45
b.restitution = w.restitution; b.dmg = CONFIG.slingDamage;          // 0.6
b.backspin = 0; b.sidespin = 0; b.spin.set(0,0,0);
b.look = 'steel'; b.scale = w.ballScale;                            // 0.45
b.mesh.material = this.steelMat; b.mesh.scale.setScalar(w.ballScale);
b.mesh.visible = true; b.mesh.position.copy(origin);
b.vel.copy(this._fwd).multiplyScalar(speed);
this.ctx.audio.swing(0.3);                  // lighter "twang"
this.ctx.shake.addTrauma(CONFIG.slingTrauma);
this.ctx.effects.muzzle?.(origin, this._fwd);
```

The flat feel comes from `gravityMul 0.45` applied in `_integrate` (see § 5).

### 4.3 `_fireExplosive` (bazugolf)

One slow fat shell, **always explosive** (no power-up needed), draws a shell:

```js
this.aimVec(this._fwd, this.aimYaw, pitch);
const b = this.balls.find(x => !x.active); if (!b) return;
b.active = true; b.grounded = false; b.life = 0; b.bounces = 0;
b.explosive = true; b.bazu = true;          // bazu => bigger radius + knockback
b.drag = w.drag; b.gravityMul = w.gravityMul; b.restitution = 0;
b.dmg = CONFIG.explosionDamage; b.backspin = 0; b.sidespin = 0; b.spin.set(0,0,0);
b.look = 'shell'; b.scale = w.ballScale;    // 1.8
b.mesh.material = this.shellMat; b.mesh.scale.setScalar(w.ballScale);
b.mesh.visible = true; b.mesh.position.copy(origin);
b.vel.copy(this._fwd).multiplyScalar(speed);
this.ctx.audio.swing(1.0);                  // heavy launch thump
this.ctx.shake.addTrauma(CONFIG.shake.bigShotKick);   // launch kick (detonation adds more)
this.ctx.effects.muzzle?.(origin, this._fwd);
```

Detonation reuses the existing `explode()` with a `bazu` branch for the bigger AoE,
knockback and heavy feedback (see § 6).

---

## 5. Per-ball physics changes (`_integrate` + ground model)

Two new per-ball fields so weapons differ without per-type code in the hot loop:

- `b.gravityMul` (default 1) — scales gravity in `_integrate`.
- `b.restitution` (default `CONFIG.restitution`) — used at the ground-bounce step.
- `b.dmg` (default `CONFIG.ballDamage`) — damage applied on a zombie hit.
- `b.scale`, `b.look` — visual only.

`_integrate` gets a `gravMul` arg (preview passes the weapon's, live passes `b`'s):

```js
_integrate(pos, vel, spin, dt, dragMul, gravMul) {
  this._vRel.copy(vel).sub(this.wind);
  const speed = this._vRel.length();
  this._a.set(0, -CONFIG.gravity * (gravMul ?? 1), 0);     // <-- only change
  this._a.addScaledVector(this._vRel, -CONFIG.dragCoef * dragMul * speed);
  this._cross.crossVectors(spin, this._vRel);
  this._a.addScaledVector(this._cross, CONFIG.kMagnus);
  vel.addScaledVector(this._a, dt);
  pos.addScaledVector(vel, dt);
  spin.multiplyScalar(1 - CONFIG.spinDecay * dt);
}
```

Callers: live loop `this._integrate(b.mesh.position, b.vel, b.spin, dt, b.drag,
b.gravityMul)`; preview `this._integrate(this._pPos, this._pVel, this._pSpin, dt,
w.drag, w.gravityMul ?? 1)`. Zero new allocation.

Ground bounce uses `b.restitution` instead of the global constant:

```js
b.vel.y = -b.vel.y * (b.restitution ?? CONFIG.restitution);
```

Putter (`0.08`) and bazu (`0`) thus stop bouncing; slingshot (`0.30`) skips low.
The **roll model is untouched** — putter's negative `backspin` (topspin) already
feeds `topspin = max(0,-b.backspin)` to extend roll. The mowing behaviour is emergent.

Zombie-hit damage uses `b.dmg`: in the collision block, `z.hitBall(hit, p, b.vel)`
currently hard-codes `CONFIG.ballDamage`. Add a damage param to `hitBall` (or call
the existing generic `z.damage(z, b.dmg)` + apply knockback) so slingshot's 0.6 and
putter's 1 land correctly. Smallest change: `z.hitBall(hit, p, b.vel, b.dmg)` with
`hitBall(z, p, ballVel, dmg = CONFIG.ballDamage)`.

---

## 6. Detonation (bazugolf) — `explode()` with a `bazu` branch

`explode(pos, ball)` already does AoE damage + `effects.fireball` + `props.igniteArea`
+ gore + audio + `shake.addTrauma(0.35)` + `postfx.boomPulse()` + `world.flash()`.
Extend it to read the bazu flag for a bigger, punchier blast:

```js
explode(pos, ball) {
  const big = ball && ball.bazu;
  const radius = big ? CONFIG.bazuExplosionRadius : CONFIG.explosionRadius;  // 17 vs 13
  const killed = z.damageArea(pos, radius, {
    dmg: CONFIG.explosionDamage, dismember: true,
    knockback: big ? CONFIG.bazuKnockback : undefined,   // damageArea already takes knockback
  });
  this.ctx.effects.fireball(pos, true);                  // always the "big" fireball for bazu
  this.ctx.props?.igniteArea(pos, radius);               // chain barrels/cars in the bigger ring
  // ...gore + audio unchanged...
  this.ctx.shake.addTrauma(big ? CONFIG.bazuTrauma : 0.35);
  if (big) this.ctx.shake.hitStop?.(CONFIG.bazuHitStop); // 120ms freeze
  this.ctx.postfx?.boomPulse?.(); this.ctx.world?.flash?.(big ? 0.7 : 0.5);
  // ...score unchanged...
  if (ball) { ball.active = false; ball.mesh.visible = false; ball.bazu = false; }
}
```

`damageArea` already accepts a `knockback` option (turret/explosion path) — bazu just
passes a bigger one (22 vs the area default 14). `props.igniteArea(pos, radius)` is
reused verbatim with the larger radius so the bazooka chains barrels/cars across a
wide street. The non-bazu explosive power-up path is unchanged (`big=false`).

`b.bazu` must be **reset to false** on detonation and in any ball-recycle/`reset()`
path so a recycled pool slot doesn't inherit it.

---

## 7. Projectile visuals (3 materials, no new geometry)

The ball pool is one `SphereGeometry`. We **re-skin and re-scale** the pooled mesh per
shot — no per-shot allocation, no extra draw geometry. In the `Golf` constructor,
build three materials once:

- `this.ballMat` — existing white golf-ball PBR.
- `this.expMat` — existing emissive explosive (also reused for the **bazu shell**, or
  a dedicated `this.shellMat`: darker olive-drab body + strong orange emissive, so the
  heavy shell reads as a live warhead; `ballScale 1.8` makes it visibly fat).
- `this.steelMat` — `MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.95,
  roughness: 0.2 })` for the slingshot's small steel ball (`ballScale 0.45`, no
  shadow needed for the tiny pellet — keep `castShadow` for consistency, it's cheap).

Per fire we set `b.mesh.material = <mat>` and `b.mesh.scale.setScalar(w.ballScale ??
1)`. On recycle/reset, reset scale to 1 and material to `ballMat`. The trajectory
preview line can tint per weapon (optional): putter/sling lines slightly different
opacity, but reusing the existing white line is fine for v3.

Putter ball = the normal white golf ball (it's still a golf ball, just rolling).

---

## 8. HUD weapon readout

The HUD already shows `#club-name` (icon + label) and `#spin-mode`. v3:

- `snapshot()` in `main.js` sets `s.weapon = ctx.golf.weapon.label`,
  `s.weaponIcon = ctx.golf.weapon.icon`, `s.fireType = ctx.golf.weapon.fireType`,
  and for ammo it reports the **active reserve**: `s.ammoKind = w.ammoKind`,
  `s.shells = this.shells`. Keep `s.club`/`s.clubIcon` as aliases so existing HUD code
  keeps working, or rename the HUD fields to `weapon`.
- `hud.update()`:
  - `#club-name` ← `${s.weaponIcon} ${s.weapon}`.
  - When the active weapon is bazugolf, the **BALLS** readout shows **shells**
    instead: e.g. `🚀 ${s.shells}` with a distinct color, so the player sees the
    limited reserve. Add a small `#shells` span next to `#ammo` (or repurpose the
    ammo line based on `s.ammoKind`). Concretely: if `s.ammoKind==='shells'`,
    `el.ammo.textContent = '🚀 ' + s.shells` and color it orange; else the existing
    `BALLS n`.
  - Spin readout (`#spin-mode`) is dimmed / shows `—` for sling & bazu (spin doesn't
    apply) — set it to `''`/`—` when `s.fireType !== 'normal'`.
- Cycle/unlock feedback uses the existing `hud.toast()` (already wired in `main.js`
  for `cycleClub`). The unlock toast is green (`unlockToastColor`).

`index.html`: the `#loadout` div already hosts `#club-name` + `#spin-mode`. Add an
optional `#weapon-ammo`/`#shells` span if we don't repurpose `#ammo`. No layout
overhaul needed; the icons are emoji (procedural-safe, no asset generation).

---

## 9. Input wiring

- **C** — already routed to `cycleClub` → now `cycleWeapon` (skips locked). No input
  change (handler renamed internally; `input.js` keeps `KeyC → handlers.cycleClub`).
- **V** — spin cycle unchanged (only affects `fireType:'normal'` weapons).
- **G** — NEW: `handlers.buyWeapon` (free key). Add in `input.js`:
  `if (down && e.code === 'KeyG') this.handlers.buyWeapon?.();` and a touch chip
  (`btn-buy`) wired like `btn-club`. Gamepad: map to an unused face/bumper if desired
  (optional).
- Slingshot rapid-fire needs the **held** state: `input._fire(true/false)` already
  fires `chargeStart/chargeEnd`; `golf` tracks `this._held` from those so it can
  re-arm. No new input event.

`main.js` handler additions:

```js
cycleClub: () => { if (this.state==='playing'){ const w = ctx.golf.cycleWeapon(); hud.toast(`${w.icon} ${w.label}`, '#ffd9a0'); } },
buyWeapon: () => { if (this.state==='playing') this.buyWeapon(); },
```

---

## 10. strings.js additions

```js
hudShells: 'SHELLS',
weaponPutter: 'PUTTER', weaponSling: 'SLINGSHOT', weaponBazu: 'BAZUGOLF',
unlockedWeapon: 'UNLOCKED',
allWeaponsOwned: 'ALL WEAPONS OWNED',
survivorsShort: 'SURVIVORS',
buyWeaponLbl: 'BUY GUN',
ctrlWeaponDesktop: 'C — weapon · V — spin · G — buy gun (survivors)',
ctrlWeaponTouch: 'WEAPON / SPIN / BUY — change shot',
```

(The existing `ctrlClubDesktop` line can be replaced by `ctrlWeaponDesktop`.)

---

## 11. Reset / lifecycle hygiene (zero-alloc, pool-safe)

On `golf.reset()` and on every ball recycle (`b.active=false` paths), reset the new
per-ball fields so a reused slot is clean:

```js
b.gravityMul = 1; b.restitution = CONFIG.restitution; b.dmg = CONFIG.ballDamage;
b.bazu = false; b.look = 'ball'; b.scale = 1;
b.mesh.scale.setScalar(1); b.mesh.material = this.ballMat;
```

On `game._reset()`: `this.shells = CONFIG.weaponShellsStart;
this.ownedWeapons = new Set(...owned ids); ctx.golf.weaponIndex = CONFIG.defaultWeapon;`
and `golf` clears `this._cooldown = 0; this._held = false;`.

Supply-crate pickup (`game.onPickup('supply')`): if `ownedWeapons.has('bazu')`,
`this.shells = Math.min(CONFIG.weaponShellsMax, this.shells + CONFIG.weaponShellsPerCrate)`.

---

## 12. Touch / preview / camera notes

- **Preview**: `updatePreview()` reads the selected weapon and passes
  `w.gravityMul` + `w.drag` + `w.restitution` into the same integrator + the ground
  step, so the dotted line + landing marker stay accurate for putter rolls (the marker
  lands where it first touches; the long roll is not previewed beyond the touch point —
  acceptable, matches current behaviour) and the flat slingshot line.
- **Camera**: no changes. All weapons fire from `shootOrigin` (rooftop perch ≈ y 9.2);
  the bazu's bigger blast and knockback are gameplay/AoE only and never move the
  building or the chase camera, so the FROZEN visibility constraint (cam sees street
  past the low building) holds.
- **Balance guardrails**: bazu radius 17 < perimeter 38, so a single shell clears a
  chunk of the line but not the whole ring; shells are scarce (max 8, no regen).
  Slingshot's 0.6 dmg means a 1-hp runner dies in 2 pellets, a 2-hp shambler in 4,
  a 6-hp brute is a poor target (use a club/bazu) — preserving weapon roles.
