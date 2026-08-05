/**
 * Tests for growing a body from a genome.
 *
 * Reflection is the thing worth testing hardest. It is easy to write code that
 * puts the mirrored limb in the right *place* while bending it the wrong way,
 * and that mistake is nearly invisible on screen until you notice the creature
 * paddles with one side and claws with the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';

import { expand } from '../src/genome/expand.ts';
import { randomGenome } from '../src/genome/random.ts';
import { decodeGenome, encodeGenome } from '../src/genome/codec.ts';
import { MAX_PARTS, SWING_AXES } from '../src/genome/types.ts';

const SEEDS = Array.from({ length: 300 }, (_, i) => i);

test('every random genome grows a body within the part budget', () => {
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    assert.ok(s.parts.length >= 1, `seed ${seed} grew nothing`);
    assert.ok(s.parts.length <= MAX_PARTS, `seed ${seed} grew ${s.parts.length} parts`);
  }
});

test('growth is deterministic', () => {
  for (const seed of [0, 3, 77, 4242]) {
    assert.deepEqual(expand(randomGenome(seed)), expand(randomGenome(seed)));
  }
});

test('a genome that went through a URL grows the identical body', () => {
  for (const seed of SEEDS) {
    const original = randomGenome(seed);
    const restored = decodeGenome(encodeGenome(original));
    assert.deepEqual(expand(restored), expand(original), `seed ${seed} grew differently after a round trip`);
  }
});

test('every part except the root has a joint to its parent', () => {
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    const jointed = new Set(s.joints.map((j) => j.childPart));
    for (let i = 0; i < s.parts.length; i++) {
      const part = s.parts[i]!;
      if (part.parent === -1) {
        assert.equal(i, 0, `seed ${seed}: a non-root part had no parent`);
      } else {
        assert.ok(jointed.has(i), `seed ${seed}: part ${i} has a parent but no joint`);
        assert.ok(part.parent < i, `seed ${seed}: part ${i} references a parent built after it`);
      }
    }
    assert.equal(s.joints.length, s.parts.length - 1, `seed ${seed}: joint count does not match part count`);
  }
});

test('all geometry is finite', () => {
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    for (const p of s.parts) {
      for (const n of [...p.position, ...p.rotation, ...p.halfExtents]) {
        assert.ok(Number.isFinite(n), `seed ${seed} produced a non-finite number`);
      }
      // A quaternion that is not unit-length would silently skew every part
      // hanging off it.
      const len = Math.hypot(...p.rotation);
      assert.ok(Math.abs(len - 1) < 1e-6, `seed ${seed}: rotation is not a unit quaternion (${len})`);
    }
    assert.ok(Number.isFinite(s.minY) && Number.isFinite(s.radius));
  }
});

test('parts never grow into the middle of their parent', () => {
  // The child's near face should sit on the parent's surface, so the distance
  // between their centres must be at least roughly the child's own half-length.
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    for (const j of s.joints) {
      const parent = s.parts[j.parentPart]!;
      const child = s.parts[j.childPart]!;
      const gap = new Vector3(...child.position).sub(new Vector3(...parent.position)).length();
      assert.ok(gap > child.halfExtents[1] * 0.5, `seed ${seed}: a part is buried inside its parent`);
    }
  }
});

// ------------------------------------------------------------------ symmetry

/** Pair up parts that are mirror copies of one another. */
function mirrorPairs(skeleton: ReturnType<typeof expand>) {
  const originals = skeleton.parts.filter((p) => !p.mirrored);
  const mirrored = skeleton.parts.filter((p) => p.mirrored);
  return { originals, mirrored };
}

