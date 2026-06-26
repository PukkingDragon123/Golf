# Golf Z — v2 Defect Review

**24 confirmed defects: 2 high · 9 med · 13 low.** All verified against source. Grouped by severity; each has file/function, the issue, and the concrete fix. None are caught by the headless smoke test (`tools/verify.mjs`), which drives `game.step` manually and inspects neither trajectory shape, GC pressure, rAF timing, nor visuals.

---

## HIGH (2)

### H1 — Backspin produces downward force (Magnus axis inverted)
**`public/js/golf.js` — `_buildSpin` (line 112) / `_integrate` (line 136)**
The spin-axis sign is inverted, so positive backspin yields a DOWNWARD Magnus force and topspin yields lift — the opposite of real golf and of the file's own bounce logic (which treats positive `b.backspin` as bite/kick-back). For flight `fwd=+z`: `_right = fwd×UP = -x`, `out = _right*(-backRPS)` → `spin=+x`; `spin×vRel = (+x)×(+z) = -y` → force points down. Verified numerically (backRPS=10 → y-component −300). Impact: high-backspin clubs (9-iron 9, wedge 15) and the `back` spin mode (+7) sink and shorten instead of holding/ballooning; topspin/driver floats instead of diving.
**Fix:** Flip the axis sign — drop the minus in `_buildSpin` line 112: `out.copy(this._right).multiplyScalar(backRPS)`; OR negate the Magnus term in `_integrate` line 136: `addScaledVector(this._cross, -CONFIG.kMagnus)`. Pick one. If you negate `kMagnus`, re-check that sidespin (`out.y += sideRPS`) still curves toward the intended side. After: for `fwd=+z`, `backRPS>0` must give a +y Magnus component.

### H2 — Per-frame closure allocation in `_writeFK` (zero-alloc HARD RULE violation)
**`public/js/zombies.js` — `_writeFK` (line 312)**
`const set = (slot, mtx) => {...}` allocates a fresh arrow closure (capturing `this`, `i`, `detach`) on every call. `_writeFK` runs once per alive zombie (update, line 411) and once per dying zombie (`_ragStep`, line 364) every frame — up to ~48–66 closures/frame (~4000/sec at 60Hz). Steady GC pressure; violates the zero-alloc-in-per-frame-loop rule.
**Fix:** Hoist a private method `_setPart(i, detach, slot, mtx) { this.parts[slot].setMatrixAt(i, (detach & (1<<slot)) ? this._hidden : mtx); }` and replace each `set(SLOT, mtx)` with `this._setPart(i, detach, SLOT, mtx)`. (Inlining the 11 sites also works.) Scratch matrices already exist as instance members; no FK behavior change.

---

## MED (9)

### M1 — `_emit` options object literal allocated on hot paths
**`public/js/effects.js` — `_emit(x,y,z,n,opts)` and presets (lines 68, 86–109)**
`_emit` destructures an options object; every preset passes a fresh `{r,g,b,speed,spread,life,gravity,up}` literal. Three presets fire from per-frame sim loops: `Props.update`→`embers` (props.js:189, ~13%/frame per cooking barrel), Player→`exhaust` (player.js:216, every ~0.03s boosting), Zombies ragdoll-landing→`dust` (zombies.js:341). Per-frame alloc.
**Fix (a, preferred):** positional signature `_emit(x,y,z,n,r,g,b,speed,spread,life,gravity,up=0)`, presets pass numbers directly — removes both literal and destructure. **(b):** preallocate one scratch opts object per preset on the instance and reuse it.

### M2 — Gamepad never polled while paused (controller-only player stuck)
**`public/js/main.js` `frame()` + `public/js/input.js` `_gamepad`**
`input.update(dt)`→`_gamepad(dt)` is called only from `game.step`, which runs only while `state==='playing'` (main.js:256–260). While paused, no step runs, so the gamepad is never polled. START (input.js:122) calls `pause()`, which accepts the paused state to resume — but it can never fire because polling stopped. A gamepad-only player can pause but never resume; same dead spot blocks any gamepad menu interaction.
**Fix:** Poll every rAF frame regardless of sim state — call `input._gamepad(realDt)` (or `input.update`) unconditionally in `frame()` so edge-detected buttons keep firing while paused/menu, and have `game.step` read the already-updated input.

