# Gore / Blood System — `public/js/gore.js`

A self-contained gore subsystem that complements `effects.js`. It adds the **visceral**
layer that the abstract `Effects` (white sparks, green puff, fire explosion, shock rings)
deliberately leaves out: **red blood particle bursts**, **persistent ground blood decals**
baked into ONE reused `CanvasTexture` (= one extra draw call, never grows unbounded), and
**optional flying gore chunks** as a small capped `InstancedMesh` (+1 draw call) for big
kills. It exposes a tiny imperative API (`burst`, `splat`, `chunk`) called from
`zombies.kill/hitBall/runOver`, `golf.explode`, and `player`/vehicle run-over.

Design constraints honored (match the existing engine):
- Client-side, fixed-timestep 60Hz, **zero per-frame allocation** (all scratch reused).
- Capped pools; ring-buffer cursors like `Effects._emit`.
- **Low draw calls**: blood particles reuse a single `THREE.Points` (1 draw call), the
  ground decal layer is **1 plane** (1 draw call), gore chunks are **1 `InstancedMesh`**
  (1 draw call). Total budget for the whole gore system = **3 draw calls, constant**.
- Everything procedural — no external assets, no AI generation.
- Matches the golden-hour palette: blood is a dark, slightly desaturated arterial red so it
  reads against the warm asphalt without going cartoon-bright.

This spec is written to slot cleanly next to the planned `zombies.md` refactor (which adds
`hitBall`, `runOver`, `dismember`, debris). Gore does **not** depend on that refactor — its
hooks are additive and degrade gracefully if called from the current rigid-horde zombies
(today `zombies.kill(z)` and `golf.explode` are the live call sites).

---

## 1. Why a separate file (vs extending Effects)

`Effects` is the *bright additive* layer: `AdditiveBlending`, never writes depth, colors
fade to black. Blood is the opposite — it's **dark, normal-alpha-blended, and persistent**
(decals must survive on the ground). Cramming a persistent `CanvasTexture` decal plane and
a debris `InstancedMesh` into `Effects` would muddy that clean "additive sparks only"
abstraction. A dedicated `Gore` subsystem with its own pools keeps both readable and lets
the decal canvas own its world↔UV mapping math in one place.

`Effects.bloodSpray(p,dx,dz)` is mentioned in `zombies.md` as a possible additive-particle
helper. We **supersede** that idea: `Gore.burst()` is the blood-particle entry point and
lives here with the rest of gore (normal blending, gravity, ground-stick), so `Effects`
stays purely additive. (If `zombies.md`'s `bloodSpray` is implemented first, it can simply
forward to `ctx.gore.burst`.)

---

## 2. Public API (signatures + lifecycle)

```js
class Gore {
  constructor(scene, ctx)   // builds particle Points, decal plane+canvas, chunk InstancedMesh

  // ---- emission hooks (called by zombies / golf / vehicle) ----
  burst(pos, amount = 1, dir = null)
      // Blood particle spray at pos. `amount` ~ severity 0.5..3 (scales particle count
      // & speed). `dir` optional THREE.Vector3 (or {x,z}) biasing the spray cone; if
      // null, emits a roughly spherical pop. Also auto-queues a small ground splat near
      // pos.x/pos.z so a kill always leaves a mark even if chunk/splat aren't called.

  splat(pos, size = 1)
      // Stamp ONE persistent blood blob onto the decal canvas at world pos.x/pos.z.
      // `size` ~ 0.5..3 scales the blob radius. Marks the canvas dirty (uploaded once
      // per frame, NOT once per splat). Out-of-bounds positions are ignored cheaply.

  chunk(pos, vel)
      // Spawn ONE flying gore chunk (tumbling tinted box) from the chunk pool. `vel`
      // is a THREE.Vector3 initial velocity (caller can scale by severity). Recycles the
      // oldest if the pool is full. On landing it auto-splats a small decal then settles.

  // ---- convenience presets (thin wrappers used by the hooks) ----
  killGore(pos, dir, severity = 1)   // burst(severity) + splat(severity) + N chunks(severity)
  dismemberGore(pos, dir)            // heavier burst + 2-3 chunks + medium splat

  // ---- lifecycle (mirror Effects) ----
  reset()       // clear particles, clear ALL decals (wipe canvas), hide all chunks
  update(dt)    // integrate particles + chunks; upload dirty buffers/canvas once
}
```

`amount`/`severity`/`size` are deliberately loose scalars (not enums) so call sites can
pass a continuous value (e.g. ball-speed-derived severity) without a lookup table.

### Argument shapes
- `pos` — anything with `.x/.y/.z` (a `THREE.Vector3` or the zombie scratch `_p`). Read-only;
  never retained (we copy out the scalars). Callers may pass their own reused scratch.