test('reflected creatures are bilaterally symmetric in position', () => {
  let checked = 0;
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    const { mirrored } = mirrorPairs(s);
    if (mirrored.length === 0) continue;

    for (const m of mirrored) {
      // Every mirrored part must have a twin at the reflected position.
      const twin = s.parts.find(
        (p) =>
          !p.mirrored &&
          Math.abs(p.position[0] + m.position[0]) < 1e-6 &&
          Math.abs(p.position[1] - m.position[1]) < 1e-6 &&
          Math.abs(p.position[2] - m.position[2]) < 1e-6,
      );
      assert.ok(twin, `seed ${seed}: a mirrored part has no twin at the reflected position`);
      assert.deepEqual(twin!.halfExtents, m.halfExtents, `seed ${seed}: a mirrored twin is a different size`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} mirrored parts were checked`);
});

test('a mirrored limb bends the mirrored way, not merely sits in the mirrored place', () => {
  // The real test of reflection. Take each mirrored joint, swing it by some
  // angle, and confirm the tip of the limb ends up exactly where the original
  // limb's tip would be if you flipped it across the midline. Position-only
  // mirroring passes the previous test and fails this one.
  let checked = 0;

  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));

    for (const mj of s.joints) {
      const mChild = s.parts[mj.childPart]!;
      if (!mChild.mirrored) continue;

      // Find the corresponding joint on the unmirrored side.
      const oj = s.joints.find((j) => {
        const c = s.parts[j.childPart]!;
        return (
          !c.mirrored &&
          j.gene === mj.gene &&
          Math.abs(c.position[0] + mChild.position[0]) < 1e-6 &&
          Math.abs(c.position[1] - mChild.position[1]) < 1e-6 &&
          Math.abs(c.position[2] - mChild.position[2]) < 1e-6
        );
      });
      if (!oj) continue;

      const oChild = s.parts[oj.childPart]!;
      const angle = 0.37; // arbitrary, just needs to be non-zero

      // Where the far tip of each limb goes after swinging by the same angle.
      const tipOf = (part: typeof oChild, joint: typeof oj) => {
        const parent = s.parts[joint.parentPart]!;
        const parentRot = new Quaternion(...parent.rotation);
        const swing = new Quaternion().setFromAxisAngle(new Vector3(...joint.axis), angle);
        // Rotate the child about the hinge, which lives in the parent's frame.
        const rotated = parentRot.clone().multiply(swing).multiply(parentRot.clone().invert());
        const pivot = new Vector3(...joint.anchorParent).applyQuaternion(parentRot).add(new Vector3(...parent.position));
        const tip = new Vector3(0, part.halfExtents[1], 0)
          .applyQuaternion(new Quaternion(...part.rotation))
          .add(new Vector3(...part.position))
          .sub(pivot)
          .applyQuaternion(rotated)
          .add(pivot);
        return tip;
      };

      const originalTip = tipOf(oChild, oj);
      const mirroredTip = tipOf(mChild, mj);

      assert.ok(
        Math.abs(originalTip.x + mirroredTip.x) < 1e-5 &&
          Math.abs(originalTip.y - mirroredTip.y) < 1e-5 &&
          Math.abs(originalTip.z - mirroredTip.z) < 1e-5,
        `seed ${seed}: mirrored limb swings to (${mirroredTip.toArray()}), expected the mirror of (${originalTip.toArray()})`,
      );
      checked++;
    }
  }

  assert.ok(checked > 80, `only ${checked} mirrored joints were checked`);
});

test('a hinge axis is the same vector in both bodies it connects', () => {
  // Rapier is given one axis for both frames, which is only valid because a
  // child's rest orientation is a pure rotation about that axis. If this ever
  // stops holding, every joint starts life violating its own constraint.
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    for (const j of s.joints) {
      const parent = new Quaternion(...s.parts[j.parentPart]!.rotation);
      const child = new Quaternion(...s.parts[j.childPart]!.rotation);
      const axis = new Vector3(...j.axis);

      const worldFromParent = axis.clone().applyQuaternion(parent);
      const worldFromChild = axis.clone().applyQuaternion(child);
      assert.ok(
        worldFromParent.distanceTo(worldFromChild) < 1e-5,
        `seed ${seed}: hinge axis disagrees between the two bodies it joins`,
      );
    }
  }
});

test('hinge axes are only ever the two supported swing axes', () => {
  const allowed = SWING_AXES.map((a) => a.join(',')).concat(SWING_AXES.map((a) => [a[0], -a[1], -a[2]].join(',')));
  for (const seed of SEEDS) {
    for (const j of expand(randomGenome(seed)).joints) {
      // -0 and 0 print differently; normalise before comparing.
      const key = j.axis.map((n) => n + 0).join(',');
      assert.ok(allowed.includes(key), `seed ${seed}: unexpected hinge axis ${key}`);
    }
  }
});

test('measurements bound the body', () => {
  for (const seed of SEEDS) {
    const s = expand(randomGenome(seed));
    for (const p of s.parts) {
      const centre = new Vector3(...p.position);
      assert.ok(centre.length() <= s.radius + 1e-6, `seed ${seed}: a part sits outside the reported radius`);
      assert.ok(p.position[1] >= s.minY - 1e-6, `seed ${seed}: a part sits below the reported minimum`);
    }
    assert.ok(s.radius > 0, `seed ${seed}: zero radius`);
  }
});