### M3 — Preview integrates at wrong timestep + ignores bounce/roll
**`public/js/golf.js` — `updatePreview` vs `update`**
Preview hardcodes `dt = 0.045` (~22Hz, line 207) while live flight uses sim dt `1/60` (~0.0167). Semi-implicit Euler with quadratic drag + Magnus is timestep-sensitive; the ~2.7× larger dt overshoots range and shifts apex, so the predicted landing marker diverges from where the ball lands. Preview also only decays the spin VECTOR and never models scalar `b.backspin/b.sidespin` bounce gating or ground bounce/roll, so the marker ignores bite/roll-out entirely.
**Fix:** Step the preview at the same fixed dt (`STEP/1000` or a new config const — there is no `CONFIG.fixedDt`). Since `trajPoints=64` at `1/60` covers only ~1.07s, either raise `trajPoints` to cover `ballMaxLife` (=9s) or sub-step (accumulate several `1/60` steps per stored point). First-descent ground-stop already matches.

### M4 — Run-over ignores reverse travel direction
**`public/js/player.js` — `runOverPass` / `_runOver`**
The nose point (lines 239–240), front-gate dot (246), and impulse forward-mix (257) all use `this._fwd` (heading-forward, sign-independent of `this.speed`). `cartReverseSpeed`(9) > `runOverMinSpeed`(4), so reverse passes the gate. While reversing the cart moves along `-this._fwd`, so the impulse launches struck zombies in the cart's FACING direction (≈opposite actual motion), and the front-gate screens out the real rear-bumper victims.
**Fix:** Compute travel vector `tx,tz = this._fwd.{x,z} * Math.sign(this.speed)` and use it for the nose offset, front-gate dot, and forward-mix term. Or gate `runOverPass` on `this.speed>0` if reverse run-overs aren't intended.

### M5 — No lateral containment on the ramp (curbs are decorative)
**`public/js/player.js` `update` bounds block (171–190) + `public/js/world.js` (128–133)**
The bounds block clamps only `region===2` (roof) and `region===0` (street). On the ramp (`region===1`) there is NO x-clamp; the only constraint is `_surfaceAt`'s `|x|<=ramp.width/2+0.1` test, which flips the surface to street level (a fall) once exceeded. Ramp curbs in world.js are meshes with no collision data, so a hard skid slides the cart off the deck.
**Fix:** Add a `region===1` branch clamping `this.pos.x` to ±(`ramp.width/2 − margin`) and zeroing `lateralVel` on contact, matching the visible curb extents (inner faces at ±4.0).

### M6 — `this.z.indexOf(z)` O(n) scan every frame per ragdoll
**`public/js/zombies.js` — `_ragStep` (lines 354, 364)**
`this.z.indexOf(z)` runs every frame for each dying ragdoll (364 always, 354 on fade) to recover a pool index the caller already has. `this.z` is a fixed pool (length `max`=48), so the index equals the update() loop index `i`. O(dying × max) per frame purely to re-derive a known index.
**Fix:** Pass `i` in: `this._ragStep(z, dt, i)` and use it for `_writeFK`/`_hideZombie`. Or store `z._idx = i` at pool construction. Same `indexOf` in `kill()` (line 225) can take the caller's index (per-kill, not per-frame).

### M7 — `snapshotBuild()` allocates every rendered frame in build mode
**`public/js/survivors.js` — `snapshotBuild()` (lines 320–325)**
Called from `game.snapshot()` in the rAF loop every rendered frame (main.js:223). While `buildMode` is true it allocates a closure `opt`, the `options` array, three option object literals, and four+ template strings per frame. Gated by transient build-mode UI, so only while the build menu is open.
**Fix:** Preallocate the three option objects + array in the constructor; mutate fields in place and return the cached array. Cache label strings, rebuilding only when cost/label change. (Also consider caching the non-build-mode return literal.)

