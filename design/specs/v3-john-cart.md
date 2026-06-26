# JOHN On-Foot + Cart-as-Upgrade — Design Spec (v3)

Reworks `public/js/player.js` (the `Player` class) from "you ARE a drivable cart with a
tiny golfer" into "**you are JOHN**, a detailed humanoid who walks the rooftop on foot and
tees off, and the **golf cart is a purchasable upgrade** he can mount." Touches the chase
camera in `public/js/golf.js` (foot vs cart blend, `shootOrigin`), `main.js`
(`step` order, `snapshot`, purchase wiring), `hud.js` (foot/cart HUD swap + buy prompt),
`config.js` (walk + cart-cost tunables), `input.js` (mount/exit key), and `strings.js`.
It **coordinates with** the shop-economy spec (`design/specs/shop-economy.md`, sibling, may
not exist yet) for *where the cart purchase is triggered and what currency pays for it*.

This spec is the authority for: the **`mode` (`'foot'|'cart'`) Player state machine**, the
**procedural walk cycle + detailed JOHN model build**, **mount/exit semantics**, how
**`shootOrigin`, camera ground-blend, run-over, and the ramp degrade gracefully on foot**,
the **purchase trigger contract** with the shop, and all CONFIG additions.

It matches existing conventions: shared `ctx`, fixed 60 Hz `step(dt)`, **zero allocation in
per-frame loops** (reuse `Vector3`/`Matrix4`/`Euler`/`Quaternion`), `z.x`/`z.zz` zombie
ground coords, `clamp`/`lerp`/`damp` from `utils.js`, pooled `ctx.effects`,
`pbrMaterial(THREE, set, opts)` materials, strings in `strings.js`, **no AI assets**
(everything procedural). It supersedes the parts of `design/specs/vehicle.md` that assume
the cart is always present and always controlled; the cart *physics/run-over/ramp* sections
of that spec remain authoritative and are reused verbatim **when `mode === 'cart'`**.

---

## 0. Coordinate / world facts (frozen — unchanged)

- Street `y 0`. Rooftop drivable slab top face = `rooftopHeight + 1.2 = 9.2` (`this.roofTop`).
- `Player.pos` is the **ground-contact origin** of whatever John is standing on/in
  (roof surface, ramp surface, or street). Same meaning in both modes.
- Rooftop slab spans `±17` in X/Z (`towerFootprint/2 = (rooftopSize+4)/2 = 17`); parapets at
  `±(half+2)=±17`. Roof drivable/walkable clamp `lim = (rooftopSize/2+2) − 0.9 = 16.1`.
- The **ramp** (region 1) bridges roof→street on the `+Z` edge through the one open parapet
  gap; street is region 0, roof is region 2. The `_surfaceAt(x,z)` region function in
  `player.js` is unchanged and used by BOTH modes.
- Perimeter ring (zombies stop & attack) radius `38`; spawn `96`; ground half-extent `380`.
- **Camera/visibility constraint (HARD):** the rooftop is height 8 *on purpose* so the
  elevated chase camera clears the parapet and sees the perimeter ring (38) and street
  horde. JOHN on foot does **not** change tower height; the camera baseline is unchanged
  (`camHeight 15`, `camDistance 15`). Foot mode only nudges the *blend* (see §6), never
  raises the building. **Do not raise the tower.**

---

## 1. The big idea / behavior summary

| | **FOOT** (default, before purchase) | **CART** (after purchase, mounted) |
|---|---|---|
| Avatar | JOHN, detailed humanoid, full body visible | JOHN seated in the cart (existing cart + a simplified seated JOHN) |
| WASD | **walks** John around the roof (procedural walk cycle, modest speed) | drives the cart (existing arcade physics) |
| Reach | **roof only** (region 2). Cannot enter ramp/street. | roof + ramp + street (unchanged) |
| Run-over | **none** (John has no mass/speed to flatten zombies) | unchanged (`runOverPass`) |
| `shootOrigin` | from John's hands/club height while standing | from the cart seat (unchanged height) |
| Camera | elevated chase, foot variant (see §6) | unchanged ground-blend chase |
| Cart health / boost | **n/a** — HUD hides cart bar, shows BUY prompt | unchanged |
| Aim + shoot | yes (on foot) | yes (in cart) |

The player **always** aims with the mouse and tees off (golf is the core verb in both
modes). WASD is the only control that changes meaning. Buying the cart is a one-time
upgrade per run; once bought, John can optionally **exit/re-enter** the parked cart.

---

## 2. Player API changes (`public/js/player.js`)

### 2.1 New / changed state (constructor)

