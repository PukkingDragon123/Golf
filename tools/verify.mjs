import { chromium } from 'playwright-core';

const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const URL = 'http://localhost:8123/?dev=1';

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

const errors = [], warns = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error') errors.push(m.text()); else if (t === 'warning') warns.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e?.stack || e)));
page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(1200);

console.log('BOOT', JSON.stringify(await page.evaluate(() => ({
  golfz: !!window.GOLFZ, state: window.GOLFZ?.game?.state,
  draws: window.GOLFZ?.renderer?.info?.render?.calls, tris: window.GOLFZ?.renderer?.info?.render?.triangles,
  gl: (() => { try { return !!window.GOLFZ.renderer.getContext(); } catch { return false; } })(),
}))));
await page.screenshot({ path: 'tools/shot_menu.png' });

await page.click('#btn-play').catch((e) => console.log('click err', e.message));
await page.waitForTimeout(300);

// Drive the fixed-step sim manually (headless rAF is throttled).
const r = await page.evaluate(() => {
  const { ctx, game, renderer, scene, camera } = window.GOLFZ;
  const countAlive = () => ctx.zombies.z.reduce((n, z) => n + (z.alive ? 1 : 0), 0);
  const out = {};

  // 0) golf physics: full-power flat carry per club (driver>iron>wedge), via the shared preview integrator
  ctx.golf.wind.set(0, 0, 0); ctx.golf.spinMode = 'default'; ctx.golf.aimYaw = Math.PI; ctx.golf.aimPitch = 0.1;
  ctx.golf.charging = true; ctx.golf.power = 100;
  const so = ctx.player.shootOrigin; const carry = [];
  for (let ci = 0; ci < 3; ci++) {
    ctx.golf.clubIndex = ci; ctx.golf.updatePreview(true);
    carry.push(Math.round(Math.hypot(ctx.golf.marker.position.x - so.x, ctx.golf.marker.position.z - so.z)));
  }
  ctx.golf.charging = false; ctx.golf.clubIndex = 0;
  out.carry = carry; // expect descending
  out.clubCycle = ctx.golf.cycleClub().label; ctx.golf.clubIndex = 0;
  { const w = {}; ctx.golf.windInfo(w); out.windOk = typeof w.mag === 'number'; }

  // 0a-weapons) putter roller, slingshot rapid steel, bazugolf explosive shell
  const countActiveBalls = () => ctx.golf.balls.reduce((n, b) => n + (b.active ? 1 : 0), 0);
  // putter: full-power flat roll should out-carry a lofted wedge AND end up rolling on the deck
  ctx.golf.selectWeapon('putter'); ctx.golf.aimYaw = Math.PI; ctx.golf.aimPitch = 0.1;
  ctx.golf.charging = true; ctx.golf.power = 100; ctx.golf.updatePreview(true);
  out.putterCarry = Math.round(Math.hypot(ctx.golf.marker.position.x - so.x, ctx.golf.marker.position.z - so.z));
  ctx.golf.charging = false;
  // unlock the two locked guns the way the game does (spend survivors)
  game.survivors = 40;
  out.lockedFirst = ctx.golf.nextLockedWeapon().id;     // expect 'sling'
  game.buyWeapon();                                     // unlocks sling, selects it
  out.afterBuy1 = ctx.golf.weapon.id;
  out.lockedSecond = ctx.golf.nextLockedWeapon().id;    // expect 'bazu'
  game.buyWeapon();                                     // unlocks bazu (+3 shells), selects it
  out.afterBuy2 = ctx.golf.weapon.id; out.shellsAfterBuy = game.shells;
  // slingshot: held rapid fire should emit several pellets over ~0.6s and burn balls
  ctx.golf.selectWeapon('sling'); game.ammo = 30; const sa0 = game.ammo;
  ctx.golf.beginFire(); for (let k = 0; k < 40; k++) ctx.golf.update(1 / 60, true); ctx.golf.endFire();
  out.slingShots = sa0 - game.ammo;                     // expect several
  for (let k = 0; k < 40; k++) ctx.golf.update(1 / 60, true);  // let pellets clear
  // bazugolf fire(): consumes a shell + respects cooldown (gameplay path)
  ctx.golf.selectWeapon('bazu'); game.shells = 4; ctx.golf._cooldown = 0;
  const bs0 = game.shells; ctx.golf.aimYaw = Math.PI; ctx.golf.aimPitch = 0.2; ctx.golf.fire(1.0);
  out.bazuSpent = bs0 - game.shells;                    // expect 1
  out.bazuCooldownBlocks = (ctx.golf.fire(1.0), game.shells === bs0 - 1); // 2nd fire blocked by cooldown
  // bazugolf detonation: inject a shell straight down onto a frozen cluster -> bigger AoE kill
  for (let k = 0; k < 6; k++) ctx.zombies.spawn('shambler');
  const bzc = ctx.zombies.z.filter((z) => z.alive).slice(-6);
  bzc.forEach((z, j) => { z.x = (j - 3) * 2.2; z.zz = -34; z.speed = 0; z.hp = 1; });
  const bk0 = ctx.zombies.aliveCount;
  const sh = ctx.golf.balls.find((b) => !b.active);
  sh.active = true; sh.grounded = false; sh.life = 0; sh.explosive = true; sh.bazu = true;
  sh.drag = 1.6; sh.gravityMul = 0.8; sh.restitution = 0; sh.dmg = 5; sh.spin.set(0, 0, 0);
  sh.mesh.material = ctx.golf.shellMat; sh.mesh.scale.setScalar(1.8); sh.mesh.visible = true;
  sh.mesh.position.set(0, 16, -34); sh.vel.set(0, -22, 0);
  for (let k = 0; k < 90; k++) ctx.golf.update(1 / 60, true);
  out.bazuKills = bk0 - ctx.zombies.aliveCount;          // expect several (radius 17)
  // bone stubs: the dismembered cluster should be mid-ragdoll showing exposed bone now
  ctx.zombies.update(1 / 60);
  const bm = ctx.zombies.boneMesh.instanceMatrix.array; let stubs = 0;
  for (let k = 0; k < bm.length; k += 16) { const sx = Math.hypot(bm[k], bm[k + 1], bm[k + 2]); if (sx > 0.05) stubs++; }
  out.boneStubsVisible = stubs;                          // expect > 0 (severed wounds expose bone)
  out.dismembered = ctx.zombies.z.filter((z) => z.dying && z.detach).length;
  // restore default loadout + a fresh wave so downstream sections mirror baseline
  ctx.golf.reset(); ctx.golf.clubIndex = 0;
  ctx.zombies.reset(); ctx.zombies.startWave(1);

  // 0b) vehicle: surface regions (roof/ramp/ground) + run-over kill+score
  out.surf = [ctx.player._surfaceAt(0, 8).region, ctx.player._surfaceAt(0, 28).region, ctx.player._surfaceAt(0, 60).region];
  ctx.zombies.spawn('shambler');
  const tz = ctx.zombies.z.find((z) => z.alive);
  tz.x = 0; tz.zz = -60; tz.speed = 0; tz.hitT = 0; tz.hp = 1;
  ctx.player.pos.set(0, 0, -54); ctx.player.region = 0; ctx.player.heading = Math.PI; ctx.player.speed = 18; ctx.player._fwd.set(0, 0, -1);
  const rs0 = game.score;
  ctx.player.runOverPass(1 / 60);
  out.ranOver = tz.dying || !tz.alive;
  out.runScore = game.score - rs0;
  ctx.player.returnToRoof();

  // 0c) chaos props: placed + ball detonation + chain reaction
  out.propsAlive = ctx.props.all.filter((p) => p.alive).length;
  const bar = ctx.props.barrels.find((p) => p.alive);
  if (bar) {
    for (let k = 0; k < 6; k++) ctx.zombies.spawn('shambler');
    ctx.zombies.z.filter((z) => z.alive).slice(-6).forEach((z) => { z.x = bar.x + (Math.random() - 0.5) * 5; z.zz = bar.z + (Math.random() - 0.5) * 5; z.speed = 0; });
    const ps0 = game.score, pa0 = ctx.props.all.filter((p) => p.alive).length;
    ctx.props.detonate(bar, 0);
    for (let k = 0; k < 60; k++) ctx.props.update(1 / 60);
    out.propScore = game.score - ps0;
    out.propsDestroyed = pa0 - ctx.props.all.filter((p) => p.alive).length;
  }

  // 0d) survivors / tower-defense: cages, rescue, turret, barricade
  ctx.survivors.onWaveStart(1);
  out.cages = ctx.survivors.surv.filter((s) => s.state === 'caged').length;
  const cg = ctx.survivors.surv.find((s) => s.state === 'caged');
  if (cg) {
    cg.x = 30; cg.z = 0; const sv0 = game.survivors;
    ctx.survivors._free(cg);
    for (let k = 0; k < 700; k++) ctx.survivors.update(1 / 60);
    out.rescued = game.survivors - sv0;
  }
  game.survivors = 12; ctx.survivors.buildMode = true; ctx.survivors.selectedPost = 0; ctx.survivors.pendingBuild = 'turret';
  ctx.survivors.confirmBuild();
  out.turretBuilt = ctx.survivors.posts[0].build;
  ctx.zombies.spawn('shambler');
  const tzz = ctx.zombies.z.filter((z) => z.alive).slice(-1)[0];
  const p0 = ctx.survivors.posts[0]; tzz.x = p0.x + 5; tzz.zz = p0.z; tzz.speed = 0; tzz.hp = 6;
  const hp0 = tzz.hp;
  for (let k = 0; k < 150; k++) ctx.survivors.update(1 / 60);
  out.turretWorks = (hp0 - tzz.hp) > 0 || !tzz.alive;
  game.survivors = 12; ctx.survivors.selectedPost = 3; ctx.survivors.pendingBuild = 'barricade'; ctx.survivors.confirmBuild();
  out.blockOk = ctx.survivors.blockAt(ctx.survivors.posts[3].angle).blocked;
  ctx.survivors.buildMode = false; ctx.survivors.reset();

  // 1) spawn the wave
  for (let i = 0; i < 480; i++) game.step(1 / 60);
  out.spawned = countAlive(); out.toSpawn = ctx.zombies.toSpawn;

  // 2) deterministic collision API tests
  const liveA = ctx.zombies.z.filter((z) => z.alive);
  if (liveA.length) {
    const z0 = liveA[0];
    out.hitTestHit = ctx.zombies.hitTest({ x: z0.x, y: 2, z: z0.zz }, 0.95) ? 1 : 0;
    const a0 = countAlive();
    out.areaKills = ctx.zombies.damageArea({ x: z0.x, y: 2, z: z0.zz }, 16);
    out.aliveDropAfterArea = a0 - countAlive();
  }

  // 3) full ball-physics path: drop a ball onto a FROZEN zombie -> must kill + score
  for (let i = 0; i < 120; i++) game.step(1 / 60); // respawn some
  const live2 = ctx.zombies.z.filter((z) => z.alive);
  let ballKill = 0;
  if (live2.length) {
    const z1 = live2[0]; z1.speed = 0; z1.hp = 1; // freeze + 1-hit so the drop kills & scores
    const b = ctx.golf.balls.find((x) => !x.active);
    b.active = true; b.grounded = false; b.life = 0; b.explosive = false;
    b.mesh.material = ctx.golf.ballMat; b.mesh.visible = true;
    b.mesh.position.set(z1.x, 30, z1.zz); b.vel.set(0, -15, 0);
    const s0 = game.score, a0 = countAlive();
    for (let i = 0; i < 120; i++) game.step(1 / 60);
    ballKill = a0 - countAlive(); out.ballScoreGain = game.score - s0;
  }
  out.ballPhysicsKill = ballKill;
  out.goreInk = Math.round(ctx.gore._ink);
  out.goreChunkCap = ctx.gore.chunks.length;

  // 4) real fire() path (multiball + normal) — must not throw
  game.multiballShots = 3; game.armed = 'multiball'; ctx.golf.aimPitch = -0.5; ctx.golf.fire(0.8);
  game.explosiveShots = 5; game.armed = 'explosive'; ctx.golf.fire(0.85);
  for (let i = 0; i < 30; i++) game.step(1 / 60);

  // 5) perf + visibility: force a near-full horde across the perimeter band, look out
  for (let i = 0; i < 70; i++) ctx.zombies.spawn();
  for (let i = 0; i < 3; i++) game.step(1 / 60);
  ctx.player.pos.set(0, ctx.player.roofTop, 0);
  ctx.player.heading = Math.PI;
  const liveH = ctx.zombies.z.filter((z) => z.alive);
  liveH.forEach((z, i) => {
    const ang = Math.PI + ((i / liveH.length) - 0.5) * 1.7;  // wide arc toward -Z
    const rad = 22 + (i % 7) * 5;
    z.x = Math.sin(ang) * rad; z.zz = Math.cos(ang) * rad;
    z.yaw = Math.atan2(-z.x, -z.zz);
    if (i % 6 === 0) { z.type = 2; z.scale = 1.55; }          // a few brutes for size variety
    else if (i % 3 === 0) { z.type = 1; z.scale = 0.82; z.gait = 1; }
  });
  for (let k = 0; k < 24; k++) ctx.zombies.update(1 / 60);    // a few frames of walk anim (frozen below)
  liveH.forEach((z) => { z.speed = 0; });
  // lay down visible gore in the kill zone for the screenshot
  for (let k = 0; k < 16; k++) { const a = Math.PI + (k / 16 - 0.5) * 1.6, rd = 28 + (k % 5) * 7; ctx.gore.killGore({ x: Math.sin(a) * rd, y: 1.4, z: Math.cos(a) * rd }, Math.sin(a), Math.cos(a), 2.2); }
  ctx.gore.update(1 / 60);
  ctx.golf.aimYaw = Math.PI; ctx.golf.aimPitch = -0.34;
  for (let i = 0; i < 16; i++) ctx.golf.updateCamera(camera, 0.3);
  ctx.golf.updatePreview(true);
  renderer.render(scene, camera);
  out.drawCalls = renderer.info.render.calls;
  out.tris = renderer.info.render.triangles;
  out.finalScore = game.score; out.health = Math.round(game.health); out.state = game.state;
  ctx.postfx.render(0.05);   // composite (bloom) for the screenshot
  return out;
});
console.log('RUN', JSON.stringify(r, null, 0));
await page.screenshot({ path: 'tools/shot_game.png' });