### M8 — Dead `tQ = this._q.clone()` in per-frame render loop
**`public/js/survivors.js` — `_render()` posts loop (line 289)**
`const tQ = this._q.clone()` allocates a new `THREE.Quaternion` every posts-loop iteration (`postCount=12` → ~720 allocs/sec at 60fps). `tQ` is never read — pure dead code that only triggers the allocation. Violates zero-alloc-in-render.
**Fix:** Delete line 289. No behavior change.

---

## LOW (13)

### L1 — Preview `computeBoundingSphere()` is dead per-frame work
**`public/js/golf.js` — `updatePreview` (line 215)**
Called every visible frame on `trajLine`, which has `frustumCulled=false`, so the bounding sphere is never read — the per-frame loop over 64 points is wasted CPU. (No per-call alloc in r160; perf, not alloc.)
**Fix:** Drop the line; keeping `position.needsUpdate=true` (line 214) is sufficient for the GPU upload.

### L2 — Suspension grade-tilt applied about heading-rotated axis
**`public/js/player.js` — `update` (lines 202, 207)**
`gradePitch` is a constant local-X tilt applied via `root.rotation.set(gradePitch, heading, 0)` with order `YXZ`, so the slope-pitch axis yaws with heading. Correct only when facing straight down the +z slope; backing up the ramp (heading≈π) or turning on the incline tilts the body/wheels the wrong way (verified off by up to 45°). Cosmetic — does not feed height/collision/physics.
**Fix:** Decompose from the slope normal: `pitch = grade*cos(heading)`, `roll = grade*sin(heading)` (full pitch/zero roll at heading=0; zero pitch/full roll at 90°). Or zero `gradePitch` when heading isn't slope-aligned.

### L3 — Turret barrel never tracks its target
**`public/js/survivors.js` — `_composePost` (line 310) vs `_fire` (202–204)**
Projectiles fire toward the acquired zombie, but the barrel yaw is fixed to `atan2(-p.x,-p.z)` (always facing the tower/origin), so bullets visibly emanate sideways from an inward-pointing barrel. Cosmetic — hit detection uses the correct firing direction.
**Fix:** Cache `post.yawTurret = Math.atan2(t.x - post.x, t.zz - post.z)` on acquire/fire and use it in `_composePost`, falling back to the inward angle when `post.target` is null.

### L4 — Survivor can be freed twice in one frame (double VFX/SFX)
**`public/js/survivors.js` — `update()` caged branch (lines 216–222)**
The threatened-clear path (220) can call `_free(s)`, then the cart-proximity check (222) runs unconditionally and can call `_free(s)` again (it re-checks only cart distance, not `s.state`). `_free` re-fires `greenPuff` + `audio.pickup` and resets `freeT`, so a double puff/sound. No double-count (counting is in `_arrive`).
**Fix:** `continue` after the line-220 free, or guard line 222 with `if (s.state === 'caged' && ...)`.

### L5 — `find()` closure + redundant `indexOf` in spawn
**`public/js/zombies.js` — `spawn` (lines 129, 142)**
`this.z.find((s)=>!s.alive&&!s.dying)` allocates a predicate closure, then `indexOf(z)` does a second O(n) scan for the index just found. Throttled by `spawnInterval` (down to 0.30s), so not a hot-loop rule violation, but avoidable churn in dense waves.
**Fix:** Single indexed loop: `let z=null,i=-1; for(let k=0;k<this.max;k++){const s=this.z[k]; if(!s.alive&&!s.dying){z=s;i=k;break;}} if(!z) return;` — no closure, single scan, `i` ready for the setColorAt loop.

### L6 — `find()` closure in multiball `fire`
**`public/js/golf.js` — `fire` (line 167)**
`this.balls.find((x)=>!x.active)` allocates a closure per loop iteration, up to `multiballCount`(5) per multiball shot. Input-driven (not per-frame), so not a rule violation, but avoidable.
**Fix:** Hoisted index scan: `let b=null; for(let i=0;i<this.balls.length;i++){ if(!this.balls[i].active){b=this.balls[i];break;} }` — or a free-list cursor.

