# Articulated Zombies — Design Spec

Replaces `public/js/zombies.js`. Renders ~45 alive zombies (+ ragdolls + debris) as
**instanced body parts**: one `THREE.InstancedMesh` per limb part. Each frame we run
forward kinematics over a tiny per-zombie skeleton, compose a world `Matrix4` per part,
and `setMatrixAt(slot)`. ANY zombie count = a fixed, small number of draw calls.

This document is the authority for the FK math, animation formulas, the ragdoll
integrator, dismemberment logic, per-type CONFIG numbers, the exact draw-call count,
and the zero-allocation plan. It matches the existing `ctx` wiring and code style
(`z.x`/`z.zz` ground coords, `kill`/`damageArea`/`hitTest`/`startWave`/`update` API,
`mergeGeometries(THREE, parts)`, `pbrMaterial`, seeded `makeRNG`, pooled effects).

---

## 0. Coordinate / world facts (frozen)

- Street = `y 0`. Zombies walk the street; the player perches on the rooftop (`y 8`)
  and lobs golf balls down. Perimeter ring radius `38` (`CONFIG.buildingRadius`) is
  where they stop and attack the tower. Spawn ring `96` (`CONFIG.spawnRadius`).
- Existing zombie ground position is stored as `z.x` (X) and `z.zz` (Z) — **keep these
  names** so `golf.js` / `main.js` dev HUD keep working unchanged. `z.yaw` faces origin.
- Visual height ~`4.4` (`CONFIG.zombieHeight`), collision radius `1.8` (`CONFIG.zombieRadius`).
- Gravity world constant is `24` (`CONFIG.gravity`); we reuse it for ragdoll/debris.

---

## 1. Skeleton & rest-pose limb dimensions (low-poly humanoid, ~4.4 tall @ scale 1)

A zombie is a kinematic chain of joints. Lengths are in world units at `scale = 1`
(per-type `scale` multiplies everything). Origin of the skeleton is the **feet on the
ground** (root pelvis floats at hip height). All part box geometries are authored so the
part's **local origin is its proximal joint** (top of the bone), the bone extends down
`-Y` by its length; this makes FK a pure parent-joint transform with no per-part offset
fudge. Heights below are measured from ground in rest pose.

```
Joint tree (parent -> child), rest local offset from parent joint (pre-rotation):
  pelvis (root)            world hip pivot at y = 2.05
    spine  -> torso        offset (0, +0.15, 0)  ; torso pivots at lower spine
      neck -> head         offset (0, +1.55, 0)  ; from spine pivot to neck
      shoulderL            offset (+0.62, +1.35, 0)
        elbowL             offset (0, -0.95, 0)   along upper-arm
      shoulderR            offset (-0.62, +1.35, 0)
        elbowR             offset (0, -0.95, 0)
    hipL                   offset (+0.34, -0.20, 0)
      kneeL                offset (0, -1.05, 0)   along thigh
    hipR                   offset (-0.34, -0.20, 0)
      kneeR                offset (0, -1.05, 0)
```

### Part list & box geometry (11 parts → 11 instanced meshes)

| slot | part        | geometry (BoxGeometry / Sphere)        | bone length L | local pivot (origin) |
|------|-------------|----------------------------------------|---------------|----------------------|
| 0    | head        | Sphere r 0.5 (12,10)                   | n/a           | neck (sphere centered +0.5 below pivot via baked offset) |
| 1    | torso       | Box 1.30 × 1.55 × 0.78                  | 1.55          | lower-spine joint, extends +Y |
| 2    | pelvis      | Box 1.15 × 0.55 × 0.72                  | 0.55          | hip pivot, centered |
| 3    | upperArmL   | Box 0.34 × 0.98 × 0.34                  | 0.95          | shoulderL, extends -Y |
| 4    | upperArmR   | Box 0.34 × 0.98 × 0.34                  | 0.95          | shoulderR, extends -Y |
| 5    | lowerArmL   | Box 0.30 × 0.92 × 0.30                  | 0.90          | elbowL, extends -Y |
| 6    | lowerArmR   | Box 0.30 × 0.92 × 0.30                  | 0.90          | elbowR, extends -Y |
| 7    | upperLegL   | Box 0.42 × 1.10 × 0.44                  | 1.05          | hipL, extends -Y |
| 8    | upperLegR   | Box 0.42 × 1.10 × 0.44                  | 1.05          | hipR, extends -Y |
| 9    | lowerLegL   | Box 0.40 × 1.05 × 0.42                  | 1.00          | kneeL, extends -Y |
| 10   | lowerLegR   | Box 0.40 × 1.05 × 0.42                  | 1.00          | kneeR, extends -Y |

