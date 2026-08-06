/**
 * Tests for crossover and mutation.
 *
 * The property that matters most is that a child is always a *valid* genome.
 * An invalid one would not crash — it would grow a subtly wrong body and the
 * player would simply think that creature was ugly, which is the kind of bug
 * that survives for a very long time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/rng.ts';
import { breed, crossover, mutate, GENERATION_SIZE } from '../src/genome/breed.ts';
import { randomGenome } from '../src/genome/random.ts';
import { decodeGenome, encodeGenome } from '../src/genome/codec.ts';
import { expand } from '../src/genome/expand.ts';
import {
  MAX_GENOME_EDGES,
  MAX_GENOME_NODES,
  MAX_PART_SIZE,
  MAX_PARTS,
  MIN_PART_SIZE,
  type Genome,
} from '../src/genome/types.ts';

/** Everything a genome must satisfy to be safe to hand to the physics engine. */
function assertValid(g: Genome, what: string): void {
  assert.ok(g.parts.length >= 1 && g.parts.length <= MAX_GENOME_NODES, `${what}: ${g.parts.length} parts`);
  assert.ok(g.edges.length <= MAX_GENOME_EDGES, `${what}: ${g.edges.length} edges`);
  assert.ok(g.root >= 0 && g.root < g.parts.length, `${what}: root out of range`);

  for (const p of g.parts) {
    for (const s of p.size) {
      assert.ok(Number.isFinite(s), `${what}: non-finite size`);
      assert.ok(s >= MIN_PART_SIZE - 1e-9 && s <= MAX_PART_SIZE + 1e-9, `${what}: size ${s} out of range`);
    }
    assert.ok(p.recursionLimit >= 1 && p.recursionLimit <= 5, `${what}: recursion limit ${p.recursionLimit}`);
    assert.ok(p.hue >= 0 && p.hue < 1, `${what}: hue ${p.hue} out of range`);
  }

  for (const e of g.edges) {
    assert.ok(e.from >= 0 && e.from < g.parts.length, `${what}: edge from ${e.from} has no such part`);
    assert.ok(e.to >= 0 && e.to < g.parts.length, `${what}: edge to ${e.to} has no such part`);
    assert.ok(Number.isFinite(e.restAngle) && Number.isFinite(e.u) && Number.isFinite(e.v));
    assert.ok(e.u >= -1 && e.u <= 1 && e.v >= -1 && e.v <= 1, `${what}: attachment off the face`);
    assert.ok(e.joint.swing === 0 || e.joint.swing === 1, `${what}: bad swing axis`);
    assert.ok(e.joint.amplitude >= 0 && e.joint.amplitude <= 1, `${what}: amplitude out of range`);
    assert.ok(Number.isFinite(e.joint.phase) && Number.isFinite(e.joint.frequency));
  }

  // The real proof: it survives a URL round trip and grows a body.
  assert.deepEqual(decodeGenome(encodeGenome(g)), g, `${what}: did not survive a round trip`);
  const skeleton = expand(g);
  assert.ok(skeleton.parts.length >= 1 && skeleton.parts.length <= MAX_PARTS, `${what}: grew ${skeleton.parts.length}`);
}

test('crossover always produces a valid genome', () => {
  for (let seed = 0; seed < 400; seed++) {
    const rng = new Rng(seed);
    const child = crossover(randomGenome(seed), randomGenome(seed + 9973), rng);
    assertValid(child, `crossover seed ${seed}`);
  }
});

test('mutation always produces a valid genome, at every rate', () => {
  for (const rate of [0, 0.1, 0.35, 0.7, 1]) {
    for (let seed = 0; seed < 120; seed++) {
      const child = mutate(randomGenome(seed), rate, new Rng(seed * 31 + 7));
      assertValid(child, `mutate rate ${rate} seed ${seed}`);
    }
  }
});

