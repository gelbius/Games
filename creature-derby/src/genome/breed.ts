/**
 * Crossover and mutation: where the next generation comes from.
 *
 * Two rules govern everything here.
 *
 * The first is that a child must always be a *valid* genome. Every operation
 * below either preserves validity or repairs it before returning — edges never
 * point at parts that were removed, indices are always remapped after a
 * deletion, and every number stays inside its declared range. A malformed
 * genome would not fail loudly; it would grow a subtly broken body, and the
 * player would just think the creature was ugly.
 *
 * The second is that nothing here knows what a good creature is. Mutation is
 * blind. The player supplies the entire selection pressure by choosing two
 * parents, and this file only shuffles and jiggles what they chose.
 */

import { Rng } from '../rng.ts';
import { quantize } from './codec.ts';
import {
  type EdgeGene,
  type Genome,
  type JointGene,
  type PartGene,
  type Swing,
  clamp,
  MAX_EDGE_SCALE,
  MAX_FREQUENCY,
  MAX_GENOME_EDGES,
  MAX_GENOME_NODES,
  MAX_JOINT_LIMIT,
  MAX_PART_SIZE,
  MIN_EDGE_SCALE,
  MIN_FREQUENCY,
  MIN_JOINT_LIMIT,
  MIN_PART_SIZE,
} from './types.ts';

const TAU = Math.PI * 2;

/** Creatures per generation: the two parents plus their offspring. */
export const GENERATION_SIZE = 8;

/** How strongly a mutation rate of 1.0 perturbs a single number. */
const MAX_JITTER = 0.55;

function clonePart(p: PartGene): PartGene {
  return { size: [...p.size] as PartGene['size'], recursionLimit: p.recursionLimit, hue: p.hue };
}

function cloneEdge(e: EdgeGene): EdgeGene {
  return {
    from: e.from,
    to: e.to,
    restAngle: e.restAngle,
    u: e.u,
    v: e.v,
    scale: e.scale,
    reflect: e.reflect,
    joint: { ...e.joint },
  };
}

/**
 * Combine two parents into one child graph.
 *
 * Single-point crossover on the part list and on the edge list separately, the
 * classic genetic-algorithm operator. Cutting at a point rather than picking
 * each gene independently keeps neighbouring genes together, and neighbouring
 * genes here are exactly the ones that have to agree — a limb's size and the
 * edge that attaches it are only sensible as a pair.
 *
 * Because the parents can have different numbers of parts, the child can end up
 * with edges pointing past the end of its own part list. Those are dropped
 * rather than repaired: an edge whose target no longer exists has no meaning.
 */
export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  const cutParts = rng.intBetween(1, Math.min(a.parts.length, b.parts.length));
  const parts = [...a.parts.slice(0, cutParts), ...b.parts.slice(cutParts)]
    .slice(0, MAX_GENOME_NODES)
    .map(clonePart);

  // A genome with no parts cannot grow anything. Should be unreachable, since
  // cutParts is at least 1, but a creature-less generation is not a failure
  // mode worth risking.
  if (parts.length === 0) parts.push(clonePart(a.parts[0]!));

  const cutEdges = rng.intBetween(0, Math.min(a.edges.length, b.edges.length));
  const edges = [...a.edges.slice(0, cutEdges), ...b.edges.slice(cutEdges)]
    .filter((e) => e.from < parts.length && e.to < parts.length)
    .slice(0, MAX_GENOME_EDGES)
    .map(cloneEdge);

  return {
    version: 1,
    seed: rng.nextSeed(),
    root: 0,
    parts,
    edges,
  };
}

/** Nudge a number, keeping it inside its range. */
function jitter(value: number, rng: Rng, rate: number, span: number, min: number, max: number): number {
  return clamp(value + rng.gauss() * rate * MAX_JITTER * span, min, max);
}

/** Nudge an angle. Angles wrap, so they have no range to clamp to. */
function jitterAngle(value: number, rng: Rng, rate: number, span: number): number {
  return value + rng.gauss() * rate * MAX_JITTER * span;
}

