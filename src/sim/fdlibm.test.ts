import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cos, exp, log, log2, pow } from './fdlibm';
import { Rng } from './random';

/**
 * The engine's math has to give the bits Node gives on x86-64, on every CPU
 * and in every engine, or a replay link shows a different run on a Mac or in
 * Safari. Math.* on the machine running these tests is not a reference: on
 * Apple silicon it is the thing being fixed. The expected bits here come from
 * V8's own src/base/ieee754.cc, compiled with -ffp-contract=off so that no
 * multiply-add is fused, which is the arithmetic an x86-64 build does.
 */

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

function bits(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  F64[0] = x;
  return U64[0].toString(16).padStart(16, '0');
}

function fromBits(b: bigint): number {
  U64[0] = b;
  return F64[0];
}

/** Exactly 2^n, built from its bit pattern rather than computed. */
function twoTo(n: number): number {
  return n >= -1022
    ? fromBits(BigInt(n + 1023) << 52n)
    : fromBits(1n << BigInt(n + 1074));
}

type Fn = 'log' | 'log2' | 'exp' | 'cos' | 'pow';
const PORT: Record<Fn, (x: number, y: number) => number> = {
  log: (x) => log(x),
  log2: (x) => log2(x),
  exp: (x) => exp(x),
  cos: (x) => cos(x),
  pow: (x, y) => pow(x, y),
};

/*
 * Inputs where an x86-64 build and some other build disagree, with the x86-64
 * answer. The comment on each is what the other build returns: V8 on arm64
 * (Node on Apple silicon), V8 compiled with every multiply-add fused (GCC's
 * default on Linux arm64), or the macOS libm that JavaScriptCore calls.
 */
const KNOWN: readonly [Fn, readonly number[], string][] = [
  ['log', [0.8177996163722128], 'bfc9bee3557661e8'], // arm64 V8: ...61e7
  ['log', [0.7298580706119537], 'bfd42768167ac4c0'], // arm64 V8: ...c4bf
  ['log', [0.6940754565875977], 'bfd75f054632da37'], // fully fused: ...da38
  ['log', [0.6187646049074829], 'bfdeb8d143eb18dc'], // libm: ...18dd
  ['exp', [-8.705745683982968], '3f25b5aaf1bc63fc'], // arm64 V8: ...63fd
  ['exp', [-14.175727986730635], '3ea767b0ebe8d446'], // arm64 V8: ...d445
  ['exp', [29.71871891990304], '429d58596406aabe'], // libm: ...aabf
  ['cos', [3.9708428923793426], 'bfe59d1cf2be8d8c'], // arm64 V8: ...8d8d
  ['cos', [5.295861576566039], '3fe1a12e24f6a76a'], // arm64 V8: ...a76b
  ['cos', [2.1354826980774297], 'bfe11ff4c90d6c51'], // libm: ...6c52
  ['pow', [9.048815758433193, 10.901927575469017], '4218fdd97f2bb596'], // arm64 V8: ...b597
  ['pow', [5.566856975201517, 11.095684040337801], '41a65abc88b9e44b'], // arm64 V8: ...e44a
  ['pow', [38.48445693729445, 0.6804656609892845], '4027f9a6bd613476'], // libm: ...3477
  ['log2', [651.9470829516649], '4022b27d26109baa'], // fully fused: ...9bab
  ['log2', [6044.671812560409], '40291f7626b47084'], // libm: ...7085
];

/** A uniformly random bit pattern, or null when it is not finite. */
function anyDouble(rng: Rng): number | null {
  const hi = BigInt(Math.floor(rng.next() * 2 ** 32));
  const lo = BigInt(Math.floor(rng.next() * 2 ** 32));
  const x = fromBits((hi << 32n) | lo);
  return Number.isFinite(x) ? x : null;
}

/**
 * Seeded inputs over the ranges the engine draws from and over every
 * exponent, including the large cosines that need the full 2/pi reduction.
 */
function sweep(n: number): [Fn, number, number][] {
  const rng = new Rng(20261107);
  const out: [Fn, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const u = 1 - rng.next();
    out.push(['log', u, 0], ['log2', 2 + rng.next() * 1e5, 0]);
    out.push(
      ['cos', 2 * Math.PI * rng.next(), 0],
      ['cos', (rng.next() - 0.5) * 2e6, 0],
    );
    out.push(['exp', -rng.next() * 50, 0], ['exp', (rng.next() - 0.5) * 1500, 0]);
    out.push(['pow', 1 - rng.next(), 1 / (0.01 + 2 * rng.next())]);
    out.push(['pow', rng.next() * 100, (rng.next() - 0.5) * 100]);
    const a = anyDouble(rng);
    const b = anyDouble(rng);
    if (a !== null)
      out.push(['log', Math.abs(a), 0], ['log2', Math.abs(a), 0], ['cos', a, 0]);
    if (a !== null && b !== null) out.push(['pow', Math.abs(a), b]);
  }
  return out;
}

