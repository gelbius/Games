/**
 * Checkpoint 1: prove the three pieces of the stack talk to each other.
 *
 * A box falls onto a ground plane. If you see that, then Vite is bundling,
 * three.js is rendering, and Rapier's WebAssembly physics engine has loaded and
 * is stepping. Everything later in the project sits on top of exactly this.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, CREATURE_GROUPS } from './sim/constants.ts';

const status = document.querySelector<HTMLDivElement>('#hud-status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;

async function main(): Promise<void> {
  // Rapier is compiled from Rust to WebAssembly. It has to finish loading
  // before any physics type exists, hence the await.
  await RAPIER.init();
  status.textContent = 'physics ready — box should fall';

  // ---------------------------------------------------------------- rendering
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  scene.fog = new THREE.Fog(0x0e1116, 30, 90);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  camera.position.set(6, 5, 9);
  camera.lookAt(0, 1, 0);

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(8, 14, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 20;
  key.shadow.camera.bottom = -20;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x2a2f38, 1.0));

  const groundMesh = new THREE.Mesh(
    new THREE.BoxGeometry(200, 1, 200),
    new THREE.MeshStandardMaterial({ color: 0x1b2330, roughness: 0.95 }),
  );
  groundMesh.position.y = -0.5;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const grid = new THREE.GridHelper(200, 100, 0x2f3a4c, 0x212a37);
  grid.position.y = 0.002;
  scene.add(grid);

  const boxMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x6fd3c7, roughness: 0.5 }),
  );
  boxMesh.castShadow = true;
  scene.add(boxMesh);

  // ----------------------------------------------------------------- physics
  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;

  // Ground: a fixed (immovable) body with a big flat box collider.
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const groundCollider = RAPIER.ColliderDesc.cuboid(100, 0.5, 100).setFriction(1.0);
  groundCollider.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(groundCollider, groundBody);

  // The falling box: dynamic body, starts 6m up and slightly tilted so you can
  // see it settle rather than land perfectly flat.
  const boxBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 6, 0)
      .setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.3, 0.2))),
  );
  const boxCollider = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setFriction(0.8).setRestitution(0.2);
  boxCollider.setCollisionGroups(CREATURE_GROUPS);
  world.createCollider(boxCollider, boxBody);

  // ------------------------------------------------------------- fixed timestep
  // Render frames come at whatever rate the monitor runs at, but physics must
  // advance in equal-sized steps or the same genome would behave differently on
  // different machines. We accumulate real elapsed time and spend it in whole
  // FIXED_DT steps.
  let accumulator = 0;
  let last = performance.now();
  let steps = 0;

  function resize(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function frame(now: number): void {
    requestAnimationFrame(frame);
    resize();

    // Clamp so that tabbing away for a minute does not try to catch up with
    // thousands of physics steps in one frame.
    accumulator += Math.min((now - last) / 1000, 0.25);
    last = now;
    while (accumulator >= FIXED_DT) {
      world.step();
      accumulator -= FIXED_DT;
      steps += 1;
    }

    const t = boxBody.translation();
    const r = boxBody.rotation();
    boxMesh.position.set(t.x, t.y, t.z);
    boxMesh.quaternion.set(r.x, r.y, r.z, r.w);

    status.textContent = `steps ${steps} · box y=${t.y.toFixed(3)}`;
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  status.textContent = `failed: ${String(err)}`;
  console.error(err);
});
