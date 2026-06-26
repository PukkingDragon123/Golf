# Survivors — Tower-Defense + Rescue Layer (Design Spec)

New file: `public/js/survivors.js` exporting `class Survivors`. One subsystem on the
shared `ctx`, constructed and wired exactly like `Zombies`/`PowerUps`/`Golf`. It adds
three interlocking systems on top of the existing wave loop:

1. **RESCUE** — stranded civilians in cages out in the zombie field. Free them (clear
   nearby zombies / smack the cage with a ball / drive the cart to them). Freed
   survivors sprint to the tower and become a spendable resource: `game.survivors`.
2. **DEFENSE** — spend survivors to staff perimeter **posts**. A staffed post is an
   auto-turret (acquire nearest zombie in range, fire pooled projectiles on a cooldown,
   call `zombies.damage()`), or a **spotter** (marks/slows a cluster, buffs neighbours).
3. **ECONOMY / TOWER-DEFENSE PLACEMENT** — survivors (and score) buy & upgrade turrets
   and **barricades** (perimeter HP walls that block & slow zombie pathing). Player
   places/selects posts around the perimeter with click / key / touch / gamepad.

This document is the authority for the data model, spawn/rescue logic, turret
targeting+firing, barricade↔zombie collision, economy numbers, placement UX, HUD
additions, CONFIG additions, and integration with `Game` + `Zombies`. It matches the
existing code style and `ctx` wiring (`z.x`/`z.zz` ground coords, pooled meshes,
`InstancedMesh`, seeded `makeRNG`, `pbrMaterial`, zero per-frame allocation, fixed 60 Hz).

> **NOTE — required `zombies.js` change.** Today `zombies.js` only exposes
> `kill(z)` / `damageArea(pos,r)` (one-shot kills) and pathing is "walk straight at the
> origin, stop at `buildingRadius`". This layer needs (a) **per-zombie HP** so turrets
> can chip damage, and (b) **barricade-aware pathing**. Both are small, additive edits
> spelled out in §8. Everything else is new code in `survivors.js`.

---

## 0. Coordinate / world facts (frozen — reused, not changed)

- Street `y 0`; rooftop `y 8` (`CONFIG.rooftopHeight`); player drives the 30-wide roof.
- **Perimeter ring** radius `38` (`CONFIG.buildingRadius`) — zombies stop & attack here;
  turrets/barricades/posts live on/just outside this ring. Spawn ring `96`.
- Zombie ground pos = `z.x` (X), `z.zz` (Z); `z.yaw` faces target. Radius `1.8`,
  height `4.4`. World gravity `24`. These names/values are untouched.
- Survivors, posts, projectiles all live at street level (`y 0`). The cart can reach the
  street? No — the cart is roof-locked. "Drive to rescue" is satisfied by the cart being
  **above** a cage near the roof edge (see §3.3) OR by the simpler ball/clear methods; we
  keep all three so every control scheme can rescue.

---

## 1. Data model

All structs are plain objects in pre-allocated pools (no per-frame `new`). Counts are
fixed at construction. Ground coords use `.x`/`.z` (NOT `.zz`; only zombies use `.zz`,
kept for back-comzompat — survivors are new code so they use clean `.x/.z`).

### 1.1 Survivor (rescue target + the runner that goes home)

```
Survivor (pool size CONFIG.surv.maxCages, reused as cage+runner+staffed):
  state    : 'idle' | 'caged' | 'freeing' | 'running' | 'safe' | 'posted' | 'dead'
  x, z     : ground position
  cageHP   : number        // when 'caged': ball/explosion damage to bust the cage
  freeT    : number        // 'freeing' animation timer
  runT     : number        // distance-eased progress 0..1 while 'running' home
  homeX,homeZ              // tower-base target the runner sprints to (roof-edge foot)
  postId   : number        // when 'posted': which Post they staff (else -1)
  kind     : 0|1|2         // cosmetic body tint variant
  slot     : number        // index into the InstancedMesh
```

A survivor object is **the cage while caged**, **the runner while running**, and is
recycled to `idle` once `safe` (it has handed a +1 to `game.survivors`). When assigned to
a post it flips to `posted` and is parented (visually) to that post. We never destroy
them; the pool cycles. `maxCages` simultaneously-visible bodies bounds the draw cost.

### 1.2 Post (a fixed perimeter slot the player builds on)

```
Post (pool size CONFIG.surv.postCount, laid out once at construction):
  id        : index
  x, z      : on a ring at radius CONFIG.surv.postRadius (just inside perimeter)
  yaw       : atan2(-x,-z)  // faces outward toward the spawn field
  angle     : ring angle (for nearest-post selection from aim)
  build     : 'empty' | 'turret' | 'spotter' | 'barricade'
  level     : 1..3         // upgrade tier (0 when empty)
  manned    : number       // survivors stationed here (turret=level, spotter=1)
  // turret runtime:
  target    : zombie ref | null
  cooldown  : number       // seconds until next shot
  heat      : 0..1         // muzzle-glow / recoil ease for render
  // barricade runtime:
  hp, maxHP : number
  // selection:
  selected  : boolean      // highlighted in placement mode
```