- `dir` — optional `THREE.Vector3`; only `.x`,`.z` (horizontal) + a small upward bias are
  used to tilt the spray cone. May also be a bare `{x,z}` object.
- `vel` — `THREE.Vector3` for `chunk`. Copied into the pool slot; not retained.

---

## 3. Blood particle bursts (1 draw call — `THREE.Points`)

Mirrors `Effects` exactly (same buffer layout, same ring-buffer `cursor`, same per-frame
integrator) but with **normal alpha blending** (blood is dark, not glowing) and a
**ground-stick** terminal behavior so droplets pool on the asphalt for a beat before dying.

### Buffers (allocated once in constructor)
```
cap   = CONFIG.gore.particleCap            // 360
pos   = Float32Array(cap*3)                // xyz, y=-9999 = parked
vel   = Float32Array(cap*3)
life  = Float32Array(cap)                  // seconds remaining
maxLife = Float32Array(cap)
seed  = Float32Array(cap)                  // per-particle 0..1 for size/alpha variance
cursor = 0
```
Geometry: `BufferGeometry` with `position` (dynamic) + a static per-vertex `color` is
**not** needed — blood is one tint, so we use a flat material color and animate **opacity
via a custom alpha** is overkill; instead we follow Effects' pattern and DO keep a `col`
Float32Array so each droplet can fade its brightness toward the dark-clot color as it ages
(bright fresh red → dark maroon). Cheaper alternative chosen: **single material color**
`CONFIG.gore.bloodColor`, `vertexColors:false`, and fade only via shrinking the parked
particle out (move to y=-9999 at end of life). We keep it tint-only to save a buffer
upload; brightness variance comes from `seed` baked into nothing visible — acceptable.

> Decision: **no per-vertex color buffer.** One material color, `transparent:true`,
> `depthWrite:false`, `NormalBlending`. Saves a Float32Array(cap*3) upload every frame.
> The droplet sprite is a dark radial blob (see §3.2).

Material:
```js
new THREE.PointsMaterial({
  size: CONFIG.gore.particleSize,        // 1.1
  map: bloodSprite(),                    // dark radial alpha sprite (see §3.2)
  color: CONFIG.gore.bloodColor,         // 0x7a0a0a arterial dark red
  transparent: true,
  depthWrite: false,
  depthTest: true,                       // unlike Effects' additive sparks, blood respects depth
  blending: THREE.NormalBlending,
  sizeAttenuation: true,
  opacity: 0.95,
})
```
`points.frustumCulled = false` (same as Effects — the pool spans the whole arena).

### 3.1 `_emit(x,y,z,n, {speed, spread, life, up, dir})`
Same structure as `Effects._emit` but biased by `dir` when present:
```
for k in 0..n:
  i = cursor; cursor = (cursor+1) % cap
  pos[i*3..] = x,y,z
  // base random direction on a sphere (reuse Effects' theta/phi sampling)
  theta = rand*2PI ; phi = acos(2*rand-1)
  sp = speed * (0.4 + rand*0.6)
  dx = sin(phi)*cos(theta) ; dy = cos(phi) ; dz = sin(phi)*sin(theta)
  if dir:                       // bias the cone toward dir (horizontal) + a little up
     dx = lerp(dx, dirx, 0.6); dz = lerp(dz, dirz, 0.6); dy = dy*0.5 + 0.4
  vel[i*3]   = dx * sp * spread
  vel[i*3+1] = dy * sp * 0.6 + up
  vel[i*3+2] = dz * sp * spread
  life[i] = maxLife[i] = life * (0.7 + rand*0.5)
  seed[i] = rand
```
`dirx,dirz` are pre-normalized once per `burst` call (not per particle).

### 3.2 `bloodSprite()` (built once)
A 64×64 canvas radial gradient, **dark center, soft edge** (opposite of Effects' white
sprite): `rgba(120,12,12,1)` → `rgba(90,6,6,0.55)` → `rgba(70,0,0,0)`. Returned as a
`THREE.CanvasTexture`. The material `color` multiplies this; keeping the sprite already
red-tinted lets us drop vertex colors entirely.

### 3.3 Integrator (in `update(dt)`)
Same loop shape as `Effects.update` (single `for i<cap`, early-`continue` on parked):
```
life[i] -= dt
if life<=0: park (pos.y=-9999); continue
vel.y -= CONFIG.gravity * dt          // reuse the global gravity (24)
pos += vel*dt
if pos.y < CONFIG.gore.groundY:        // 0.06 — just above asphalt
   pos.y = CONFIG.gore.groundY
   vel.y *= -0.18                      // tiny squishy bounce (less than Effects' 0.3)
   vel.x *= 0.55; vel.z *= 0.55        // droplets stick/smear
   // first ground contact -> queue a tiny splat (probability-gated so not every droplet)
   if (life[i] > 0.04 && rand < CONFIG.gore.dropSplatChance) splatXZ(pos.x, pos.z, 0.35)
```
After the loop: `points.geometry.attributes.position.needsUpdate = true` (one upload).
No color upload (single material color). The droplet→splat feedback gives free organic
spatter around a kill without extra call-site work; `dropSplatChance` (≈0.04) caps how
many of the ~360 droplets ever touch the canvas.

