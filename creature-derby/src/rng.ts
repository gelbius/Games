/**
 * Seeded pseudorandom number generator.
 *
 * Math.random() cannot be seeded, so it is unusable here: the same genome must
 * produce the same creature and the same race every time, on every machine, or
 * sharing a creature by URL would be meaningless.
 *
 * This is mulberry32 — small, fast, and good enough for shuffling body plans.
 * It is not cryptographically secure and must never be used for anything that
 * needs to be unguessable.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to a 32-bit unsigned integer. Fractional or negative seeds would
    // otherwise silently produce a different stream than the same seed rounded.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [min, max] inclusive. */
  intBetween(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** A uniformly chosen element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(items.length)]!;
  }

  /**
   * Approximately standard-normal, via the sum of 3 uniforms.
   * Used for mutation, where most changes should be small and large ones rare.
   */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  /** A fresh seed drawn from this stream, for spawning child generators. */
  nextSeed(): number {
    return (this.next() * 4294967296) >>> 0;
  }
}

/** A seed from the clock, for when the player wants a genuinely new creature. */
export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
