/**
 * The stage each creature races on.
 *
 * Every racer gets its own scene rather than sharing one big world with lanes
 * marked out in it. That costs a little memory and buys three things worth
 * more: a creature's run cannot be perturbed by whoever it happens to be racing
 * against, so a shared genome replays exactly; each panel is framed
 * independently; and no lane spacing has to be guessed at.
 *
 * Geometry, materials and textures are created once and shared between all
 * eight scenes. Only the lightweight Object3D wrappers are per-scene.
 *
 * A note on shadows. Real shadow maps are off, because eight panels means eight
 * scenes means eight shadow passes every frame, which is the single most
 * expensive thing this renderer could be asked to do for eight small creatures.
 * But without *some* contact with the ground the creatures visibly float and
 * the shot stops reading as physical. So each lane gets one cheap decal — a
 * soft dark ellipse under the creature that tracks it and fades with height.
 * One extra transparent quad per panel buys most of what the shadow pass did.
 */

import * as THREE from 'three';

export interface Stage {
  readonly renderer: THREE.WebGLRenderer;
}

const SKY = 0x0e1116;

/** How far the ground extends around a racer. Comfortably past any 15s run. */
const GROUND_EXTENT = 90;

/** Height at which the contact shadow has faded out entirely. */
const SHADOW_FADE_HEIGHT = 2.2;

// Shared once. Creating these per scene would allocate eight copies of the same
// buffers on the GPU for no reason.
const groundGeometry = new THREE.BoxGeometry(GROUND_EXTENT * 2, 1, GROUND_EXTENT * 2);
const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x232c3a, roughness: 0.96 });
const shadowGeometry = new THREE.PlaneGeometry(1, 1);

/** A soft round blob, drawn once into a texture and reused by every lane. */
function createBlobTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.32)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let blobTexture: THREE.Texture | null = null;

export function createRenderer(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;
  renderer.setClearColor(SKY, 1);
  return { renderer };
}

/**
 * A scene holding ground, grid, lights and a contact shadow, ready for one
 * creature.
 *
 * The grid is not decoration. Over featureless ground a moving creature looks
 * stationary, because there is nothing for the eye to measure it against.
 */
export function createLaneScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 18, 85);

  const key = new THREE.DirectionalLight(0xfff2e0, 2.1);
  key.position.set(6, 12, 5);
  key.castShadow = false;
  scene.add(key);

  scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a2028, 1.15));

  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.y = -0.5;
  scene.add(ground);

  const grid = new THREE.GridHelper(GROUND_EXTENT * 2, GROUND_EXTENT, 0x44546b, 0x2c3648);
  grid.position.y = 0.003;
  scene.add(grid);

  blobTexture ??= createBlobTexture();
  const shadow = new THREE.Mesh(
    shadowGeometry,
    new THREE.MeshBasicMaterial({
      map: blobTexture,
      transparent: true,
      depthWrite: false,
      // Fog would tint the shadow toward the sky colour at distance, turning it
      // into a pale smudge.
      fog: false,
    }),
  );
  shadow.name = 'contactShadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.006;
  shadow.renderOrder = 1;
  scene.add(shadow);

  return scene;
}

/**
 * Move the contact shadow under the creature.
 *
 * It grows with the creature's spread and fades as the creature leaves the
 * ground, which is what sells a jump.
 */
export function updateContactShadow(scene: THREE.Scene, x: number, y: number, z: number, radius: number): void {
  const shadow = scene.getObjectByName('contactShadow');
  if (!(shadow instanceof THREE.Mesh)) return;

  const size = Math.max(0.5, radius * 2.1);
  shadow.scale.set(size, size, 1);
  shadow.position.x = x;
  shadow.position.z = z;

  const material = shadow.material as THREE.MeshBasicMaterial;
  const height = Math.max(0, y);
  material.opacity = THREE.MathUtils.clamp(1 - height / SHADOW_FADE_HEIGHT, 0.05, 1);
}