Authoring each part geometry: build the `BoxGeometry`, then bake a translation so the box
centre sits at `-L/2` on local Y (i.e. local origin = top of bone). For `torso` the box
extends `+Y` so bake `+L/2`. For `head` the sphere is baked `-0.5` so its origin is the
neck pivot. For `pelvis` no bake (centered). Bake with `geo.translate(...)` once at build
time — this is the SAME trick as the old `mergeGeometries` matrices, but per-part.

The instanced material is `pbrMaterial(THREE, ctx.assets.zombie, {roughness:0.9})` shared
by all 11 meshes (one material, reused). Per-instance tint via `setColorAt` as today.

---

## 2. Forward kinematics (per zombie, per frame) — no allocation

We do NOT build a `THREE.Object3D` hierarchy (too many objects, GC). We compute each
joint's **world matrix** by chaining parent world-matrix * local(joint rotation+offset),
using a handful of reusable scratch `Matrix4`/`Quaternion`/`Vector3`/`Euler`.

State driving FK is a compact per-joint angle set (radians) produced by the animator
(section 3). Joints we actually rotate:

```
spineBend         (torso pitch forward, hunched)         -> torso part
headYaw, headPitch(head tracks player)                   -> head part
shL.pitch, shL.roll  (shoulder swing fwd, arm out)       -> upperArmL/lowerArmL chain
shR.pitch, shR.roll
elbowL, elbowR    (flex, always >=0 forward reach)
hipL.pitch, hipR.pitch (leg swing)                       -> upper/lower leg chains
kneeL, kneeR      (flex, >=0)
```

### Matrix chain (reuse `mRoot, mJoint, mPart`, `q`, `e`, `v`):

```
// ROOT: position the pelvis pivot in the world.
rootPos = (z.x, hipHeight*scale + bob, z.zz)         // hipHeight rest = 2.05
rootQuat = Euler(0, z.yaw, lean)                     // lean = side sway
mRoot.compose(rootPos, rootQuat, (scale,scale,scale))

// PELVIS part (slot 2): mRoot * localPelvis(rotation=0)  -> setMatrixAt(2)
// SPINE/TORSO (slot 1):
mJoint = mRoot * T(0,0.15,0) * R_x(spineBend)
torso world = mJoint                                 -> setMatrixAt(1)
// HEAD (slot 0): from torso joint up to neck, then head yaw/pitch
mHead = mJoint * T(0,1.55,0) * R_y(headYaw) * R_x(headPitch)  -> setMatrixAt(0)
// SHOULDER+UPPER ARM L (slot 3):
mShL = mJoint * T(0.62,1.35,0) * R(zRoll=shL.roll, xPitch=shL.pitch)
upperArmL world = mShL                               -> setMatrixAt(3)
// LOWER ARM L (slot 5): down the upper arm, then elbow flex
mElL = mShL * T(0,-0.95,0) * R_x(elbowL)
lowerArmL world = mElL                               -> setMatrixAt(5)
// (mirror for R: slots 4,6 with shoulder offset -0.62)
// HIP+UPPER LEG L (slot 7):
mHipL = mRoot * T(0.34,-0.20,0) * R_x(hipL.pitch)
upperLegL world = mHipL                              -> setMatrixAt(7)
// LOWER LEG L (slot 9):
mKnL = mHipL * T(0,-1.05,0) * R_x(kneeL)
lowerLegL world = mKnL                               -> setMatrixAt(9)
// (mirror for R: slots 8,10)
```

Implementation detail (no-alloc): we keep ONE `Matrix4` per *depth level* we need to
remember (`mRoot`, `mJoint` for torso-rooted children, `mShL/mShR/mHipL/mHipR` for the
limb-proximal frames, plus `mPart` scratch for the leaf). Local transforms are built by
`mPart.compose(vOffset.set(...), q.setFromEuler(e.set(rx,ry,rz)), ONE)` then
`mPart.multiplyMatrices(parentWorld, mPart)`. Since `scale` is baked into `mRoot`, child
multiplies inherit it — limb offsets must therefore be the *unscaled* rest offsets (they
get scaled by the root). That is exactly why offsets above are authored at scale 1.

