/**
 * Sweeps motor gains against both of the things that matter, so they can be
 * traded off knowingly rather than one at a time.
 *
 * Distance travelled is the one that is easy to forget: a creature that stands
 * perfectly still is maximally stable and no fun at all to watch. Tuning for
 * tidiness alone produced a generation that barely moved.
 *
 * Every number here comes through the same spawnCreature path the game uses,
 * so the tool cannot drift away from what actually ships.
 *
 * Usage: node tools/sweep.ts [sampleSize]
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { expand } from '../src/genome/expand.ts';
import { randomGenome } from '../src/genome/random.ts';
import { centreOfMass, driveCreature, motorGains, spawnCreature } from '../src/sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, RACE_STEPS } from '../src/sim/constants.ts';

await RAPIER.init();

const SAMPLE = Number(process.argv[2] ?? 200);

function race(seed: number): { distance: number; tipDegrees: number } {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const gc = RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.1);
  gc.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(gc, ground);

  const creature = spawnCreature(world, expand(randomGenome(seed)), { x: 0, y: 0, z: 0 });
  const a = { x: 0, y: 0, z: 0 };
  centreOfMass(creature, a);
  const uprightStart = { ...creature.bodies[0]!.rotation() };

  for (let step = 0; step < RACE_STEPS; step++) {
    driveCreature(creature, step * FIXED_DT);
    world.step();
  }

  const b = { x: 0, y: 0, z: 0 };
  centreOfMass(creature, b);
  const r = creature.bodies[0]!.rotation();

  // How far the torso has rolled away from the pose it was built in.
  const dot = Math.abs(uprightStart.x * r.x + uprightStart.y * r.y + uprightStart.z * r.z + uprightStart.w * r.w);
  return {
    distance: Math.hypot(b.x - a.x, b.z - a.z),
    tipDegrees: (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI,
  };
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

console.log('stiff  damp  angDamp | median | p90  | max   | stuck | upright');
for (const [st, dp, ad] of [
  [8000, 90, 0.02],
  [8000, 90, 0.1],
  [8000, 90, 0.2],
  [8000, 90, 0.35],
  [8000, 30, 0.1],
  [8000, 200, 0.1],
] as [number, number, number][]) {
  motorGains.stiffness = st;
  motorGains.damping = dp;
  motorGains.angularDamping = ad;

  const runs = Array.from({ length: SAMPLE }, (_, s) => race(s));
  const d = runs.map((r) => r.distance);
  const upright = runs.filter((r) => r.tipDegrees < 35).length / SAMPLE;

  console.log(
    String(st).padStart(5),
    String(dp).padStart(5),
    String(ad).padStart(8),
    '|',
    pct(d, 0.5).toFixed(2).padStart(6),
    '|',
    pct(d, 0.9).toFixed(2).padStart(4),
    '|',
    Math.max(...d).toFixed(2).padStart(5),
    '|',
    `${((d.filter((x) => x < 0.25).length / SAMPLE) * 100).toFixed(0)}%`.padStart(5),
    '|',
    `${(upright * 100).toFixed(0)}%`.padStart(6),
  );
}
