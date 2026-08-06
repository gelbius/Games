/**
 * Who is winning, right now.
 *
 * Purely a readout. Nothing here feeds back into the game — the leader gets no
 * advantage and no automatic place in the next generation, because the player
 * is still the only selection pressure. It exists so you can see the race
 * without reading eight numbers.
 *
 * The whole difficulty is that naive "sort by distance every frame" flickers.
 * Two creatures a centimetre apart swap places several times a second as they
 * wobble, and a badge that strobes between panels is worse than no badge. So a
 * challenger has to *beat* the current holder by a margin to take the position,
 * not merely edge ahead of it.
 */

/** How far ahead a challenger must get before it takes a place, in metres. */
const MARGIN = 0.04;

/**
 * Until someone has actually gone somewhere, there is no race to rank. At the
 * start every creature has travelled exactly zero and the ordering would be
 * meaningless.
 */
const MINIMUM_TO_RANK = 0.05;

export interface Standing {
  lane: number;
  distance: number;
}

export class Ranking {
  /** Lane indices of the leader and runner-up, or undefined while unsettled. */
  private first?: number;
  private second?: number;

  /** Recompute from the current distances. Safe to call every frame. */
  update(distances: readonly number[]): void {
    const field: Standing[] = distances
      .map((distance, lane) => ({ lane, distance }))
      .sort((a, b) => b.distance - a.distance);

    if ((field[0]?.distance ?? 0) < MINIMUM_TO_RANK) {
      this.first = undefined;
      this.second = undefined;
      return;
    }

    this.first = hold(field, this.first);
    this.second = hold(
      field.filter((s) => s.lane !== this.first),
      this.second === this.first ? undefined : this.second,
    );
  }

  /** 1 for the leader, 2 for the runner-up, 0 for everyone else. */
  placeOf(lane: number): 0 | 1 | 2 {
    if (lane === this.first) return 1;
    if (lane === this.second) return 2;
    return 0;
  }

  reset(): void {
    this.first = undefined;
    this.second = undefined;
  }
}

/**
 * Keep the incumbent unless the front-runner has pulled clearly ahead of it.
 */
function hold(field: readonly Standing[], incumbent: number | undefined): number | undefined {
  const leader = field[0];
  if (!leader) return undefined;
  if (incumbent === undefined) return leader.lane;

  const held = field.find((s) => s.lane === incumbent);
  if (!held) return leader.lane;

  return leader.distance > held.distance + MARGIN ? leader.lane : incumbent;
}

/** Words for a place. Deliberately not "fastest" — this is distance, not speed. */
export function placeLabel(place: 0 | 1 | 2): string {
  return place === 1 ? '1st' : place === 2 ? '2nd' : '';
}