```js
this.mode = 'foot';          // 'foot' | 'cart'  — the master switch
this.cartOwned = false;      // has the cart been purchased this run?
this.cartMounted = false;    // is John currently in the cart? (only meaningful if owned)
// foot locomotion
this.footSpeed = 0;          // current scalar ground speed on foot (m/s)
this.footHeading = Math.PI;  // facing while walking (separate from cart heading)
this.walkPhase = 0;          // procedural walk-cycle phase (radians)
this._footVel = new THREE.Vector3();   // scratch, reused
this._desired = new THREE.Vector3();   // scratch, reused
// parked-cart bookkeeping (when owned but on foot)
this.cartParkPos = new THREE.Vector3();
this.cartParkHeading = Math.PI;
```

`this.region`, `this.pos`, `this.heading`, `this.health`, `this.boostFuel`, `this.speed`,
`this.swingT`, etc. all remain. In foot mode `this.speed`/`lateralVel`/`boost*` are held at
their idle values and **not** integrated; `this.health` (cart hull) is only meaningful in
cart mode (HUD reads it conditionally — see §8).

### 2.2 Scene graph (two rigs under one root)

Keep the existing `root` group (positioned by `this.pos`, yawed by heading). Under it:

```
root
├─ cartRig   (= today's `bodyTilt` + wheels + bag + seated-John)   visible when mode==='cart' OR (owned && parked)
└─ johnRig   (the new detailed on-foot JOHN)                       visible when mode==='foot'
```

- **`cartRig`** is the existing cart build (body/nose/seat/canopy/posts/wheels/bag/clubs)
  PLUS a *simplified seated JOHN* (reuse the existing small golfer; it stays as the driver).
  Wheels still live on `root` (planted), the rest under the tilt group as today.
- **`johnRig`** is the new full-detail standing model (§3), a child of `root` so it inherits
  position; its **own yaw** is set from `footHeading` (independent of cart `heading`).
- Visibility is toggled in `update()` by setting `this.cartRig.visible` / `this.johnRig.visible`.
  When the cart is **owned but John is on foot**, the cart is rendered **parked** at
  `cartParkPos`/`cartParkHeading` (a separate parked transform, not following `pos`), so John
  can walk away from it and walk back to mount. Implement the parked cart as the SAME
  `cartRig` re-parented to a `cartParkGroup` directly under `scene` (or kept under `root` and
  given an explicit offset) — simplest is a dedicated `this.cartParkGroup = new THREE.Group()`
  added to the scene; `cartRig` is attached to `root` when mounted and to `cartParkGroup`
  when parked. Re-parent on mount/exit only (not per frame), so no per-frame alloc.

### 2.3 Public API (called by main / golf / shop)

```js
get shootOrigin()            // mode-aware (see §5)
get boost01()                // cart fuel ratio; returns 0 on foot
get onFoot()                 // === (this.mode === 'foot')
swing()                      // unchanged: triggers the swing animation on whichever rig is active

mountCart()                  // FOOT→CART. Precondition: cartOwned && cartMounted===false
                             //   && John is within CONFIG.cart.mountRadius of cartParkPos
                             //   && region===2 (on the roof). Snaps pos→cartParkPos,
                             //   heading→cartParkHeading, re-parents cartRig under root,
                             //   sets mode='cart', cartMounted=true. Returns true on success.
exitCart()                   // CART→FOOT. Parks the cart at current pos (cartParkPos/Heading),
                             //   re-parents cartRig under cartParkGroup, places John one step
                             //   to the cart's left on the roof, mode='foot'. Returns true.
purchaseCart()               // marks cartOwned=true and spawns the parked cart next to John
                             //   (cartParkPos = pos + side offset, on the roof). Does NOT
                             //   auto-mount. Idempotent (no-op if already owned).
                             //   Called by the shop AFTER it has charged the player (§7).

update(dt, drive)            // mode dispatch (see §4)
runOverPass(dt)              // EARLY-RETURN when mode!=='cart' (already returns on region 2;
                             //   add `if (this.mode !== 'cart') return;` as the first line)
reset()                      // resets to FOOT, cartOwned=false, cartMounted=false, John at spawn
returnToRoof()               // CART-only recover (drive-the-ramp "R"); on foot it just re-centers
                             //   John on the roof (he can't be off it anyway → near-no-op)
```

### 2.4 `update(dt, drive)` dispatch

```js
update(dt, drive) {
  if (this.mode === 'cart') this._updateCart(dt, drive);   // = today's update() body verbatim
  else                      this._updateFoot(dt, drive);
  this._renderRigs(dt);                                    // visibility + parked cart transform
}
```