Posts are evenly spaced: `N = CONFIG.surv.postCount` (e.g. 12) at
`angle = i/N * TAU`, `radius = postRadius`. They render as a small empty pad when
`empty`, a turret rig when built, etc. (one merged geometry per build type, pooled).

### 1.3 Turret (the active behavior of a `build:'turret'` post — not a separate pool)

Turret state lives **on the Post** (`target`, `cooldown`, `heat`, `level`). Per-level
stats come from a table (`CONFIG.surv.turret[level]`): `{ range, dps→damage+rate, projSpeed, cost }`.
Firing uses a shared **projectile pool** (§5.2).

### 1.4 Barricade (the active behavior of a `build:'barricade'` post)

Barricade state also lives on the Post: `hp`, `maxHP`, `level`. It occupies an arc of the
perimeter centered on the post's `angle`, half-width `CONFIG.surv.barricadeArc` (radians).
Zombies whose approach vector crosses that arc are blocked/slowed and chew its HP (§6).

### 1.5 Projectile (turret bullet pool)

```
Projectile (pool size CONFIG.surv.projMax):
  active : bool
  x,y,z  : position
  vx,vy,vz: velocity
  life   : seconds remaining
  dmg    : number
  slot   : InstancedMesh index
```

---

## 2. Rendering plan (low draw-call, matches existing instancing discipline)

| Visual                | Mesh                                  | Draw calls |
|-----------------------|---------------------------------------|------------|
| Survivor bodies+cages | 1 `InstancedMesh` (merged little-person geo), `maxCages` slots | 1 |
| Cage bars overlay     | 1 `InstancedMesh` (merged bar-box geo), shown only for `caged` | 1 |
| Post pads / turret rigs | 1 `InstancedMesh` per build-type geo (empty/turret/spotter/barricade), `postCount` slots each, hidden slots scaled 0 | 4 |
| Projectiles           | 1 `InstancedMesh` (small sphere), `projMax` slots | 1 |
| Range/selection rings | reuse a couple pooled `RingGeometry` meshes (like golf marker) | ~2 |
| Spotter highlight     | reuse `effects` flash/ring pool — no new mesh | 0 |

Total added steady-state ≈ **9 draw calls**, all instanced, frustumCulled off (small
ring, always near camera). Survivor + cage geometries built via `mergeGeometries(THREE,
parts)` exactly like the zombie body. Materials via `pbrMaterial(THREE, ctx.assets.*)`
reusing existing canvases (`crate` for cages/turrets, `roof`/`facade` for barricades,
`zombie`→re-tinted or a new tiny `survivor` canvas — see §9 textures note). Per-instance
tint via `setColorAt`. Hidden slots use the same `makeScale(0,0,0)` trick as zombies.

Zero per-frame allocation: reuse `_m: Matrix4`, `_q: Quaternion`, `_e: Euler`,
`_p/_p2: Vector3`, `_s: Vector3` scratch members (same pattern as `Zombies`).

---

## 3. Rescue logic

### 3.1 Cage spawning

Cages are seeded **between** the spawn ring and the perimeter so they sit inside the
zombie field but are reachable. On `startWave(w)` Survivors gets a hook
`onWaveStart(w)` (called from `Game.startWave`, see §7) that spawns
`min(maxCages_active, CONFIG.surv.cagesPerWave)` new caged survivors if fewer than
`CONFIG.surv.maxActiveCages` exist:

```
spawnCage():
  slot = pool.find(s => s.state==='idle')   // recycled body
  ang  = rng()*TAU
  rad  = rng.range(CONFIG.surv.cageRadMin, CONFIG.surv.cageRadMax)  // e.g. 50..82
  s.x = cos(ang)*rad; s.z = sin(ang)*rad
  s.state='caged'; s.cageHP=CONFIG.surv.cageHP; s.kind=rng.int(0,2)
  s.postId=-1
  audio: faint cry cue (optional, reuse groan-like _tone)
```

Cages persist across waves until rescued or (optional) overrun. A caged survivor does NOT
get attacked by zombies in v1 (keeps it forgiving); zombies path past toward the tower.
(Hook left in §10 for "zombies can convert an un-rescued cage" hard mode.)

### 3.2 Three rescue methods (any one frees the cage)

A cage transitions `caged → freeing → running` when ANY trigger fires:

