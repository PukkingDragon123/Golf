# GOLF Z — Design Plan

A 3D zombie-golf survival game. You are a golfer stranded on a skyscraper rooftop
in a dead city; rain golf balls down on the zombie horde flooding the streets.

## Profile
- **Time:** real-time. **Space:** continuous 3D. **Agency:** one hero (golfer + cart).
- **Conflict:** vs system (the horde). **Content:** procedural waves. **Outcome:** endless survival (score + best wave).
- **Players:** solo. **Session:** minutes. **Engagement:** execution (aim/power skill) + accumulation (score, waves, power-ups).
- **Delivery context:** web — desktop (mouse+keyboard) + mobile (touch) + gamepad. Strings external. Physical key codes.

## Experience formula
The player feels like a clutch sharpshooter under rising pressure because the game constantly
rewards a well-read arcing shot with a satisfying multi-zombie wipe, while the horde keeps
creeping toward the tower.

## Core verbs
- **Aim** (yaw/pitch) — re-weighted by distance, height, and power-up type.
- **Charge & Drive (swing)** — a ping-pong power meter; timing = skill.
- **Drive the cart** — reposition the shooting platform, collect crates, dodge nothing but reposition for angles.
- **Use power-up** — explosive (AoE), multi-ball (spread), supply (ammo), health.

## Loops
- Positive: combos/explosives clear groups → score → (no runaway; ammo is the limiter).
- Negative: ammo is scarce (sources: slow regen + supply crates; sink: every shot). Health drains while zombies reach the tower — good aim is the comeback.

## Information map
- Visible: trajectory preview line, power meter, ammo, health, wave, score, active power-up, horde threat (zombies at the base glow/cluster).
- The threat trail is observable (zombies converge on the tower base) — no hidden state decides the outcome.

## Walkthrough (subsystems)
1. **Representation:** third-person chase camera behind the golfer, looking out/down over the street. Player controls camera yaw/pitch (= aim). HUD never hides the firing lane.
2. **Input:** mouse aim + hold-to-charge (desktop); drag-aim + tap-charge (touch); right stick aim + trigger charge (gamepad). WASD / left-stick / touch d-pad drives the cart. Physical key codes.
3. **Agency metrics (FROZEN):** launch speed 26–78 u/s, gravity 24, rooftop at y=42, spawn ring r=190. All live in `js/config.js`.
4. **Resistance × verb:** distance→power; clustering→explosive; spread of fast zombies→multi-ball; running dry→drive to crate / regen; tower pressure→prioritize base.
5. **Peaks:** every Nth wave is a surge (count + speed jump) — the exam of the patterns taught so far.
6. **Rewards:** strongest reward = a new verb (explosive/multi-ball change how you aim). Big rewards (crates) drop on the roof between waves.
7. **Interface:** every HUD element serves a decision; nothing decorative.
8. **Economy:** ammo has sources (regen, supply crates) and sinks (shots). Health has sources (health packs) and sinks (zombie attacks at base).
9. **Delivery of mechanics:** wave 1 teaches aim+power; explosive/multi-ball introduced via early crate drops in safety before the surge.
10. **Entry:** title → "Click / Tap to play" → immediate aiming. On death: score, best wave, restart.

## Technology
- Three.js (vendored, no CDN) on a `<canvas>`, custom golf/cart physics, fixed-timestep sim.
- PBR materials from generated + post-processed textures (basecolor/normal/roughness).
- Zombies = a single `InstancedMesh` of camera-facing sprite billboards (one draw call for the whole horde).
- Golden-hour directional sun + warm fog + ambient; film-grain & vignette via CSS overlay.
- Web Audio for SFX/music playback with per-layer gain (music quiet, sfx mid).

## Style (locked, byte-identical into every asset prompt)
> Gritty photorealistic 3D with physically-based weathered surfaces and faint cinematic film grain; solid believable proportions, no cartoon outlines, worn concrete-and-metal edges. Environment in sun-bleached grey concrete and warm asphalt with rust accents; the golf cart, clubs and balls in clean white-and-chrome that pops against the grime; zombies in sickly desaturated green-grey flesh and torn clothing; pickups marked with a bright safety-orange glow. Warm golden-hour sun raking low through smog-hazed abandoned streets, long soft shadows, dusty volumetric haze. High contrast, clean readable silhouettes, consistent grounded realistic 3D-game perspective.

## Honest limits
No 3D mesh generator available → characters/props are real geometry + sprite billboards dressed in
photoreal textures, not bespoke sculpted meshes. Target is gritty grounded realism, not film-CGI characters.