`setMatrixAt(slot, mPart)` writes into the per-part InstancedMesh at the zombie's index
`i`. Slot index within each part mesh == the zombie's array index `i` (stable mapping:
zombie `i` always uses instance `i` in every part mesh). Dead/empty zombies write the
`_hidden` zero-scale matrix to every part (as the old code did for the single mesh).

After the loop: set `needsUpdate = true` on all 11 `instanceMatrix` buffers ONCE.

---

## 3. Procedural animation formulas

Each zombie has `phase` (per-zombie offset, set at spawn) and a `gait` cycle rate.
Let `t = z.phase` advanced each frame by `z.phase += dt * cycleRate`. Movement state ∈
{`walk`, `run`, `attack`, `flinch`}. Anim outputs the joint angles consumed by FK.

Common terms: `s = sin(t)`, `c = cos(t)`, `s2 = sin(2t)`.

### Walk / shuffle (Shambler default)
```
cycleRate   = 4.0 + speed*0.35           // slow lurch
bob         = abs(sin(t)) * 0.10*scale - 0.05   // vertical hip bob
lean        = sin(t*0.5) * 0.10          // side sway (z-roll of root)
spineBend   = 0.42 + sin(t*0.5)*0.05     // permanent hunch + tiny breathe
// legs swing out of phase
hipL.pitch  =  sin(t)        * 0.55
hipR.pitch  =  sin(t+PI)     * 0.55
kneeL       =  max(0, -sin(t)     ) * 0.9 + 0.15   // bend on the back-swing
kneeR       =  max(0, -sin(t+PI)  ) * 0.9 + 0.15
// arms reach forward (zombie pose) and counter-swing the legs
shBase      = -1.15                       // raise both arms forward (-x pitch)
shL.pitch   = shBase + sin(t+PI)*0.18
shR.pitch   = shBase + sin(t)   *0.18
shL.roll    = -0.18 ; shR.roll = 0.18     // arms splayed slightly out
elbowL      = 0.55 + sin(t)*0.10          // permanently bent claw
elbowR      = 0.55 + sin(t+PI)*0.10
```

### Run (Runner) — same structure, hotter numbers
```
cycleRate   = 8.5 + speed*0.5
bob         = abs(sin(t)) * 0.16*scale
spineBend   = 0.62 + sin(t*0.5)*0.04      // leaning hard into the sprint
hip*.pitch  amplitude 1.05  (longer stride)
knee*       amplitude 1.4  (high knees)
shBase      = -0.6 ; arm swing amplitude 0.9 (pumping, not reaching)
elbow*      = 1.1  (tight, pumping)
```

### Attack lunge (when `atBase`, i.e. dist <= perimeter)
A one-shot-ish ping-pong driven by `z.atkT` advanced each frame, looping every
`atkPeriod = 1.1s`. `u = atkT/atkPeriod`, `lunge = sin(u*PI)` (0→1→0).
```
cycleRate   = 0 (feet planted)            // stop the walk cycle
spineBend   = 0.40 + lunge*0.45           // rear back then thrust
shBase      = -1.9 - lunge*0.6            // arms swing up overhead then down/forward
shL.pitch   = shBase ; shR.pitch = shBase
elbowL/R    = 0.3 + (1-lunge)*0.8         // extend on the strike
headPitch   = lunge*0.3                   // head snaps down toward target
// small forward foot stomp
hipL.pitch  = lunge*0.25 ; hipR.pitch = -lunge*0.15
```
The damage tick to the tower fires on the strike apex (see §6).

### Flinch (hit reaction) — overlays the current state for `flinchT` seconds
When a non-lethal hit lands (`z.hp > 0` after damage), set `z.flinchT = 0.22`. While
`flinchT > 0` (decremented by dt), blend a recoil onto spine/head/arms:
```
k = flinchT / 0.22                        // 1 -> 0
spineBend += k * 0.5 * hitSign            // jerk back from the hit direction
headPitch += k * 0.4
shL.pitch += k * 0.5 ; shR.pitch += k*0.5 // arms fly up
cycleRate *= (1 - 0.7*k)                  // stagger / slow the walk
```
`hitSign` = sign of dot(hitDir, facing) so it recoils away from the impact.