`_updateCart` is the **current** `update()` body, moved wholesale (cart physics, bounds,
vertical follow, suspension tilt, wheels, exhaust, hull regen, swing). No behavior change in
cart mode. `_renderRigs` sets `cartRig.visible`/`johnRig.visible`, drives the parked-cart
transform when owned+on-foot, and advances the swing arm on the active rig.

### 2.5 `_updateFoot(dt, drive)` — walking on the roof

Modest, responsive, **not** a vehicle. Direction is taken straight from `drive` mapped into
world space relative to the **aim yaw** (so "W" = walk the way the camera/aim faces, which is
the intuitive third-person convention), with `drive.steer` as strafe. (Alternative: WASD =
world-cardinal; pick aim-relative for feel — see §9 note.)

```
// 1. desired planar velocity from input, aim-relative
const ay = ctx.golf.aimYaw;                       // camera/aim facing
const fwd.x =  Math.sin(ay), fwd.z =  Math.cos(ay);
const right.x = Math.cos(ay), right.z = -Math.sin(ay);
desired = fwd * drive.throttle + right * drive.steer;   // length 0..~1.41, clamp to 1
const inLen = min(1, |desired|);
// 2. smooth accel toward target speed (no momentum drift; arcade-snappy)
targetSpeed = inLen * CONFIG.walk.speed;
footSpeed = damp(footSpeed, targetSpeed, CONFIG.walk.accel, dt);
// 3. face the way you move (only when actually moving)
if (inLen > 0.05) footHeading = damp-angle(footHeading, atan2(desired.x, desired.z), CONFIG.walk.turn, dt);
// 4. integrate position on the roof plane
pos.x += desired.x_norm * footSpeed * dt;
pos.z += desired.z_norm * footSpeed * dt;
```

Use a **shortest-arc angle damp** for heading (lerp along `atan2(sin Δ, cos Δ)`), matching
the survivors/zombie facing convention. `desired.x_norm` is `desired` normalized (guard
zero-length).

**Roof containment (foot, region 2 ONLY):** after integrating, clamp to the walkable roof so
John can never reach the ramp gap or fall off:

```
lim = (rooftopSize/2 + 2) − CONFIG.walk.edgeMargin;     // edgeMargin ~1.0 → ±16
pos.x = clamp(pos.x, -lim, lim);
pos.z = clamp(pos.z, -lim, lim);     // NOTE: clamp BOTH signs of Z, including the ramp side,
                                     // so John stays on the roof and never walks down the ramp.
```

This is the key "degrade gracefully" rule: **on foot, the ramp gap is a wall.** Also avoid
the rooftop AC unit (`world.js` places a 5×3×4 box at `(half-5, …, -(half-5))`): add a cheap
circular push-out so John doesn't clip it (treat as a radius-3.2 obstacle at that XZ; if
inside, push `pos` radially out). Vertical: `pos.y = this.roofTop` (no damp needed — the roof
is flat; a tiny `damp` is fine but unnecessary). `this.region = 2` always on foot.

