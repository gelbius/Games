/**
 * Measures how far randomly generated creatures actually get in a 15-second
 * race, and how they get there.
 *
 * The point is not to select for fast creatures — the player does all the
 * selecting — but to check that the oscillators produce *movement at all*. A
 * generation where every creature sits still is not a game, however faithful
 * the genetics are.
 *
 * Usage: node tools/locomotion.ts [sampleSize]
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { expand } from '../src/genome/expand.ts';
import { randomGenome } from '../src/genome/random.ts';
import { centreOfMass, driveCreature, spawnCreature } from '../src/sim/creature.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, RACE_STEPS } from '../src/sim/constants.ts';

await RAPIER.init();

const SAMPLE = Number(process.argv[2] ?? 300);

function race(seed: number): { forward: number; total: number; drift: number } {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const gc = RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.1);
  gc.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(gc, ground);

  const creature = spawnCreature(world, expand(randomGenome(seed)), { x: 0, y: 0, z: 0 });
  const start = { x: 0, y: 0, z: 0 };
  centreOfMass(creature, start);

  for (let step = 0; step < RACE_STEPS; step++) {
    driveCreature(creature, step * FIXED_DT);
    world.step();
  }

  const end = { x: 0, y: 0, z: 0 };
  centreOfMass(creature, end);
  return {
    forward: end.z - start.z,
    total: Math.hypot(end.x - start.x, end.z - start.z),
    drift: Math.abs(end.x - start.x),
  };
}

const results = Array.from({ length: SAMPLE }, (_, seed) => race(seed));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

const totals = results.map((r) => r.total);
const stuck = totals.filter((d) => d < 0.25).length;

console.log(`${SAMPLE} creatures, ${RACE_STEPS / 60}s each\n`);
console.log(`distance moved   p10 ${percentile(totals, 0.1).toFixed(2)}m   median ${percentile(totals, 0.5).toFixed(2)}m` +
  `   p90 ${percentile(totals, 0.9).toFixed(2)}m   max ${Math.max(...totals).toFixed(2)}m`);
console.log(`barely moved (<0.25m): ${stuck} of ${SAMPLE}  (${((stuck / SAMPLE) * 100).toFixed(0)}%)`);
console.log(`sideways drift   median ${percentile(results.map((r) => r.drift), 0.5).toFixed(2)}m`);

// A spread of outcomes is what makes selection interesting: if every creature
// travels the same distance the player has nothing to choose between.
console.log(`\nspread (p90 / median): ${(percentile(totals, 0.9) / Math.max(0.01, percentile(totals, 0.5))).toFixed(1)}x`);