### Head tracking
`headYaw` eases toward `angleDelta(z.yaw, angleToPlayer)` clamped to ±0.7 rad; the player
is the rooftop perch at world `(0, 9, 0)`-ish, so target = `atan2(playerX - z.x,
playerZ - z.zz) - z.yaw`. `headPitch` eases toward a slight up-look `-0.25` (looking up at
the rooftop) plus the attack/flinch additions. Use `damp(cur, tgt, 8, dt)` from utils.

All the above are pure `Math.sin/cos` — zero allocation, evaluated into the per-zombie
joint scratch struct (preallocated, see §7).

---

## 4. Types (Shambler / Runner / Brute)

Per-type table → stored in `CONFIG.zombieTypes`. `health` is in **hits** (ball = 1 dmg,
explosion = 5 dmg, runover = 4 dmg — see §6). `weight` 0..1 = knockback resistance.

| type     | speedMul | scale | health | gait   | weight | spawnWeight | tint            |
|----------|----------|-------|--------|--------|--------|-------------|-----------------|
| shambler | 1.00     | 1.00  | 2      | walk   | 0.0    | 0.62        | green-grey      |
| runner   | 1.85     | 0.82  | 1      | run    | 0.0    | 0.26        | paler, leaner   |
| brute    | 0.55     | 1.55  | 6      | walk   | 0.85   | 0.12        | darker, ruddy   |

- **Shambler**: the baseline. Uses `waveSpeed` directly.
- **Runner**: lean (scale 0.82 but legs/arms use higher swing amplitude), runs the run
  cycle, dies in 1 hit, but is fast and reaches the perimeter quickly → pressure unit.
- **Brute**: big (1.55× → ~6.8 tall), slow, 6 hits, resists knockback (`weight` damps the
  ragdoll/runover impulse), deals `3×` tower damage when attacking. Topple is heavier
  (slower settle, bigger ground impact dust).

Type selection at spawn: weighted pick using the seeded RNG; the Brute/Runner mix ramps
with wave number (more runners + the first brute starting wave 3) via:
```
runnerChance = clamp(0.12 + wave*0.04, 0, 0.45)
bruteChance  = wave >= 3 ? clamp(0.04 + (wave-3)*0.025, 0, 0.22) : 0
roll RNG: brute first, then runner, else shambler
```
Per-type `speed = waveSpeed * speedMul * rng.range(0.9,1.1)`.

Surge waves (`CONFIG.surgeEvery`) bump count ×1.5 and shift the mix toward runners
(`runnerChance += 0.15`).

---

## 5. Ragdoll death

On `kill(z, opts)` the zombie flips from `alive` to a **ragdoll** state (not the old
fade-topple). We do NOT run a full constraint solver — too costly for ~45 bodies. Instead
a **lightweight per-part rigid-ish ragdoll** that looks physical:

State per dying zombie (preallocated `z.rag`):
- `tBody` whole-body topple: a single angular spring that rotates the whole skeleton about
  a horizontal axis (the topple direction = opposite the hit / away from impulse). The
  skeleton keeps its last anim pose but freezes it, then the **root** gains:
  - `rag.angVel` (rad/s) about the topple axis, `rag.angle` integrated.
  - `rag.vy`, `rag.vx`, `rag.vz` linear velocity of the root (from kill impulse).
  - `rag.y` root height; collides with ground.
- **Per-limb lag**: each limb gets a small secondary angle `limbLag[j]` driven by a damped
  spring that trails the body's angular velocity (so arms/legs flop a beat behind the
  torso). `limbLag[j] += (-k*limbLag[j] - d*limbVel[j]) ... ` cheap 1-DOF spring per joint.

