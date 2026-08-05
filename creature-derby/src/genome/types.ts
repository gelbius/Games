/**
 * The genome: a directed graph describing a creature, after Karl Sims (1994).
 *
 * The key idea, and the reason this is a graph rather than a tree: a node can
 * be visited more than once while the body is being grown, including by an edge
 * pointing back at itself. That is how one small piece of genetic data produces
 * a segmented tail or a multi-jointed leg — the same node, instantiated
 * repeatedly until its recursion limit runs out.
 *
 * Nodes are body parts (boxes). Edges say how a child part attaches to its
 * parent, and carry the joint that connects them.
 */

export type Vec3 = [number, number, number];

/**
 * Which face of the parent box a child attaches to.
 * The creature's body axes are a fixed convention across the whole project:
 *   +X / -X is left and right   (the axis reflection mirrors across)
 *   +Y / -Y is up and down
 *   +Z / -Z is forward and back (the race runs toward +Z)
 */
export const FACE = {
  RIGHT: 0,
  LEFT: 1,
  UP: 2,
  DOWN: 3,
  FRONT: 4,
  BACK: 5,
} as const;

export type Face = 0 | 1 | 2 | 3 | 4 | 5;

/** Unit outward normal of each face, indexed by Face. */
export const FACE_NORMALS: readonly Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** A body part. Sizes are half-extents, so a size of 0.5 spans 1 metre. */
export interface PartGene {
  /** Half-extents of the box, in metres. */
  size: Vec3;
  /**
   * How many times this part may appear along a single chain of growth.
   * 1 means "appears once"; 3 gives a three-segment limb or tail.
   */
  recursionLimit: number;
  /** Hue in [0, 1). Cosmetic only, but inherited so lineages look related. */
  hue: number;
}

/** The oscillator and hinge that drive one joint. */
export interface JointGene {
  /** Which of the parent's local axes the hinge rotates about: 0=X, 1=Y, 2=Z. */
  axis: 0 | 1 | 2;
  /** Half-range of the hinge in radians. The joint swings within ±limit. */
  limit: number;
  /** Oscillation rate in cycles per second. */
  frequency: number;
  /** Swing size as a fraction [0, 1] of `limit`. */
  amplitude: number;
  /** Where in its cycle this joint starts, in radians [0, 2π). */
  phase: number;
}

/** How a child part attaches to a parent part. */
export interface EdgeGene {
  /** Index into Genome.parts of the parent. */
  from: number;
  /** Index into Genome.parts of the child. May equal `from`, meaning recursion. */
  to: number;
  /** Which face of the parent the child grows from. */
  face: Face;
  /** Position on that face, each in [-1, 1], as a fraction of the face's extent. */
  u: number;
  v: number;
  /** Child's orientation relative to the attachment frame, as Euler XYZ radians. */
  twist: Vec3;
  /** Size multiplier applied to the child, and compounded on each recursion. */
  scale: number;
  /**
   * Mirror this limb across the body's left-right axis, producing a matched
   * pair. This is what separates creatures that read as animals from creatures
   * that read as debris, so it is a first-class part of the genome rather than
   * a rendering trick.
   */
  reflect: boolean;
  /** The joint connecting child to parent. */
  joint: JointGene;
}

/** A complete creature description. */
export interface Genome {
  /** Format version, so old shared URLs can be migrated rather than crash. */
  version: 1;
  /** Seed for any randomness needed at build time. Part of the creature's identity. */
  seed: number;
  /** Index into `parts` of the part the body grows outward from. */
  root: number;
  parts: PartGene[];
  edges: EdgeGene[];
}

// ---------------------------------------------------------------------------
// Limits. These exist to keep the physics fast enough to run eight creatures at
// once, and to stop a mutation from producing a thousand-legged monster.
// ---------------------------------------------------------------------------

/** Hard cap on parts in a grown body. The brief calls for roughly 12–15. */
export const MAX_PARTS = 14;

/** Cap on nodes in the genome graph itself, before growth. */
export const MAX_GENOME_NODES = 6;

/** Cap on edges in the genome graph. */
export const MAX_GENOME_EDGES = 10;

export const MIN_PART_SIZE = 0.06;
export const MAX_PART_SIZE = 0.85;

export const MIN_FREQUENCY = 0.2;
export const MAX_FREQUENCY = 2.6;

export const MIN_JOINT_LIMIT = 0.15;
export const MAX_JOINT_LIMIT = 1.4;

export const MIN_EDGE_SCALE = 0.4;
export const MAX_EDGE_SCALE = 1.15;

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
