// =============================================================
// World — sky, golden-hour lighting, fog, street, the player's tower,
// rooftop platform, and an instanced city skyline.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { tex, pbrMaterial } from './textures.js';

const C = CONFIG.col;

export function buildWorld(scene, assets, renderer) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const roofY = CONFIG.rooftopHeight;

  // ---- sky dome ----
  const skyTex = tex(THREE, assets.sky, { srgb: true });
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(CONFIG.groundRadius * 1.4, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  scene.add(sky);

  // ---- fog: dusty warm haze ----
  scene.fog = new THREE.FogExp2(C.fog, 0.0016);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0xd9c6b0, 0x4a3b2e, 0.65);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(C.sunWarm, 2.5);
  const target = new THREE.Object3D();
  target.position.set(0, roofY, 0);
  scene.add(target);
  sun.target = target;
  sun.position.set(34, roofY + 30, -16);  // low warm raking angle
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 130;
  const sb = 24; // shadow frustum focused on the rooftop (crisp cart/golfer shadows)
  sun.shadow.camera.left = -sb; sun.shadow.camera.right = sb;
  sun.shadow.camera.top = sb; sun.shadow.camera.bottom = -sb;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.5;
  scene.add(sun);

  // a soft warm fill from the opposite side
  const fill = new THREE.DirectionalLight(0xffcf9a, 0.35);
  fill.position.set(-30, 25, 20);
  scene.add(fill);

  // ---- street ground ----
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(CONFIG.groundRadius, 64),
    pbrMaterial(THREE, assets.asphalt, { repeat: [70, 70], roughness: 1, aniso })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- defense perimeter: zombies stop & attack on this ring (you defend it) ----
  const perim = new THREE.Mesh(
    new THREE.RingGeometry(CONFIG.buildingRadius - 1.4, CONFIG.buildingRadius + 1.4, 120),
    new THREE.MeshBasicMaterial({ color: C.pickup, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  perim.rotation.x = -Math.PI / 2; perim.position.y = 0.3; scene.add(perim);
  const perim2 = new THREE.Mesh(
    new THREE.RingGeometry(CONFIG.buildingRadius - 0.3, CONFIG.buildingRadius + 0.3, 120),
    new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  perim2.rotation.x = -Math.PI / 2; perim2.position.y = 0.32; scene.add(perim2);

  // ---- the player's tower ----
  const half = CONFIG.rooftopSize / 2;
  const towerFootprint = CONFIG.rooftopSize + 4;
  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(towerFootprint, roofY, towerFootprint),
    pbrMaterial(THREE, assets.facade, { repeat: [4, Math.round(roofY / 9)], roughness: 0.85, aniso })
  );
  tower.position.set(0, roofY / 2, 0);
  tower.castShadow = true; tower.receiveShadow = true;
  scene.add(tower);

  // rooftop platform (drivable surface)
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(towerFootprint, 1.2, towerFootprint),
    pbrMaterial(THREE, assets.roof, { repeat: [6, 6], roughness: 0.95, aniso })
  );
  roof.position.set(0, roofY + 0.6, 0);
  roof.receiveShadow = true; roof.castShadow = true;
  scene.add(roof);

  // parapet wall around the roof edge
  const parapetMat = pbrMaterial(THREE, assets.roof, { repeat: [8, 1], roughness: 0.95, aniso });
  const ph = 1.6, pt = 0.8;
  const edges = [
    [0, roofY + 1.2 + ph / 2, half + 2, towerFootprint, ph, pt],
    [0, roofY + 1.2 + ph / 2, -(half + 2), towerFootprint, ph, pt],
    [half + 2, roofY + 1.2 + ph / 2, 0, pt, ph, towerFootprint],
    [-(half + 2), roofY + 1.2 + ph / 2, 0, pt, ph, towerFootprint],
  ];
  for (const [x, y, z, w, h, d] of edges) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), parapetMat);
    wall.position.set(x, y, z);
    wall.castShadow = true; wall.receiveShadow = true;
    scene.add(wall);
  }

  // a rooftop AC unit / housing for visual interest (and a shadow caster)
  const acMat = new THREE.MeshStandardMaterial({ color: 0x6b6f74, metalness: 0.5, roughness: 0.6 });
  const ac = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 4), acMat);
  ac.position.set(half - 5, roofY + 1.2 + 1.5, -(half - 5));
  ac.castShadow = true; ac.receiveShadow = true;
  scene.add(ac);

  // ---- instanced city skyline (one draw call) ----
  const cityMat = pbrMaterial(THREE, assets.facade, { repeat: [3, 8], roughness: 0.85, aniso });
  const N = 150;
  const city = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), cityMat, N);
  city.castShadow = false; city.receiveShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const col = new THREE.Color();
  let placed = 0;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2 + Math.random() * 0.3;
    const rad = 120 + Math.random() * 170;
    const w = 14 + Math.random() * 28;
    const h = 30 + Math.random() * 150;
    const d = 14 + Math.random() * 28;
    pos.set(Math.cos(ang) * rad, h / 2, Math.sin(ang) * rad);
    scl.set(w, h, d);
    q.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.random() * 0.6);
    m.compose(pos, q, scl);
    city.setMatrixAt(placed, m);
    const v = 0.7 + Math.random() * 0.5;
    col.setRGB(v, v * 0.97, v * 0.92);
    city.setColorAt(placed, col);
    placed++;
  }
  city.count = placed;
  city.instanceMatrix.needsUpdate = true;
  if (city.instanceColor) city.instanceColor.needsUpdate = true;
  scene.add(city);

  // baseline for explosion light drama
  const baseSunI = sun.intensity;
  const baseFog = scene.fog.color.clone();
  const boomFog = new THREE.Color(C.fog).lerp(new THREE.Color(CONFIG.grade.fogBoomColor), 1);
  let _f = 0;

  return {
    sun, sky, roofY, half,
    flash(a) { if (a > _f) _f = a; },
    tick(dt) {
      if (_f > 0.0001) {
        _f = Math.max(0, _f - dt * 2.2);
        sun.intensity = baseSunI + _f * 1.6;
        scene.fog.color.copy(baseFog).lerp(boomFog, _f * 0.5);
      } else if (sun.intensity !== baseSunI) {
        sun.intensity = baseSunI; scene.fog.color.copy(baseFog);
      }
    },
    dispose() {},
  };
}