> Zero-alloc: reuse `Math.random()` (no allocation), all writes into preallocated typed
> arrays. No `Math.hypot` in the hot path.

---

## 4. Persistent ground blood decals — the BLOOD LAYER (1 draw call)

The persistence mechanism is **a single reused `CanvasTexture`** painted onto **one flat
plane** hovering just above the asphalt. We never instantiate decal meshes — the canvas
*is* the memory. Splatting = drawing a semi-transparent blob into the 2D canvas at the
mapped pixel, then uploading the canvas **once per frame** if anything was drawn.

### 4.1 The plane
```js
this.decalSize = CONFIG.gore.decalWorldSize         // 220  (covers ±110 world units)
const geo = new THREE.PlaneGeometry(this.decalSize, this.decalSize, 1, 1)
this.decalCanvas = document.createElement('canvas')
this.decalCanvas.width = this.decalCanvas.height = CONFIG.gore.decalRes   // 1024
this.dctx = this.decalCanvas.getContext('2d')
this.dctx.clearRect(0,0,res,res)                    // start transparent
this.decalTex = new THREE.CanvasTexture(this.decalCanvas)
this.decalTex.colorSpace = THREE.SRGBColorSpace     // matches sRGB color pipeline
this.decalTex.anisotropy = renderer-aniso? (we don't have renderer here; leave default 1
   — the plane is viewed near-top-down so aniso gains are marginal; keep default to avoid
   threading renderer into Gore. If desired, ctx can carry maxAniso — see §9 note.)
const mat = new THREE.MeshBasicMaterial({
  map: this.decalTex,
  transparent: true,
  depthWrite: false,                 // don't occlude; it's a thin overlay
  polygonOffset: true,               // avoid z-fight with the asphalt at y≈0
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
  fog: true,                         // let distant blood fade into the warm haze
})
this.decalPlane = new THREE.Mesh(geo, mat)
this.decalPlane.rotation.x = -Math.PI/2              // lay flat (matches ground)
this.decalPlane.position.y = CONFIG.gore.decalY      // 0.05 — above asphalt, below balls
this.decalPlane.renderOrder = 2                      // draw after ground + perimeter rings
this.decalPlane.frustumCulled = false
scene.add(this.decalPlane)
```
The plane is centered at world origin (the tower base / arena center). Because the playable
death zone is the perimeter ring (r≈38) out to the spawn ring (r≈96), a ±110 plane with a
1024² canvas gives **~9.3 px / world-unit** in the hot zone — plenty for blob spatter — and
simply ignores kills past r≈110 (deep-field zombies that died off-screen aren't worth
decaling). This is the requested "concentrate resolution near the action radius 0..110".

### 4.2 World → canvas-UV → pixel mapping
The plane spans world XZ ∈ [−S/2, +S/2] with `S = decalWorldSize`. Canvas is `R×R` px.
The plane was rotated `-PI/2` about X, so **plane-local +Y maps to world −Z**. We bake the
mapping so a world point lands where it visually should:

```
// world (wx, wz)  ->  canvas pixel (px, py), origin top-left
half = S * 0.5
u = (wx + half) / S            // 0..1 left→right  == world -X..+X
v = (wz + half) / S            // 0..1
px = u * R
py = (1 - v) * R               // flip so +Z is toward the bottom; matches plane orientation
```
Verification of orientation: with `rotation.x=-PI/2`, texture +U runs along world +X and
texture +V runs along world +Z for a default `PlaneGeometry` whose UVs are (0,0) bottom-left.
We choose `py = (1-v)*R` so canvas-y increases as world-z decreases, keeping splats visually
under their kill. (Exact flip is cosmetic — blood blobs are radially symmetric — but we lock
it so the optional debris-shadow / directional smear in §4.4 lands the right way.)

Bounds check (cheap, before any 2D draw):
```
if (wx < -half || wx > half || wz < -half || wz > half) return   // off the blood layer
```