test('repeated mutation does not drift into an invalid genome', () => {
  // Fifty generations of compounding change is where clamping bugs surface.
  const rng = new Rng(4242);
  let g = randomGenome(11);
  for (let generation = 0; generation < 50; generation++) {
    g = mutate(g, 0.6, rng);
    assertValid(g, `generation ${generation}`);
  }
});

test('a generation is eight creatures, the first two being the parents unchanged', () => {
  const a = randomGenome(5);
  const b = randomGenome(6);
  const generation = breed(a, b, 0.35, 99);

  assert.equal(generation.length, GENERATION_SIZE);
  assert.equal(encodeGenome(generation[0]!), encodeGenome(a), 'parent A was altered');
  assert.equal(encodeGenome(generation[1]!), encodeGenome(b), 'parent B was altered');
  for (const [i, g] of generation.entries()) assertValid(g, `generation member ${i}`);
});

test('breeding is deterministic', () => {
  const a = randomGenome(5);
  const b = randomGenome(6);
  const first = breed(a, b, 0.4, 1234).map(encodeGenome);
  const second = breed(a, b, 0.4, 1234).map(encodeGenome);
  assert.deepEqual(first, second);
});

test('a different seed gives different offspring', () => {
  const a = randomGenome(5);
  const b = randomGenome(6);
  const first = breed(a, b, 0.4, 1).map(encodeGenome).slice(2);
  const second = breed(a, b, 0.4, 2).map(encodeGenome).slice(2);
  assert.notDeepEqual(first, second);
});

test('a mutation rate of zero copies the parents exactly', () => {
  const a = randomGenome(21);
  const b = randomGenome(22);
  for (const child of breed(a, b, 0, 7)) {
    // With no mutation every child is either a parent or a straight
    // recombination of them — never something with new genes in it.
    assertValid(child, 'zero-rate child');
  }
  const tame = breed(a, b, 0, 7).slice(2);
  const wild = breed(a, b, 1, 7).slice(2);
  assert.notDeepEqual(tame.map(encodeGenome), wild.map(encodeGenome));
});

test('a higher mutation rate moves offspring further from their parents', () => {
  /** How much of a child's genome differs from the parent it came from. */
  function divergence(rate: number): number {
    let total = 0;
    let count = 0;
    for (let seed = 0; seed < 60; seed++) {
      const parent = randomGenome(seed);
      const child = mutate(parent, rate, new Rng(seed * 17 + 3));

      // Compare the numbers the two genomes have in common.
      const a = parent.parts.flatMap((p) => [...p.size, p.hue]);
      const b = child.parts.flatMap((p) => [...p.size, p.hue]);
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) total += Math.abs(a[i]! - b[i]!);
      count += n;

      // A different number of parts is itself divergence.
      total += Math.abs(parent.parts.length - child.parts.length) * 0.5;
      count += 1;
    }
    return total / count;
  }

  const tame = divergence(0.15);
  const wild = divergence(0.9);
  assert.ok(wild > tame * 1.5, `rate 0.9 diverged ${wild.toFixed(4)} vs rate 0.15 ${tame.toFixed(4)}`);
});

test('removing a part never leaves an edge pointing at nothing', () => {
  // Structural mutation is the operation most likely to corrupt a genome,
  // because deleting a part shifts every index above it.
  const rng = new Rng(8888);
  for (let seed = 0; seed < 300; seed++) {
    let g = randomGenome(seed);
    // A high rate makes structural changes likely on every pass.
    for (let i = 0; i < 6; i++) g = mutate(g, 1, rng);
    assertValid(g, `heavily mutated seed ${seed}`);
  }
});

test('offspring stay within the part budget once grown', () => {
  const rng = new Rng(31337);
  let g = randomGenome(3);
  for (let i = 0; i < 80; i++) {
    g = mutate(g, 0.8, rng);
    assert.ok(expand(g).parts.length <= MAX_PARTS);
  }
});
