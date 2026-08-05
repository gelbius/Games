/**
 * The shared stage: renderer, lights, ground.
 *
 * Everything that is the same no matter how many creatures are on screen lives
 * here, so the race code can concern itself with creatures alone.
 */

import * as THREE from 'three';

export interface Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
}

const SKY = 0x0e1116;

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(SKY, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 24, 120);

  const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
  key.position.set(10, 18, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -40;
  key.shadow.camera.right = 40;
  key.shadow.camera.top = 40;
  key.shadow.camera.bottom = -40;
  key.shadow.camera.far = 80;
  key.shadow.bias = -0.0012;
  scene.add(key);

  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a2028, 1.1));

  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(600, 1, 600),
    new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.96 }),
  );
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  scene.add(ground);

  // A grid gives the eye something to measure motion against. Without it a
  // creature moving over featureless ground looks stationary.
  const grid = new THREE.GridHelper(600, 300, 0x44546b, 0x2c3648);
  grid.position.y = 0.003;
  scene.add(grid);

  return { renderer, scene };
}
