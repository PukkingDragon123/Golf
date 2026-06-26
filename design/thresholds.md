# GOLF Z — Numeric thresholds (frozen before build)

## Performance budget (weakest target: mid mobile browser)
- Target **60 fps**; never below 30 on the worst-case scene (full horde + balls in flight + explosion).
- `devicePixelRatio` capped at **1.5**.
- The whole zombie horde (up to 70 alive) renders as **one draw call** via a single `InstancedMesh`.
- Live golf balls capped at **60**; explosions are short-lived pooled particle bursts.
- **Zero allocations inside the frame loop** — reuse vectors/matrices, pool balls/particles/zombies.
- Hidden things are neither drawn nor simulated (despawn off-bounds balls, cull dead zombies).

## Input tolerance
- Power meter ping-pongs 0→100→0 over ~1.4 s; release anywhere — honest near-max reads as a good shot.
- Aim is continuous; no hard snap. Pitch clamped to [-1.15, +0.78] rad.
- Conflicting inputs (opposite drive keys, charge+drive, focus loss mid-charge) resolve predictably and never soft-lock.

## Balance (all live in js/config.js, tuned one change at a time)
- Ammo: start 18, max 40, slow regen 0.18/s (anti-softlock), +14 per supply crate.
- Health: start 100; each zombie at the tower base drains 5.5/s.
- Score: +10 per kill, +5 per extra zombie in an explosion combo.
- Waves: count = 8 + 4·wave; spawn interval 1.15 s → 0.32 s min; zombie speed 3.2 + 0.32·wave.
- Explosion radius 16 u; explosive pickup = 5 shots; multi-ball pickup = 3 shots × 5 balls.

## Determinism
- Fixed-timestep simulation (60 Hz) decoupled from render; seeded RNG for spawn placement.
