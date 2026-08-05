/**
 * Checkpoint 4: the creature moves.
 *
 * Every joint now follows a sine wave — its own frequency, its own swing size,
 * its own starting point in the cycle. Nothing here knows what walking is. The
 * gait is what falls out when a dozen oscillators push against the ground.
 *
 * Press SPACE for the next creature, R to replay the current one.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { expand } from './genome/expand.ts';
import { randomGenome } from './genome/random.ts';
import { encodeGenome } from './genome/codec.ts';
import { createStage } from './render/scene.ts';
import { createCreatureView, disposeCreatureView, syncCreatureView } from './render/creatureMesh.ts';
import {
  centreOfMass,
  despawnCreature,
  driveCreature,
  spawnCreature,
  type CreatureHandle,
} from './sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, RACE_SECONDS } from './sim/constants.ts';

const status = document.querySelector<HTMLDivElement>('#hud-status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;

async function main(): Promise<void> {
  await RAPIER.init();

  const { renderer, scene } = createStage(canvas);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400);

  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;

  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const groundCollider = RAPIER.ColliderDesc.cuboid(300, 0.5, 300).setFriction(1.1);
  groundCollider.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(groundCollider, groundBody);

  let creature: CreatureHandle | null = null;
  let view: ReturnType<typeof createCreatureView> | null = null;
  let seed = Number(new URLSearchParams(location.search).get('seed') ?? 3) || 0;

  let label = '';
  let viewDistance = 3;
  let startZ = 0;

  /**
   * Simulated time, not wall-clock time. The gait advances by exactly FIXED_DT
   * per physics step, so the same creature walks identically on a 144Hz monitor
   * and a 60Hz one.
   */
  let simTime = 0;

  const com = { x: 0, y: 0, z: 0 };

  function show(nextSeed: number): void {
    if (creature) despawnCreature(world, creature);
    if (view) {
      scene.remove(view.group);
      disposeCreatureView(view);
    }

    seed = nextSeed;
    const genome = randomGenome(seed);
    const skeleton = expand(genome);
    creature = spawnCreature(world, skeleton, { x: 0, y: 0, z: 0 });
    view = createCreatureView(skeleton);
    scene.add(view.group);

    simTime = 0;
    centreOfMass(creature, com);
    startZ = com.z;
    viewDistance = Math.max(skeleton.radius * 5, 2);

    label =
      `seed <b>${seed}</b> · ${skeleton.parts.length} parts · ${skeleton.joints.length} joints · ` +
      `${skeleton.parts.filter((p) => p.mirrored).length} mirrored · ${encodeGenome(genome).length}-char genome`;
  }

  show(seed);

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      show(seed + 1);
    } else if (e.code === 'KeyR') {
      show(seed);
    }
  });

  let accumulator = 0;
  let last = performance.now();

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

    accumulator += Math.min((now - last) / 1000, 0.25);
    last = now;

    while (accumulator >= FIXED_DT) {
      if (creature) driveCreature(creature, simTime);
      world.step();
      simTime += FIXED_DT;
      accumulator -= FIXED_DT;
    }

    if (view && creature) {
      syncCreatureView(view, creature);
      centreOfMass(creature, com);

      // A placeholder follow: enough to keep the creature on screen while the
      // gait is being judged. The real broadcast rig is the next checkpoint.
      camera.position.set(com.x + viewDistance * 0.8, com.y + viewDistance * 0.6, com.z + viewDistance);
      camera.lookAt(com.x, com.y, com.z);

      const travelled = com.z - startZ;
      status.innerHTML =
        `${label}<br><span style="opacity:.65">t ${simTime.toFixed(1)}s / ${RACE_SECONDS}s · ` +
        `travelled ${travelled.toFixed(2)}m · SPACE next · R replay</span>`;
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  status.textContent = `failed: ${String(err)}`;
  console.error(err);
});
