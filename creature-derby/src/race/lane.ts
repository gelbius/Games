/**
 * One racer: its own physics world, its own scene, its own camera.
 *
 * Self-contained on purpose. A lane knows nothing about the other seven, which
 * is what guarantees a creature runs the same race whether it is alone or in a
 * field of eight — and therefore that a shared link replays what the sender saw.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { expand, type Skeleton } from '../genome/expand.ts';
import type { Genome } from '../genome/types.ts';
import { createLaneScene, updateContactShadow } from '../render/scene.ts';
import { createCreatureView, disposeCreatureView, syncCreatureView, type CreatureView } from '../render/creatureMesh.ts';
import { BroadcastCamera, type Subject } from '../render/broadcastCamera.ts';
import {
  despawnCreature,
  driveCreature,
  measureCreature,
  spawnCreature,
  type CreatureHandle,
} from '../sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS } from '../sim/constants.ts';

export class Lane {
  readonly genome: Genome;
  readonly skeleton: Skeleton;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly world: RAPIER.World;
  private readonly creature: CreatureHandle;
  private readonly view: CreatureView;
  private readonly rig: BroadcastCamera;

  private readonly measured = {
    centre: { x: 0, y: 0, z: 0 },
    radius: 1,
    velocity: { x: 0, y: 0, z: 0 },
  };
  private readonly subject: Subject = {
    centre: new THREE.Vector3(),
    radius: 1,
    velocity: new THREE.Vector3(),
  };

  private readonly startZ: number;
  private readonly startX: number;

  constructor(genome: Genome) {
    this.genome = genome;
    this.skeleton = expand(genome);

    this.world = new RAPIER.World(GRAVITY);
    this.world.timestep = FIXED_DT;

    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    const groundCollider = RAPIER.ColliderDesc.cuboid(120, 0.5, 120).setFriction(1.1);
    groundCollider.setCollisionGroups(GROUND_GROUPS);
    this.world.createCollider(groundCollider, ground);

    this.creature = spawnCreature(this.world, this.skeleton, { x: 0, y: 0, z: 0 });

    this.scene = createLaneScene();
    this.view = createCreatureView(this.skeleton);
    this.scene.add(this.view.group);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 300);
    this.rig = new BroadcastCamera(this.camera);

    const start = this.read();
    this.startX = start.centre.x;
    this.startZ = start.centre.z;
    this.rig.reset(start);
  }

  /** Advance the physics by exactly one fixed step. */
  step(simTime: number): void {
    driveCreature(this.creature, simTime);
    this.world.step();
  }

  /** Update meshes and camera. Called once per rendered frame, not per step. */
  present(frameSeconds: number): void {
    syncCreatureView(this.view, this.creature);
    const s = this.read();
    this.rig.update(s, frameSeconds);
    updateContactShadow(this.scene, s.centre.x, s.centre.y - s.radius, s.centre.z, s.radius);
  }

  /** How far the creature has got from where it started, in metres. */
  get distance(): number {
    const c = this.subject.centre;
    return Math.hypot(c.x - this.startX, c.z - this.startZ);
  }

  /** Distance along the race direction. Negative means it went backwards. */
  get forward(): number {
    return this.subject.centre.z - this.startZ;
  }

  private read(): Subject {
    measureCreature(this.creature, this.measured);
    this.subject.centre.set(this.measured.centre.x, this.measured.centre.y, this.measured.centre.z);
    this.subject.velocity.set(this.measured.velocity.x, this.measured.velocity.y, this.measured.velocity.z);
    this.subject.radius = this.measured.radius;
    return this.subject;
  }

  dispose(): void {
    despawnCreature(this.world, this.creature);
    this.scene.remove(this.view.group);
    disposeCreatureView(this.view);
    this.world.free();
  }
}
