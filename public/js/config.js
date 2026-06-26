// =============================================================
// GOLF Z — global tunable configuration (all balance numbers live here)
// Style (locked, golden-hour apocalypse) drives the palette + lighting below.
// =============================================================

export const CONFIG = {
  // ---- World / scale (FROZEN agency metrics) ----
  rooftopHeight: 8,       // low rooftop perch (street = y 0) — keeps the street visible
  rooftopSize: 30,        // square rooftop side length (drivable area)
  buildingRadius: 38,     // the DEFENSE PERIMETER: zombies stop & attack here (in the visible band)
  groundRadius: 380,      // ground plane half-extent
  spawnRadius: 96,        // zombies spawn on a ring at this radius
  despawnRadius: 200,     // balls beyond this are removed

  // ---- Golf ball physics ----
  gravity: 24,            // downward accel (scaled for game feel)
  dragCoef: 0.0016,       // quadratic air drag
  restitution: 0.42,      // ground bounciness
  rollFriction: 1.9,      // horizontal damping/sec while grounded
  ballRadius: 0.95,
  ballStopSpeed: 1.6,     // grounded ball below this speed stops
  ballMaxLife: 9,         // seconds before despawn
  maxBalls: 60,

  // ---- Shooting ----
  minLaunch: 16,          // launch speed at 0% power
  maxLaunch: 52,          // launch speed at 100% power
  powerChargeRate: 150,   // power meter %/sec (ping-pongs 0->100->0)
  pitchMin: -0.7,         // steepest down (rad)
  pitchMax: 0.95,         // highest lob (rad)
  pitchDefault: 0.02,     // ~level — from a low perch you drive shots out across the lot
  yawSensitivity: 0.0024, // mouse px -> rad
  pitchSensitivity: 0.0022,
  padAimSpeed: 2.2,       // gamepad stick -> rad/sec
  trajPoints: 64,         // trajectory preview sample count

  // ---- Cart / driving ----
  cartAccel: 30,
  cartMaxSpeed: 19,
  cartTurnRate: 2.5,      // rad/sec
  cartFriction: 3.0,

  // ---- Ammo ----
  startAmmo: 18,
  maxAmmo: 40,
  ammoRegen: 0.18,        // balls/sec trickle (anti-softlock)
  ammoPerSupply: 14,

  // ---- Health ----
  startHealth: 100,
  zombieDamage: 4.0,      // dmg/sec per zombie attacking the perimeter
  healthPerPack: 30,

  // ---- Zombies ----
  zombieRadius: 1.8,      // collision radius
  zombieHeight: 4.4,      // visual height
  zombieBaseSpeed: 3.1,
  zombieSpeedPerWave: 0.30,
  zombieMaxAlive: 70,

  // ---- Waves ----
  waveBaseCount: 8,
  waveCountPerWave: 4,
  spawnIntervalBase: 1.15,
  spawnIntervalMin: 0.30,
  waveBreak: 4.0,         // seconds between waves
  surgeEvery: 4,          // every Nth wave is a surge (count+speed jump)

  // ---- Scoring ----
  scorePerKill: 10,
  comboBonus: 5,          // per extra zombie in one explosion

  // ---- Power-ups ----
  explosionRadius: 13,
  explosiveShotsPerPickup: 5,
  multiballShotsPerPickup: 3,
  multiballSpread: 0.15,  // rad between spread balls
  multiballCount: 5,
  crateInterval: 12,      // seconds between roof crate drops
  crateLife: 24,
  crateCollectRadius: 4.2,

  // ---- Camera (elevated chase looking out + down over the street) ----
  camDistance: 15,
  camHeight: 15,
  camLookAhead: 24,
  camLookDrop: 11,
  camLerp: 7,             // follow smoothing (per sec)
  fov: 62,

  // ---- Palette (from the locked STYLE FORMULA) ----
  col: {
    sunWarm:    0xffd9a0,  // golden-hour key light
    skyTop:     0x4a5a6e,  // smog-hazed blue-grey zenith
    skyHorizon: 0xe8a766,  // warm hazy horizon
    fog:        0xd8a878,  // dusty warm haze
    concrete:   0x9a958b,  // sun-bleached grey concrete
    asphalt:    0x53504c,  // warm dark asphalt
    rust:       0x8a5a3a,
    cartWhite:  0xf2f0ea,  // clean white-and-chrome
    chrome:     0xb8bcc2,
    zombieSkin: 0x7c8a5e,  // sickly desaturated green-grey
    zombieCloth:0x4a4438,
    pickup:     0xff7a1a,  // bright safety-orange glow
    explosive:  0xff4a2a,
    multiball:  0x39b6ff,
    supply:     0xffc23a,
    health:     0x4dff7a,
  },
};

// Power-up metadata. order = cycle order for the "use" key.
export const POWERUPS = {
  explosive: { color: 0xff4a2a, label: 'EXPLOSIVE', icon: '💥' },
  multiball: { color: 0x39b6ff, label: 'MULTI-BALL', icon: '🎱' },
  supply:    { color: 0xffc23a, label: 'AMMO', icon: '⛳' },
  health:    { color: 0x4dff7a, label: 'HEALTH', icon: '➕' },
};