function mutatePart(part: PartGene, rng: Rng, rate: number): void {
  for (let i = 0; i < 3; i++) {
    if (rng.chance(0.5 * rate)) {
      part.size[i] = jitter(part.size[i]!, rng, rate, 0.3, MIN_PART_SIZE, MAX_PART_SIZE);
    }
  }
  if (rng.chance(0.12 * rate)) {
    part.recursionLimit = clamp(part.recursionLimit + (rng.chance(0.5) ? 1 : -1), 1, 4);
  }
  if (rng.chance(0.35 * rate)) {
    // Hue wraps, so a small drift accumulates into whole new colours over many
    // generations, which makes a lineage visibly a lineage.
    part.hue = (part.hue + rng.gauss() * rate * 0.09 + 1) % 1;
  }
}

function mutateJoint(joint: JointGene, rng: Rng, rate: number): void {
  if (rng.chance(0.4 * rate)) {
    joint.frequency = jitter(joint.frequency, rng, rate, MAX_FREQUENCY - MIN_FREQUENCY, MIN_FREQUENCY, MAX_FREQUENCY);
  }
  if (rng.chance(0.4 * rate)) {
    joint.amplitude = jitter(joint.amplitude, rng, rate, 1, 0, 1);
  }
  if (rng.chance(0.4 * rate)) {
    joint.phase = (jitterAngle(joint.phase, rng, rate, TAU * 0.35) % TAU + TAU) % TAU;
  }
  if (rng.chance(0.3 * rate)) {
    joint.limit = jitter(joint.limit, rng, rate, MAX_JOINT_LIMIT - MIN_JOINT_LIMIT, MIN_JOINT_LIMIT, MAX_JOINT_LIMIT);
  }
  if (rng.chance(0.08 * rate)) {
    // Swapping the plane a joint swings in is a big change: a walking leg
    // becomes a rowing one.
    joint.swing = (joint.swing === 0 ? 1 : 0) as Swing;
  }
}

function mutateEdge(edge: EdgeGene, rng: Rng, rate: number): void {
  if (rng.chance(0.45 * rate)) edge.restAngle = jitterAngle(edge.restAngle, rng, rate, 1.2);
  if (rng.chance(0.4 * rate)) edge.u = clamp(edge.u + rng.gauss() * rate * 0.4, -1, 1);
  if (rng.chance(0.4 * rate)) edge.v = clamp(edge.v + rng.gauss() * rate * 0.4, -1, 1);
  if (rng.chance(0.4 * rate)) {
    edge.scale = jitter(edge.scale, rng, rate, MAX_EDGE_SCALE - MIN_EDGE_SCALE, MIN_EDGE_SCALE, MAX_EDGE_SCALE);
  }
  if (rng.chance(0.09 * rate)) {
    // Turning symmetry on or off is the single most visible mutation there is,
    // so it is deliberately rare — a lineage should not lose its body plan by
    // accident every other generation.
    edge.reflect = !edge.reflect;
  }
  mutateJoint(edge.joint, rng, rate);
}

/** A brand-new limb, for the add-a-part mutation. */
function freshPart(rng: Rng, hue: number): PartGene {
  const thickness = rng.range(0.07, 0.15);
  return {
    size: [thickness, rng.range(0.18, 0.4), thickness],
    recursionLimit: rng.intBetween(1, 2),
    hue: (hue + rng.range(-0.08, 0.08) + 1) % 1,
  };
}

