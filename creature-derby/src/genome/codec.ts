/**
 * Turning a genome into a string and back.
 *
 * This is deliberately built before anything visual, because it decides what
 * the rest of the project can do. A genome that fits in a URL means saving,
 * sharing, bookmarking, and later asynchronous multiplayer all come for free
 * and need no server, no database, and no accounts. Retrofitting that later
 * would have meant rewriting the genome.
 *
 * The wire format is a compact array-of-arrays, not the readable object form:
 * key names would triple the length of every URL for no benefit.
 *
 *   genome  ->  compact JSON  ->  UTF-8 bytes  ->  base64url  ->  URL hash
 *
 * Everything decoded here is untrusted — it arrives from a link someone was
 * sent. Decoding therefore validates hard and throws on anything malformed,
 * rather than handing a half-built genome to the physics engine.
 */

import {
  type EdgeGene,
  type Face,
  type Genome,
  type JointGene,
  type PartGene,
  type Vec3,
  MAX_GENOME_EDGES,
  MAX_GENOME_NODES,
} from './types.ts';

/** Decimal places kept when a genome is written down. */
const PRECISION = 4;

/**
 * Round to the stored precision.
 *
 * Every genome is quantised the moment it is created or mutated, so the value
 * held in memory is always exactly the value that would be written to a URL.
 * Without this, decode(encode(g)) would differ from g in the last decimal place
 * and a shared creature would race very slightly differently from the original
 * — which, over 15 seconds of chaotic physics, becomes a visibly different run.
 */
function q(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`genome contains a non-finite number: ${n}`);
  const f = 10 ** PRECISION;
  // +0 avoids a stored "-0", which survives JSON and breaks equality checks.
  return Math.round(n * f) / f + 0;
}

function qVec(v: Vec3): Vec3 {
  return [q(v[0]), q(v[1]), q(v[2])];
}

/** Return a copy of the genome with every number at canonical precision. */
export function quantize(g: Genome): Genome {
  return {
    version: 1,
    seed: g.seed >>> 0,
    root: g.root | 0,
    parts: g.parts.map(
      (p): PartGene => ({
        size: qVec(p.size),
        recursionLimit: p.recursionLimit | 0,
        hue: q(p.hue),
      }),
    ),
    edges: g.edges.map(
      (e): EdgeGene => ({
        from: e.from | 0,
        to: e.to | 0,
        face: e.face,
        u: q(e.u),
        v: q(e.v),
        twist: qVec(e.twist),
        scale: q(e.scale),
        reflect: !!e.reflect,
        joint: {
          axis: e.joint.axis,
          limit: q(e.joint.limit),
          frequency: q(e.joint.frequency),
          amplitude: q(e.joint.amplitude),
          phase: q(e.joint.phase),
        },
      }),
    ),
  };
}

// --------------------------------------------------------------- compact form

type CompactPart = [number, number, number, number, number];
type CompactEdge = [
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
];

interface CompactGenome {
  v: 1;
  s: number;
  r: number;
  p: CompactPart[];
  e: CompactEdge[];
}

function toCompact(g: Genome): CompactGenome {
  const c = quantize(g);
  return {
    v: 1,
    s: c.seed,
    r: c.root,
    p: c.parts.map((p): CompactPart => [p.size[0], p.size[1], p.size[2], p.recursionLimit, p.hue]),
    e: c.edges.map((e): CompactEdge => [
      e.from, e.to, e.face, e.u, e.v,
      e.twist[0], e.twist[1], e.twist[2], e.scale, e.reflect ? 1 : 0,
      e.joint.axis, e.joint.limit, e.joint.frequency, e.joint.amplitude, e.joint.phase,
    ]),
  };
}

