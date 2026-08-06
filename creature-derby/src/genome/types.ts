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
 * The creature's body axes are a fixed convention across the whole project:
 *   +X / -X is left and right   (the axis reflection mirrors across)
 *   +Y / -Y is up and down
 *   +Z / -Z is forward and back (the race runs toward +Z)
 */

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

/**
 * Which axis a joint swings about.
 *
 * Only two are offered, and that is forced by the physics engine rather than
 * chosen for taste. Rapier's revolute joint takes a single axis vector and uses
 * it in *both* bodies' local frames, so a limb's resting orientation has to be
 * a pure rotation about its own hinge axis — otherwise the joint is born
 * violating its own constraint and the creature twitches on frame one.
 *
 * Given that, a limb rests somewhere in the plane perpendicular to its hinge:
 *   PITCH swings in the side-on plane — the up/down stride of a walking leg.
 *   ROLL  swings in the head-on plane — the out/in sweep of a rowing limb.
 *
 * A third, twist-about-the-limb axis would be degenerate: rotating a limb about
 * its own long axis moves it nowhere, so it could never contribute to a gait.
 */
export const SWING = {
  PITCH: 0,
  ROLL: 1,
} as const;

export type Swing = 0 | 1;

/** Local axis vector each swing rotates about. */
export const SWING_AXES: readonly Vec3[] = [
  [1, 0, 0], // PITCH
  [0, 0, 1], // ROLL
];

/** The oscillator and hinge that drive one joint. */
export interface JointGene {
  /** Which plane this joint swings in. */
  swing: Swing;
  /** Half-range of the hinge in radians. The joint swings within ±limit of rest. */
  limit: number;
  /** Oscillation rate in cycles per second. */
  frequency: number;
  /** Swing size as a fraction [0, 1] of `limit`. */
  amplitude: number;
  /** Where in its cycle this joint starts, in radians [0, 2π). */
  phase: number;
}

/**
 * How a child part attaches to a parent part.
 *
 * Note there is no stored face. The direction a limb grows is decided entirely
 * by `restAngle`, and the face it emerges from is then *derived* as whichever
 * face that direction points out of. That is not a shortcut — it makes it
 * structurally impossible for a mutation to produce a limb growing into the
 * middle of its own body, which is otherwise the most common way random
 * creatures come out looking wrong.
 */
export interface EdgeGene {
  /** Index into Genome.parts of the parent. */
  from: number;
  /** Index into Genome.parts of the child. May equal `from`, meaning recursion. */
  to: number;
  /**
   * The child's resting rotation about the hinge axis, in radians. This decides
   * which way the limb points: for a PITCH joint, 0 is straight up, π is
   * straight down, ±π/2 is forward or back.
   */
  restAngle: number;
  /** Where on the derived face the limb attaches, each in [-1, 1]. */
  u: number;
  v: number;
  /** Size multiplier applied to the child, compounded on each recursion. */
  scale: number;
  /**
   * Mirror this limb across the body's midline, producing a matched pair.
   * This is what separates creatures that read as animals from creatures that
   * read as debris, so it is a first-class part of the genome rather than a
   * rendering trick.
   *
   * Only honoured on edges growing from the root part: bilateral symmetry is a
   * property of the body midline, and mirroring a limb that hangs off another
   * limb has no coherent meaning.
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

/** How far above the ground a creature is dropped at the start of a race. */
export const SPAWN_CLEARANCE = 0.12;

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
