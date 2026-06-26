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
    const z1 = live2[0]; z1.speed = 0; // freeze so the ball lands on it
    const b = ctx.golf.balls.find((x) => !x.active);
    b.active = true; b.grounded = false; b.life = 0; b.explosive = false;
    b.mesh.material = ctx.golf.ballMat; b.mesh.visible = true;
    b.mesh.position.set(z1.x, 30, z1.zz); b.vel.set(0, -15, 0);
    const s0 = game.score, a0 = countAlive();
    for (let i = 0; i < 120; i++) game.step(1 / 60);
    ballKill = a0 - countAlive(); out.ballScoreGain = game.score - s0;
  }
  out.ballPhysicsKill = ballKill;

  // 4) real fire() path (multiball + normal) — must not throw
  game.multiballShots = 3; game.armed = 'multiball'; ctx.golf.aimPitch = -0.5; ctx.golf.fire(0.8);
  game.explosiveShots = 5; game.armed = 'explosive'; ctx.golf.fire(0.85);
  for (let i = 0; i < 30; i++) game.step(1 / 60);

  // 5) perf + visibility: force a near-full horde across the perimeter band, look out
  for (let i = 0; i < 70; i++) ctx.zombies._spawnOne();
  for (let i = 0; i < 3; i++) game.step(1 / 60);
  ctx.player.pos.set(0, ctx.player.roofTop, 0);
  ctx.player.heading = Math.PI;
  const liveH = ctx.zombies.z.filter((z) => z.alive);
  liveH.forEach((z, i) => {
    const ang = Math.PI + ((i / liveH.length) - 0.5) * 2.2;  // wide arc toward -Z
    const rad = 30 + (i % 8) * 8;
    z.x = Math.sin(ang) * rad; z.zz = Math.cos(ang) * rad;
    z.yaw = Math.atan2(-z.x, -z.zz);
  });
  ctx.golf.aimYaw = Math.PI; ctx.golf.aimPitch = -0.34;
  for (let i = 0; i < 16; i++) ctx.golf.updateCamera(camera, 0.3);
  ctx.golf.updatePreview(true);
  renderer.render(scene, camera);
  out.hordeAlive = liveH.length;
  out.drawCalls = renderer.info.render.calls;
  out.tris = renderer.info.render.triangles;
  out.finalScore = game.score; out.health = Math.round(game.health); out.state = game.state;
  return out;
});
console.log('RUN', JSON.stringify(r, null, 0));
await page.screenshot({ path: 'tools/shot_game.png' });

console.log('--- ERRORS (' + errors.length + ') ---'); errors.slice(0, 40).forEach((e) => console.log(e));
console.log('--- WARNINGS (' + warns.length + ') ---'); warns.slice(0, 10).forEach((w) => console.log(w));

await browser.close();
process.exit(errors.length ? 1 : 0);
