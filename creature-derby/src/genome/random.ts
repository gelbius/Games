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
 * supplies all the selection pressure.
 */

import { Rng } from '../rng.ts';
import { quantize } from './codec.ts';
import {
  type EdgeGene,
  type Face,
  type Genome,
  type JointGene,
  type PartGene,
  FACE,
  MAX_FREQUENCY,
  MAX_JOINT_LIMIT,
  MIN_FREQUENCY,
  MIN_JOINT_LIMIT,
} from './types.ts';

/** Faces a limb may sensibly grow from. Growing out of the back is allowed. */
const LIMB_FACES: readonly Face[] = [FACE.RIGHT, FACE.DOWN, FACE.BACK, FACE.FRONT];

function randomJoint(rng: Rng): JointGene {
  return {
    axis: rng.int(3) as 0 | 1 | 2,
    limit: rng.range(MIN_JOINT_LIMIT, MAX_JOINT_LIMIT),
    frequency: rng.range(MIN_FREQUENCY, MAX_FREQUENCY),
    // Biased high: a joint that barely moves contributes nothing to a gait.
    amplitude: rng.range(0.45, 1.0),
    phase: rng.range(0, Math.PI * 2),
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

/** A limb segment: elongated along one axis so it reads as a leg, not a lump. */
function limbPart(rng: Rng, hue: number): PartGene {
  const thickness = rng.range(0.07, 0.15);
  const length = rng.range(0.18, 0.42);
  return {
    size: [thickness, length, thickness],
    // Recursion turns one gene into a jointed multi-segment limb.
    recursionLimit: rng.intBetween(1, 3),
    // Keep limbs near the torso's hue so a creature reads as one animal.
    hue: (hue + rng.range(-0.06, 0.06) + 1) % 1,
  };
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

    // Each limb design is attached to the torso once or twice.
    const attachments = rng.intBetween(1, 2);
    for (let a = 0; a < attachments; a++) {
      const face = rng.pick(LIMB_FACES);
      edges.push({
        from: 0,
        to: limbIndex,
        face,
        u: rng.range(-0.75, 0.75),
        v: rng.range(-0.75, 0.75),
        twist: [rng.range(-0.6, 0.6), rng.range(-0.6, 0.6), rng.range(-0.6, 0.6)],
        scale: rng.range(0.7, 1.0),
        // Overwhelmingly reflected. A limb on only one side is the exception,
        // not the rule, and this single probability is the biggest lever on
        // whether a generation looks like animals or like wreckage.
        reflect: rng.chance(0.85),
        joint: randomJoint(rng),
      });
    }

    // Sometimes the limb grows out of itself, giving a jointed chain: the
    // upper leg, lower leg, foot pattern, from one gene.
    if (rng.chance(0.55)) {
      edges.push({
        from: limbIndex,
        to: limbIndex,
        // Segments continue from the far end of the previous segment.
        face: FACE.DOWN,
        u: rng.range(-0.2, 0.2),
        v: rng.range(-0.2, 0.2),
        twist: [rng.range(-0.5, 0.5), rng.range(-0.3, 0.3), rng.range(-0.5, 0.5)],
        scale: rng.range(0.62, 0.92),
        // A self-edge must never reflect: the mirroring already happened at the
        // attachment to the torso, and reflecting again would double every
        // segment and blow past the part budget immediately.
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
      face: rng.chance(0.5) ? FACE.FRONT : FACE.BACK,
      u: rng.range(-0.15, 0.15),
      v: rng.range(-0.3, 0.3),
      twist: [rng.range(-0.3, 0.3), 0, 0],
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