// driving screenshot: cart on the street facing the horde, ground chase cam
await page.evaluate(() => {
  const { ctx, game, hud, camera } = window.GOLFZ;
  game.state = 'playing'; game.health = 1000; hud.startPlaying();
  let i = 0; for (const z of ctx.zombies.z) { if (!z.alive) continue; const a = (i++ / 9) * Math.PI * 2, rd = 46 + (i % 4) * 7; z.x = Math.sin(a) * rd; z.zz = Math.cos(a) * rd; z.speed = 0; z.atBase = false; }
  // stage tower defense: turrets + barricade + a caged survivor, all in -Z view
  ctx.survivors.reset(); game.survivors = 30; ctx.survivors.buildMode = true;
  ctx.survivors.selectedPost = 5; ctx.survivors.pendingBuild = 'turret'; ctx.survivors.confirmBuild(); ctx.survivors.confirmBuild();
  ctx.survivors.selectedPost = 6; ctx.survivors.confirmBuild();
  ctx.survivors.selectedPost = 7; ctx.survivors.pendingBuild = 'barricade'; ctx.survivors.confirmBuild();
  ctx.survivors.buildMode = false;
  const cg2 = ctx.survivors.surv.find((s) => s.state === 'idle'); if (cg2) { cg2.state = 'caged'; cg2.x = 12; cg2.z = -62; cg2.cageHP = 3; }
  ctx.survivors.update(0.016);
  ctx.player.pos.set(8, 0, 58); ctx.player.region = 0; ctx.player.heading = Math.PI; ctx.player.speed = 0;
  ctx.player.root.position.copy(ctx.player.pos); ctx.player.root.rotation.set(0, Math.PI, 0);
  ctx.golf.aimYaw = Math.PI; ctx.golf.aimPitch = 0.0; ctx.golf._g = 1;
  for (let k = 0; k < 24; k++) ctx.golf.updateCamera(camera, 0.2);
  ctx.postfx.render(0.05);
});
await page.screenshot({ path: 'tools/shot_drive.png' });

