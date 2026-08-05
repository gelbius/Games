/**
 * Tests that the bodies we hand to Rapier behave.
 *
 * Two things are being pinned down here.
 *
 * First, the sign convention. Rapier measures a revolute joint's angle from a
 * frame it derives internally, and nothing documents how that lines up with the
 * resting rotation the skeleton describes. Rather than guess and hope, the
 * first test asks the engine directly: hold every motor at its resting angle
 * with gravity switched off, and see whether the creature stays where it was
 * built. If the convention were inverted, the limbs would immediately snap to
 * the wrong side and the test fails.
 *
 * Second, stability. A randomly generated creature driven by oscillators is a
 * good way to find a solver blow-up, so a sample of them run a full race and
 * are checked for having stayed finite and on the map.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';

import { expand } from '../src/genome/expand.ts';
import { randomGenome } from '../src/genome/random.ts';
import { centreOfMass, driveCreature, spawnCreature } from '../src/sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, RACE_STEPS } from '../src/sim/constants.ts';

before(async () => {
  await RAPIER.init();
});

function makeWorld(gravity: { x: number; y: number; z: number }): RAPIER.World {
  const world = new RAPIER.World(gravity);
  world.timestep = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const collider = RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.0);
  collider.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(collider, ground);
  return world;
}

test('joints rest where the skeleton says they should, so the angle convention is right', () => {
  // Weightless, so the only thing that can move a limb is its own motor.
  const world = makeWorld({ x: 0, y: 0, z: 0 });
  let worstDrift = 0;

  for (let seed = 0; seed < 40; seed++) {
    const skeleton = expand(randomGenome(seed));
    const creature = spawnCreature(world, skeleton, { x: seed * 12, y: 0, z: 0 });

    const before = creature.bodies.map((b) => ({ ...b.translation() }));
    // Hold at rest: drive nothing, the motors were configured at rest angle.
    for (let i = 0; i < 180; i++) world.step();

    creature.bodies.forEach((body, i) => {
      const now = body.translation();
      const was = before[i]!;
      worstDrift = Math.max(worstDrift, Math.hypot(now.x - was.x, now.y - was.y, now.z - was.z));
    });
  }

  // A correct sign holds every part within a few millimetres of where it was
  // built. An inverted sign swings limbs to the opposite side of their hinge,
  // which is tens of centimetres.
  assert.ok(worstDrift < 0.05, `parts drifted ${worstDrift.toFixed(3)}m at rest; the angle convention is inverted`);
});

test('a driven creature stays finite and on the map for a whole race', () => {
  for (let seed = 0; seed < 25; seed++) {
    const world = makeWorld(GRAVITY);
    const skeleton = expand(randomGenome(seed));
    const creature = spawnCreature(world, skeleton, { x: 0, y: 0, z: 0 });

    for (let step = 0; step < RACE_STEPS; step++) {
      driveCreature(creature, step * FIXED_DT);
      world.step();
    }

    for (const body of creature.bodies) {
      const t = body.translation();
      assert.ok(
        Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z),
        `seed ${seed}: the solver produced a non-finite position`,
      );
      // 15 seconds of oscillating limbs should not fling anything a hundred
      // metres; if it does, something is pumping energy into the system.
      assert.ok(
        Math.abs(t.x) < 100 && Math.abs(t.z) < 100 && t.y > -5 && t.y < 60,
        `seed ${seed}: a part ended up at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})`,
      );
    }
  }
});

test('creatures start above the ground rather than buried in it', () => {
  const world = makeWorld(GRAVITY);
  for (let seed = 0; seed < 60; seed++) {
    const skeleton = expand(randomGenome(seed));
    const creature = spawnCreature(world, skeleton, { x: seed * 12, y: 0, z: 0 });

    // The true lowest point of a rotated box is one of its eight corners, not
    // its centre minus a half-extent.
    let lowest = Infinity;
    creature.bodies.forEach((body, i) => {
      const t = body.translation();
      const r = body.rotation();
      const q = new Quaternion(r.x, r.y, r.z, r.w);
      const [hx, hy, hz] = skeleton.parts[i]!.halfExtents;
      for (let c = 0; c < 8; c++) {
        const corner = new Vector3(c & 1 ? hx : -hx, c & 2 ? hy : -hy, c & 4 ? hz : -hz).applyQuaternion(q);
        lowest = Math.min(lowest, t.y + corner.y);
      }
    });

    assert.ok(lowest > -0.01, `seed ${seed}: spawned ${(-lowest).toFixed(3)}m into the ground`);
  }
});

test('the same creature races identically every time', () => {
  // The whole point of a seeded generator and a fixed timestep. If this fails,
  // a shared link shows a different run than the one the sender saw.
  const run = () => {
    const world = makeWorld(GRAVITY);
    const creature = spawnCreature(world, expand(randomGenome(1234)), { x: 0, y: 0, z: 0 });
    for (let step = 0; step < 600; step++) {
      driveCreature(creature, step * FIXED_DT);
      world.step();
    }
    const com = { x: 0, y: 0, z: 0 };
    centreOfMass(creature, com);
    return com;
  };

  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'two identical races diverged');
});
