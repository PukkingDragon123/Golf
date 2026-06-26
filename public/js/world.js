// =============================================================
// World — sky, golden-hour lighting, fog, street, the player's tower,
// rooftop platform, and an instanced city skyline.
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { tex, pbrMaterial } from './textures.js';
import { mergeGeometries } from './utils.js';

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

  // parapet walls (3 solid edges + a split ramp-side edge) + the ramp
  const parapetMat = pbrMaterial(THREE, assets.roof, { repeat: [8, 1], roughness: 0.95, aniso });
  const ph = 1.6, pt = 0.8;
  const edgeZ = half + 2;
  const RP = CONFIG.ramp;
  const rs = RP.side;
  const solidEdges = [
    [0, roofY + 1.2 + ph / 2, -edgeZ * rs, towerFootprint, ph, pt],
    [edgeZ, roofY + 1.2 + ph / 2, 0, pt, ph, towerFootprint],
    [-edgeZ, roofY + 1.2 + ph / 2, 0, pt, ph, towerFootprint],
  ];
  for (const [x, y, z, w, h, d] of solidEdges) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), parapetMat);
    wall.position.set(x, y, z); wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
  }
  // ramp-side parapet: two segments leaving the ramp mouth open
  const gap = RP.width + 1, segW = (towerFootprint - gap) / 2;
  for (const sx of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(segW, ph, pt), parapetMat);
    wall.position.set(sx * (gap / 2 + segW / 2), roofY + 1.2 + ph / 2, edgeZ * rs);
    wall.castShadow = true; wall.receiveShadow = true; scene.add(wall);
  }
  // the ramp deck down to the street
  const rampAng = Math.atan2(RP.slopeRise, RP.slopeRun);
  const inclineLen = Math.hypot(RP.slopeRise, RP.slopeRun);
  const slabT = 1.2;
  const rampMat = pbrMaterial(THREE, assets.roof, { repeat: [2, Math.round(inclineLen / 4)], roughness: 0.95, aniso });
  const midZ = edgeZ + RP.slopeRun / 2, midY = RP.slopeRise / 2;
  const incline = new THREE.Mesh(new THREE.BoxGeometry(RP.width, slabT, inclineLen), rampMat);
  incline.rotation.x = -rampAng * rs;
  incline.position.set(0, midY - 0.55, midZ * rs);
  incline.receiveShadow = true; incline.castShadow = true; scene.add(incline);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(RP.width, slabT, RP.apronZ + 2), pbrMaterial(THREE, assets.roof, { repeat: [2, 2], roughness: 0.95, aniso }));
  apron.position.set(0, roofY + 0.6, (edgeZ - RP.apronZ / 2) * rs);
  apron.receiveShadow = true; scene.add(apron);
  for (const sx of [-1, 1]) {
    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, RP.curbH + 0.7, inclineLen), parapetMat);
    curb.rotation.x = -rampAng * rs;
    curb.position.set(sx * (RP.width / 2 + 0.2), midY + 0.2, midZ * rs);
    curb.castShadow = true; scene.add(curb);
  }

  // a rooftop AC unit / housing for visual interest (and a shadow caster)
  const acMat = new THREE.MeshStandardMaterial({ color: 0x6b6f74, metalness: 0.5, roughness: 0.6 });
  const ac = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 4), acMat);
  ac.position.set(half - 5, roofY + 1.2 + 1.5, -(half - 5));
  ac.castShadow = true; ac.receiveShadow = true;
  scene.add(ac);

  // =====================================================================
  // v3 — decorate the tower into a clearly THREE-FLOOR building.
  // All decoration lives BELOW the roof (facade trim) or low at the back
  // corners (roof clutter) so the elevated chase camera still clears the
  // parapet and sees the perimeter ring + street horde. Rooftop height,
  // footprint, parapet and ramp are untouched (FROZEN gameplay geometry).
  // Each group is merged into ONE mesh so the whole dressing is a few draws.
  // =====================================================================
  const fp = towerFootprint, hf = fp / 2;       // shaft 34, half-extent 17
  const roofTopY = roofY + 1.2;                  // 9.2 — walkable slab top
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
  const T = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    _e.set(rx, ry, rz); _q.setFromEuler(_e); _v.set(x, y, z);
    return { geo, mat4: new THREE.Matrix4().compose(_v, _q, _one) };
  };
  const addMerged = (parts, material, cast = true, recv = true) => {
    const mesh = new THREE.Mesh(mergeGeometries(THREE, parts), material);
    mesh.castShadow = cast; mesh.receiveShadow = recv; scene.add(mesh); return mesh;
  };

  // ---- concrete trim: plinth base + two floor-divider ledges (=> 3 floors) + cornice + corner pilasters ----
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x827b70, roughness: 0.92, metalness: 0.02 });
  const trim = [
    T(new THREE.BoxGeometry(fp + 2, 1.1, fp + 2), 0, 0.55, 0),                 // street plinth (wider base)
    T(new THREE.BoxGeometry(fp + 0.8, 0.45, fp + 0.8), 0, roofY * 0.34, 0),     // floor line 1
    T(new THREE.BoxGeometry(fp + 0.8, 0.45, fp + 0.8), 0, roofY * 0.67, 0),     // floor line 2
    T(new THREE.BoxGeometry(fp + 1.4, 0.6, fp + 1.4), 0, roofY - 0.35, 0),      // crown cornice
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1])
    trim.push(T(new THREE.BoxGeometry(1.1, roofY - 0.6, 1.1), sx * hf, roofY / 2, sz * hf)); // corner pilasters
  // ground-floor entrance surround on the -X face
  trim.push(T(new THREE.BoxGeometry(0.6, 3.2, 4.4), -hf - 0.2, 1.7, 6));
  addMerged(trim, trimMat);

  // ---- balcony ledges + window sills on the mid/top floors (front -Z face) ----
  const sill = [];
  for (const fy of [roofY * 0.5, roofY * 0.83]) for (const sx of [-1, 0, 1])
    sill.push(T(new THREE.BoxGeometry(4.2, 0.3, 0.7), sx * 9, fy, -hf - 0.25));
  // a small balcony rail on the front-mid floor
  for (const sx of [-1, 1]) sill.push(T(new THREE.BoxGeometry(5, 0.9, 0.18), sx * 9, roofY * 0.5 + 0.6, -hf - 0.55));
  addMerged(sill, trimMat);

  // ---- boarded-up storefront (apocalypse): door + criss-cross planks on the -Z ground floor ----
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.85, metalness: 0.0 });
  const boards = [
    T(new THREE.BoxGeometry(0.3, 2.6, 3.2), -hf - 0.45, 1.5, 6),               // -X door panel
    T(new THREE.BoxGeometry(4.6, 0.5, 0.5), 0, 2.0, -hf - 0.45, 0, 0, 0.5),     // plank /
    T(new THREE.BoxGeometry(4.6, 0.5, 0.5), 0, 2.0, -hf - 0.45, 0, 0, -0.5),    // plank \
    T(new THREE.BoxGeometry(4.6, 0.5, 0.5), -10, 1.6, -hf - 0.45, 0, 0, 0.5),
    T(new THREE.BoxGeometry(4.6, 0.5, 0.5), 10, 1.6, -hf - 0.45, 0, 0, -0.5),
  ];
  addMerged(boards, boardMat, true, false);

  // ---- metal: fire escape on +X face + low rooftop water tank & vents at the back corners ----
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x70757b, roughness: 0.5, metalness: 0.6 });
  const metal = [];
  for (let f = 0; f < 3; f++) {                                                 // 3 fire-escape landings (one per floor)
    const y = 2.2 + f * (roofY * 0.33);
    metal.push(T(new THREE.BoxGeometry(0.18, 0.18, 3.4), hf + 0.6, y, 4));       // platform deck
    metal.push(T(new THREE.BoxGeometry(0.12, 1.0, 3.4), hf + 0.6, y + 0.5, 4));  // outer rail
    metal.push(T(new THREE.BoxGeometry(0.12, roofY * 0.33, 0.12), hf + 0.6, y + roofY * 0.16, 5.6)); // stringer
  }
  // low water tank on legs (back-right corner), top ~ AC height — never blocks the forward camera
  const tx = -(hf - 5), tz = -(hf - 5);
  for (const [lx, lz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]])
    metal.push(T(new THREE.CylinderGeometry(0.16, 0.16, 1.0, 6), tx + lx, roofTopY + 0.5, tz + lz));
  metal.push(T(new THREE.CylinderGeometry(2.0, 2.0, 2.3, 16), tx, roofTopY + 2.1, tz));
  metal.push(T(new THREE.ConeGeometry(2.1, 0.8, 16), tx, roofTopY + 3.6, tz));
  // a couple of squat roof vents (back-left)
  metal.push(T(new THREE.CylinderGeometry(0.5, 0.6, 1.2, 10), -(hf - 4), roofTopY + 0.6, hf - 6));
  metal.push(T(new THREE.CylinderGeometry(0.5, 0.6, 1.2, 10), -(hf - 6.5), roofTopY + 0.6, hf - 5));
  addMerged(metal, metalMat);

  // ---- sandbag defenses stacked in the rooftop back corners (low, apocalypse decor) ----
  const sandMat = new THREE.MeshStandardMaterial({ color: 0x9a8a5c, roughness: 0.97, metalness: 0.0 });
  const sand = [];
  for (const [cx, cz] of [[hf - 2, -(hf - 2)], [-(hf - 2), -(hf - 2)]]) {
    for (let r = 0; r < 2; r++) for (let b = 0; b < 4; b++) {
      const off = (b - 1.5) * 1.0 + (r % 2 ? 0.5 : 0);
      sand.push(T(new THREE.BoxGeometry(0.95, 0.45, 0.65), cx + off, roofTopY + 0.22 + r * 0.42, cz));
    }
  }
  addMerged(sand, sandMat, true, true);

  // ---- a lit rooftop-edge sign on the -X facade (below the roofline, faces out) ----
  const signMat = new THREE.MeshStandardMaterial({ color: CONFIG.col.pickup, emissive: CONFIG.col.pickup, emissiveIntensity: 0.9, roughness: 0.5 });
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2.6, 7.5), signMat);
  sign.position.set(-hf - 0.7, roofY - 1.6, -3); sign.castShadow = false; scene.add(sign);
  const signFrameMat = metalMat;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.55, 3.0, 8.0), signFrameMat);
  frame.position.set(-hf - 0.55, roofY - 1.6, -3); scene.add(frame);

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