**Walk cycle (procedural):** advance `walkPhase` by `footSpeed * CONFIG.walk.cadence * dt`
(phase scales with speed so steps don't moonwalk). Drive the johnRig joints from `walkPhase`
(legs counter-swing, arms counter-swing, torso bob + slight lean into acceleration). See §3.3
for joint math. When `footSpeed ≈ 0`, ease `walkPhase` blending toward a neutral idle pose
(don't freeze mid-stride): lerp the per-joint swing amplitude toward 0 with `damp`.

**Set transforms:** `root.position.copy(pos)`; `root.rotation.set(0, 0, 0)` (do **not** yaw
the root by cart heading in foot mode); instead `johnRig.rotation.y = footHeading`. This keeps
the cart-yaw path untouched and lets John's facing be independent.

No boost, no drift, no lateral skid, no suspension tilt, no wheels, no exhaust, no hull regen
on foot. `this.speed`/`lateralVel`/`boostActive` stay 0.

### 2.6 Mount / exit detail

- **`mountCart()`** is invoked from `main.js` on a key press (§ input) **only when**
  `cartOwned && !cartMounted && region===2 && dist(pos, cartParkPos) <= CONFIG.cart.mountRadius`.
  On success: `pos.copy(cartParkPos)`, `heading = cartParkHeading`, re-parent `cartRig` →
  `root`, `mode='cart'`, `cartMounted=true`, zero `speed`/`lateralVel`, play `ctx.audio.pickup()`,
  HUD toast `STR.cartMounted`.
- **`exitCart()`** parks at the current spot: `cartParkPos.copy(pos)`,
  `cartParkHeading = heading`, re-parent `cartRig` → `cartParkGroup` (set its transform once),
  place John on the roof beside the cart (`pos += left * 2.2`, then clamp to roof `lim` and to
  region 2 — if the cart is on the ramp/street, **refuse exit** unless `region===2`; show a
  hint that you can only dismount on the roof). `mode='foot'`, `cartMounted=false`,
  `footHeading = heading`. This keeps the "on foot = roof only" invariant intact.
- **Guard:** never allow `exitCart` while `region !== 2` (you can't get stranded on the
  street with no cart). `mountCart`/`exitCart` are no-ops with a HUD hint when preconditions
  fail.

---

## 3. The detailed JOHN model (procedural, `johnRig`)

Built once in the constructor. ~22–28 small meshes, all `MeshStandardMaterial` (no textures
required; optionally reuse `assets` later). Cast shadows on torso/head/limbs. Articulated via
nested `Group` pivots so the walk cycle (§3.3) and swing (existing) can pose it. Local origin
at the feet (`y 0` = ground contact); total height ~3.4 units to read at the chase distance
(slightly heroic, matching the 4.4-tall zombies' scale language).

### 3.1 Materials (palette — add to `CONFIG.col`)

```
johnSkin:  0xc98d63   (reuse existing golfer skin tone)
johnPolo:  0xe23b3b   (a bold red polo so John reads against golden-hour + green zombies)
johnSlacks:0x2b2f38   (charcoal slacks)
johnCap:   CONFIG.col.pickup (0xff7a1a — matches pickups/perimeter accent)
johnShoe:  0xf2f0ea   (white golf shoes, = cartWhite)
johnGlove: 0xf4f1ea   (off-white glove on the lead hand)
```

Roughness ~0.6–0.7 on cloth/skin, shoes a touch glossier (0.4). Cap brim slightly metalless.

### 3.2 Rig hierarchy + parts

```
johnRig (Group, yaw = footHeading)
└─ hipPivot (y≈1.05)                       ← walk bob applied here
   ├─ pelvis  (Box 0.55 × 0.32 × 0.34, slacks)
   ├─ legL pivot (hip joint, x −0.16)      ← swings about local X (walk)
   │  ├─ thighL (Box 0.20 × 0.55 × 0.22, slacks)
   │  └─ kneeL pivot (y −0.55)
   │     ├─ shinL (Box 0.17 × 0.52 × 0.19, slacks)
   │     └─ shoeL (Box 0.22 × 0.14 × 0.40, shoe; toe +z)
   ├─ legR pivot (x +0.16)  …mirror…
   ├─ spine pivot (y +0.16)               ← slight counter-rotate + lean
   │  ├─ torso (Box 0.62 × 0.66 × 0.40, polo)  + collar trim + 3 buttons (tiny boxes)
   │  ├─ shoulderL pivot (x −0.34, y +0.5)
   │  │  ├─ upperArmL (Box 0.16 × 0.46 × 0.16, polo, short sleeve → skin lower)
   │  │  └─ elbowL pivot (y −0.46) → forearmL (skin) → handL (glove box)
   │  ├─ shoulderR pivot (x +0.34, y +0.5)  → upperArmR → elbowR → forearmR → handR(glove)
   │  └─ neck (y +0.62) → head (Sphere r0.24, skin)
   │     ├─ face: 2 eye dots (tiny dark spheres/boxes), a nose box, a simple mouth box
   │     ├─ ear L/R (small boxes), optional sideburn shade
   │     └─ cap: dome (Sphere top-half r0.27, johnCap) + brim (flattened Box/Cylinder, +z)
   └─ (club is held by the lead hand — see §3.4)
```

This replaces the single sphere-head / box-torso golfer with a face (eyes/nose/mouth), a
brimmed cap, a collared polo with buttons, slacks with knees, and shoes — readable at chase
distance, still cheap. Keep counts modest; merge static sub-parts (face features, buttons,
collar) into the head/torso via `mergeGeometries(THREE, …)` (already imported in survivors)
so John is a handful of draw calls, not 28.

**Frozen pivots for animation** (store refs on `this`):
`this.j = { hip, legL, legR, kneeL, kneeR, spine, shoulderL, shoulderR, elbowL, elbowR, head, armSwing }`
where `armSwing` is the existing swing-arm pivot (the right shoulder used for the golf swing).

### 3.3 Walk cycle (procedural FK from `walkPhase`)

All amplitudes scaled by `amp = damp(prevAmp, clamp(footSpeed / walk.speed, 0, 1), …)` so the
pose blends in/out with movement (no frozen mid-step on stop):

```
const s = Math.sin(walkPhase), c = Math.cos(walkPhase);
// legs counter-swing about X
legL.rotation.x =  s * walk.legSwing * amp;
legR.rotation.x = -s * walk.legSwing * amp;
// knees bend on the back-swing of each leg (one-sided)
kneeL.rotation.x = Math.max(0, -s) * walk.kneeBend * amp;
kneeR.rotation.x = Math.max(0,  s) * walk.kneeBend * amp;
// arms counter-swing to legs (skip the right arm while a swing is playing)
shoulderL.rotation.x = -s * walk.armSwing * amp;
if (swingT < 0) shoulderR.rotation.x = s * walk.armSwing * amp;
// torso bob (twice per stride) + slight forward lean with speed
hip.position.y    = baseHipY + Math.abs(c) * walk.bob * amp;
spine.rotation.x  = walk.lean * amp;
// subtle torso counter-yaw so shoulders rotate against hips
spine.rotation.y  = -s * walk.torsoTwist * amp;
// head stays roughly level (counter the bob a touch)
head.rotation.x   = -spine.rotation.x * 0.5;
```

Tune so a full stride (`walkPhase += π` per step) reads as ~2 steps/sec at full `walk.speed`.
`walkPhase` wraps mod `TAU` to keep the float bounded.

### 3.4 Club / hands holding the current weapon

John holds the **current club** in his gloved hands. The existing swing arm (`armSwing` =
right shoulder pivot) carries a club shaft + club-head mesh exactly like today's golfer, but
now both hands meet on the grip (the left forearm IKs loosely to the grip — approximate by
parenting a thin "left-hand-to-grip" connector, or simply pose `shoulderL`/`elbowL` to a fixed
"hands together" rotation while idle and let it ride the swing). The club geo can reflect the
selected club for flavor (optional): subscribe to `ctx.golf.club.id` and swap the club-head
size/shape on `cycleClub` — **not required**; a single generic club is acceptable for v3.
The swing animation reuses the existing `swingT` ramp driving `armSwing.rotation.x`.

### 3.5 Seated JOHN (cart mode)

In cart mode keep the **existing small seated golfer** that ships with the cart (it already
sits in `cartRig`). Do not render the full standing `johnRig` in the seat (it would clip).
Optionally upgrade the seated golfer's head to the new capped/faced head for continuity —
low priority. The standing `johnRig` is simply hidden in cart mode.

---

## 4. Mode-conditioned systems (graceful degrade)

| System | Cart mode | Foot mode |
|---|---|---|
| `runOverPass(dt)` | runs (region 0/1 only) | **first line `if (mode!=='cart') return;`** → no run-over |
| Ramp / region transitions | full (roof↔ramp↔street) | clamped to roof; ramp gap is a wall (§2.5) |
| `shootOrigin` | cart seat height | John's hands height (§5) |
| Camera ground-blend | full `_g` blend by `pos.y` | `pos.y` is always roofTop → `_g→0` (roof framing), plus foot tweaks (§6) |
| Cart health / claw damage | active (zombies claw the cart on the street) | n/a (John never reaches the street; no claw path) |
| Boost / exhaust / drift / suspension | active | inactive |
| Wheels spin | active | (cart parked → wheels static) |

Because foot mode pins `pos.y = roofTop` and `region = 2`, **every** existing region-gated
path already degrades correctly: `runOverPass` already early-returns on `region===2`; the
camera's `groundTgt = clamp(1 − pos.y/(rooftopHeight+1.2),0,1)` evaluates to ~0 (roof
framing); claw damage only happens when zombies reach the player, which on the roof they
never do (they stop at the perimeter). The only **new** explicit guard required is the
`mode!=='cart'` early-return in `runOverPass` (defense-in-depth) and the foot roof-clamp.

---

## 5. `shootOrigin` (mode-aware)

Today: `this._so.set(pos.x, pos.y + 3.0, pos.z)` (cart seat ≈ 3.0 above the cart origin).
Make it mode-aware so balls launch from John's hands when on foot and from the seat in the
cart:

```js
get shootOrigin() {
  const h = (this.mode === 'cart') ? CONFIG.cart.shootY : CONFIG.walk.shootY;
  return this._so.set(this.pos.x, this.pos.y + h, this.pos.z);
}
```

- `CONFIG.cart.shootY = 3.0` (unchanged value → identical cart behavior; just relocated).
- `CONFIG.walk.shootY ≈ 2.6` (John's hands/club height while standing ≈ chest-high on a
  ~3.4-tall model). Lower than the cart seat, which is correct — on foot you're shorter.

Keep `shootOrigin` returning the reused `this._so` scratch (zero alloc). `golf.js` already
reads `ctx.player.shootOrigin` for fire, preview, muzzle, and camera — all stay correct.
Optionally bias the origin slightly toward John's facing (`+ fwd*0.4`) so balls don't spawn
inside his head when aiming straight; not required (the ball radius/launch clears the head).

---

## 6. Camera behavior on foot (`golf.js` `updateCamera`)

The existing chase camera is driven by `ctx.player.shootOrigin` + `aimYaw/aimPitch` and a
ground factor `_g`. On foot, `pos.y` is always `roofTop`, so `_g→0` and you get the **roof
framing** automatically (the constraint-safe elevated view). No structural change is required;
the camera already "just works." Two small, optional refinements for foot feel:

1. **Tighter foot framing.** John is smaller and slower than the cart, so a slightly closer
   roof framing reads better. Add foot variants and blend by `mode` (not by `pos.y`, which is
   pinned on the roof):
   - `CONFIG.camDistanceFoot ≈ 12` (vs roof `15`), `CONFIG.camHeightFoot ≈ 12` (vs `15`).
   - In `updateCamera`, when `ctx.player.onFoot`, lerp the base `dist/height` toward the foot
     values via a separate smoothed `this._foot01 = damp(this._foot01, onFoot?1:0, 6, dt)` so
     mounting/dismounting eases the camera instead of snapping. Keep the existing ground-blend
     `g` on top (it's ~0 on the roof anyway). **Do not** drop below the parapet-clearing
     height — clamp `height ≥ CONFIG.camHeight*0.7` so the perimeter ring stays visible.
2. **Keep `camMinAbove` clamp.** The existing `camera.position.y ≥ pos.y + camMinAbove`
   guard already prevents the camera from sinking into the roof when aiming up. Unchanged.

The HARD visibility rule is preserved: foot framing only *tightens* the elevated chase; it
never lowers the building or the camera enough to lose the ring/horde. If in doubt, ship foot
mode with the **unchanged** camera (option 1 is polish, not required).

---

## 7. Purchase trigger — coordination with the shop-economy spec

The cart is a **buyable upgrade**. This spec owns the *Player-side effect of the purchase*
(`purchaseCart()` / `mountCart()`); the **shop-economy spec owns the storefront, the
currency, the price gating, and the buy UI**. Contract between them:

### 7.1 What the Player exposes to the shop

```js
ctx.player.cartOwned          // bool — shop reads to show "OWNED" / hide the cart item
ctx.player.purchaseCart()     // shop calls AFTER charging the player; idempotent
ctx.player.mountCart()        // optional: shop/HUD "ENTER CART" action, or bound to a key
```

### 7.2 Currency + price

- **Price:** `CONFIG.cart.cost` (a single integer). Default proposal **`cartCost: 4`**
  (see §9 tuning) denominated in the **existing survivor currency** (`game.survivors`,
  spent via `game.spendSurvivors(n)`), because that is the only in-world currency that
  exists today and the cart is a mid-run power spike comparable to a few turret tiers.
  If the shop-economy spec introduces a *separate* currency (e.g. cash from kills), it
  overrides `CONFIG.cart.cost`'s denomination there — this spec stays agnostic: it only
  requires that *something* calls `purchaseCart()` once payment clears.
- **Game-side helper (in `main.js`)**, mirroring `spendSurvivors`:

  ```js
  buyCart() {
    if (ctx.player.cartOwned) return false;
    if (!this.spendSurvivors(CONFIG.cart.cost)) { hud.flashMsg(STR.cartNoFunds); return false; }
    ctx.player.purchaseCart();
    hud.toast(STR.cartBought, '#' + CONFIG.col.pickup.toString(16));
    ctx.audio.pickup();
    return true;
  }
  ```

  The shop spec wires its buy button / aisle to `game.buyCart()` (or to its own currency
  equivalent that ends in `ctx.player.purchaseCart()`).

### 7.3 Where the buy is triggered (until the shop spec lands)

To keep the game shippable before a full shop exists, provide a **minimal inline trigger**
that the shop spec can later replace:

- A **rooftop "cart stall" / call-button** prop (cheap: reuse a small box + glowing ring near
  the AC unit). When John (on foot) stands within `CONFIG.cart.buyRadius` of it AND can afford
  it, HUD shows a **BUY CART (cost 🧍)** prompt; pressing the **mount/interact key** (§ input)
  calls `game.buyCart()` then immediately `mountCart()`.
- This stall is owned/placed by the shop spec when it exists; until then, place a single
  invisible buy-zone at a fixed roof spot (e.g. near spawn) and gate on radius. Keep it as
  one method `Game._tryBuyPrompt()` so it's trivially relocatable.

**Coordination note for the shop author:** the shop should treat the cart as one SKU whose
`onPurchase` is exactly `ctx.player.purchaseCart()`, and should read `ctx.player.cartOwned`
to render OWNED/sold-out. Do not duplicate cart state in the shop. The mount action is
separate from the purchase (you buy once; you may mount/exit many times).

---

## 8. Integration: main snapshot + HUD

### 8.1 `main.js`

- **`step()` order is unchanged.** `ctx.player.update(dt, input.drive)` and
  `ctx.player.runOverPass?.(dt)` stay where they are; the Player internally dispatches by
  mode and `runOverPass` self-guards.
- **Reset:** `_reset()` already calls `ctx.player.reset?.()` and re-seats `pos`. Player.reset
  now also forces `mode='foot'`, `cartOwned=false`, `cartMounted=false` so each run starts
  on foot without a cart. (Per-run ownership is intentional; persisting cart ownership across
  runs is a shop-spec decision, not this one.)
- **Input wiring (new handler):** add a **mount/interact** command (`KeyF`) →
  `if (state==='playing') { if (player.onFoot) game.tryMountOrBuy(); else player.exitCart?.(); }`
  where `tryMountOrBuy` does the buy-prompt/mount logic of §7.3. Bind a gamepad face button
  too (e.g. **X / button 2**). Update `input.js` `_key` + `_gamepad` accordingly and the
  control strings.
- **Snapshot additions** (extend the existing object; all primitives, no alloc beyond the
  existing literal which is created once per frame as today):

  ```js
  s.mode = ctx.player.mode;                 // 'foot' | 'cart'
  s.cartOwned = ctx.player.cartOwned;
  s.canBuyCart = !ctx.player.cartOwned && this.survivors >= CONFIG.cart.cost && nearStall;
  s.canMount  = ctx.player.cartOwned && ctx.player.onFoot && nearCart;
  s.cartCost  = CONFIG.cart.cost;
  ```

  Keep the existing cart-health gate but make it mode-aware so the cart bar only shows in
  cart mode:

  ```js
  if (ctx.player.mode === 'cart') { s.cartHealth = player.health; s.boost = player.boost01; s.damage = player.hurt; }
  // else: leave cartHealth undefined → HUD hides the cart bar (existing branch already does this)
  ```

### 8.2 `hud.js`

- **Cart bar:** already conditional on `s.cartHealth !== undefined` — by leaving it undefined
  on foot, the existing `else` branch hides it. No new code needed beyond the snapshot gate.
- **Buy / mount prompt:** add a small bottom-center prompt element (or reuse the `msg`
  flash): when `s.canBuyCart` show `STR.buyCartPrompt` + cost + 🧍 (dim if unaffordable);
  when `s.canMount` show `STR.mountCartPrompt`; when in cart and on the roof show
  `STR.exitCartHint`. These are cheap text toggles; reuse the build-menu styling.
- **Control hints / blurb:** update the start-screen control list and tagline to say WASD
  walks John and the cart is an upgrade (string changes in §strings).

### 8.3 `strings.js` (new keys)

```
cartBought:     'CART ACQUIRED',
cartMounted:    'YOU\'RE DRIVING',
cartNoFunds:    'NOT ENOUGH SURVIVORS FOR THE CART',
buyCartPrompt:  'BUY CART',
mountCartPrompt:'ENTER CART  (F)',
exitCartHint:   'EXIT CART  (F)',
ctrlMountDesktop:'F — buy / enter / exit the cart',
ctrlWalkDesktop:'W A S D — walk John (buy the cart to drive)',
```

Also update `blurb`, `ctrlDriveDesktop`/`ctrlDriveTouch` wording so they describe *walking*
first and *driving after buying the cart*.

---

## 9. CONFIG additions (`public/js/config.js`)

Group foot + cart-upgrade tunables. (Existing `cart*`/`boost*`/`ramp`/`runOver*` keys stay;
the new nested `walk`/`cart` blocks below are additive and don't collide.)

```js
// ---- JOHN on-foot locomotion (v3) ----
walk: {
  speed: 7,          // m/s top walk speed (modest; cart maxes 22)
  accel: 10,         // damp rate toward target speed (snappy, arcade)
  turn: 12,          // heading damp rate (shortest-arc) — fast face-turn
  cadence: 1.1,      // walkPhase advance per (m/s · s); tunes step frequency vs speed
  legSwing: 0.85,    // rad leg swing amplitude at full speed
  kneeBend: 0.7,     // rad knee bend on back-swing
  armSwing: 0.55,    // rad arm counter-swing
  bob: 0.10,         // vertical hip bob (units)
  lean: 0.10,        // forward torso lean at speed (rad)
  torsoTwist: 0.18,  // shoulder/hip counter-twist (rad)
  edgeMargin: 1.0,   // keep-back from the roof edge (walkable lim = roofHalf+2 - margin ≈ 16)
  shootY: 2.6,       // ball launch height above pos on foot (hands/chest)
},

// ---- Cart-as-upgrade (v3) ----
cart: {
  cost: 4,           // price in survivor currency (game.spendSurvivors); shop may override denomination
  buyRadius: 4.5,    // John must be this close to the stall to buy
  mountRadius: 3.0,  // John must be this close to the parked cart to enter
  parkOffset: 2.6,   // sideways offset where the cart parks on purchase / exit
  shootY: 3.0,       // ball launch height in the cart (= today's hard-coded 3.0)
},

// ---- Camera foot variants (v3, optional polish) ----
camDistanceFoot: 12,
camHeightFoot:   12,
```

Palette additions to `CONFIG.col` (from §3.1): `johnSkin, johnPolo, johnSlacks, johnCap,
johnShoe, johnGlove`.

`cartCost` is exposed as `CONFIG.cart.cost` (referenced by the prompt as "cartCost"); if a
flat `CONFIG.cartCost` is preferred for the shop spec's convenience, alias it — but a single
source is better; the shop reads `CONFIG.cart.cost`.

---

## 10. Risks / edge cases / acceptance

1. **Stranded with no cart:** the on-foot roof clamp (both Z signs) and the
   `exitCart` `region===2` guard guarantee John can never reach the street on foot. The cart
   physics (region 0/1) are untouched and only reachable once mounted. **Acceptance:** holding
   W toward the ramp gap on foot stops at the parapet line; it never walks onto the ramp.
2. **Mount/exit re-parenting:** re-parent `cartRig` between `root` and `cartParkGroup` **only**
   on mount/exit (not per frame) to avoid GC. The parked-cart transform is set once on
   purchase/exit. **Acceptance:** no per-frame allocation introduced (verify with the dev
   draw/tri counter staying flat; matches the zero-alloc HARD RULE).
3. **Camera continuity on mount:** without easing, the camera would pop (foot framing →
   cart ground-blend). The `_foot01` damp (§6) and the existing `_g` damp absorb it.
   **Acceptance:** mounting near the ramp and driving down shows a smooth descent (no snap).
4. **`shootOrigin` height mismatch:** if `walk.shootY` is too low, balls clip the parapet on
   flat shots from near the edge. Keep `shootY` ≥ the parapet top relative to roof
   (parapet `ph=1.6` above roof; `2.6 > 1.6` clears it). **Acceptance:** a flat driver shot
   from mid-roof clears the parapet.
5. **Visibility HARD RULE:** foot camera tightening must not drop the perimeter ring/horde
   out of frame. The `height ≥ camHeight*0.7` clamp and unchanged tower height protect this.
   **Acceptance:** on foot, the perimeter ring (radius 38) and at least the near street horde
   are visible when aiming forward — same as cart-on-roof today.
6. **Purchase idempotency / double-buy:** `purchaseCart()` is idempotent and `buyCart()`
   early-returns if owned, so a double-click or shop+inline both firing can't double-charge
   or spawn two carts. **Acceptance:** buying twice charges once; one parked cart exists.
7. **Run-over off on foot:** the `mode!=='cart'` early-return plus the existing `region===2`
   return both prevent flattening zombies on foot (and John never reaches them anyway).
   **Acceptance:** walking on the roof never scores run-overs and never damages zombies by
   contact.
8. **Reset to foot each run:** `reset()` clears ownership; a new run starts on foot. If the
   shop spec wants persistent ownership, it persists its own flag and re-calls
   `purchaseCart()` after `reset()` — out of scope here. **Acceptance:** game-over → restart
   begins on foot with no cart.
9. **Touch controls:** the left virtual stick now walks John (same `drive.throttle/steer`),
   and a touch **ENTER/EXIT** button (reuse the boost button slot when on foot, or add one)
   calls the mount/exit path. **Acceptance:** touch player can walk, buy, mount, drive, exit.

### Implementation order (suggested)
1. Add `mode` + split `update` into `_updateCart` (verbatim) / `_updateFoot` (stub) — verify
   cart mode unchanged (force `mode='cart'` temporarily).
2. Build `johnRig` + walk cycle; wire `_updateFoot` + roof clamp; default `mode='foot'`.
3. Mode-aware `shootOrigin` + `runOverPass` guard + camera foot variants.
4. `purchaseCart`/`mountCart`/`exitCart` + parked-cart re-parenting.
5. `game.buyCart` + inline buy-stall + input key + snapshot/HUD prompts + strings.
6. Coordinate the buy trigger with the shop-economy spec (replace the inline stall).
```