/** A brand-new attachment, for the add-a-part and add-an-edge mutations. */
function freshEdge(rng: Rng, from: number, to: number): EdgeGene {
  return {
    from,
    to,
    restAngle: Math.PI + rng.range(-0.6, 0.6),
    u: rng.chance(0.5) ? rng.range(0.4, 0.9) : rng.range(-0.9, -0.4),
    v: rng.range(-0.8, 0.8),
    scale: rng.range(0.7, 1.0),
    reflect: rng.chance(0.8),
    joint: {
      swing: rng.chance(0.7) ? 0 : 1,
      limit: rng.range(MIN_JOINT_LIMIT, MAX_JOINT_LIMIT),
      frequency: rng.range(MIN_FREQUENCY, MAX_FREQUENCY),
      amplitude: rng.range(0.45, 1),
      phase: rng.range(0, TAU),
    },
  };
}

/**
 * Delete a part and repair every edge that referred to it.
 *
 * This is the operation most likely to corrupt a genome, because part indices
 * shift when one is removed. Edges pointing at the deleted part are dropped;
 * every index above it is decremented.
 */
function removePart(genome: Genome, index: number): void {
  if (index <= 0 || index >= genome.parts.length) return; // never the root
  genome.parts.splice(index, 1);
  genome.edges = genome.edges
    .filter((e) => e.from !== index && e.to !== index)
    .map((e) => {
      if (e.from > index) e.from -= 1;
      if (e.to > index) e.to -= 1;
      return e;
    });
}

/**
 * Perturb a genome.
 *
 * `rate` runs from 0 (an exact copy) to 1 (barely recognisable). It scales both
 * how often a gene changes and how far it moves, so the slider does what a
 * player expects at both ends rather than only changing frequency.
 */
export function mutate(source: Genome, rate: number, rng: Rng): Genome {
  const genome: Genome = {
    version: 1,
    seed: rng.nextSeed(),
    root: 0,
    parts: source.parts.map(clonePart),
    edges: source.edges.map(cloneEdge),
  };

  if (rate <= 0) return quantize({ ...genome, seed: source.seed });

  for (const part of genome.parts) mutatePart(part, rng, rate);
  for (const edge of genome.edges) mutateEdge(edge, rng, rate);

  // ------------------------------------------------------------- structural
  // Grow a new limb.
  if (genome.parts.length < MAX_GENOME_NODES && genome.edges.length < MAX_GENOME_EDGES && rng.chance(0.16 * rate)) {
    const index = genome.parts.length;
    genome.parts.push(freshPart(rng, genome.parts[0]!.hue));
    genome.edges.push(freshEdge(rng, rng.int(index), index));
  }

  // Lose a limb.
  if (genome.parts.length > 1 && rng.chance(0.13 * rate)) {
    removePart(genome, rng.intBetween(1, genome.parts.length - 1));
  }

  // Attach an existing limb somewhere else as well.
  if (genome.parts.length > 1 && genome.edges.length < MAX_GENOME_EDGES && rng.chance(0.14 * rate)) {
    genome.edges.push(freshEdge(rng, rng.int(genome.parts.length), rng.intBetween(1, genome.parts.length - 1)));
  }

  // Drop an attachment. Parts left unreachable simply never grow.
  if (genome.edges.length > 1 && rng.chance(0.12 * rate)) {
    genome.edges.splice(rng.int(genome.edges.length), 1);
  }

  return quantize(genome);
}

/**
 * A whole new generation from two chosen parents.
 *
 * Both parents carry through untouched. That matters more than it sounds: if
 * every creature were a mutated child, a lineage the player liked could be lost
 * in one unlucky generation, and there would be no way to hold on to something
 * good while exploring around it.
 */
export function breed(parentA: Genome, parentB: Genome, rate: number, seed: number): Genome[] {
  const rng = new Rng(seed);
  const generation: Genome[] = [quantize(parentA), quantize(parentB)];

  while (generation.length < GENERATION_SIZE) {
    // Most offspring mix both parents; a few are a mutated copy of one, which
    // keeps a distinctive parent's body plan available even when crossover
    // happens to blend it away.
    const child = rng.chance(0.75)
      ? crossover(parentA, parentB, rng)
      : { ...(rng.chance(0.5) ? parentA : parentB) };
    generation.push(mutate(child, rate, rng));
  }

  return generation;
}