### 4.3 `splatXZ(wx, wz, size)` — the draw
```
px,py = map(wx,wz)              // §4.2
r = CONFIG.gore.splatBaseRadiusPx * size * (0.7 + rand*0.6)   // px radius, jittered
dctx.globalCompositeOperation = 'source-over'
// main pool — soft dark radial gradient, low alpha so overlaps build up naturally
g = dctx.createRadialGradient(px,py,0, px,py,r)
g.addColorStop(0,   'rgba(86,8,8,0.55)')
g.addColorStop(0.6, 'rgba(70,4,4,0.40)')
g.addColorStop(1,   'rgba(60,0,0,0)')
dctx.fillStyle = g
dctx.beginPath(); dctx.arc(px,py,r,0,TAU); dctx.fill()
// 2-4 satellite droplets around it for organic spatter (cheap small arcs)
for k in 0..(2+rand*3):
   a = rand*TAU; d = r*(0.6+rand*0.9)
   rr = r*(0.12+rand*0.22)
   sx=px+cos(a)*d; sy=py+sin(a)*d
   dctx.fillStyle = 'rgba(72,3,3,0.42)'
   dctx.beginPath(); dctx.arc(sx,sy,rr,0,TAU); dctx.fill()
this._decalDirty = true        // upload happens once in update()
this._decalInk += size         // budget accounting (see §4.5 fade/cap)
```
`splat(pos,size)` is just `splatXZ(pos.x,pos.z,size)` with the bounds check. `createRadialGradient`
does allocate a gradient object — this is acceptable because **splats are event-driven**
(a few per kill, not per-frame-per-particle) and Canvas2D gradient creation is the standard
way to get soft blobs. The per-frame *integrators* (particles, chunks) allocate nothing;
only the occasional `splat` touches the 2D context. We gate droplet auto-splats by
`dropSplatChance` so the canvas-draw rate stays bounded even in a big horde wipe.

### 4.4 (Optional) directional smear for run-overs
`runOver`/fast-ball kills can pass a `dir`; `splatXZ` gains an optional `dir` param that, if
present, stretches the blob into an ellipse along `dir` using `dctx.save/translate/rotate/
scale/restore` around the radial fill — a tire-drag / impact streak. Off by default (radial)
to keep the common path branch-free.

### 4.5 Capping & fade so it NEVER grows unbounded
Two independent caps keep the canvas bounded **in cost** (the canvas is a fixed 1024² buffer
— it never grows in *memory*; the concern is purely visual saturation + draw rate):

1. **Ink budget + global fade.** Track `_decalInk` (sum of recent splat `size`s). Each
   `update(dt)`, if `_decalInk > CONFIG.gore.inkFadeThreshold` (e.g. 60), apply a gentle
   global fade pass that *lifts* old blood so new blood stays legible and the ground never
   turns into a solid red sheet:
   ```
   // fade: multiply existing alpha down a touch using 'destination-out'
   this._fadeAcc += dt
   if (this._fadeAcc >= CONFIG.gore.fadeInterval):       // every ~0.8 s
      this._fadeAcc = 0
      dctx.globalCompositeOperation = 'destination-out'
      dctx.fillStyle = `rgba(0,0,0,${CONFIG.gore.fadeAlpha})`   // 0.04
      dctx.fillRect(0,0,R,R)
      dctx.globalCompositeOperation = 'source-over'
      this._decalInk *= (1 - CONFIG.gore.fadeAlpha*2)
      this._decalDirty = true
   ```
   This is **one `fillRect` every ~0.8 s** (negligible) and bounds total on-screen blood:
   splat-in rate vs. fade-out rate reach equilibrium, so the layer self-limits no matter how
   long you play. Below the threshold (early game) we **don't fade** so the first kills'
   blood persists satisfyingly.

2. **Hard upload throttle.** The canvas is re-uploaded to the GPU at most once per frame and
   only when `_decalDirty` (a splat or fade happened this frame). A `CanvasTexture` upload of
   1024² is a single `texImage2D` — cheap, but we still skip it on idle frames.

> Net result: **one extra draw call** (the decal plane), a fixed 4 MB canvas (1024²×RGBA),
> at most one texture upload/frame, and a bounded amount of visible blood via the fade
> equilibrium. Exactly the requested "the canvas splat IS the persistence; cap/fade so it
> never grows unbounded."

### 4.6 `reset()` for the decal layer
```
this.dctx.clearRect(0,0,R,R)
this._decalInk = 0; this._fadeAcc = 0; this._decalDirty = true   // upload the cleared canvas
```
Called from `game._reset()` so a new run starts on clean asphalt.

---

## 5. Flying gore chunks (1 draw call — `InstancedMesh`)

For *big* kills (explosions, run-overs, fast-ball severs) we fling a few tumbling chunks.
This is the same idea as `zombies.md`'s "debris pool" but **owned by Gore** and tinted
**blood-meat** (dark red) rather than zombie-green, so it complements rather than duplicates.
If the zombies debris pool also exists, the two coexist (zombies green limb-chunks + gore red
meat-bits) — both are bounded single InstancedMeshes. If `zombies.md` debris is NOT built,
this gives the gore chunk effect on its own.

