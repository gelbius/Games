/**
 * Growing a body from a genome.
 *
 * This is the step Sims called developing the phenotype: the genome is a small
 * graph, and the body is what you get by walking that graph outward from the
 * root, instantiating a part each time you arrive at a node, and stopping when
 * a node has been visited as many times as its recursion limit allows.
 *
 * The output is a Skeleton: plain numbers describing where every part sits and
 * how the joints connect them. Deliberately no physics engine and no renderer
 * are involved, which means the hardest geometry in the project — reflection —
 * can be tested directly rather than judged by squinting at a screen.
 *
 * Coordinates are creature-local: the root sits at the origin, unrotated, and
 * +Z is the direction the creature will be asked to race in.
 */

import { Quaternion, Vector3 } from 'three';
import {
  type Genome,
  type Vec3,
  MAX_PART_SIZE,
  MAX_PARTS,
  MIN_PART_SIZE,
  SWING_AXES,
} from './types.ts';

export interface SkeletonPart {
  /** Index into Skeleton.parts of this part's parent, or -1 for the root. */
  parent: number;
  /** Which PartGene this grew from. */
  gene: number;
  /** Half-extents after all accumulated scaling. */
  halfExtents: Vec3;
  /** Position in creature-local space. */
  position: Vec3;
  /** Orientation in creature-local space, as [x, y, z, w]. */
  rotation: [number, number, number, number];
  hue: number;
  /** True if this part is the mirrored copy of a reflected limb. */
  mirrored: boolean;
}

export interface SkeletonJoint {
  parentPart: number;
  childPart: number;
  /** Which EdgeGene drives this joint, so the oscillator can be read back. */
  gene: number;
  /** Attachment point in the parent part's local frame. */
  anchorParent: Vec3;
  /** Attachment point in the child part's local frame. */
  anchorChild: Vec3;
  /**
   * Hinge axis. One vector, correct in *both* bodies' local frames — which is
   * only true because a child's resting orientation is always a pure rotation
   * about this axis. See the note on SWING in types.ts.
   */
  axis: Vec3;
  /** The angle the joint rests at, and oscillates around. */
  restAngle: number;
  limit: number;
  frequency: number;
  amplitude: number;
  phase: number;
}

export interface Skeleton {
  parts: SkeletonPart[];
  joints: SkeletonJoint[];
  /** Lowest point of the body, used to drop it onto the ground without clipping. */
  minY: number;
  /** Distance from the body's centre to its furthest corner. Used by the camera. */
  radius: number;
}

/** Outward normals of the six faces of a box, and which axis each one lies on. */
const FACES: readonly { normal: Vec3; normalAxis: 0 | 1 | 2; uAxis: 0 | 1 | 2; vAxis: 0 | 1 | 2 }[] = [
  { normal: [1, 0, 0], normalAxis: 0, uAxis: 1, vAxis: 2 },
  { normal: [-1, 0, 0], normalAxis: 0, uAxis: 1, vAxis: 2 },
  { normal: [0, 1, 0], normalAxis: 1, uAxis: 0, vAxis: 2 },
  { normal: [0, -1, 0], normalAxis: 1, uAxis: 0, vAxis: 2 },
  { normal: [0, 0, 1], normalAxis: 2, uAxis: 0, vAxis: 1 },
  { normal: [0, 0, -1], normalAxis: 2, uAxis: 0, vAxis: 1 },
];

/**
 * Reflecting across the body's midline (the plane x = 0).
 *
 * A position simply has its x negated. A *rotation* is less obvious: mirroring
 * turns a right-handed rotation into a left-handed one, and the quaternion that
 * expresses the mirrored rotation is (x, -y, -z, w). The same sign pattern
 * applies to the hinge axis, because a rotation axis is a pseudovector and
 * flips the opposite way to a position under a reflection.
 *
 * Getting this wrong is subtle and ugly: the limbs end up in the right places
 * but bending the wrong way, so the creature paddles with one side and claws
 * with the other.
 */
