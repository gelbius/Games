/**
 * Measures how well randomly generated creatures hold themselves up.
 *
 * Used to justify the motor gains in sim/creature.ts and the body-plan biases
 * in genome/random.ts, both of which were tuned against these numbers rather
 * than by eye. Re-run it after changing either.
 *
 * Usage: node tools/stability.ts
 *
 * Note that changing the generator changes which creatures a given seed
 * produces, so two runs compare two *populations*, not the same creatures under
 * two rules. Keep the sample large enough that this is a fair comparison.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { expand } from '../src/genome/expand.ts';
import { randomGenome } from '../src/genome/random.ts';
import { FIXED_DT, GRAVITY, GROUND_GROUPS, CREATURE_GROUPS } from '../src/sim/constants.ts';
import { SPAWN_CLEARANCE } from '../src/genome/types.ts';

await RAPIER.init();

const DENSITY = 450;

function trial(seed: number, stiffness: number, damping: number, steps: number) {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = FIXED_DT;
  const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const gc = RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setFriction(1.1);
  gc.setCollisionGroups(GROUND_GROUPS);
  world.createCollider(gc, g);

  const sk = expand(randomGenome(seed));
  const bodies: RAPIER.RigidBody[] = [];
  const lift = SPAWN_CLEARANCE - sk.minY;
  for (const p of sk.parts) {
    const b = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.position[0], p.position[1] + lift, p.position[2])
        .setRotation({ x: p.rotation[0], y: p.rotation[1], z: p.rotation[2], w: p.rotation[3] })
        .setLinearDamping(0.05).setAngularDamping(0.35),
    );
    const c = RAPIER.ColliderDesc.cuboid(...p.halfExtents).setDensity(DENSITY).setFriction(1.1).setRestitution(0);
    c.setCollisionGroups(CREATURE_GROUPS);
    world.createCollider(c, b);
    bodies.push(b);
  }
  for (const s of sk.joints) {
    const d = RAPIER.JointData.revolute(
      { x: s.anchorParent[0], y: s.anchorParent[1], z: s.anchorParent[2] },
      { x: s.anchorChild[0], y: s.anchorChild[1], z: s.anchorChild[2] },
      { x: s.axis[0], y: s.axis[1], z: s.axis[2] },
    );
    const j = world.createImpulseJoint(d, bodies[s.parentPart]!, bodies[s.childPart]!, true) as RAPIER.RevoluteImpulseJoint;
    j.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
    j.configureMotorPosition(s.restAngle, stiffness, damping);
  }

  const rootY0 = bodies[0]!.translation().y;
  const rot0 = bodies[0]!.rotation();
  for (let i = 0; i < steps; i++) world.step();
  const rootY1 = bodies[0]!.translation().y;
  const rot1 = bodies[0]!.rotation();

  // how much the torso tipped, in degrees
  const dot = Math.abs(rot0.x*rot1.x + rot0.y*rot1.y + rot0.z*rot1.z + rot0.w*rot1.w);
  const tip = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
  return { sink: rootY0 - rootY1, tip };
}

console.log('stiff  damp | median sink | median tip(deg) | %upright(<35deg)');
for (const [st, dp] of [[12,1.4],[60,3.5],[200,8]] as [number,number][]) {
  const sinks: number[] = [], tips: number[] = [];
  for (let s = 0; s < 400; s++) {
    const r = trial(s, st, dp, 180);
    sinks.push(r.sink); tips.push(r.tip);
  }
  sinks.sort((a,b)=>a-b); tips.sort((a,b)=>a-b);
  const upright = tips.filter(t=>t<35).length / tips.length * 100;
  console.log(
    String(st).padStart(5), String(dp).padStart(5), '|',
    sinks[200]!.toFixed(3).padStart(11), '|',
    tips[200]!.toFixed(1).padStart(15), '|',
    upright.toFixed(0).padStart(5) + '%',
  );
}
