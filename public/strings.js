// All player-visible strings live here (zero literals in game code).
// Switching language = swapping this data.
export const STR = {
  title: 'GOLF Z',
  tagline: 'Tee off against the dead.',
  blurb: "Stranded on a rooftop in a dead city. Charge your swing and rain golf balls down on the horde. Drive the cart to grab supply crates. Survive the waves.",

  start: 'CLICK / TAP TO PLAY',
  startTouch: 'TAP TO PLAY',

  ctrlHeadDesktop: 'CONTROLS',
  ctrlAimDesktop: 'Mouse — aim',
  ctrlPowerDesktop: 'Hold Left-Click / Space — charge & release to drive',
  ctrlDriveDesktop: 'W A S D — drive the cart',
  ctrlPowerupDesktop: 'Q — use power-up · P / Esc — pause',

  ctrlHeadTouch: 'CONTROLS',
  ctrlAimTouch: 'Drag right side — aim',
  ctrlPowerTouch: 'Hold SWING — charge, release to fire',
  ctrlDriveTouch: 'Left pad — drive · ITEM — use power-up',

  ctrlGamepad: 'Gamepad: left stick drive · right stick aim · RT charge/fire · A use item',

  hudScore: 'SCORE',
  hudWave: 'WAVE',
  hudBest: 'BEST',
  hudAmmo: 'BALLS',
  hudHealth: 'TOWER',
  hudPower: 'POWER',

  waveIncoming: 'WAVE',
  waveSurge: '⚠ SURGE WAVE',
  waveCleared: 'WAVE CLEARED',

  pickExplosive: 'EXPLOSIVE BALLS x5',
  pickMultiball: 'MULTI-BALL x3',
  pickSupply: '+14 BALLS',
  pickHealth: '+30 TOWER',

  outOfAmmo: 'OUT OF BALLS — grab a crate',
  noPowerup: 'no power-up',

  paused: 'PAUSED',
  resume: 'RESUME',

  gameOver: 'OVERRUN',
  gameOverSub: 'The tower fell.',
  finalScore: 'FINAL SCORE',
  reached: 'REACHED WAVE',
  restart: 'PLAY AGAIN',

  swing: 'SWING',
  item: 'ITEM',

  // v2 — clubs / spin / wind
  hudWind: 'WIND',
  spinBack: 'BACKSPIN', spinNeutral: '—', spinTop: 'TOPSPIN',
  ctrlClubDesktop: 'C — weapon · V — spin · G — buy gun (survivors)',
  ctrlClubTouch: 'WEAPON / SPIN / BUY GUN — change shot',
  // v3 — weapons
  hudShells: 'SHELLS',
  unlockedWeapon: 'UNLOCKED',
  allWeaponsOwned: 'ALL WEAPONS OWNED',
  survivorsShort: 'SURVIVORS',
  buyWeaponLbl: 'BUY GUN',
  // v2 — cart / boost
  hudCart: 'CART', hudBoost: 'BOOST',
  gameOverCart: 'The cart was overrun.',
  ctrlBoostDesktop: 'Shift — boost · R — back to roof (drive the ramp down)',
  ctrlBoostTouch: 'BOOST — nitro · drive down the ramp',
  // v2 — survivors / tower defense
  hudSurvivors: 'SURVIVORS',
  survFreed: 'SURVIVOR FREED', noSurvivors: 'no survivors to deploy',
  builtTurret: 'DEPLOYED', wallDown: 'BARRICADE DOWN',
  buildTurret: 'TURRET', buildSpotter: 'SPOTTER', buildBarricade: 'BARRICADE',
  buildUpgrade: 'UPGRADE', buildSellLbl: 'SELL', buildPost: 'POST',
  ctrlBuildDesktop: 'B — build · [ ] choose · Enter place · X sell',
  ctrlBuildTouch: 'BUILD — deploy survivors at posts',
};