function mirrorPosition(p: Vector3): Vector3 {
  return new Vector3(-p.x, p.y, p.z);
}

function mirrorRotation(q: Quaternion): Quaternion {
  return new Quaternion(q.x, -q.y, -q.z, q.w);
}

function mirrorAxis(v: Vec3): Vec3 {
  return [v[0], -v[1], -v[2]];
}

interface Pending {
  gene: number;
  parentPart: number;
  /** Position before any mirroring is applied. */
  position: Vector3;
  /** Rotation before any mirroring is applied. */
  rotation: Quaternion;
  scale: number;
  /** How many times each gene node has been used along this path. */
  counts: number[];
  mirrored: boolean;
  joint: {
    gene: number;
    anchorParent: Vec3;
    anchorChild: Vec3;
    axis: Vec3;
    restAngle: number;
  } | null;
}

function scaledHalfExtents(size: Vec3, scale: number): Vec3 {
  return [
    Math.min(Math.max(size[0] * scale, MIN_PART_SIZE), MAX_PART_SIZE),
    Math.min(Math.max(size[1] * scale, MIN_PART_SIZE), MAX_PART_SIZE),
    Math.min(Math.max(size[2] * scale, MIN_PART_SIZE), MAX_PART_SIZE),
  ];
}

/**
 * Grow a genome into a body.
 *
 * Always succeeds for any genome that survived decoding: the part budget and
 * recursion limits bound the work, so there is no input that makes this hang or
 * produce something the physics engine cannot swallow.
 */