### Integrator (per dying zombie, per frame)
```
g = CONFIG.gravity
// linear root
rag.vy -= g*dt
rag.x += rag.vx*dt ; rag.y += rag.vy*dt ; rag.z += rag.vz*dt
// ground collide for root height (root pivot rests ~0.6*scale off ground when toppled)
if (rag.y < 0.6*scale) { rag.y = 0.6*scale; rag.vy *= -0.18; rag.vx*=0.6; rag.vz*=0.6;
                         rag.angVel *= 0.5; if(first contact) effects.dust + thud }
// angular topple
rag.angVel -= sign(rag.angVel)* (rag.onGround? 6 : 1.5) *dt   // damping, stronger grounded
rag.angle  += rag.angVel*dt
rag.angle   = clamp(rag.angle, -HALF_PI*1.05, HALF_PI*1.05)   // flat on the ground
// per-limb lag springs (j over arms+legs+head+spine)
for each j: limbVel[j] += (rag.angVel - limbVel[j])*8*dt - limbLag[j]*40*dt;
            limbLag[j] += limbVel[j]*dt;  limbLag[j]=clamp(limbLag[j], -0.7, 0.7)
```
FK then runs the SAME chain as §2, except: the root quaternion gets the topple rotation
(`Euler(rag.angle about topple-local-x, z.yaw, lean→0)`), root position uses
`rag.x/rag.y/rag.zz`, and each joint angle = `frozenPoseAngle[j] + limbLag[j]`. So the
ragdoll writes into the exact same 11 instanced part meshes — no new draw calls.

### Settle + fade
- `rag.settleT` increments once `onGround && |angVel|<0.15 && |vy|<0.4`. After
  `CONFIG.ragdollSettle = 1.6s` settled, begin fade: `rag.fade` 1→0 over
  `CONFIG.ragdollFade = 1.2s`. Fade is done by **shrinking scale toward 0** in the root
  matrix (instanced; we can't cheaply alpha-fade per instance without a custom shader, and
  the corpse sinking+shrinking reads fine and matches the old `sc = 1 - t*0.15` shrink).
  Also sink `rag.y -= dt*0.5` during fade so it melts into the asphalt.
- When `fade<=0`: free the slot (write `_hidden` to all 11 parts, mark `z.dying=false`).
- Hard cap concurrent ragdolls at `CONFIG.maxRagdolls = 18`; if exceeded when a new kill
  happens, the **oldest** ragdoll is force-faded instantly (so perf stays bounded even in
  a big explosion). Explosion kills that exceed the cap just green-puff and vanish.

---

## 6. Multi-hit health, damage routing, & gore hooks

`z.hp` initialized to type health at spawn. Damage sources call into one internal
`_damage(z, dmg, dirX, dirZ, opts)` helper:

```
_damage(z, dmg, dx, dz, opts):
  if (!z.alive) return false
  z.hp -= dmg
  // knockback (scaled by 1-weight); shoves ground pos a touch + sets flinch
  kb = opts.knockback ?? dmg*0.4
  push = kb * (1 - type.weight)
  z.x += dx*push*0.15 ; z.zz += dz*push*0.15      // tiny shove (visual)
  if (z.hp <= 0) { this.kill(z, {dirX:dx, dirZ:dz, impulse: kb, dismember: opts.dismember}); return true }
  z.flinchT = 0.22 ; z.hitSign = sign(dx*sin(z.yaw)+dz*cos(z.yaw))
  ctx.effects.hit(p) ; maybe small blood puff
  return false   // survived
```

### Public API mapping (keeps golf.js working, adds richness)
- **`hitTest(p, ballR) -> z|null`** — unchanged signature. Keeps the `p.y > 5.2` early
  out (balls higher than the zombies' reach can't hit). Iterates alive zombies, tests
  `dx²+dz² < (ballR + zombieRadius*scale)²`. Returns the zombie object (golf.js then calls
  `kill` or — see below — we change golf.js to call `damageBall`). **Compat:** we keep
  `hitTest` returning the zombie; golf.js currently calls `z.kill(hit)` for a normal ball.
  To get multi-hit we expose **`hitBall(z, p, ballVel) -> {killed}`** and update golf.js's
  single line `z.kill(hit)` → `z.hitBall(hit, p, b.vel)`. A normal ball does **1 dmg**;
  brutes therefore take 6 balls. (If we must not touch golf.js, `kill` can be made to do
  1 dmg and only actually die at hp<=0 — but updating the one call site is cleaner.)
- **`damageArea(pos, r, opts) -> killedCount`** — explosion path. Each zombie in radius
  takes `opts.dmg ?? 5` damage with knockback away from `pos` and `dismember:true`. Returns
  the number that **died** (so `golf.explode` scoring is unchanged). Brutes survive a
  single blast edge; center blasts kill them.
