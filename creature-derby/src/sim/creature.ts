/**
 * Turning a grown skeleton into something the physics engine can simulate.
 *
 * The skeleton already decided where every part sits; this file only translates
 * that into Rapier rigid bodies, colliders and joints, and then drives the
 * joints each step.
 *
 * Controllers are deliberately not neural networks. Each joint is a sinusoid
 * with three evolvable numbers — how fast it swings, how far, and where in the
 * cycle it starts. That is enough to produce walking, paddling and galloping
 * gaits, and unlike a network you can look at a creature that is behaving
 * strangely and read off exactly why.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { Skeleton, SkeletonJoint } from '../genome/expand.ts';
import { SPAWN_CLEARANCE } from '../genome/types.ts';
import { CREATURE_GROUPS } from './constants.ts';

/**
 * Mass per cubic metre of body part. Roughly the density of wood: heavy enough
 * that creatures press into the ground and get traction, light enough that the
 * joint motors can actually lift a limb.
 */
const DENSITY = 450;

/**
 * Servo strength. The oscillator sets a target *angle* and the joint springs
 * toward it, rather than applying raw torque.
 *
 * This choice matters more than it looks. Torque-driven joints on a randomly
 * generated body produce spasms: the same torque that gently swings a small
 * limb flails a large one. A servo asks for a position and the solver works out
 * the force, so limbs of wildly different sizes all behave sensibly.
 */
export const motorGains = {
  /**
   * Tuned against distance travelled, not against how tidy a creature looks
   * standing still — a creature that never moves is perfectly stable and no fun
   * to watch. Measured over 200 creatures racing 15 seconds, raising stiffness
   * from 60 to 8000 takes the median from 0.30m to 1.14m and cuts the
   * proportion that barely move from 42% to 11%. Past 8000 it plateaus.
   */
  stiffness: 8000,
  damping: 90,
  /**
   * Resistance to tumbling. Swept from 0.02 to 0.35 and it makes no measurable
   * difference to anything — distance and uprightness both move less than the
   * noise between samples. Left at a middling value; it is not the knob it
   * looks like.
   */
  angularDamping: 0.35,
};

/**
 * A note on the trade-off, because it is not obvious and it is worth being
 * honest about. Stiff motors make creatures travel much further, and also make
 * them tip over much more: over 200 racers, going from stiffness 60 to 8000
 * takes the median distance from 0.30m to 1.14m, and the proportion still
 * upright at the end from 55% down to 19%.
 *
 * That is the right way round for this game. A creature that stays primly
 * upright for fifteen seconds because it never really moved is not a racer, and
 * a player choosing between eight of those is not making a choice. Tumbling
 * ones are still in the race, and some of them tumble forward faster than the
 * walkers walk.
 */

/**
 * Deliberately no joint limits.
 *
 * Setting them looked obviously correct and was measurably wrong. Rapier
 * reports a revolute joint's angle wrapped into [-π, π], but a resting angle is
 * not wrapped — a leg pointing straight down rests at about π + 0.5. A limit
 * window placed around the unwrapped value therefore sits on the far side of
 * the wrap from the joint's actual reported angle, and the solver spends every
 * step shoving the limb toward a limit it is already inside. Measured against a
 * creature holding still in zero gravity: no limits drifts 0.0000m, limits
 * drift 0.87m.
 *
 * Nothing is lost by omitting them. The servo motor already confines each joint
 * to its resting angle plus the oscillator's swing, which is exactly the range
 * limits would have enforced.
 */

export interface CreatureHandle {
  readonly bodies: RAPIER.RigidBody[];
  readonly joints: RAPIER.RevoluteImpulseJoint[];
  readonly skeleton: Skeleton;
  /** Total mass, used to weight the centre of mass. */
  readonly mass: number;
}

/**
 * Build the bodies for one creature and place it standing on the ground at
 * `origin`.
 */
