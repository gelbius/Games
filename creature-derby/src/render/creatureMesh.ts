/**
 * Drawing a creature.
 *
 * One mesh per body part, kept in a flat array in the same order as the physics
 * bodies, so syncing is an index-for-index copy rather than a lookup.
 */

import * as THREE from 'three';
import type { Skeleton } from '../genome/expand.ts';
import type { CreatureHandle } from '../sim/creature.ts';

export interface CreatureView {
  readonly group: THREE.Group;
  readonly meshes: THREE.Mesh[];
}

/** Shared geometry: every part is the same unit cube, scaled per part. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

export function createCreatureView(skeleton: Skeleton): CreatureView {
  const group = new THREE.Group();
  const meshes: THREE.Mesh[] = [];

  for (const part of skeleton.parts) {
    const colour = new THREE.Color().setHSL(part.hue, 0.52, 0.56);
    const material = new THREE.MeshStandardMaterial({
      color: colour,
      roughness: 0.55,
      metalness: 0.05,
    });

    const mesh = new THREE.Mesh(UNIT_BOX, material);
    mesh.scale.set(part.halfExtents[0] * 2, part.halfExtents[1] * 2, part.halfExtents[2] * 2);

    group.add(mesh);
    meshes.push(mesh);
  }

  return { group, meshes };
}

/** Copy every body's position and orientation onto its mesh. */
export function syncCreatureView(view: CreatureView, creature: CreatureHandle): void {
  for (let i = 0; i < view.meshes.length; i++) {
    const mesh = view.meshes[i];
    const body = creature.bodies[i];
    if (!mesh || !body) continue;
    const t = body.translation();
    const r = body.rotation();
    mesh.position.set(t.x, t.y, t.z);
    mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

/** Release the per-part materials. Geometry is shared and must not be freed. */
export function disposeCreatureView(view: CreatureView): void {
  for (const mesh of view.meshes) {
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
  }
  view.group.clear();
}