- **`kill(z, opts)`** — now starts the ragdoll (was: fade). `opts = {dirX,dirZ,impulse,
  dismember, silent}`. Sets ragdoll velocities from impulse + a little upward pop, picks a
  topple axis from the hit direction, optionally triggers dismemberment (§7), reports the
  score? **No** — scoring stays in golf.js (`addScore` on the caller side) to preserve the
  current combo logic. `kill` only does visuals + state + gore + `ctx.audio`/`effects`.
  It DOES decrement the alive accounting and is idempotent (guards `!z.alive`).
- **`runOver(z, impulseVec)`** — vehicle hook (cart). Applies `_damage(z, 4, …)` with a
  big knockback = horizontal launch from `impulseVec`; on death forces `dismember:true`
  and a flatter, faster topple (flung). NOTE: in current geometry the cart is on the roof
  (`y 8`) and zombies are on the street, so nothing calls this yet — it is provided for a
  future street-level / ramp mode and is exercised by the dev console. It is a thin wrapper
  so it costs nothing when unused.
- **`startWave(wave) -> {count, surge}`** — unchanged contract (main.js reads `count`,
  `surge`). Internally also seeds the per-wave type-mix chances (§4).
- **`update(dt)`** — spawn pacing (unchanged cadence), then the big per-zombie loop doing
  anim→FK for alive, integrator→FK for ragdolls, integrator for debris; tower damage tick;
  groans; wave-cleared check (unchanged). Writes all instanceMatrix buffers once.

### Gore hooks into existing systems (no new draw calls for blood; reuse Effects)
- Existing `ctx.effects.greenPuff(p)` = the sickly-green death puff (reuse on kill).
- Existing `ctx.effects.hit(p)` = the white impact spark on a non-lethal hit.
- Add to **effects.js** a `bloodSpray(p, dirX, dirZ)` that emits ~10 dark-red particles
  biased along the hit direction (it's just another `_emit` call — one method, no new
  pool, no new draw call). Called on lethal ball/explosion hits and on dismemberment.
- Tower attack damage tick: in the attack-apex frame call `ctx.game.damageTower(amount)`
  where `amount = CONFIG.zombieDamage * (type==='brute'?3:1) * dt` accumulated; preserve
  the old behavior of summing all attackers and one `damageTower` call per frame.
- `ctx.audio.groan()` rate-limited as today; brutes optionally a lower groan (reuse
  `groan`, no new audio node needed).

---

## 7. Dismemberment + debris pool

On a sufficiently violent kill (`opts.dismember` from explosion / runover / a high-speed
ball) detach **1–3 limbs**. "Detachable" leaf parts: head(0), lowerArmL/R(5,6),
lowerLegL/R(9,10) (and upperArm/upperLeg for explosions). When a limb detaches:

1. We **hide that part's instance** on the parent zombie (write `_hidden` to that one
   part slot for this zombie) so the corpse looks mutilated.
2. We **spawn a debris piece** into a separate **debris instanced pool**. The debris pool
   is ONE additional `InstancedMesh` using a single generic chunk geometry (a small box,
   tinted zombie-green) — **+1 draw call total, regardless of debris count**. (We do NOT
   add 11 debris part-meshes; visual fidelity of which-limb-it-was isn't worth 11 more
   draw calls. A tumbling green chunk reads fine for gore at this scale.)
   - Alternative considered: render debris by reusing the matching part mesh's spare
     instance slots. Rejected because slot↔zombie mapping is 1:1 and stable; carving out
     debris slots complicates the mapping. The single chunk pool is simpler & bounded.

Debris pool: `CONFIG.maxDebris = 60` instances. Each debris struct:
`{active, x,y,z, vx,vy,vz, ax,ay,az (angVel), rx,ry,rz (orientation), life}`.
Integrator per frame:
```
vy -= gravity*dt ; x+=vx*dt; y+=vy*dt; z+=vz*dt
if (y < 0.3) { y=0.3; vy*=-0.25; vx*=0.7; vz*=0.7; ay*=0.6; if(first) effects.dust }
rx+=ax*dt; ry+=ay*dt; rz+=az*dt
life -= dt ; if(life<=0 || settled long) recycle -> _hidden
```
Composed into the debris InstancedMesh with the shared scratch matrix. Initial velocity =
explosion/impulse direction × speed + random spread + upward pop; angVel random.