// long-run stability: ~90s across waves, firing + building, watch for NaN / runaway pools
const stress = await page.evaluate(() => {
  const { ctx, game } = window.GOLFZ;
  game.start();
  for (let i = 0; i < 5400; i++) {
    game.step(1 / 60);
    if (i % 24 === 0 && game.ammo > 0) { ctx.golf.aimYaw = Math.PI + Math.sin(i * 0.013) * 1.2; ctx.golf.aimPitch = 0.12; ctx.golf.fire(0.85); }
    if (i % 540 === 0) { game.survivors += 3; ctx.survivors.buildMode = true; ctx.survivors.selectedPost = Math.floor(i / 540) % 12; ctx.survivors.pendingBuild = 'turret'; ctx.survivors.confirmBuild(); ctx.survivors.buildMode = false; }
    if (game.state !== 'playing') break;
  }
  let alive = 0, dy = 0; for (const z of ctx.zombies.z) { if (z.alive) alive++; if (z.dying) dy++; }
  let proj = 0; for (const p of ctx.survivors.proj) if (p.active) proj++;
  let balls = 0; for (const b of ctx.golf.balls) if (b.active) balls++;
  const nanPos = !(isFinite(ctx.player.pos.x) && isFinite(ctx.player.pos.y) && isFinite(ctx.player.pos.z));
  return { endState: game.state, wave: game.wave, score: game.score, alive, dying: dy, proj, balls, nanPos };
});
console.log('STRESS', JSON.stringify(stress));

console.log('--- ERRORS (' + errors.length + ') ---'); errors.slice(0, 40).forEach((e) => console.log(e));
console.log('--- WARNINGS (' + warns.length + ') ---'); warns.slice(0, 10).forEach((w) => console.log(w));

await browser.close();
process.exit(errors.length ? 1 : 0);