### L7 — Survivor bodies cast shadows (inconsistent with zombies)
**`public/js/survivors.js` — constructor `inst()` for `bodyMesh` (line 53)**
`bodyMesh` is created `castShadow=true` for up to `maxCages`=16 instanced bodies whose matrices re-upload every frame, adding them to the shadow pass. Zombies deliberately use `castShadow=false`. Savings small (≤6 active cages), but a one-token inconsistency.
**Fix:** Pass `shadow=false` at line 53 unless survivor shadows are a deliberate hero detail. Static cages/turrets/walls fine to keep.

### L8 — Dead recursion guard in `detonate`
**`public/js/props.js` — `detonate(prop, depth)`**
Every caller passes `depth=0` (lines 150, 190) and the chain path calls only `_cook` (never `detonate`), so `depth` never increments and `if (depth < this.all.length)` is always true. Vestigial — gives a false impression of a chain cap. Not a crash (chaining is deferred via the cooking flag).
**Fix:** Remove the `depth` param and unwrap the always-true guard so the neighbor-cook loop always runs; or actually thread/increment `depth` if a real chain cap is wanted.

### L9 — `flashSurvFreed?.()` calls a nonexistent method
**`public/js/survivors.js` — `update()` freeing→running (line 225)**
`this.ctx.game.flashSurvFreed?.()` — no such method exists anywhere; `?.` silently no-ops, so the free-completion instant gives no HUD feedback. (Start-of-free has `greenPuff`+`audio.pickup`; arrival has score; only the completion flash is missing.)
**Fix:** Implement `Game.flashSurvFreed()` (e.g. `hud.toast('SURVIVOR FREED', ...)` with a new `strings.js` entry), or delete the dead call and rely on the `_free`/`_arrive` feedback.

### L10 — Dead `flashNoAmmo` no-op on barricade destruction
**`public/js/survivors.js` — `damageBarricade()` (line 129)**
`this.ctx.game && this.ctx.game.flashNoAmmo && 0;` reads the function reference without calling it (`&&0` discards), so nothing fires — barricade destruction gives no feedback. (Missing `()` vs the correctly-invoked calls elsewhere; "out of ammo" is the wrong message anyway.)
**Fix:** Remove the dead expression, or replace with a proper destruction cue (dedicated HUD flash + audio) — not literally `flashNoAmmo`.

### L11 — Unreachable `'safe'` survivor state
**`public/js/survivors.js` — `onWaveStart()` filter (line 93) vs `_arrive()` (138)**
The filter excludes `state !== 'safe'`, but `'safe'` is never assigned — `_arrive` sets `'idle'` (correct for pooling). The documented terminal state (`...→running→safe`) is never reached. Functionally harmless (filter never matches); state machine inconsistent with design.
**Fix:** Drop the dead `&& s.state !== 'safe'` clause (`'idle'` already marks free slots). Or, for a distinct terminal state, set `'safe'` in `_arrive` AND add it to the reusable-slot search in `_spawnCage`.

### L12 — Accumulator drip-feeds steps after a 100–250ms stall
**`public/js/main.js` — `frame()` (lines 251–260)**
`elapsed` is clamped only above 250ms. A 100–250ms stall (GC, tab refocus that doesn't fire `blur`) accumulates in full; the while-loop guard caps at 6 steps (~100ms) but the residual is NOT cleared (acc only resets when not playing), so it drip-feeds extra steps over the next frames — a visible post-stall fast-forward/stutter. Self-corrects in a couple frames.
**Fix:** Lower the raw-elapsed clamp to ~6×STEP (~64ms) so a single frame never queues more than the guard can drain (cleaner than `if (acc>=STEP) acc=0;`, which can discard legitimate sub-frame residual on low/variable refresh).

### L13 — `Shake.reset()` leaves `hitStopDur` stale
**`public/js/postfx.js` — `Shake.reset()` (line 74)**
`reset()` clears `trauma/hitStopT/time` but not `hitStopDur`. Currently harmless (the only reader runs under `hitStopT>0`, and `hitStop()` always rewrites both fields together), but a latent footgun — `reset()` doesn't fully restore constructor state.
**Fix:** Add `this.hitStopDur = 0;` to `reset()` for consistency with the constructor.
