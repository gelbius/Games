/**
 * Checkpoint 3: a genome grown into a real body, standing on the ground.
 *
 * The creature is not being driven yet — its joint motors are simply holding
 * their resting angles — so what you should see is a still, symmetric animal
 * that does not collapse, sink, or twitch.
 *
 * Press a number key to look at a different random creature.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { expand } from './genome/expand.ts';
import { randomGenome } from './genome/random.ts';
import { encodeGenome } from './genome/codec.ts';
import { createStage } from './render/scene.ts';
import { createCreatureView, disposeCreatureView, syncCreatureView } from './render/creatureMesh.ts';
import { despawnCreature, spawnCreature, type CreatureHandle } from './sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS } from './sim/constants.ts';

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

    const pairs = skeleton.parts.filter((p) => p.mirrored).length;
    status.innerHTML =
      `seed <b>${seed}</b> · ${skeleton.parts.length} parts · ${skeleton.joints.length} joints · ` +
      `${pairs} mirrored<br><span style="opacity:.6">press SPACE for another · ${encodeGenome(genome).length}-char genome</span>`;

    // Frame the creature from the front-right, so bilateral symmetry is
    // visible at a glance.
    const d = Math.max(skeleton.radius * 4.5, 1.6);
    camera.position.set(d * 0.75, d * 0.55, d * 0.95);
    camera.lookAt(0, skeleton.radius * 0.6, 0);
  }

  show(seed);

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      show(seed + 1);
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
      world.step();
      accumulator -= FIXED_DT;
    }

    if (view && creature) syncCreatureView(view, creature);
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  status.textContent = `failed: ${String(err)}`;
  console.error(err);
});