export function expand(genome: Genome): Skeleton {
  const parts: SkeletonPart[] = [];
  const joints: SkeletonJoint[] = [];

  const queue: Pending[] = [
    {
      gene: genome.root,
      parentPart: -1,
      position: new Vector3(0, 0, 0),
      rotation: new Quaternion(),
      scale: 1,
      counts: genome.parts.map((_, i) => (i === genome.root ? 1 : 0)),
      mirrored: false,
      joint: null,
    },
  ];

  while (queue.length > 0 && parts.length < MAX_PARTS) {
    const item = queue.shift()!;
    const gene = genome.parts[item.gene]!;
    const half = scaledHalfExtents(gene.size, item.scale);

    const position = item.mirrored ? mirrorPosition(item.position) : item.position;
    const rotation = item.mirrored ? mirrorRotation(item.rotation) : item.rotation;

    const partIndex = parts.length;
    parts.push({
      parent: item.parentPart,
      gene: item.gene,
      halfExtents: half,
      position: [position.x, position.y, position.z],
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      hue: gene.hue,
      mirrored: item.mirrored,
    });

    if (item.joint) {
      const j = item.joint;
      const edge = genome.edges[j.gene]!;
      joints.push({
        parentPart: item.parentPart,
        childPart: partIndex,
        gene: j.gene,
        anchorParent: item.mirrored ? [-j.anchorParent[0], j.anchorParent[1], j.anchorParent[2]] : j.anchorParent,
        anchorChild: item.mirrored ? [-j.anchorChild[0], j.anchorChild[1], j.anchorChild[2]] : j.anchorChild,
        axis: item.mirrored ? mirrorAxis(j.axis) : j.axis,
        restAngle: j.restAngle,
        limit: edge.joint.limit,
        frequency: edge.joint.frequency,
        amplitude: edge.joint.amplitude,
        phase: edge.joint.phase,
      });
    }

    // ------------------------------------------------------------- children
    const isRoot = item.parentPart === -1;

    for (let ei = 0; ei < genome.edges.length; ei++) {
      const edge = genome.edges[ei]!;
      if (edge.from !== item.gene) continue;

      const counts = item.counts.slice();
      counts[edge.to] = (counts[edge.to] ?? 0) + 1;
      const limit = genome.parts[edge.to]?.recursionLimit ?? 1;
      if (counts[edge.to]! > limit) continue;

      const axis = SWING_AXES[edge.joint.swing]!;
      const axisVec = new Vector3(axis[0], axis[1], axis[2]);

      // The child's rest orientation relative to its parent: a pure rotation
      // about the hinge axis, which is what keeps the joint consistent.
      const relative = new Quaternion().setFromAxisAngle(axisVec, edge.restAngle);

      // A limb grows along its own local +Y, so its growth direction in the
      // parent's frame is that axis carried through the rest rotation.
      const growth = new Vector3(0, 1, 0).applyQuaternion(relative);

      // The face the limb emerges from is *derived* from where it points, so a
      // limb can never grow into the middle of its own parent.
      let best = 0;
      let bestDot = -Infinity;
      for (let f = 0; f < FACES.length; f++) {
        const n = FACES[f]!.normal;
        const dot = n[0] * growth.x + n[1] * growth.y + n[2] * growth.z;
        if (dot > bestDot) {
          bestDot = dot;
          best = f;
        }
      }
      const face = FACES[best]!;

      // Attachment point on that face, in the parent's local frame.
      const attach: Vec3 = [0, 0, 0];
      attach[face.normalAxis] = face.normal[face.normalAxis]! * half[face.normalAxis];
      attach[face.uAxis] += edge.u * half[face.uAxis];
      attach[face.vAxis] += edge.v * half[face.vAxis];

      const childScale = item.scale * edge.scale;
      const childHalf = scaledHalfExtents(genome.parts[edge.to]!.size, childScale);

      // The child's near face meets the attachment point, so its centre sits
      // half its own length further along the growth direction.
      const centreLocal = new Vector3(attach[0], attach[1], attach[2]).addScaledVector(growth, childHalf[1]);

      const childPosition = centreLocal.clone().applyQuaternion(item.rotation).add(item.position);
      const childRotation = item.rotation.clone().multiply(relative);

      const pending: Omit<Pending, 'mirrored'> = {
        gene: edge.to,
        parentPart: partIndex,
        position: childPosition,
        rotation: childRotation,
        scale: childScale,
        counts,
        joint: {
          gene: ei,
          anchorParent: attach,
          anchorChild: [0, -childHalf[1], 0],
          axis,
          restAngle: edge.restAngle,
        },
      };

      // Reflection only means something across the body's own midline, so it is
      // honoured on limbs growing straight off the root and nowhere else.
      // A limb sitting exactly on the midline and pointing along it is its own
      // mirror image, so reflecting it would just stack two parts in one place.
      const distinctMirror =
        Math.abs(centreLocal.x) > 1e-3 || Math.abs(growth.x) > 1e-3;
      const wantsPair = edge.reflect && isRoot && distinctMirror;

      // Reserve slots so a pair is never cut in half by the part budget: half a
      // reflected pair is exactly the asymmetric result reflection exists to
      // avoid.
      const reserved = parts.length + queue.length;
      const needed = wantsPair ? 2 : 1;
      if (reserved + needed > MAX_PARTS) continue;

      queue.push({ ...pending, mirrored: item.mirrored });
      if (wantsPair) queue.push({ ...pending, mirrored: true });
    }
  }

  return { parts, joints, ...measure(parts) };
}

/** Lowest point and bounding radius of a grown body. */
function measure(parts: readonly SkeletonPart[]): { minY: number; radius: number } {
  if (parts.length === 0) return { minY: 0, radius: 1 };

  const q = new Quaternion();
  const corner = new Vector3();
  let minY = Infinity;
  let radius = 0;

  for (const part of parts) {
    q.set(part.rotation[0], part.rotation[1], part.rotation[2], part.rotation[3]);
    const [hx, hy, hz] = part.halfExtents;
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz)
        .applyQuaternion(q)
        .add(new Vector3(part.position[0], part.position[1], part.position[2]));
      if (corner.y < minY) minY = corner.y;
      radius = Math.max(radius, corner.length());
    }
  }

  return { minY, radius };
}