1. **Clear nearby zombies.** Each `update(dt)`, for every `caged` survivor count alive
   zombies within `CONFIG.surv.clearRadius` (e.g. 9). If that count is `0` AND it was
   `>0` at some recent point (i.e. the area is *now* clear and the player did the
   clearing), start a `clearHold` timer; if it stays clear for `CONFIG.surv.clearHold`
   seconds (e.g. 1.2s) → free. Implementation: store `s._wasThreatened` once any zombie
   was ever in radius; only auto-free a threatened cage so untouched far cages don't free
   themselves for free. Reuses `zombies` array scan (cheap; `maxActiveCages` is small).

2. **Hit the cage with a ball.** Hook into the ball↔world collision. Add
   `survivors.ballHit(pos, ballRadius, explosive)` called from `golf.update` right after
   the existing `zombies.hitTest`. If a ball is within `cageHP` reach of a `caged`
   survivor: subtract impact damage (`explosive`→instant free via `damageArea`-style;
   normal ball → `cageHP -= CONFIG.surv.ballCageDamage`, ~34, so ~3 hits). On reaching 0
   → free. Returns `true` if it consumed/should-bounce the ball (we let the ball plow
   through like a zombie hit: caller multiplies vel by 0.6, same as zombie code).

3. **Drive the cart to it.** Cages may also spawn in a **near band** adjacent to the
   roof's footprint edge when `rng() < CONFIG.surv.nearCageChance`. The cart can't leave
   the roof, so "driving to" = the cart's ground-projected position is within
   `CONFIG.surv.cartRescueRadius` of the cage's `x,z`. Checked each frame against
   `ctx.player.pos`. (For touch/pad players this is the no-aim-needed rescue path.)
   Practically these near-cages sit just past the parapet so a player who noses the cart
   to the edge above them frees them.

### 3.3 Freeing → running → safe

```
free(s):
  s.state='freeing'; s.freeT=0
  ctx.effects.greenPuff({x:s.x,y:1.6,z:s.z})   // burst, reuse pool
  ctx.audio.pickup()                            // happy chime
  hud.toast(STR.survFreed, '#4dff7a')

update freeing:  s.freeT += dt; cage bars sink/fade; at freeT> CONFIG.surv.freeDur(0.5):
  s.state='running'; s.runT=0
  s.homeX,s.homeZ = nearest point on tower footprint edge to (s.x,s.z)

update running:
  move toward (homeX,homeZ) at CONFIG.surv.runSpeed (e.g. 9, faster than zombies)
  bob/lean anim like a zombie phase; face direction of travel
  if reached home (dist < 2): s.state='safe'; arrive()

arrive(s):
  game.addSurvivors(1)        // +1 spendable
  game.addScore(CONFIG.surv.scorePerRescue)   // e.g. 75
  hud.toast(STR.survSafe, '#9cff5a'); audio.pickup()
  s.state='idle'              // recycle the body slot
```

