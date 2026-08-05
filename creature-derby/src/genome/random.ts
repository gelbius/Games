/**
 * Making a creature out of nothing but a number.
 *
 * A uniformly random graph produces uniformly random junk: parts at absurd
 * angles, limbs sprouting from nowhere, nothing that reads as an animal. So the
 * generator is biased. It builds a torso, then hangs limbs off it, and it
 * strongly prefers reflected limbs so that what comes out is bilaterally
 * symmetric. Symmetry is doing most of the work of making these look alive.
 *
 * The bias is not cheating: it is the same choice Sims made in giving his
 * creatures a structured genome rather than random matter. The player still
 * supplies all the selection pressure — nothing here scores a creature or
 * favours one that moves well.
 */

import { Rng } from '../rng.ts';
import { quantize } from './codec.ts';
import {
  type EdgeGene,
  type Genome,
  type JointGene,
  type PartGene,
  MAX_FREQUENCY,
  MAX_JOINT_LIMIT,
  MIN_FREQUENCY,
  MIN_JOINT_LIMIT,
  SWING,
} from './types.ts';

const TAU = Math.PI * 2;

function randomJoint(rng: Rng): JointGene {
  return {
    swing: rng.chance(0.7) ? SWING.PITCH : SWING.ROLL,
    limit: rng.range(MIN_JOINT_LIMIT, MAX_JOINT_LIMIT),
    frequency: rng.range(MIN_FREQUENCY, MAX_FREQUENCY),
    // Biased high: a joint that barely moves contributes nothing to a gait.
    amplitude: rng.range(0.45, 1.0),
    phase: rng.range(0, TAU),
  };
}

/** A torso: wide and long relative to its height, so the creature has a body. */
function torsoPart(rng: Rng): PartGene {
  return {
    size: [rng.range(0.22, 0.42), rng.range(0.14, 0.26), rng.range(0.3, 0.6)],
    recursionLimit: 1,
    hue: rng.next(),
  };
}

/** A limb segment: elongated along its growth axis so it reads as a leg. */
function limbPart(rng: Rng, hue: number): PartGene {
  const thickness = rng.range(0.07, 0.15);
  const length = rng.range(0.18, 0.42);
  return {
    // Limbs always grow along their own local Y, so Y is the long dimension.
    size: [thickness, length, thickness],
    // Recursion turns one gene into a jointed multi-segment limb.
    recursionLimit: rng.intBetween(1, 3),
    // Keep limbs near the torso's hue so a creature reads as one animal.
    hue: (hue + rng.range(-0.06, 0.06) + 1) % 1,
  };
}

/**
 * A resting angle that points a limb somewhere useful.
 *
 * Straight down is the interesting case — that is a leg, and legs are what
 * make something walk — so most limbs start near there, with the rest spread
 * out to the sides and back for variety.
 */
function limbRestAngle(rng: Rng): number {
  // π points a limb straight down, for both swing axes.
  if (rng.chance(0.6)) return Math.PI + rng.range(-0.5, 0.5); // downward: a leg
  return rng.range(0, TAU); // anything: a fin, a wing, an oar, a mistake
}

/**
 * Build a random genome from a seed.
 *
 * The same seed always yields exactly the same genome, so a creature can be
 * referred to by its seed alone until it has been bred.
 */
export function randomGenome(seed: number): Genome {
  const rng = new Rng(seed);

  const torso = torsoPart(rng);
  const parts: PartGene[] = [torso];
  const edges: EdgeGene[] = [];

  // One or two distinct limb designs. More than that and the creature stops
  // looking like a single animal.
  const limbKinds = rng.intBetween(1, 2);
  for (let k = 0; k < limbKinds; k++) {
    const limbIndex = parts.length;
    parts.push(limbPart(rng, torso.hue));

    // Each limb design is attached to the torso once or twice — twice gives the
    // front-and-back pairs that make a four-legged creature.
    const attachments = rng.chance(0.7) ? 2 : 1;

    // All attachments of one limb design point roughly the same way and sit on
    // the same side. Drawing a fresh angle per attachment gave creatures a leg
    // forward, a leg sideways and a leg up, which cannot hold a body off the
    // ground. Sharing the angle, together with the front-to-back spread below,
    // is worth a lot: over 400 seeds it takes the proportion still upright
    // after three seconds from 46% to 61%, and halves how far a creature has
    // tipped, from 38 degrees to 15.
    const baseAngle = limbRestAngle(rng);
    const baseSide = rng.chance(0.5) ? 1 : -1;
    const reflect = rng.chance(0.85);

    for (let a = 0; a < attachments; a++) {
      edges.push({
        from: 0,
        to: limbIndex,
        restAngle: baseAngle + rng.range(-0.18, 0.18),
        // Off-centre, so the mirrored copy lands somewhere different. A limb
        // attached exactly on the midline has no distinct mirror image.
        u: baseSide * rng.range(0.45, 0.95),
        // Spread front to back, so a pair of attachments becomes shoulders and
        // hips rather than two limbs in the same place.
        v: attachments === 1 ? rng.range(-0.5, 0.5) : (a === 0 ? rng.range(0.4, 0.9) : rng.range(-0.9, -0.4)),
        scale: rng.range(0.78, 1.0),
        // Overwhelmingly reflected. A limb on only one side is the exception,
        // not the rule, and this single probability is the biggest lever on
        // whether a generation looks like animals or like wreckage.
        reflect,
        joint: randomJoint(rng),
      });
    }

    // Sometimes the limb grows out of itself, giving a jointed chain: the
    // upper leg, lower leg, foot pattern, all from one gene.
    if (rng.chance(0.55)) {
      edges.push({
        from: limbIndex,
        to: limbIndex,
        // Near zero means "keep going the way the parent segment was already
        // pointing", with a bend at each joint. Larger angles fold the limb up.
        restAngle: rng.range(-0.7, 0.7),
        u: rng.range(-0.2, 0.2),
        v: rng.range(-0.2, 0.2),
        scale: rng.range(0.62, 0.92),
        // A self-edge must never reflect: the mirroring already happened where
        // the limb met the torso. Reflecting again would double every segment
        // and blow through the part budget immediately.
        reflect: false,
        joint: randomJoint(rng),
      });
    }
  }

  // Occasionally a head or tail: a single unreflected part on the body axis.
  if (rng.chance(0.5)) {
    const knobIndex = parts.length;
    parts.push({
      size: [rng.range(0.1, 0.22), rng.range(0.1, 0.2), rng.range(0.12, 0.3)],
      recursionLimit: rng.intBetween(1, 2),
      hue: (torso.hue + rng.range(-0.1, 0.1) + 1) % 1,
    });
    edges.push({
      from: 0,
      to: knobIndex,
      // Roughly horizontal, so it reads as a head or a tail rather than a horn.
      restAngle: (rng.chance(0.5) ? Math.PI / 2 : -Math.PI / 2) + rng.range(-0.3, 0.3),
      u: rng.range(-0.15, 0.15),
      v: rng.range(-0.3, 0.3),
      scale: rng.range(0.7, 1.0),
      reflect: false,
      joint: randomJoint(rng),
    });
  }

  return quantize({ version: 1, seed, root: 0, parts, edges });
}

/** A generation's worth of unrelated creatures, all derived from one seed. */
export function randomPopulation(seed: number, count: number): Genome[] {
  const rng = new Rng(seed);
  return Array.from({ length: count }, () => randomGenome(rng.nextSeed()));
}
