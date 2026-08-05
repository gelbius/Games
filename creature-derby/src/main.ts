/**
 * Checkpoint 5: the broadcast camera.
 *
 * The creature is the same as before; what changed is that the shot now holds
 * it. Track a creature that sprints, staggers and cartwheels, keep the horizon
 * level, widen when it throws its limbs out, and never sink through the floor.
 *
 * SPACE next creature · R replay · C toggle manual orbit
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';

import { expand } from './genome/expand.ts';
import { randomGenome } from './genome/random.ts';
import { encodeGenome } from './genome/codec.ts';
import { createStage } from './render/scene.ts';
import { createCreatureView, disposeCreatureView, syncCreatureView } from './render/creatureMesh.ts';
import { BroadcastCamera, type Subject } from './render/broadcastCamera.ts';
import {
  despawnCreature,
  driveCreature,
  measureCreature,
  spawnCreature,
  type CreatureHandle,
} from './sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, RACE_SECONDS } from './sim/constants.ts';

const status = document.querySelector<HTMLDivElement>('#hud-status')!;
const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;

async function main(): Promise<void> {
  await RAPIER.init();

  const { renderer, scene } = createStage(canvas);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  const rig = new BroadcastCamera(camera);

  // The manual fallback, for when the automatic shot is not what you want to
  // look at. Disabled until asked for, so it never fights the rig.
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.enabled = false;
  let manual = false;

  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;

  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const groundCollider = RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.1);
  groundCollider.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(groundCollider, groundBody);

  let creature: CreatureHandle | null = null;
  let view: ReturnType<typeof createCreatureView> | null = null;
  let seed = Number(new URLSearchParams(location.search).get('seed') ?? 3) || 0;
  let label = '';
  let simTime = 0;
  let startZ = 0;

  // Reused every frame rather than reallocated, so the camera does not generate
  // garbage sixty times a second.
  const measured = {
    centre: { x: 0, y: 0, z: 0 },
    radius: 1,
    velocity: { x: 0, y: 0, z: 0 },
  };
  const subject: Subject = {
    centre: new THREE.Vector3(),
    radius: 1,
    velocity: new THREE.Vector3(),
  };

  function readSubject(c: CreatureHandle): Subject {
    measureCreature(c, measured);
    subject.centre.set(measured.centre.x, measured.centre.y, measured.centre.z);
    subject.velocity.set(measured.velocity.x, measured.velocity.y, measured.velocity.z);
    subject.radius = measured.radius;
    return subject;
  }

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
    startZ = 0;
    startZ = readSubject(creature).centre.z;

    // Cut, do not glide, when a different creature appears.
    rig.reset(readSubject(creature));

    label =
      `seed <b>${seed}</b> · ${skeleton.parts.length} parts · ${skeleton.joints.length} joints · ` +
      `${skeleton.parts.filter((p) => p.mirrored).length} mirrored · ${encodeGenome(genome).length}-char genome`;
  }

  show(seed);

  // A handle on the running game, for tools/camera-check.mjs and for poking at
  // things from the browser console.
  (window as unknown as Record<string, unknown>).derby = {
    camera,
    show,
    get time(): number {
      return simTime;
    },
    get subject(): Subject | null {
      return creature ? readSubject(creature) : null;
    },
  };

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      show(seed + 1);
    } else if (e.code === 'KeyR') {
      show(seed);
    } else if (e.code === 'KeyC') {
      manual = !manual;
      orbit.enabled = manual;
      if (manual && creature) {
        // Hand the manual controls the shot the rig had, so toggling does not
        // teleport the view.
        orbit.target.copy(readSubject(creature).centre);
        orbit.update();
      } else if (creature) {
        rig.reset(readSubject(creature));
      }
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

    const elapsed = Math.min((now - last) / 1000, 0.25);
    last = now;
    accumulator += elapsed;

    while (accumulator >= FIXED_DT) {
      if (creature) driveCreature(creature, simTime);
      world.step();
      simTime += FIXED_DT;
      accumulator -= FIXED_DT;
    }

    if (view && creature) {
      syncCreatureView(view, creature);
      const s = readSubject(creature);

      if (manual) {
        // Manual orbit still follows the creature; only the angle is yours.
        orbit.target.lerp(s.centre, 0.12);
        orbit.update();
      } else {
        rig.update(s, elapsed);
      }

      status.innerHTML =
        `${label}<br><span style="opacity:.65">t ${simTime.toFixed(1)}s / ${RACE_SECONDS}s · ` +
        `travelled ${(s.centre.z - startZ).toFixed(2)}m · spread ${s.radius.toFixed(2)}m · ` +
        `camera ${manual ? '<b>manual</b>' : 'auto'} · SPACE next · R replay · C camera</span>`;
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  status.textContent = `failed: ${String(err)}`;
  console.error(err);
});