A `running` survivor is **immune** (we don't want a frustrating last-second death). If
desired later, a runner caught by a zombie within reach could be lost (§10 hook).

---

## 4. Economy

Single spendable currency: **survivors rescued** (`game.survivors`), with an optional
**score** top-up for barricade repair so score isn't dead-weight. Numbers in
`CONFIG.surv` (see §11), summarized:

| Action                         | Cost (survivors) | Notes |
|--------------------------------|------------------|-------|
| Build turret (Lv1) on a post   | 2                | auto-fires, range `26`, ~`18 dps` |
| Upgrade turret Lv1→Lv2         | 2                | range `30`, ~`34 dps`, +manned |
| Upgrade turret Lv2→Lv3         | 3                | range `34`, ~`60 dps`, twin-fire |
| Build spotter on a post        | 1                | slows+marks a cluster, buffs adjacent turrets |
| Build barricade on a post      | 1                | `120` HP arc wall, blocks+slows |
| Upgrade barricade (+HP / slow) | 1 per tier       | Lv2 `220` HP, Lv3 `360` HP + bigger slow |
| Repair barricade               | score `200`/tier OR 1 survivor → full | uses score so survivors stay for offense |
| Sell / reclaim a post          | refunds `floor(spent/2)` survivors | lets you re-plan |

Costs scale gently; rescuing ~1–2 survivors/wave means by wave 4–5 you can field a few
turrets + a barricade or two. `game.survivors` starts at `CONFIG.surv.startSurvivors`
(e.g. 0, or 1 for a friendly start). Spending is gated in `Survivors` (it owns the build
menu) and mutates `game.survivors` via `game.spendSurvivors(n)` → returns bool.

---

## 5. Turret targeting + firing

### 5.1 Targeting (per turret post, every frame, but throttled)

Re-acquire only when `target` is null/dead/out-of-range, or every
`CONFIG.surv.retargetInterval` (e.g. 0.25s) via a per-post `retargetT` accumulator — NOT
a full scan every frame for every turret. Acquisition picks the zombie **nearest the
post** within `range`, preferring zombies closest to the perimeter (most dangerous):

```
acquire(post):
  best=null; bestScore=Infinity; rr = range*range
  for z in zombies.z:
    if !z.alive: continue
    dx=z.x-post.x; dz=z.zz-post.z; d2=dx*dx+dz*dz
    if d2>rr: continue
    // score: distance to post minus a bias for zombies near the tower
    score = d2 - CONFIG.surv.perimeterBias * (CONFIG.spawnRadius - hypot(z.x,z.zz))
    if score<bestScore: bestScore=score; best=z
  post.target = best
```

`zombies.z` is the existing array; loop is bounded by `zombieMaxAlive` (70). With ~12
posts retargeting at 4 Hz that's ≤ ~3360 cheap checks/sec — negligible.

### 5.2 Firing + projectile pool

```
update turret(post, dt):
  post.cooldown -= dt; post.heat = max(0, post.heat - dt*4)
  if !post.target or !post.target.alive or outOfRange: acquire on retarget tick
  if post.target and post.cooldown<=0:
    fireProjectile(post)            // (twice, slightly fanned, at Lv3)
    post.cooldown = 1 / stats.rate  // shots/sec from level table
    post.heat = 1
    audio.turretShot()              // light _tone+_noise zap (new tiny sfx, §9)

fireProjectile(post):
  p = projPool.find(!active); if !p: return
  // lead the target slightly using its current radial velocity (cheap)
  aimX = target.x; aimZ = target.zz
  muzzle = (post.x, CONFIG.surv.muzzleY≈2.2, post.z) offset forward by post.yaw
  dir = normalize(aim - muzzle); p.vel = dir * stats.projSpeed
  p.dmg = stats.damage; p.life = CONFIG.surv.projLife; p.active=true
```

### 5.3 Projectile integration (pooled, in `Survivors.update`)

```
for p in projPool where active:
  p.life -= dt; if p.life<=0: deactivate
  p.x+=vx*dt; ... (straight line; tiny gravity vy-=g*0.15*dt for arc flavor — optional)
  // hit test vs zombies — reuse the same dx*dz<rr test
  hit = zombies.hitTestAt(p.x, p.z, CONFIG.surv.projRadius)   // see §8.2
  if hit:
    zombies.damage(hit, p.dmg)     // NEW per-zombie HP damage (§8.1)
    ctx.effects.hit({x:p.x,y:p.y,z:p.z})
    deactivate p
  // write instance matrix
```

Spotter posts don't fire; each frame they pick the densest nearby zombie cluster, apply
a `marked`/`slow` flag (a per-zombie `slow` multiplier read in zombie movement, §8.3) to
zombies within `spotterRadius`, and grant adjacent turret posts a `+spotterBuff` rate
multiplier. Visual: a pooled ground ring + occasional `effects` ping on marked targets.

---

## 6. Barricade ↔ zombie pathing & collision

A barricade post defines a blocking **arc** on the perimeter:
`center angle = post.angle`, half-width `CONFIG.surv.barricadeArc` (e.g. `0.22` rad ≈
covers the gap to its neighbours for `postCount=12` → arcs nearly tile the ring), at
radius ≈ `buildingRadius`. It has `hp`.

Zombies already path radially inward (`z.x -= z.x*inv; z.zz -= z.zz*inv`). The change
(in `zombies.update`, §8.3) is: **before** moving a zombie inward past `buildingRadius`,
ask `ctx.survivors.blockAt(angle)`:

```
blockAt(zombieAngle) -> { blocked:bool, slow:number, post } :
  for post in posts where build==='barricade' and hp>0:
    if angularDist(zombieAngle, post.angle) < barricadeArc:
      return { blocked:true, slow: CONFIG.surv.barricadeSlow[level], post }
  return { blocked:false }
```

Zombie behavior when blocked at the wall (dist ≈ `buildingRadius + standoff`):
- It stops advancing (clamped to just outside the wall, like it stops at the perimeter
  today) and instead **attacks the barricade**: `survivors.damageBarricade(post,
  CONFIG.surv.zombieVsBarricade * dt)` per blocked zombie. It does NOT damage the tower
  while a wall stands in front of it — that's the whole point (walls buy time).
- While merely *near but not yet at* the wall, its inward step is scaled by `slow`
  (`< 1`) so even a damaged wall slows the approach.
- When a barricade's `hp` hits 0: `build='empty'`, refund nothing, `effects` dust burst,
  the arc opens, zombies behind it resume normal radial march to the tower.

Edge cases:
- Gaps between barricade arcs let zombies leak through to the tower — players must cover
  angles or accept leakage. This is the core TD tension.
- A `caged`/`running` survivor and projectiles ignore barricades (only zombie marching
  consults `blockAt`).
- `angularDist(a,b)` = `abs(atan2(sin(a-b),cos(a-b)))` — reuse a small inline helper
  (no `utils` change needed, or add `angleDist` next to `angleDelta`).

Performance: `blockAt` loops only over barricade posts (≤ `postCount`), called per alive
zombie per frame → ≤ `70*12` = 840 cheap angle checks/frame worst case. Fine. Optionally
cache an `Array(64)` angular occupancy bitmap rebuilt only when a barricade is
built/destroyed (`_rebuildBlockMask()`), turning `blockAt` into one array index — listed
in §11 perf if profiling demands it.

---

## 7. Placement / build UX

Posts are selectable; the player opens a **build mode** and assigns survivors. The aim
system already points a yaw out over the field — we reuse it so desktop/pad players never
leave the cart.

### 7.1 Selection model

`Survivors` keeps `this.selectedPost` (index) and `this.buildMode` (bool). The
**currently aimed post** is computed from `ctx.golf.aimYaw`: convert aim yaw to a ground
angle and pick the post whose `angle` is nearest (`argmin angularDist`). That post shows
a highlight ring + a small floating build menu (DOM, see HUD §8/9-of-HUD). This means
"aim at a post, press build" works on every device with zero new cursor.

### 7.2 Inputs (added to `Input` handlers map — see §8.4 of integration)

| Intent            | Desktop            | Touch                    | Gamepad           |
|-------------------|--------------------|--------------------------|-------------------|
| Toggle build mode | `B` (or `Tab`)     | BUILD button (new)       | `Y` / button[3]   |
| Cycle build type  | mouse wheel / `[` `]` | tap type chips in menu | bumpers LB/RB     |
| Confirm build/upgrade on aimed post | `Left-Click` / `Enter` while in build mode | tap CONFIRM / tap post chip | `A` (button[0]) |
| Sell / reclaim    | `X`                | SELL chip                | `B` (button[1])   |
| Exit build mode   | `B` / `Esc`        | close (X) chip           | `Y` again         |

While `buildMode` is on, `Left-Click`/`Space`/`RT` do **not** fire golf balls (the charge
handlers early-return — `Game.chargeStart` checks `ctx.survivors.buildMode`). Aiming
still rotates to let you sweep across posts. Build mode auto-pauses nothing (real-time TD
— you place under pressure), but the power meter is suppressed.

New `Input` handlers (wired in `Game` constructor like the existing ones):
`buildToggle, buildCycle(dir), buildConfirm, buildSell`. Add to `input.js`:
- `KeyB`/`Tab` → `buildToggle`; `BracketLeft/Right` → `buildCycle(∓1)`; wheel → cycle;
  `KeyX` → `buildSell`; `Enter` → `buildConfirm`. Gamepad button[3] edge → toggle,
  bumpers[4]/[5] edge → cycle, button[0] in build mode → confirm, button[1] → sell.
- These follow the EXACT edge-detection pattern already in `input.js` (`_padCharge`
  style booleans, `held` set for keys).

### 7.3 Selecting which post when aim is ambiguous (touch)

Touch players can also tap directly: `Survivors` exposes `pickPostAtScreen(nx,ny,camera)`
— but to avoid a raycaster, the simpler shipped path is: build menu shows the aimed post
+ ◀ ▶ chips to step `selectedPost` around the ring. Tap a type chip → build. This needs
no unprojection and matches the DOM-overlay HUD philosophy.

---

## 8. Required edits to existing files

### 8.1 `zombies.js` — per-zombie HP (additive)

- In the pool init object add: `hp: 0, maxHp: 0`.
- In `_spawnOne()` set `slot.hp = slot.maxHp = CONFIG.zombieHP * (1 + CONFIG.zombieHPPerWave*wave)`
  (store wave on `this.waveSpeed`-style; pass via `this._waveForHP`). Default
  `zombieHP` small (e.g. `34`) so a single direct golf-ball still one-shots via the
  existing `kill()` path (golf calls `kill`, not `damage`).
- Add method:
  ```
  damage(z, amount):           // chip damage from turrets/projectiles
    if (!z.alive) return false
    z.hp -= amount
    if (z.hp <= 0) { this.kill(z); return true }  // kill() handles score? NO — see note
    return false
  ```
  **Score note:** `kill()` today doesn't add score (golf.js adds it). Turret kills should
  also score. Cleanest: `damage()` calls `this.kill(z)` then `ctx.game.addScore(
  CONFIG.scorePerKill, false)` **only when killer is a turret**. Pass an optional
  `killerScores=true` flag, or have `Survivors` add the score itself when `damage()`
  returns true. Spec picks the latter (Survivors owns its scoring) to keep `kill()` pure.

### 8.2 `zombies.js` — point hit-test helper for projectiles

```
hitTestAt(x, z, r):           // ground-plane variant of hitTest (no Vector3 alloc)
  const rr = r + CONFIG.zombieRadius;
  for (const zz of this.z) {
    if (!zz.alive) continue;
    const dx = x - zz.x, dz = z - zz.zz;
    if (dx*dx+dz*dz < rr*rr) return zz;
  }
  return null;
```

### 8.3 `zombies.js` — barricade-aware march + slow (the pathing edit)

Inside `update(dt)`, replace the inward-move branch:

```
if (dist > bRad) {
  // consult barricades (only if a survivors subsystem is wired)
  let slow = 1, wall = null;
  if (this.ctx.survivors) {
    const ang = Math.atan2(zz.zz, zz.x);          // NOTE polar of (x,z)
    const b = this.ctx.survivors.blockAt(ang);
    if (b.blocked) { slow = b.slow; wall = b.post; }
  }
  const standoff = wall ? CONFIG.surv.wallStandoff : 0;  // e.g. 2.5
  if (wall && dist <= bRad + standoff) {
    // at the wall: attack it instead of advancing
    this.ctx.survivors.damageBarricade(wall, CONFIG.surv.zombieVsBarricade * dt);
    z.atBase = false;            // does NOT damage tower while wall stands
  } else {
    const inv = z.speed * slow * dt / (dist || 1);
    z.x -= z.x*inv; z.zz -= z.zz*inv;
    z.yaw = Math.atan2(-z.x, -z.zz);
  }
} else { attacking++; z.atBase = true; }
```

Also apply per-zombie `slow` from spotters: store `z.slow` (default 1, decays back to 1
each frame; spotter sets it low). Multiply into `inv` above. Add `slow:1` to the pool
object and reset it to 1 at the top of each zombie's update before spotter re-applies.

`this.ctx.survivors` is set in `main.js` (§8.5). Guard with `if (this.ctx.survivors)` so
zombies still work if the layer is disabled.

### 8.4 `input.js` — new handler hooks (pattern-matched additions)

Add to `_key`, `_gamepad`, and document the touch buttons (HUD wires them like
SWING/ITEM). New handler keys: `buildToggle`, `buildCycle`, `buildConfirm`, `buildSell`.
No structural change — just more `this.handlers.X?.()` calls behind new key codes and a
`buildMode` read isn't needed in input (Game gates it).

### 8.5 `main.js` — construction, wiring, state, loop, snapshot

- Construct after powerups/golf: `ctx.survivors = new Survivors(scene, ctx);`
  (so `ctx.zombies.ctx.survivors` resolves — zombies is built before survivors; that's
  fine because zombies only *reads* `this.ctx.survivors` at update time, after main.js
  finishes wiring. Just ensure `ctx.survivors` exists before the first `step()`. It does:
  construction is synchronous in the same block.)
- `_reset()`: add `this.survivors = CONFIG.surv.startSurvivors;` and call
  `ctx.survivors.reset();`.
- `Game.step(dt)`: call `ctx.survivors.update(dt)` **after** `ctx.zombies.update(dt)`
  (so projectiles act on the freshly-moved horde) and **before** `ctx.effects.update`.
- `startWave(w)`: after starting the zombie wave, `ctx.survivors.onWaveStart(w)`.
- New `Game` methods:
  ```
  addSurvivors(n){ this.survivors += n; hud.bumpSurv?.(); }
  spendSurvivors(n){ if(this.survivors<n) return false; this.survivors-=n; return true; }
  ```
- `chargeStart()` handler: `if (ctx.survivors.buildMode) return;` so build mode suppresses
  firing. Add build handlers to the `input.setHandlers({...})` map:
  ```
  buildToggle:  ()=>{ if(this.state==='playing') ctx.survivors.toggleBuild(); },
  buildCycle:   (d)=>{ if(this.state==='playing') ctx.survivors.cycleBuild(d); },
  buildConfirm: ()=>{ if(this.state==='playing') ctx.survivors.confirmBuild(); },
  buildSell:    ()=>{ if(this.state==='playing') ctx.survivors.sellSelected(); },
  ```
- `snapshot()`: add `survivors: this.survivors, buildMode: ctx.survivors.buildMode,
  buildInfo: ctx.survivors.snapshotBuild()` (for the HUD build menu — aimed post id,
  type, level, cost, affordability, total turrets/barricades, perimeter integrity %).
- Lose condition unchanged — the tower still falls when `health<=0`. Turrets/barricades
  simply reduce how fast that happens (fewer zombies reach `atBase`). No new lose state.

### 8.6 `hud.js` / `index.html` — see §9.

---

## 9. HUD additions

### 9.1 Persistent readouts (always-on while playing)

- **Survivors counter** in the topbar: a new cell `SURVIVORS <n>` (green `--health`
  gradient accent). `hud.update(s)` sets `el.survivors.textContent = s.survivors` and
  pulses (`bumpSurv`) on gain.
- **Perimeter integrity** mini-bar near the tower health bar: aggregate barricade HP /
  total possible, thin bar under the existing health bar. `s.buildInfo.integrity` (0..1).
- Small **turret/barricade tally** chips (like the power-up chips, bottom-right):
  `🔫 ×<turrets>` and `🧱 ×<barricades>`.

### 9.2 Build menu overlay (shown only when `buildMode`)

A DOM panel `#build` (hidden by default, `.on` when `buildMode`). Driven by
`hud.updateBuild(s.buildInfo)`:

```
#build  (bottom-center, above touch buttons; pointer-events:auto)
  ◀  POST 7  ▶                 (step selectedPost around ring)
  [ TURRET 2🧍 ] [ SPOTTER 1🧍 ] [ BARRICADE 1🧍 ]   ← type chips, dim if unaffordable
  selected post status: "Turret Lv2 · 34 dps · upgrade 3🧍" / "Empty"
  [ UPGRADE 3🧍 ]  [ SELL +2🧍 ]   (contextual)
  hint line: "B exit · [ ] cycle · click build"  (device-aware via STR)
```

Chips are real buttons wired in `hud.wireBuild(input/survivors)` (touch + click), calling
`ctx.survivors.cycleBuild/confirmBuild/sellSelected/stepPost(±1)`. Affordability greys a
chip (`opacity:.4; pointer-events:none`) when `cost > survivors`. The aimed-post id and
all costs come from `snapshotBuild()` so HUD stays a pure renderer (no game logic),
matching the existing HUD contract.

### 9.3 Toasts / banners (reuse existing `hud.toast` / `hud.banner`)

- `STR.survFreed` ("SURVIVOR FREED"), `STR.survSafe` ("+1 SURVIVOR"),
  `STR.survLost` (if a runner is ever lost — §10), `STR.noSurvivors`
  ("NEED SURVIVORS"), `STR.builtTurret`, `STR.wallDown` ("BARRICADE DOWN").
- All added to `strings.js` (zero literals in code — house rule).

### 9.4 `index.html` additions

- Topbar: one more `<div>` cell `SURVIVORS / <span id="survivors">`.
- Under `#health-wrap`: a `#integrity-track`/`#integrity-bar` thin bar.
- In `#powerups` cluster: `#td-turrets`, `#td-walls` chips.
- New `#build` panel block (markup above) + CSS following the `.pu`/`.controls` style
  tokens (`--panel`, `--line`, `--accent`).
- New touch button `#btn-build` (BUILD) near ITEM, shown via `body.touch`.

---

## 10. Game-feel, balance & tuning notes

- **Pacing target:** ~1–2 rescues/wave; a turret pays for itself by wave 3. Barricades
  are the "buy time" tool, turrets the "thin the horde" tool, spotters the multiplier.
- **Survival math:** today tower dmg = `attacking * 4 dps`. A Lv2 turret (~34 dps,
  zombie HP ~34+wave) kills ~1 zombie/sec; 3 turrets ≈ remove ~3 attackers' worth of
  pressure continuously → roughly doubles survivable waves. Barricade arcs cut the
  *number* that reach `atBase` at all.
- **Anti-degenerate:** post count (12) caps total defenses; survivor income caps build
  rate; barricade gaps guarantee some leakage so the player must keep golfing.
- **Hooks left for later (NOT in v1):** un-rescued cage gets converted by zombies;
  runner can be killed mid-sprint; turret "ammo"/overheat; survivor classes with
  perks; angular occupancy bitmap for `blockAt` if profiling shows cost.

---

## 11. CONFIG additions (`config.js`)

Add a `surv` block to `CONFIG`, plus zombie-HP fields. All numbers tunable here only
(house rule: no magic numbers in code).

```js
// ---- Zombie HP (NEW — enables chip damage from turrets/projectiles) ----
zombieHP: 34,            // base HP; one direct golf ball uses kill() so still one-shots
zombieHPPerWave: 0.12,   // +12% HP per wave

// ---- Survivors / Tower-Defense ----
surv: {
  // rescue
  maxCages: 16,           // pooled survivor bodies (cage+runner+posted share the pool)
  maxActiveCages: 6,      // simultaneous caged survivors in the field
  cagesPerWave: 2,        // new cages spawned at wave start (up to maxActiveCages)
  cageRadMin: 50, cageRadMax: 82,   // spawn band (inside spawn ring 96, outside perim 38)
  nearCageChance: 0.25,   // chance a cage spawns in the cart-reachable near band
  cageHP: 100,            // total cage damage to bust open
  ballCageDamage: 34,     // per normal-ball hit (~3 hits)
  clearRadius: 9,         // zombie-free radius that auto-frees a threatened cage
  clearHold: 1.2,         // seconds the area must stay clear
  cartRescueRadius: 8,    // cart-over-cage rescue distance
  freeDur: 0.5,           // cage-open animation
  runSpeed: 9,            // survivor sprint home (faster than zombies)
  scorePerRescue: 75,

  // posts / placement
  postCount: 12,          // evenly spaced perimeter slots
  postRadius: 40,         // just outside the perimeter ring (38)
  startSurvivors: 1,      // friendly starting economy

  // turret tiers [unused index 0]
  turret: [null,
    { range: 26, rate: 1.6, damage: 12, projSpeed: 60, cost: 2, manned: 1 }, // Lv1 ~19 dps
    { range: 30, rate: 2.2, damage: 16, projSpeed: 70, cost: 2, manned: 2 }, // Lv2 ~35 dps
    { range: 34, rate: 2.8, damage: 22, projSpeed: 80, cost: 3, manned: 3 }, // Lv3 ~61 dps, twin
  ],
  retargetInterval: 0.25,
  perimeterBias: 1.5,     // prefer zombies nearer the tower
  muzzleY: 2.2,
  spotterCost: 1, spotterRadius: 14, spotterSlow: 0.55, spotterBuff: 1.25,

  // projectiles
  projMax: 48,
  projRadius: 0.6,
  projLife: 1.4,

  // barricades [unused index 0]
  barricadeCost: 1,
  barricadeArc: 0.22,     // half-width radians (≈ tiles the 12-post ring)
  barricadeHP: [0, 120, 220, 360],
  barricadeSlow: [1, 0.6, 0.45, 0.3],   // approach slow per level (lower=slower)
  barricadeUpgradeCost: 1,
  repairScoreCost: 200,   // score to repair one tier of barricade HP
  wallStandoff: 2.5,      // zombies attack from this far outside the wall
  zombieVsBarricade: 9,   // barricade HP dps per attacking zombie

  // economy / refunds
  sellRefundFrac: 0.5,    // floor(spent * frac) survivors back
}
```

Color additions to `CONFIG.col` (reuse palette feel): `survivor: 0x4dff7a` (uses existing
health green), `turret: 0xb8bcc2` (chrome), `barricade: 0x8a5a3a` (rust),
`spotter: 0x39b6ff` (multiball blue).

---

## 12. `Survivors` public API & lifecycle

```js
export class Survivors {
  constructor(scene, ctx)          // builds pooled meshes, posts ring, projectile pool
  reset()                          // all survivors→idle, posts→empty, proj inactive, buildMode off
  onWaveStart(wave)                // spawn cages for the wave
  update(dt)                       // rescue checks, turret/spotter logic, projectiles, barricades, write all instance matrices

  // --- rescue hooks called by other systems ---
  ballHit(pos, ballRadius, explosive) -> bool   // golf.js calls; true if ball should plow-through
  blockAt(angle) -> { blocked, slow, post }     // zombies.js pathing consults this
  damageBarricade(post, amount)                 // zombies.js calls when chewing a wall

  // --- build/economy (called via Game handlers / HUD chips) ---
  toggleBuild()
  cycleBuild(dir)                  // change pending build type
  stepPost(dir)                    // move selectedPost around the ring (touch ◀ ▶)
  confirmBuild()                   // build/upgrade pending type on aimed/selected post
  sellSelected()
  get buildMode()                  // bool, read by Game.chargeStart to suppress fire
  snapshotBuild() -> {...}         // pure render data for HUD build menu + tallies

  // internals (no alloc): _acquire(post), _fireProjectile(post),
  //   _free(s), _arrive(s), _aimedPostId(), _rebuildBlockMask()(optional)
}
```

Lifecycle matches siblings: constructed in `main.js`, `reset()` on new game,
`update(dt)` each fixed step from `Game.step`. Reads from `ctx`:
`ctx.zombies` (`.z`, `damage`, `hitTestAt`), `ctx.golf.aimYaw` (aimed post),
`ctx.player.pos` (cart-rescue), `ctx.effects` (puffs/hits/rings), `ctx.audio`
(rescue chime, turret zap, wall-down thud), `ctx.game` (`survivors`, `spendSurvivors`,
`addSurvivors`, `addScore`). Writes to `Game`: survivor count + score only. Reads/writes
zombies via the new `damage`/`hitTestAt`/`blockAt` contract — no other coupling.

---

## 13. Per-frame cost summary (zero-alloc, bounded)

- Rescue scan: `maxActiveCages(6) × zombieMaxAlive(70)` worst = 420 checks (only for
  `caged` survivors), ≤ every frame. Cheap.
- Turret retarget: `postCount(12) × 70` only on the 4 Hz retarget tick → amortized small.
- Turret fire + projectile integrate: `projMax(48)` integrations + `48 × 70` hit checks
  worst case = 3360 — bounded, but use `projRadius` early-out and break on first hit.
- Barricade `blockAt`: `aliveZombies × barricadeCount` ≤ `70 × 12` = 840 angle ops, OR
  O(1) with the optional occupancy bitmap.
- Instance-matrix writes: ≤ `maxCages + postCount×meshes + projMax` `setMatrixAt` calls,
  all reusing scratch `Matrix4/Quaternion/Euler/Vector3`. One `needsUpdate=true` per mesh.
- Added draw calls ≈ 9, all instanced. No new lights except reusing the `effects` flash
  pool for turret muzzle pings (optional; default uses additive instanced muzzle quad,
  no light) to keep shadow/light cost flat.
```