### Pool
```
N = CONFIG.gore.chunkCap                  // 48
geo = a tiny irregular chunk — a low-poly shape; use a BoxGeometry(0.5,0.45,0.55) jittered,
      or an IcosahedronGeometry(0.32,0) (20 tris) for a meatier blob. Pick icosa (cheap,
      rounder). One geometry shared by all instances.
mat = MeshStandardMaterial({ color: CONFIG.gore.chunkColor /*0x8c1414*/, roughness:0.85,
                             metalness:0.0 })   // lit like the world (not additive)
this.chunkMesh = new THREE.InstancedMesh(geo, mat, N)
this.chunkMesh.frustumCulled = false
this.chunkMesh.castShadow = false; this.chunkMesh.receiveShadow = false
this.chunkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
for i in 0..N: setMatrixAt(i, _hidden)     // zero-scale parked
scene.add(this.chunkMesh)
```
Per-chunk state — a **preallocated array of plain structs** (allocated once, numeric fields,
never grown):
```
this.chunks[i] = { active:false, x,y,z, vx,vy,vz,
                   rx,ry,rz,           // current orientation (euler)
                   ax,ay,az,           // angular velocity
                   scale, life, splatted:false }
this.chunkCursor = 0
```
Scratch (created once): `_cm` Matrix4, `_cq` Quaternion, `_ce` Euler, `_cv` Vector3,
`_cs` Vector3, `_hidden = makeScale(0,0,0)`.

### `chunk(pos, vel)`
```
i = chunkCursor; chunkCursor = (i+1)%N        // ring-buffer = oldest recycled (bounded)
c = this.chunks[i]
c.active=true; c.x=pos.x; c.y=pos.y; c.z=pos.z
c.vx=vel.x + rand(-1,1)*2 ; c.vy=vel.y + 2 + rand*3 ; c.vz=vel.z + rand(-1,1)*2  // upward pop
c.rx=rand*TAU; c.ry=rand*TAU; c.rz=rand*TAU
c.ax=rand(-6,6); c.ay=rand(-6,6); c.az=rand(-6,6)
c.scale = CONFIG.gore.chunkScale * (0.7+rand*0.7)
c.life = CONFIG.gore.chunkLife * (0.8+rand*0.5)    // ~2.2 s
c.splatted=false
```

### Integrator (in `update(dt)`)
```
for i in 0..N:
  c = chunks[i]; if !c.active: continue
  c.life -= dt
  if c.life<=0: c.active=false; setMatrixAt(i,_hidden); dirty=true; continue
  c.vy -= CONFIG.gravity*dt
  c.x+=c.vx*dt; c.y+=c.vy*dt; c.z+=c.vz*dt
  if c.y < CONFIG.gore.chunkGroundY:        // 0.32 (≈ icosa radius)
     c.y = CONFIG.gore.chunkGroundY
     c.vy *= -0.25; c.vx*=0.6; c.vz*=0.6
     c.ax*=0.5; c.ay*=0.5; c.az*=0.5
     if !c.splatted:                         // first landing -> leave a small mark
        c.splatted=true
        splatXZ(c.x, c.z, 0.5)
  c.rx+=c.ax*dt; c.ry+=c.ay*dt; c.rz+=c.az*dt
  // compose into instance matrix (reuse scratch)
  _ce.set(c.rx,c.ry,c.rz); _cq.setFromEuler(_ce)
  _cv.set(c.x,c.y,c.z); _cs.setScalar(c.scale)
  _cm.compose(_cv,_cq,_cs); setMatrixAt(i,_cm); dirty=true
if dirty: chunkMesh.instanceMatrix.needsUpdate = true
```
Chunks landing auto-splat (once each) so a violent kill leaves not just the central blob but
a scatter of small marks where the meat lands — reinforcing the decal layer for free.

`reset()` for chunks: set every `c.active=false`, write `_hidden` to all instances,
`instanceMatrix.needsUpdate=true`, `chunkCursor=0`.

---

## 6. Convenience presets (the actual hook bodies)

```
killGore(pos, dir, severity=1):
   burst(pos, severity, dir)                 // particles (also auto-queues 1 small splat)
   splat(pos, 0.9*severity)                  // a definite central pool
   n = round(CONFIG.gore.chunksPerKill * severity)   // 0..3 typically; 0 for tiny kills
   for k in 0..n: chunk(pos, _spreadVel(dir, severity))   // _spreadVel uses scratch _cv

dismemberGore(pos, dir):
   burst(pos, 1.6, dir)
   splat(pos, 1.3)
   for k in 0..(2+ (rand<0.5?1:0)): chunk(pos, _spreadVel(dir,1.4))
```
`_spreadVel(dir, sev)` writes into the reused `_cv` scratch (returns it): a base outward
speed `CONFIG.gore.chunkSpeed*sev` along `dir` (or random horizontal if no dir) + jitter; the
upward pop is added inside `chunk()`. Returning shared scratch is fine because `chunk()`
copies the components immediately.