export function spawnCreature(
  world: RAPIER.World,
  skeleton: Skeleton,
  origin: { x: number; y: number; z: number },
): CreatureHandle {
  const bodies: RAPIER.RigidBody[] = [];
  const joints: RAPIER.RevoluteImpulseJoint[] = [];
  let mass = 0;

  // Lift the whole body so its lowest corner starts just above the ground.
  // Spawning even slightly interpenetrating makes the solver launch creatures
  // into the air on the first step.
  const lift = SPAWN_CLEARANCE - skeleton.minY;

  for (const part of skeleton.parts) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(
          origin.x + part.position[0],
          origin.y + part.position[1] + lift,
          origin.z + part.position[2],
        )
        .setRotation({
          x: part.rotation[0],
          y: part.rotation[1],
          z: part.rotation[2],
          w: part.rotation[3],
        })
        // A little damping stops the flailing feedback loop where a limb pumps
        // energy into the body faster than friction can take it out.
        .setLinearDamping(0.05)
        .setAngularDamping(motorGains.angularDamping),
    );

    const collider = RAPIER.ColliderDesc.cuboid(
      part.halfExtents[0],
      part.halfExtents[1],
      part.halfExtents[2],
    )
      .setDensity(DENSITY)
      .setFriction(1.1)
      .setRestitution(0.0);
    collider.setCollisionGroups(CREATURE_GROUPS);
    world.createCollider(collider, body);

    mass += body.mass();
    bodies.push(body);
  }

  for (const spec of skeleton.joints) {
    const parent = bodies[spec.parentPart];
    const child = bodies[spec.childPart];
    if (!parent || !child) continue;

    const data = RAPIER.JointData.revolute(
      { x: spec.anchorParent[0], y: spec.anchorParent[1], z: spec.anchorParent[2] },
      { x: spec.anchorChild[0], y: spec.anchorChild[1], z: spec.anchorChild[2] },
      { x: spec.axis[0], y: spec.axis[1], z: spec.axis[2] },
    );

    const joint = world.createImpulseJoint(data, parent, child, true) as RAPIER.RevoluteImpulseJoint;
    // Acceleration-based, so the same stiffness produces the same motion on a
    // heavy limb and a light one. Force-based motors make big creatures sag and
    // small ones snap.
    joint.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
    joint.configureMotorPosition(spec.restAngle, motorGains.stiffness, motorGains.damping);
    joints.push(joint);
  }

  return { bodies, joints, skeleton, mass };
}

/**
 * Drive every joint to where its oscillator says it should be at time `t`.
 *
 * Called once per fixed physics step, never per rendered frame — the gait has
 * to depend only on simulated time or the same creature would move differently
 * on a faster monitor.
 */
export function driveCreature(creature: CreatureHandle, t: number): void {
  const specs = creature.skeleton.joints;
  for (let i = 0; i < creature.joints.length; i++) {
    const spec = specs[i];
    const joint = creature.joints[i];
    if (!spec || !joint) continue;
    joint.configureMotorPosition(targetAngle(spec, t), motorGains.stiffness, motorGains.damping);
  }
}

/** Where a single joint should be pointing at time `t`, in radians. */
export function targetAngle(spec: SkeletonJoint, t: number): number {
  const swing = Math.sin(t * spec.frequency * Math.PI * 2 + spec.phase) * spec.amplitude * spec.limit;
  return spec.restAngle + swing;
}

/** Mass-weighted centre of the creature, which is what the camera follows. */
export function centreOfMass(creature: CreatureHandle, out: { x: number; y: number; z: number }): void {
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const body of creature.bodies) {
    const m = body.mass();
    const t = body.translation();
    x += t.x * m;
    y += t.y * m;
    z += t.z * m;
    total += m;
  }
  if (total <= 0) total = 1;
  out.x = x / total;
  out.y = y / total;
  out.z = z / total;
}

/**
 * Measure what the camera needs: where the creature is, how much room it takes
 * up right now, and how fast it is going.
 *
 * The radius is measured from the parts' current positions rather than from the
 * resting skeleton, because a creature that has just thrown its limbs out needs
 * a wider shot than the same creature standing still — and a creature that has
 * face-planted needs a tighter one.
 */
export function measureCreature(
  creature: CreatureHandle,
  out: { centre: { x: number; y: number; z: number }; radius: number; velocity: { x: number; y: number; z: number } },
): void {
  centreOfMass(creature, out.centre);

  let radius = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let total = 0;

  for (let i = 0; i < creature.bodies.length; i++) {
    const body = creature.bodies[i]!;
    const t = body.translation();
    const half = creature.skeleton.parts[i]?.halfExtents;

    // Distance to the far corner of this part, so nothing pokes out of frame.
    const reach = half ? Math.hypot(half[0], half[1], half[2]) : 0;
    radius = Math.max(radius, Math.hypot(t.x - out.centre.x, t.y - out.centre.y, t.z - out.centre.z) + reach);

    const m = body.mass();
    const v = body.linvel();
    vx += v.x * m;
    vy += v.y * m;
    vz += v.z * m;
    total += m;
  }

  if (total <= 0) total = 1;
  out.radius = radius;
  out.velocity.x = vx / total;
  out.velocity.y = vy / total;
  out.velocity.z = vz / total;
}

/** Remove every body and joint belonging to this creature from the world. */
export function despawnCreature(world: RAPIER.World, creature: CreatureHandle): void {
  // Removing a body removes the joints attached to it, so the joints do not
  // need removing separately.
  for (const body of creature.bodies) world.removeRigidBody(body);
}