/*
 * sha256 over the x86-64 results for sweep(20000), one bit pattern per line,
 * from the same ieee754.cc build as KNOWN.
 */
const SWEEP_DIGEST = '1624b6e6e5db84e14ca34714323eefb636da938f702c1de21009b3023e165e41';

describe('fdlibm port', () => {
  it.each(KNOWN)('%s(%s) gives the x86-64 bits', (fn, args, want) => {
    expect(bits(PORT[fn](args[0], args[1] ?? 0))).toBe(want);
  });

  it('matches the x86-64 build on a seeded sweep', () => {
    const h = createHash('sha256');
    for (const [fn, x, y] of sweep(20000)) h.update(bits(PORT[fn](x, y)) + '\n');
    expect(h.digest('hex')).toBe(SWEEP_DIGEST);
  });
});

describe('fdlibm port: results every engine agrees on', () => {
  /*
   * ECMAScript pins these exactly, so Math.* is a fair reference for them on
   * any machine. Object.is, so a wrong-signed zero fails.
   */
  const SPECIAL = [
    0,
    -0,
    1,
    -1,
    0.5,
    -0.5,
    2,
    -2,
    3,
    -3,
    1.5,
    -1.5,
    5e-324,
    -5e-324,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Infinity,
    -Infinity,
    NaN,
  ];

  /** True when the spec fixes x ** y outright, so no rounding is involved. */
  function pinned(x: number, y: number): boolean {
    return (
      Number.isNaN(x) ||
      Number.isNaN(y) ||
      y === 0 ||
      x === 0 ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      (x < 0 && !Number.isInteger(y))
    );
  }

  it('log, log2, exp and cos at special values', () => {
    for (const x of [0, -0, 1, -1, -5e-324, Infinity, -Infinity, NaN]) {
      expect(Object.is(log(x), Math.log(x)), `log(${x})`).toBe(true);
      expect(Object.is(log2(x), Math.log2(x)), `log2(${x})`).toBe(true);
    }
    for (const x of [0, -0, Infinity, -Infinity, NaN, 1000, -1000]) {
      expect(Object.is(exp(x), Math.exp(x)), `exp(${x})`).toBe(true);
    }
    for (const x of [0, -0, Infinity, -Infinity, NaN]) {
      expect(Object.is(cos(x), Math.cos(x)), `cos(${x})`).toBe(true);
    }
  });

  it('pow wherever the spec fixes the answer', () => {
    for (const x of SPECIAL) {
      for (const y of SPECIAL) {
        if (pinned(x, y))
          expect(Object.is(pow(x, y), Math.pow(x, y)), `pow(${x}, ${y})`).toBe(true);
      }
    }
  });

  it('pow is exact wherever the answer is representable', () => {
    for (let n = -1074; n <= 1023; n++) expect(pow(2, n), `2^${n}`).toBe(twoTo(n));
    let p = 1;
    for (let k = 0; k <= 33; k++, p *= 3) expect(pow(3, k), `3^${k}`).toBe(p);
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const x = (rng.next() - 0.5) * 1e6;
      expect(pow(x, 1)).toBe(x);
      expect(pow(x, 2)).toBe(x * x);
      expect(pow(x, -1)).toBe(1 / x);
      expect(pow(Math.abs(x), 0.5)).toBe(Math.sqrt(Math.abs(x)));
    }
  });

  it('log2 of a power of two is its exponent, subnormals included', () => {
    for (let n = -1074; n <= 1023; n++) expect(log2(twoTo(n)), `log2(2^${n})`).toBe(n);
  });

  it('exp(1) is e, as V8 special-cases it', () => {
    expect(exp(1)).toBe(Math.E);
  });

  it('cos is even, bit for bit', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 2000; i++) {
      const x = anyDouble(rng) ?? 1;
      expect(bits(cos(-x))).toBe(bits(cos(x)));
    }
  });
});

describe('the engine uses the port', () => {
  it('no simulation source calls Math for a transcendental', () => {
    const dir = new URL('./', import.meta.url);
    const banned =
      /\bMath\.(log|log2|log10|log1p|exp|expm1|pow|cos|sin|tan|acos|asin|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot)\b|\*\*/;
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name) || name === 'fdlibm.ts')
        continue;
      // Comments may name Math.* and use ** for powers; code may not.
      const code = readFileSync(new URL(name, dir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
        .replace(/\/\/.*$/gm, '');
      code.split('\n').forEach((line, i) => {
        if (banned.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