`burst` itself auto-queues a tiny splat (§2) so even the cheapest hook path (`burst` only,
e.g. a non-lethal bloody hit) leaves a faint mark.

---

## 7. CONFIG additions (append to `CONFIG` in `config.js`)

Grouped under a single `gore` sub-object to avoid polluting the flat namespace (the rest of
CONFIG is flat, but gore is self-contained and this keeps it tidy; `Gore` reads
`CONFIG.gore.*` and the shared `CONFIG.gravity`).

```js
// ---- Gore / blood ----
gore: {
  // blood particles
  particleCap:      360,        // ring-buffer droplet pool size
  particleSize:     1.1,        // PointsMaterial size (world units, sizeAttenuation)
  bloodColor:       0x7a0a0a,   // arterial dark red (multiplies the sprite)
  groundY:          0.06,       // droplet rest height (just above asphalt)
  dropSplatChance:  0.04,       // P(a landing droplet stamps a tiny decal)
  burstBase:        9,          // particles per `amount` unit in burst()
  burstSpeed:       16,         // base droplet speed
  // ground decal layer
  decalRes:         1024,       // canvas px (fixed 4MB RGBA buffer; never grows)
  decalWorldSize:   220,        // plane side in world units => covers ±110 (the action zone)
  decalY:           0.05,       // plane height (above asphalt @0, below ballRadius 0.95)
  splatBaseRadiusPx:18,         // base blob radius in canvas px before size/jitter scaling
  inkFadeThreshold: 60,         // accumulated splat-size before global fade kicks in
  fadeInterval:     0.8,        // s between fade passes (when above threshold)
  fadeAlpha:        0.045,      // destination-out alpha per fade pass (older blood lifts)
  // flying gore chunks
  chunkCap:         48,         // InstancedMesh size (oldest recycled when full)
  chunkScale:       0.5,        // base instance scale
  chunkSpeed:       7,          // base outward launch speed
  chunkLife:        2.2,        // s before a chunk despawns
  chunkGroundY:     0.32,       // chunk rest height (~icosa radius)
  chunkColor:       0x8c1414,   // dark meat-red (lit, not additive)
  chunksPerKill:    2,          // chunks ≈ round(this * severity); explosions pass sev≈3
},
```
No existing CONFIG keys change. `Gore` also reads the existing top-level `CONFIG.gravity`
(24) for both the droplet and chunk integrators, so blood falls at the same rate as the
golf ball — consistent feel.

---

## 8. Integration — wiring into `ctx`, the loop, reset, and the call sites

### 8.1 `main.js` (mirror the other subsystems, ~3 lines)
Import + construct **after `effects` and before/after `zombies`** (it has no constructor
dependency on them — only needs `scene` and `ctx`; construct it before `zombies`/`golf`/
`player` so those can reference `ctx.gore` in their own ctors if ever needed, but the hooks
are called at runtime so order is flexible):
```js
import { Gore } from './gore.js';
...
ctx.effects = new Effects(scene);
ctx.gore    = new Gore(scene, ctx);     // NEW — blood layer
ctx.player  = new Player(scene);
ctx.zombies = new Zombies(scene, ctx);
...
```
`step(dt)` — add one update call alongside `effects.update` (order: after movement so
positions are current, near `effects`):
```js
ctx.zombies.update(dt);
ctx.powerups.update(dt);
ctx.effects.update(dt);
ctx.gore.update(dt);        // NEW
```
`_reset()` — add to the reset chain so a new run wipes the decals:
```js
ctx.golf.reset(); ctx.zombies.reset(); ctx.powerups.reset();
ctx.effects.reset(); ctx.gore.reset();   // NEW
```
(`window.GOLFZ.ctx.gore` is then available for dev-console testing, e.g.
`GOLFZ.ctx.gore.killGore(new THREE.Vector3(40,1.4,0), null, 3)`.)

