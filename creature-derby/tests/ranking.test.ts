/**
 * Tests for the live placings.
 *
 * The interesting property is not "the furthest creature is first" — that is
 * a sort. It is that the badge does not strobe. Two creatures a centimetre
 * apart trade places several times a second as they wobble, and a badge
 * flickering between panels is worse than no badge at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeLabel, Ranking } from '../src/ui/ranking.ts';

test('nothing is ranked until someone has actually moved', () => {
  const ranking = new Ranking();
  ranking.update([0, 0, 0, 0, 0, 0, 0, 0]);
  for (let lane = 0; lane < 8; lane++) assert.equal(ranking.placeOf(lane), 0);

  // Still nothing at a twitch of movement.
  ranking.update([0.01, 0.02, 0, 0, 0, 0, 0, 0]);
  for (let lane = 0; lane < 8; lane++) assert.equal(ranking.placeOf(lane), 0);
});

test('the two furthest are first and second', () => {
  const ranking = new Ranking();
  ranking.update([0.3, 2.0, 0.1, 1.4, 0, 0, 0, 0]);
  assert.equal(ranking.placeOf(1), 1);
  assert.equal(ranking.placeOf(3), 2);
  assert.equal(ranking.placeOf(0), 0);
});

test('first and second are never the same creature', () => {
  const ranking = new Ranking();
  ranking.update([1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]);
  const places = Array.from({ length: 8 }, (_, lane) => ranking.placeOf(lane));
  assert.equal(places.filter((p) => p === 1).length, 1);
  assert.equal(places.filter((p) => p === 2).length, 1);
});

test('a creature edging ahead does not steal the lead', () => {
  const ranking = new Ranking();
  ranking.update([1.0, 0.5, 0, 0, 0, 0, 0, 0]);
  assert.equal(ranking.placeOf(0), 1);

  // Lane 1 pulls level and a hair past. Not enough.
  ranking.update([1.0, 1.005, 0, 0, 0, 0, 0, 0]);
  assert.equal(ranking.placeOf(0), 1, 'the lead changed hands on a 5mm difference');
  assert.equal(ranking.placeOf(1), 2);
});

test('a creature clearly ahead does take the lead', () => {
  const ranking = new Ranking();
  ranking.update([1.0, 0.5, 0, 0, 0, 0, 0, 0]);
  ranking.update([1.0, 1.4, 0, 0, 0, 0, 0, 0]);
  assert.equal(ranking.placeOf(1), 1);
  assert.equal(ranking.placeOf(0), 2);
});

test('the badge does not strobe when two creatures run neck and neck', () => {
  // The case this whole class exists for. Two creatures wobble around each
  // other for the length of a race; count how often the leader changes.
  const ranking = new Ranking();
  let leader = -1;
  let changes = 0;

  for (let step = 0; step < 900; step++) {
    const t = step / 60;
    // Both advance steadily, jittering about each other by a centimetre or two.
    const a = t * 0.1 + Math.sin(t * 9) * 0.015;
    const b = t * 0.1 + Math.cos(t * 11) * 0.015;
    ranking.update([a, b, 0, 0, 0, 0, 0, 0]);

    const now = ranking.placeOf(0) === 1 ? 0 : 1;
    if (now !== leader) {
      changes++;
      leader = now;
    }
  }

  // Sorting naively would hand the lead back and forth dozens of times.
  assert.ok(changes <= 2, `the lead changed ${changes} times in a 15-second race`);
});

test('a real overtake is still shown', () => {
  // Hysteresis must not mean the badge gets stuck. One creature genuinely
  // passes another and the badge has to follow.
  const ranking = new Ranking();
  let sawOvertake = false;

  for (let step = 0; step < 900; step++) {
    const t = step / 60;
    const slow = t * 0.05;
    const fast = t * 0.2;
    ranking.update([slow, fast, 0, 0, 0, 0, 0, 0]);
    if (ranking.placeOf(1) === 1) sawOvertake = true;
  }

  assert.ok(sawOvertake, 'a creature moving four times faster never took the lead');
});

test('reset clears the placings', () => {
  const ranking = new Ranking();
  ranking.update([1, 2, 0, 0, 0, 0, 0, 0]);
  assert.notEqual(ranking.placeOf(1), 0);
  ranking.reset();
  assert.equal(ranking.placeOf(1), 0);
  assert.equal(ranking.placeOf(0), 0);
});

test('places read as words', () => {
  assert.equal(placeLabel(1), '1st');
  assert.equal(placeLabel(2), '2nd');
  assert.equal(placeLabel(0), '');
});
