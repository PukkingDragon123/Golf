// =============================================================
// GOLF Z — consolidated configuration (v2). Every tunable lives here.
// Style: golden-hour apocalypse. Build in slices; one knob at a time.
// =============================================================

export const CONFIG = {
  // ---- World / scale (FROZEN agency metrics) ----
  rooftopHeight: 8,
  rooftopSize: 30,
  buildingRadius: 38,     // defense perimeter: zombies stop & attack here
  groundRadius: 380,
  spawnRadius: 96,
  despawnRadius: 200,

  // ---- Golf ball physics ----
  gravity: 24,
  dragCoef: 0.0016,
  restitution: 0.42,
  rollFriction: 1.9,
  ballRadius: 0.95,
  ballStopSpeed: 1.6,
  ballMaxLife: 9,
  maxBalls: 60,
  trajPoints: 64,
  minLaunch: 16,          // legacy fallbacks; clubs own launch bands
  maxLaunch: 52,

  // ---- Shooting / aim ----
  powerChargeRate: 150,
  pitchMin: -0.7,
  pitchMax: 0.95,
  pitchDefault: 0.02,
  yawSensitivity: 0.0024,
  pitchSensitivity: 0.0022,
  padAimSpeed: 2.2,

  // ---- Spin (Magnus) ----
  kMagnus: 0.0042,
  spinDecay: 0.55,
  sideSpinK: 22,
  sideSpinMax: 12,
  aimYawVelDamp: 12,
  spinTrimBack: 7,
  spinTrimTop: 9,
  // spin-aware bounce / roll
  backBiteK: 0.085,
  minHoriz: 0.02,
  backKickThresh: 8.0,
  backKickK: 0.55,
  bounceSpinLoss: 0.35,
  groundedVyThresh: 4.0,
  rollSpinReduce: 0.6,
  topspinRollK: 0.07,
  rollWindK: 0.15,
  // wind
  windMax: 7.0,
  windChangeMin: 5.0,
  windChangeMax: 11.0,
  windLerp: 0.4,
  // weapons (cycled in order; first 3 are the golf clubs). fireType branches fire():
  //   'normal' = charged golf swing, 'rapid' = held tap-fire, 'explosive' = detonate-on-impact shell
  WEAPONS: [
    { id: 'driver', label: 'DRIVER', icon: '🏌️', minLaunch: 30, maxLaunch: 52, loftBias: -0.06, backspin: 4, drag: 0.85, gravityMul: 1.0, fireType: 'normal', chargeRate: 150, fireCooldown: 0.0, ammoCost: 1, ammoKind: 'balls', restitution: 0.42, ballScale: 1.0, look: 'ball', owned: true, cost: 0 },
    { id: 'iron', label: '9-IRON', icon: '⛳', minLaunch: 22, maxLaunch: 40, loftBias: 0.10, backspin: 9, drag: 1.0, gravityMul: 1.0, fireType: 'normal', chargeRate: 150, fireCooldown: 0.0, ammoCost: 1, ammoKind: 'balls', restitution: 0.42, ballScale: 1.0, look: 'ball', owned: true, cost: 0 },
    { id: 'wedge', label: 'WEDGE', icon: '🪓', minLaunch: 14, maxLaunch: 30, loftBias: 0.30, backspin: 15, drag: 1.25, gravityMul: 1.0, fireType: 'normal', chargeRate: 150, fireCooldown: 0.0, ammoCost: 1, ammoKind: 'balls', restitution: 0.42, ballScale: 1.0, look: 'ball', owned: true, cost: 0 },
    // PUTTER: ground roller — near-zero loft, baked topspin (negative backspin), low bounce, carries & mows a lane
    { id: 'putter', label: 'PUTTER', icon: '🥍', minLaunch: 26, maxLaunch: 46, loftBias: -0.34, backspin: -14, drag: 0.55, gravityMul: 1.0, fireType: 'normal', chargeRate: 160, fireCooldown: 0.10, ammoCost: 1, ammoKind: 'balls', restitution: 0.08, ballScale: 1.0, look: 'ball', owned: true, cost: 0 },
    // SLINGSHOT: fast flat rapid-fire steel pellet — low gravity, quick charge, short cooldown, weak per-hit
    { id: 'sling', label: 'SLINGSHOT', icon: '🔩', minLaunch: 46, maxLaunch: 64, loftBias: -0.02, backspin: 0, drag: 0.45, gravityMul: 0.45, fireType: 'rapid', chargeRate: 420, fireCooldown: 0.16, ammoCost: 1, ammoKind: 'balls', restitution: 0.30, ballScale: 0.5, look: 'steel', owned: false, cost: 6 },
    // BAZUGOLF: the golf bazooka — slow heavy explosive shell, big AoE + knockback, own scarce ammo
    { id: 'bazu', label: 'BAZUGOLF', icon: '🚀', minLaunch: 18, maxLaunch: 30, loftBias: 0.06, backspin: 0, drag: 1.6, gravityMul: 0.8, fireType: 'explosive', chargeRate: 110, fireCooldown: 0.45, ammoCost: 1, ammoKind: 'shells', restitution: 0.0, ballScale: 1.8, look: 'shell', owned: false, cost: 10 },
  ],
  defaultWeapon: 0,
  // weapon-system knobs
  weaponShellsStart: 0, weaponShellsMax: 8, weaponShellsPerCrate: 3,
  slingDamage: 0.6, putterMowDamage: 1,
  bazuKnockback: 22, bazuExplosionRadius: 17, bazuTrauma: 0.55, bazuHitStop: 120,
  slingTrauma: 0.05, unlockToastColor: 0x9cff5a,

  // ---- Cart / driving (v2 arcade + ground) ----
  cartAccel: 34,
  cartMaxSpeed: 22,
  cartReverseSpeed: 9,
  cartTurnRate: 2.6,
  cartTurnFalloff: 12,
  cartFriction: 3.0,
  cartDriftGain: 0.020,
  cartGrip: 6.0,
  cartGroundFollow: 14,
  // boost
  boostMax: 2.2,
  boostRegen: 0.5,
  boostAccelMult: 1.9,
  boostSpeedMult: 1.55,
  boostCooldown: 1.2,
  // suspension / tilt
  cartLeanGain: 0.010,
  cartSkidLean: 0.05,
  cartLeanMax: 0.22,
  cartPitchGain: 0.004,
  cartTiltDamp: 9,
  // ramp + ground play area
  ramp: { width: 8, slopeRise: 9.2, slopeRun: 22, apronZ: 4, side: 1, curbH: 0.35 },
  groundPlayRadius: 150,
  // run-over
  cartHitRadius: 2.2,
  cartNoseOffset: 2.6,
  runOverMinSpeed: 4,
  runOverImpulseMin: 10,
  runOverImpulseMax: 30,
  runOverBoostMult: 1.6,
  runOverForwardMix: 0.7,
  runOverLiftBase: 4,
  runOverLiftSpeed: 8,
  runOverDrag: 0.92,
  runOverDragBoost: 0.97,
  runOverIFrame: 0.4,
  ragdollLife: 1.6,
  scoreRunOver: 12,
  scoreRunOverSpeedBonus: 10,
  roadkillWindow: 1.5,
  // cart health / street risk
  cartHealth: 100,
  cartClawRadius: 5.0,
  cartClawDamage: 9.0,
  cartHealthRegen: 6.0,
  // camera ground variants + clamp
  camDistanceGround: 11,
  camHeightGround: 5.5,
  camLookDropGround: 1.5,
  camLookAheadGround: 16,
  camMinAbove: 2.5,

  // ---- Ammo ----
  startAmmo: 18,
  maxAmmo: 40,
  ammoRegen: 0.18,
  ammoPerSupply: 14,

  // ---- Health (tower) ----
  startHealth: 100,
  zombieDamage: 4.0,
  healthPerPack: 30,

  // ---- Zombies ----
  zombieRadius: 1.8,
  zombieHeight: 4.4,
  zombieBaseSpeed: 3.1,
  zombieSpeedPerWave: 0.30,
  zombieMaxAlive: 48,
  zombieTypes: [
    { name: 'shambler', speedMul: 1.00, scale: 1.00, health: 2, gait: 'walk', weight: 0.0, tintR: 0.78, tintG: 0.86, tintB: 0.62 },
    { name: 'runner', speedMul: 1.85, scale: 0.82, health: 1, gait: 'run', weight: 0.0, tintR: 0.86, tintG: 0.88, tintB: 0.74 },
    { name: 'brute', speedMul: 0.55, scale: 1.55, health: 6, gait: 'walk', weight: 0.85, tintR: 0.62, tintG: 0.55, tintB: 0.45 },
  ],
  maxRagdolls: 18,
  ragdollSettle: 1.6,
  ragdollFade: 1.2,
  maxDebris: 84,
  ballDamage: 1,
  explosionDamage: 5,
  runoverDamage: 4,
  bruteDamageMul: 3,
  dismemberBallSpeed: 30,
  headTrackMax: 0.7,

  // ---- Waves ----
  waveBaseCount: 8,
  waveCountPerWave: 4,
  spawnIntervalBase: 1.15,
  spawnIntervalMin: 0.30,
  waveBreak: 4.0,
  surgeEvery: 4,

  // ---- Scoring ----
  scorePerKill: 10,
  comboBonus: 5,

  // ---- Power-ups ----
  explosionRadius: 13,
  explosiveShotsPerPickup: 5,
  multiballShotsPerPickup: 3,
  multiballSpread: 0.15,
  multiballCount: 5,
  crateInterval: 12,
  crateLife: 24,
  crateCollectRadius: 4.2,

  // ---- Gore (v3: heavier — denser blood, more chunks, exposed bone, longer decals) ----
  gore: {
    particleCap: 560, particleSize: 1.15, bloodColor: 0x7a0a0a, groundY: 0.06, dropSplatChance: 0.06,
    burstBase: 13, burstSpeed: 18, decalRes: 1024, decalWorldSize: 220, decalY: 0.05,
    splatBaseRadiusPx: 26, inkFadeThreshold: 130, fadeInterval: 1.0, fadeAlpha: 0.035,
    chunkCap: 80, chunkScale: 0.5, chunkSpeed: 8, chunkLife: 2.6, chunkGroundY: 0.32,
    chunkColor: 0x8c1414, chunksPerKill: 3,
    // arterial spurt from a fresh stump + exposed bone stub colour/size
    spurtN: 14, spurtSpeed: 12, boneColor: 0xe9e3d2, stubLen: 0.52, stubR0: 0.10, stubR1: 0.19,
  },

  // ---- Survivors / tower-defense ----
  surv: {
    maxCages: 16, maxActiveCages: 6, cagesPerWave: 2,
    cageRadMin: 50, cageRadMax: 82, nearCageChance: 0.25,
    cageHP: 3, ballCageDamage: 1,
    clearRadius: 9, clearHold: 1.2, cartRescueRadius: 8,
    freeDur: 0.5, runSpeed: 9, scorePerRescue: 75,
    postCount: 12, postRadius: 40, startSurvivors: 1,
    turret: [null,
      { range: 26, rate: 1.6, damage: 1, projSpeed: 60, cost: 2, manned: 1 },
      { range: 30, rate: 2.2, damage: 1.5, projSpeed: 70, cost: 2, manned: 2 },
      { range: 34, rate: 2.8, damage: 2, projSpeed: 80, cost: 3, manned: 3 }],
    retargetInterval: 0.25, perimeterBias: 1.5, muzzleY: 2.2,
    spotterCost: 1, spotterRadius: 14, spotterSlow: 0.55, spotterBuff: 1.25,
    projMax: 48, projRadius: 0.6, projLife: 1.4,
    barricadeCost: 1, barricadeArc: 0.22, barricadeHP: [0, 120, 220, 360], barricadeSlow: [1, 0.6, 0.45, 0.3],
    barricadeUpgradeCost: 1, repairScoreCost: 200, wallStandoff: 2.5, zombieVsBarricade: 9,
    sellRefundFrac: 0.5,
  },

  // ---- Chaos props ----
  props: {
    barrelCount: 14, carCount: 7, ringMin: 46, ringMax: 90, clusterCount: 5, clusterSpread: 6,
    barrelRadius: 1.3, barrelHeight: 2.6, carRadius: 2.8, carHalf: [3.2, 1.4, 1.6],
    barrelDmgRadius: 12, carDmgRadius: 16, barrelTrauma: 0.55, carTrauma: 0.8,
    barrelHitStop: 70, carHitStop: 110, chainDelayMin: 60, chainDelayMax: 180,
    debrisCount: 18, carDebrisCount: 30, fuseFlash: 0.12, ramSpeedMin: 6, respawnFrac: 0.6, scorePerProp: 25,
  },

  // ---- Screen shake + hit-stop ----
  shake: {
    maxYaw: 0.06, maxPitch: 0.05, maxRoll: 0.07, maxOffset: 0.9, decay: 1.7, freq: 22, traumaMax: 1.0,
    shotKick: 0.12, bigShotKick: 0.28, minHitStopScale: 0.05, shakeRunOver: 0.28, shakeClaw: 0.6,
  },

  // ---- Bloom ----
  bloom: { strength: 0.85, radius: 0.55, threshold: 0.78, pixelRatioCap: 1.5, exposureBoostOnBoom: 0.12 },
  grade: { fogBoomColor: 0xff7a3a, fogBoomAmount: 0.0 },

  // ---- Camera (roof baseline) ----
  camDistance: 15,
  camHeight: 15,
  camLookAhead: 24,
  camLookDrop: 11,
  camLerp: 7,
  fov: 62,

  // ---- Palette (golden-hour) ----
  col: {
    sunWarm: 0xffd9a0, skyTop: 0x4a5a6e, skyHorizon: 0xe8a766, fog: 0xd8a878,
    concrete: 0x9a958b, asphalt: 0x53504c, rust: 0x8a5a3a,
    cartWhite: 0xf2f0ea, chrome: 0xb8bcc2,
    zombieSkin: 0x7c8a5e, zombieCloth: 0x4a4438,
    pickup: 0xff7a1a, explosive: 0xff4a2a, multiball: 0x39b6ff, supply: 0xffc23a, health: 0x4dff7a,
    barrel: 0xc24a2a, barrelBand: 0xf0c020, carBody: 0x6a6e72,
    survivor: 0x4dff7a, turret: 0xb8bcc2, barricade: 0x8a5a3a, spotter: 0x39b6ff,
  },
};

// Power-up metadata. order = cycle order for the "use" key.
export const POWERUPS = {
  explosive: { color: 0xff4a2a, label: 'EXPLOSIVE', icon: '💥' },
  multiball: { color: 0x39b6ff, label: 'MULTI-BALL', icon: '🎱' },
  supply: { color: 0xffc23a, label: 'AMMO', icon: '⛳' },
  health: { color: 0x4dff7a, label: 'HEALTH', icon: '➕' },
};