### 8.2 `zombies.js` hooks
`kill(z)` already emits `ctx.effects.greenPuff(...)`. Add gore right after, reusing the
existing `this._p` scratch (no new allocation):
```js
kill(z) {
  if (!z.alive) return;
  z.alive = false; z.dying = true; z.deathT = 0;
  this._p.set(z.x, 1.4, z.zz);
  this.ctx.effects.greenPuff(this._p);
  this.ctx.gore.killGore(this._p, null, 1);   // NEW: burst + central splat + ~2 chunks
}
```
If/when `zombies.md`'s richer `kill(z, opts)` lands, pass direction + severity:
```js
// opts = {dirX, dirZ, impulse, dismember}
this._dir.set(opts.dirX||0, 0, opts.dirZ||0);            // reuse a scratch Vector3
if (opts.dismember) this.ctx.gore.dismemberGore(this._p, this._dir);
else this.ctx.gore.killGore(this._p, this._dir, 1 + (opts.impulse||0)*0.05);
```
`hitBall(z,p,ballVel)` (planned) on a **non-lethal** hit: a light `ctx.gore.burst(p, 0.6,
ballVelDirXZ)` for a bloody-but-alive impact (the existing `effects.hit(p)` stays — white
spark + dark blood reads great together). On a lethal hit, route through `kill`.
`damageArea(pos, r)` (explosion) per killed zombie: pass outward `dir` (from `pos` to the
zombie) and high severity; `golf.explode` also calls `gore` at the blast center (§8.3).
`runOver(z, impulseVec)` (planned vehicle hook): `dismemberGore(z._p, impulseVecXZ)` plus a
directional smear splat (`splatXZ(..., dir)` §4.4) for a tire-drag streak.

`reset()` does **not** need to touch gore — `game._reset()` calls `ctx.gore.reset()` once,
centrally.

### 8.3 `golf.js` hook (explosion)
`explode(pos, ball)` already calls `eff.explosion(pos)`. Add a big gore moment at the blast
center (the per-zombie blood comes from `damageArea`→`kill`; this is the central splatter):
```js
explode(pos, ball) {
  const z = this.ctx.zombies, eff = this.ctx.effects, game = this.ctx.game;
  const killed = z.damageArea(pos, CONFIG.explosionRadius);
  eff.explosion(pos);
  this.ctx.audio.explosion();
  if (killed > 0) {
    this.ctx.gore.splat(pos, 2.2);             // NEW: large scorched-blood pool at center
    for (let k = 0; k < killed && k < 6; k++)  // NEW: a few flung meat chunks (capped)
      this.ctx.gore.chunk(pos, this._goreVel());// _goreVel: scratch outward vel
    this.ctx.gore.burst(pos, 2.5);             // NEW: dense red mist over the fireball
    game.addScore(killed * CONFIG.scorePerKill + (killed - 1) * CONFIG.comboBonus, killed > 1);
  }
  if (ball) { ball.active = false; ball.mesh.visible = false; }
}
```
`this._goreVel()` is a tiny helper using golf's existing reused `this._tmp`/`_a` scratch
(random horizontal dir × `CONFIG.gore.chunkSpeed`), so still zero-alloc. Alternatively skip
the per-chunk loop here and let `damageArea`→`kill`→`killGore` produce the chunks; the
central `splat`+`burst` is the key explosion-specific addition. **Decision:** keep the
central `splat(2.2)` + `burst(2.5)` here (explosion-scale spectacle) and let per-zombie
chunks come from `kill`. Drop the explicit chunk loop to avoid double-spawning. (Shown above
for completeness; recommended final = splat + burst only.)