Dismember count: explosion center = up to 3, runover = 1–2, fast ball = 1 (chance based on
ball speed). Each detach also fires `effects.bloodSpray`.

---

## 8. Exact draw-call count

| mesh                                   | draw calls |
|----------------------------------------|------------|
| 11 body-part `InstancedMesh` (head…lowerLegR) | 11 |
| 1 debris-chunk `InstancedMesh`         | 1          |
| **Total for the entire horde + ragdolls + debris** | **12** |

This is **constant** for any number of zombies up to `maxAlive`, any number of
simultaneous ragdolls up to `maxRagdolls`, and any debris up to `maxDebris`. (Old system
was 1 draw call but a rigid blob; the articulated upgrade costs +11 draw calls flat — well
within "LOW draw calls".) No shadows on these meshes (matches old `castShadow=false`) to
keep the shadow pass cheap; the cart/golfer keep their crisp shadows.

Triangle budget: 11 boxes (12 tris each) + 1 sphere(12,10 ≈ 200 tris) per zombie ≈ ~330
tris × 45 ≈ ~15k tris for the horde — trivial.

---

## 9. Zero-allocation plan (per-frame loops)

- All scratch reused, created ONCE in constructor: `_m, _mRoot, _mJoint, _mShL, _mShR,
  _mHipL, _mHipR, _mPart` (Matrix4), `_q` (Quaternion), `_e` (Euler), `_v` (Vector3),
  `_hidden` (zero-scale Matrix4), `_player` (Vector3 reused for player pos target).
- Per-zombie state is a **preallocated plain object** in `this.z[i]` extended with fixed
  numeric fields (no arrays grown at runtime): `hp, type(idx), scale, speedMul, gait,
  phase, atkT, flinchT, hitSign, atBase`, a fixed-size `pose` object holding the ~16 joint
  angles (named scalar fields, not an array → no indexing alloc), and a fixed `rag` object
  with `angle,angVel,x,y,z,vx,vy,vz,onGround,settleT,fade` plus a fixed-length
  `Float32Array(8)` `limbLag` + `Float32Array(8)` `limbVel` allocated ONCE at construction.
- Debris is a preallocated array of `maxDebris` structs (numeric fields), allocated once.
- Type table read by integer `type` index into a frozen `CONFIG.zombieTypes` array — no
  object creation, no string compares in the hot loop (string `type` only used at spawn
  for the API/audio; hot loop uses the index + cached per-type numbers copied onto `z`).
- `Array.prototype.find` for an empty spawn slot runs only on spawn ticks (≤1/frame), not
  in the per-zombie loop. The per-zombie loop is a single `for` over `this.max` with no
  closures, no `Math.hypot` in the inner tight path where avoidable (use `dx*dx+dz*dz`).
- `instanceMatrix.needsUpdate = true` set once per part mesh per frame after the loop;
  `instanceColor` only updated when a tint actually changes (spawn / dismember), never
  every frame.
- `setMatrixAt`/`setColorAt` write into existing buffers (no alloc). Reusing one
  `THREE.Color` scratch for tint writes.

---

## 10. CONFIG additions (append to `CONFIG` in config.js)

```js
// ---- Zombie types (index order = spawn id; numbers tuned for ~45 alive) ----
zombieTypes: [
  { name:'shambler', speedMul:1.00, scale:1.00, health:2, gait:'walk', weight:0.0,  tintR:0.78, tintG:0.86, tintB:0.62 },
  { name:'runner',   speedMul:1.85, scale:0.82, health:1, gait:'run',  weight:0.0,  tintR:0.86, tintG:0.88, tintB:0.74 },
  { name:'brute',    speedMul:0.55, scale:1.55, health:6, gait:'walk', weight:0.85, tintR:0.62, tintG:0.55, tintB:0.45 },
],
zombieMaxAlive: 48,        // (was 70) tuned for articulated cost; ~45 target
maxRagdolls: 18,           // concurrent dying bodies before oldest is force-faded
ragdollSettle: 1.6,        // s settled before fade starts
ragdollFade: 1.2,          // s shrink-sink fade
maxDebris: 60,             // dismembered chunk instances (one extra draw call)
ballDamage: 1,             // dmg a normal golf ball deals
explosionDamage: 5,        // dmg an explosion deals per zombie in radius
runoverDamage: 4,          // dmg the cart deals
bruteDamageMul: 3,         // tower-damage multiplier for brutes at the perimeter
dismemberBallSpeed: 30,    // ball speed above which a lethal ball can sever a limb
headTrackMax: 0.7,         // rad clamp on head yaw tracking the player
```
(`zombieRadius`, `zombieHeight`, `zombieBaseSpeed`, `zombieSpeedPerWave`, wave numbers,
`zombieDamage`, `surgeEvery` all retained.)

