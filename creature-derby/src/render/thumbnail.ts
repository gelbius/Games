/**
 * Little portraits of a creature, for the lineage strip.
 *
 * Each is rendered once, from the resting pose, and kept as a data URL. A
 * lineage twenty generations long would otherwise mean forty live 3D views on
 * screen at once, which is absurd for something the size of a postage stamp.
 *
 * One small renderer is created lazily and reused. Browsers cap how many WebGL
 * contexts a page may hold, so making one per thumbnail would eventually start
 * silently losing the earliest ones.
 */

import * as THREE from 'three';
import { expand } from '../genome/expand.ts';
import type { Genome } from '../genome/types.ts';

const WIDTH = 104;
const HEIGHT = 78;

let renderer: THREE.WebGLRenderer | null = null;
const box = new THREE.BoxGeometry(1, 1, 1);

function getRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH * 2;
    canvas.height = HEIGHT * 2;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(WIDTH * 2, HEIGHT * 2, false);
  }
  return renderer;
}

/** A PNG data URL of this genome standing still, seen from three-quarters on. */
export function renderThumbnail(genome: Genome): string {
  const skeleton = expand(genome);
  const gl = getRenderer();

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x20262f, 1.6));
  const key = new THREE.DirectionalLight(0xfff4e6, 1.9);
  key.position.set(4, 7, 5);
  scene.add(key);

  const materials: THREE.Material[] = [];
  for (const part of skeleton.parts) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(part.hue, 0.52, 0.58),
      roughness: 0.55,
    });
    materials.push(material);

    const mesh = new THREE.Mesh(box, material);
    mesh.scale.set(part.halfExtents[0] * 2, part.halfExtents[1] * 2, part.halfExtents[2] * 2);
    mesh.position.set(part.position[0], part.position[1] - skeleton.minY, part.position[2]);
    mesh.quaternion.set(part.rotation[0], part.rotation[1], part.rotation[2], part.rotation[3]);
    scene.add(mesh);
  }

  const camera = new THREE.PerspectiveCamera(40, WIDTH / HEIGHT, 0.05, 100);
  const distance = Math.max(skeleton.radius * 3.6, 1.1);
  const height = (skeleton.radius - skeleton.minY) * 0.5;
  camera.position.set(distance * 0.72, height + distance * 0.42, distance * 0.85);
  camera.lookAt(0, height, 0);

  gl.render(scene, camera);
  const url = gl.domElement.toDataURL('image/png');

  // The geometry is shared and must not be freed; the materials are not.
  for (const material of materials) material.dispose();
  scene.clear();

  return url;
}
