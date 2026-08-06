/**
 * Tests for the two properties the whole project rests on:
 *   1. The same seed always yields the same genome.
 *   2. A genome survives the trip through a URL unchanged.
 *
 * If either breaks, sharing a creature silently gives someone a different
 * creature, which is the kind of bug that is very hard to notice by eye.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/rng.ts';
import { decodeGenome, encodeGenome, genomesEqual, quantize } from '../src/genome/codec.ts';
import { randomGenome, randomPopulation } from '../src/genome/random.ts';
import { MAX_GENOME_EDGES, MAX_GENOME_NODES } from '../src/genome/types.ts';

test('rng is deterministic for a given seed', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('rng produces different streams for different seeds', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  assert.notEqual(a.next(), b.next());
});

test('rng stays within its advertised ranges', () => {
  const rng = new Rng(99);
  for (let i = 0; i < 2000; i++) {
    const n = rng.next();
    assert.ok(n >= 0 && n < 1, `next() returned ${n}`);
    const r = rng.range(-3, 7);
    assert.ok(r >= -3 && r < 7, `range() returned ${r}`);
    const k = rng.intBetween(2, 5);
    assert.ok(k >= 2 && k <= 5 && Number.isInteger(k), `intBetween() returned ${k}`);
  }
});

test('the same seed always produces the same genome', () => {
  for (const seed of [0, 1, 7, 4242, 0xdeadbeef]) {
    assert.equal(encodeGenome(randomGenome(seed)), encodeGenome(randomGenome(seed)));
  }
});

test('different seeds produce different genomes', () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 200; seed++) seen.add(encodeGenome(randomGenome(seed)));
  // Collisions are conceivable but 200 identical genomes would mean the seed is
  // being ignored entirely.
  assert.ok(seen.size > 190, `only ${seen.size} distinct genomes from 200 seeds`);
});

test('genomes survive a round trip through base64url', () => {
  for (let seed = 0; seed < 300; seed++) {
    const original = randomGenome(seed);
    const restored = decodeGenome(encodeGenome(original));
    assert.deepEqual(restored, original, `seed ${seed} did not survive the round trip`);
    assert.ok(genomesEqual(original, restored));
  }
});

test('encoded genomes are URL-safe and comfortably short', () => {
  let longest = 0;
  for (let seed = 0; seed < 300; seed++) {
    const text = encodeGenome(randomGenome(seed));
    assert.match(text, /^[A-Za-z0-9\-_]+$/, 'encoding contains characters that need escaping');
    assert.equal(encodeURIComponent(text), text, 'encoding changes when put in a URL');
    longest = Math.max(longest, text.length);
  }
  // Browsers and chat apps handle a few thousand characters; staying well under
  // keeps shared links pasteable.
  assert.ok(longest < 1500, `longest encoding was ${longest} characters`);
});

test('quantize is idempotent', () => {
  const g = randomGenome(31337);
  assert.deepEqual(quantize(quantize(g)), quantize(g));
});

test('random genomes respect the graph size caps', () => {
  for (let seed = 0; seed < 500; seed++) {
    const g = randomGenome(seed);
    assert.ok(g.parts.length >= 1 && g.parts.length <= MAX_GENOME_NODES, `seed ${seed}: ${g.parts.length} parts`);
    assert.ok(g.edges.length <= MAX_GENOME_EDGES, `seed ${seed}: ${g.edges.length} edges`);
    for (const e of g.edges) {
      assert.ok(e.from >= 0 && e.from < g.parts.length);
      assert.ok(e.to >= 0 && e.to < g.parts.length);
    }
  }
});

test('most random creatures are bilaterally symmetric', () => {
  let symmetric = 0;
  for (let seed = 0; seed < 400; seed++) {
    if (randomGenome(seed).edges.some((e) => e.reflect)) symmetric++;
  }
  assert.ok(symmetric / 400 > 0.9, `only ${symmetric}/400 creatures had a reflected limb`);
});

test('self-edges never reflect', () => {
  for (let seed = 0; seed < 500; seed++) {
    for (const e of randomGenome(seed).edges) {
      if (e.from === e.to) assert.equal(e.reflect, false, `seed ${seed} has a reflecting self-edge`);
    }
  }
});

test('a population is deterministic and varied', () => {
  const a = randomPopulation(7, 8).map(encodeGenome);
  const b = randomPopulation(7, 8).map(encodeGenome);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 8, 'a population contained duplicates');
});

// ------------------------------------------------------------ hostile input
// Anything decoded came from a link, so it is untrusted and must fail loudly
// rather than reach the physics engine half-built.

test('malformed encodings are rejected', () => {
  const bad = [
    '',
    'not base64!!',
    'A',                       // truncated: length % 4 === 1
    encodeGenome(randomGenome(1)) + 'A',
    btoa('null').replace(/=+$/, ''),
    btoa('{"v":2}').replace(/=+$/, ''),
    btoa('{"v":1}').replace(/=+$/, ''),
    btoa('{"v":1,"s":0,"r":0,"p":[],"e":[]}').replace(/=+$/, ''),
  ];
  for (const text of bad) {
    assert.throws(() => decodeGenome(text), `expected "${text.slice(0, 24)}" to be rejected`);
  }
});

test('a genome referring to a part that does not exist is rejected', () => {
  const g = randomGenome(5);
  const json = JSON.stringify({
    v: 1, s: 0, r: 0,
    p: [[0.3, 0.2, 0.4, 1, 0.5]],
    // edge points at part 9, which is not there
    e: [[0, 9, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.5, 1, 0.5, 0]],
  });
  assert.throws(() => decodeGenome(btoa(json).replace(/=+$/, '')));
  assert.ok(g.parts.length > 0);
});

test('an absurdly large genome is rejected rather than simulated', () => {
  const parts = Array.from({ length: 400 }, () => [0.2, 0.2, 0.2, 5, 0.5]);
  const json = JSON.stringify({ v: 1, s: 0, r: 0, p: parts, e: [] });
  assert.throws(() => decodeGenome(btoa(json).replace(/=+$/, '')));
});

test('non-finite numbers are rejected', () => {
  // JSON cannot hold Infinity, but it can hold a string where a number belongs.
  const json = '{"v":1,"s":0,"r":0,"p":[["x",0.2,0.4,1,0.5]],"e":[]}';
  assert.throws(() => decodeGenome(btoa(json).replace(/=+$/, '')));
});