---

## 11. Public API (signatures + lifecycle)

```js
class Zombies {
  constructor(scene, ctx)        // builds 11 part meshes + 1 debris mesh, pools, scratch
  get aliveCount()               // count of z.alive (unchanged)
  startWave(wave) -> {count, surge}   // unchanged contract; seeds per-wave type mix
  spawn(type)                    // type: 'shambler'|'runner'|'brute' (optional; random if omitted)
                                 //   -> finds free slot, sets pos on spawn ring, hp/scale/speed
  hitTest(p, ballR) -> z|null    // unchanged: nearest-ish alive zombie overlapping p
  hitBall(z, p, ballVel) -> bool // 1 dmg (+sever chance if fast); returns true if killed
  damageArea(pos, r, opts) -> killedCount   // explosion; opts.dmg default 5, dismember:true
  kill(z, opts) -> void          // start ragdoll; opts {dirX,dirZ,impulse,dismember,silent}
  runOver(z, impulseVec) -> void // vehicle hook; big knockback + dismember + flat topple
  reset() -> void                // all slots dead, debris cleared, hide every instance
  update(dt) -> void             // spawn + anim/FK + ragdoll + debris + tower dmg + groans + wave-clear
}
```

### golf.js touch-points (minimal edits)
- `golf.update` ball-vs-zombie: replace `z.kill(hit)` with
  `const died = z.hitBall(hit, p, b.vel); if (died) { game.addScore(CONFIG.scorePerKill,false); }`
  Move the `addScore` to fire only on death (so plowing a brute doesn't over-score). Keep
  `eff.hit(p)` / `audio.hit()` / the `b.vel.multiplyScalar(0.62)` plow-through as-is.
- `golf.explode` keeps calling `z.damageArea(pos, CONFIG.explosionRadius)` (now passes
  `{dmg:CONFIG.explosionDamage, dismember:true}`) and uses the returned killed count for
  combo scoring exactly as today.

### Lifecycle / integration
- Constructed in `main.js` as `ctx.zombies = new Zombies(scene, ctx)` (unchanged line).
- `main.js` `step(dt)` calls `ctx.zombies.update(dt)` (unchanged).
- `_reset()` calls `ctx.zombies.reset()` (unchanged).
- Reads from ctx: `ctx.game.damageTower`, `ctx.game.onWaveCleared`, `ctx.effects.*`,
  `ctx.audio.groan`, `ctx.player.pos` (NEW: for head tracking — read-only).
- Reports to game scoring via the caller (golf.js) as today — `kill` itself does not score,
  preserving the existing combo math.

---

## 12. Risks / mitigations

- **FK cost**: 45 zombies × ~7 matrix multiplies + ~16 sin/cos ≈ a few thousand ops/frame
  — fine at 60Hz. Mitigation if needed: skip head-track easing for zombies beyond a
  distance, or run anim at 30Hz (alternate frames) since they're far/small.
- **InstanceColor churn**: only write on spawn/dismember, never per frame.
- **Ragdoll explosion spikes**: capped by `maxRagdolls` (force-fade oldest); debris capped
  by `maxDebris` (recycle). Worst case is bounded and constant draw calls.
- **Compat with golf.js scoring**: the one behavioral change (score on death, not on every
  ball touch) is intentional for multi-hit; documented in §11 so the integration edit is
  explicit. If untouched, fallback: `kill` does 1 dmg internally — but then explosions need
  to call `kill` 5× which is ugly; the `_damage` helper is the clean path.
- **Fade via scale-shrink** (not alpha) means corpses pop-shrink rather than dissolve;
  acceptable and matches the old shrink. True alpha fade would need a per-instance opacity
  attribute + custom `onBeforeCompile` — out of scope, noted as a future option.
- **`zombieMaxAlive` lowered 70→48**: keeps the articulated horde + ragdolls + debris
  within frame budget on mid hardware while still satisfying the "~45 alive" target.