### 8.4 Vehicle run-over (current geometry note)
Today the cart is on the roof (y≈8) and zombies attack the street perimeter (y≈0), so
nothing runs them over yet — but the hook is provided for a future street/ramp mode and for
the dev console. When a run-over is detected (cart vs. zombie XZ overlap with `speed >
threshold`), call `ctx.zombies.runOver(z, impulseVec)` which internally calls
`ctx.gore.dismemberGore(...)` + a directional smear `splat`. No per-frame cost when unused
(it's event-driven). If wired directly from `player`/`main`, the call is simply
`ctx.gore.killGore(zPos, cartFwdDir, 1.5)` + `ctx.gore.splat(zPos, dir)` for the tire streak.

---

## 9. Performance notes

- **Draw calls: +3 total, constant** for any kill count / playtime: 1 `Points` (blood
  droplets), 1 decal plane, 1 chunk `InstancedMesh`. No shadows on any gore mesh (matches
  the zombie/effects convention) — zero added shadow-pass cost.
- **Per-frame allocation: zero** in `update()`. Both integrators (`particles`, `chunks`)
  loop over fixed typed arrays / preallocated structs with reused scratch
  (`_cm,_cq,_ce,_cv,_cs,_hidden`). No `Math.hypot`, no closures, no temp objects in the hot
  loops. Buffer uploads happen once/frame (`position.needsUpdate`, `instanceMatrix.needsUpdate`)
  and the decal `CanvasTexture` uploads **only when dirty** (a splat or fade occurred).
- **Event-time allocation: tiny & bounded.** `splat()` creates one Canvas2D radial gradient
  object per call. Splats are event-driven (a few per kill) and `dropSplatChance` (0.04)
  caps droplet auto-splats, so the gradient-alloc rate is low and GC-friendly. No allocation
  in `burst`/`chunk` beyond the typed-array writes.
- **Decal canvas cost:** fixed 1024²×RGBA = **4 MB** GPU texture, allocated once, never
  resized. A full splat is a handful of `arc` fills; the fade is one `fillRect` every ~0.8 s.
  The upload is one `texImage2D(1024²)` at most once per frame. The fade-equilibrium (§4.5)
  bounds visible blood so the layer never saturates to a solid sheet regardless of session
  length.
- **Resolution placement:** 1024 px over 220 world units ≈ 4.65 px/unit globally; the action
  zone (perimeter r≈38 → spawn r≈96) sits well inside ±110, so all gameplay kills land on
  the canvas at full res. Kills beyond r≈110 (rare off-screen deaths) are silently dropped by
  the bounds check — intentional, they're not visible from the rooftop perch anyway.
- **Pool sizing rationale:** `particleCap 360` ≈ Effects' 520 scaled to gore frequency; a
  single big explosion's `burst(2.5)` emits ~`9*2.5`≈22 droplets, so the ring buffer comfortably
  holds several overlapping kills. `chunkCap 48` ≈ a couple of simultaneous explosions' worth;
  oldest-recycle keeps it bounded with no stutter.
- **Optional aniso:** the decal plane is viewed near-top-down from the elevated chase cam, so
  anisotropic filtering gains little; we skip threading `renderer.capabilities.getMaxAnisotropy()`
  into `Gore`. If a future shallow camera angle makes the decal look blurry at grazing angles,
  pass `maxAniso` via `ctx` (set in `main.js`) and apply `this.decalTex.anisotropy = maxAniso`.

---

## 10. Risks / mitigations

- **Z-fighting with the asphalt** at y≈0: mitigated by `decalY=0.05` lift + `polygonOffset`
  on the decal material + `depthWrite:false` + `renderOrder=2` (draws after ground and the
  additive perimeter rings). If any flicker remains on weak GPUs, nudge `decalY` to 0.08.
- **Decal plane over the tower:** the tower footprint (`rooftopSize+4` ≈ 34) sits at the
  arena center where the plane also is, but the tower top is at y≈9 and the decal at y=0.05,
  so the plane is buried inside the tower base — invisible there. No kills happen on the roof
  (zombies are street-level), so no blood is wasted under the tower. Safe.
- **Blood reads too bright / cartoonish** against warm asphalt: tuned dark
  (`bloodColor 0x7a0a0a`, decal alphas ≤0.55) and `fog:true` on the decal so distance blends
  it into the haze. Adjust `splat` gradient stops if needed.
- **Canvas2D gradient GC churn** in a massive simultaneous wipe (many kills one frame):
  bounded by `dropSplatChance` and the fact that explosions central-splat once (not per
  zombie). Worst realistic case is a few dozen `splat` calls in a frame — fine. If profiling
  ever flags it, cache a few pre-rendered blob sprites and `drawImage` them instead of
  building gradients (swap-in optimization; not needed at this scale).
- **Double draw-call if zombies.md debris also ships:** acceptable — gore chunks (red meat)
  + zombie debris (green limbs) are two *different* InstancedMeshes by design (4 total gore+
  debris draw calls). They don't conflict; both are bounded. If consolidation is ever wanted,
  zombies' debris could call `ctx.gore.chunk` instead of owning its own pool.
- **Severity scalars unbounded by a caller bug** (e.g. `burst(pos, 999)`): `burst` clamps
  `amount` to ≤4 internally and `chunk` spawns are ring-buffered, so a bad caller can't blow
  the pools or the particle count.
- **Determinism:** gore uses `Math.random()` (cosmetic only — never affects gameplay state,
  scoring, or zombie positions), so it does not break the seeded-RNG determinism that drives
  spawn placement. Intentional: blood spatter shouldn't be lockstep-reproducible.

---

## 11. File summary

**New:** `public/js/gore.js` — `export class Gore` per §2; builds the blood `Points`, the
decal plane + 1024² canvas, and the chunk `InstancedMesh`; owns `burst/splat/chunk/killGore/
dismemberGore/reset/update`; all scratch + pools allocated in the constructor.

**Modified:**
- `public/js/config.js` — append the `gore:{…}` sub-object (§7).
- `public/js/main.js` — import `Gore`; `ctx.gore = new Gore(scene, ctx)`; `ctx.gore.update(dt)`
  in `step`; `ctx.gore.reset()` in `_reset` (§8.1).
- `public/js/zombies.js` — `kill()` calls `ctx.gore.killGore` (+ dir/severity once the richer
  kill lands); planned `hitBall`/`runOver` route to `burst`/`dismemberGore` (§8.2).
- `public/js/golf.js` — `explode()` adds central `ctx.gore.splat` + `ctx.gore.burst` (§8.3).