// ---------------------------------------------------------------- validation

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${what} is not a finite number`);
  }
  return value;
}

function intIn(value: unknown, min: number, max: number, what: string): number {
  const n = num(value, what);
  const i = Math.round(n);
  if (i < min || i > max) throw new RangeError(`${what} out of range: ${i}`);
  return i;
}

function fromCompact(c: unknown): Genome {
  if (typeof c !== 'object' || c === null) throw new TypeError('genome is not an object');
  const o = c as Record<string, unknown>;

  if (o.v !== 1) throw new TypeError(`unsupported genome version: ${String(o.v)}`);
  if (!Array.isArray(o.p) || !Array.isArray(o.e)) throw new TypeError('genome is missing parts or edges');
  if (o.p.length < 1 || o.p.length > MAX_GENOME_NODES) {
    throw new RangeError(`genome has ${o.p.length} parts, expected 1..${MAX_GENOME_NODES}`);
  }
  if (o.e.length > MAX_GENOME_EDGES) {
    throw new RangeError(`genome has ${o.e.length} edges, expected at most ${MAX_GENOME_EDGES}`);
  }

  const partCount = o.p.length;

  const parts = o.p.map((raw, i): PartGene => {
    if (!Array.isArray(raw) || raw.length !== 5) throw new TypeError(`part ${i} is malformed`);
    return {
      size: [num(raw[0], `part ${i} size x`), num(raw[1], `part ${i} size y`), num(raw[2], `part ${i} size z`)],
      recursionLimit: intIn(raw[3], 1, 5, `part ${i} recursion limit`),
      hue: num(raw[4], `part ${i} hue`),
    };
  });

  const edges = o.e.map((raw, i): EdgeGene => {
    if (!Array.isArray(raw) || raw.length !== 15) throw new TypeError(`edge ${i} is malformed`);
    const joint: JointGene = {
      axis: intIn(raw[10], 0, 2, `edge ${i} joint axis`) as 0 | 1 | 2,
      limit: num(raw[11], `edge ${i} joint limit`),
      frequency: num(raw[12], `edge ${i} frequency`),
      amplitude: num(raw[13], `edge ${i} amplitude`),
      phase: num(raw[14], `edge ${i} phase`),
    };
    return {
      from: intIn(raw[0], 0, partCount - 1, `edge ${i} from`),
      to: intIn(raw[1], 0, partCount - 1, `edge ${i} to`),
      face: intIn(raw[2], 0, 5, `edge ${i} face`) as Face,
      u: num(raw[3], `edge ${i} u`),
      v: num(raw[4], `edge ${i} v`),
      twist: [
        num(raw[5], `edge ${i} twist x`),
        num(raw[6], `edge ${i} twist y`),
        num(raw[7], `edge ${i} twist z`),
      ],
      scale: num(raw[8], `edge ${i} scale`),
      reflect: raw[9] === 1 || raw[9] === true,
      joint,
    };
  });

  return quantize({
    version: 1,
    seed: intIn(o.s, 0, 0xffffffff, 'seed') >>> 0,
    root: intIn(o.r, 0, partCount - 1, 'root'),
    parts,
    edges,
  });
}

// ------------------------------------------------------------------- base64url

/**
 * base64url is plain base64 with two characters swapped and the padding dropped,
 * so the result is safe to drop straight into a URL without escaping.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked because String.fromCharCode(...hugeArray) overflows the call stack.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9\-_]*$/.test(text)) throw new TypeError('not a base64url string');

  // Restore the '=' padding that base64url drops. A base64 string's length mod
  // 4 is 0, 2, or 3; a remainder of 1 cannot be produced by any input and means
  // the string was truncated.
  const remainder = text.length % 4;
  if (remainder === 1) throw new TypeError('truncated base64url string');
  const padding = remainder === 2 ? '==' : remainder === 3 ? '=' : '';

  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Genome -> base64url string, suitable for a URL hash. */
export function encodeGenome(g: Genome): string {
  const json = JSON.stringify(toCompact(g));
  return bytesToBase64Url(new TextEncoder().encode(json));
}

/** base64url string -> genome. Throws if the string is not a valid genome. */
export function decodeGenome(text: string): Genome {
  const json = new TextDecoder().decode(base64UrlToBytes(text));
  return fromCompact(JSON.parse(json) as unknown);
}

/** True when two genomes are byte-identical once written down. */
export function genomesEqual(a: Genome, b: Genome): boolean {
  return encodeGenome(a) === encodeGenome(b);
}
