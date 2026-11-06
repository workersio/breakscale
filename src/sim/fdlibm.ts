/* ------------------------------------------------------------------ *
 * The engine's own log, exp, log2, pow and cos.
 *
 * A replay link promises the same run on every machine, and Math.* cannot
 * keep that promise. V8 ships fdlibm in C++ (src/base/ieee754.cc), and on
 * arm64 the compiler fuses its multiply-adds, so on Apple silicon Math.log
 * differs from x86-64 in the last bit for about 2 uniform draws in 100.
 * Safari's JavaScriptCore calls the platform libm instead and differs on
 * about 1 in 12. One bit is enough: a service time that lands a hair later
 * reorders two events and the runs part ways.
 *
 * These are line-for-line ports of V8's fdlibm, so they return what Node
 * returns on x86-64, bit for bit. JavaScript never fuses a multiply and an
 * add, so the same arithmetic gives the same bits in every engine on every
 * CPU.
 *
 * Adapted from fdlibm (http://www.netlib.org/fdlibm), as modified by the
 * V8 project authors.
 *
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 * Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to
 * use, copy, modify, and distribute this software is freely granted,
 * provided that this notice is preserved.
 *
 * Modified by Google Inc. Copyright 2016 the V8 project authors. All rights
 * reserved. Use of this source code is governed by a BSD-style license.
 * ------------------------------------------------------------------ */

// One scratch double, read and written as two 32-bit words. Every engine
// that runs this is little-endian today, but the check costs nothing.
const F64 = new Float64Array(1);
const I32 = new Int32Array(F64.buffer);
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

/** High word of x, signed. */
function highWord(x: number): number {
  F64[0] = x;
  return I32[HI];
}

/** Low word of x, as a signed int32. Compare it with 0 only. */
function lowWord(x: number): number {
  F64[0] = x;
  return I32[LO];
}

function withHighWord(x: number, hi: number): number {
  F64[0] = x;
  I32[HI] = hi;
  return F64[0];
}

function withLowWord(x: number, lo: number): number {
  F64[0] = x;
  I32[LO] = lo;
  return F64[0];
}

function fromWords(hi: number, lo: number): number {
  I32[HI] = hi;
  I32[LO] = lo;
  return F64[0];
}

const TWO54 = 1.8014398509481984e16;
const TWO53 = 9007199254740992.0;
const TWO1023 = 8.98846567431158e307;
const TWOM1022 = 2.2250738585072014e-308;
const TWOM1000 = 9.332636185032189e-302;
const HUGE = 1.0e300;
const TINY = 1.0e-300;

/** x * 2^n with one rounding, as C's scalbn. */
function scalbn(x: number, n: number): number {
  let y = x;
  if (n > 1023) {
    y *= TWO1023;
    n -= 1023;
    if (n > 1023) {
      y *= TWO1023;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    // Land below -53 first so a subnormal result is rounded only once.
    y *= TWOM1022 * TWO53;
    n += 1022 - 53;
    if (n < -1022) {
      y *= TWOM1022 * TWO53;
      n += 1022 - 53;
      if (n < -1022) n = -1022;
    }
  }
  return y * fromWords((0x3ff + n) << 20, 0);
}

/* ------------------------------------------------------------------ *
 * log(x)
 * ------------------------------------------------------------------ */

const LN2_HI = 6.9314718036912381649e-1; // 3fe62e42 fee00000
const LN2_LO = 1.90821492927058770002e-10; // 3dea39ef 35793c76
const LG1 = 6.66666666666673513e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** Natural logarithm, bit-identical to V8's Math.log on x86-64. */
export function log(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    // x < 2^-1022
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54; // subnormal, scale up
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHighWord(x, hx | (i ^ 0x3ff00000)); // normalise x or x/2
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    // -2^-20 <= f < 2^-20
    if (f === 0) {
      if (k === 0) return 0;
      return k * LN2_HI + k * LN2_LO;
    }
    const r = f * f * (0.5 - 0.3333333333333333 * f);
    if (k === 0) return f - r;
    return k * LN2_HI - (r - k * LN2_LO - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const r = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + r));
    return dk * LN2_HI - (hfsq - (s * (hfsq + r) + dk * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - r);
  return dk * LN2_HI - (s * (f - r) - dk * LN2_LO - f);
}

/* ------------------------------------------------------------------ *
 * log2(x)
 * ------------------------------------------------------------------ */

const IVLN2HI = 1.44269504072144627571; // 3ff71547 65200000
const IVLN2LO = 1.67517131648865118353e-10; // 3de705fc 2eefa200

/** Base-2 logarithm, bit-identical to V8's Math.log2 on x86-64. */
export function log2(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  if (hx === 0x3ff00000 && lx === 0) return 0;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  x = withHighWord(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const y = k;
  const f = x - 1.0;
  const hfsq = 0.5 * f * f;
  // k_log1p(f)
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = s * (hfsq + (t2 + t1));
  // f - hfsq in extra precision, then y + val_hi by Dekker's sum.
  const hi = withLowWord(f - hfsq, 0);
  const lo = f - hi - hfsq + r;
  let valHi = hi * IVLN2HI;
  let valLo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
  const sum = y + valHi;
  valLo += y - sum + valHi;
  valHi = sum;
  return valLo + valHi;
}

/* ------------------------------------------------------------------ *
 * exp(x)
 * ------------------------------------------------------------------ */

const O_THRESHOLD = 7.09782712893383973096e2; // 40862e42 fefa39ef
const U_THRESHOLD = -7.4513321910194110842e2; // c0874910 d52d3051
const INVLN2 = 1.442695040888963387;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;
const E = 2.718281828459045;

/** e^x, bit-identical to V8's Math.exp on x86-64. */
export function exp(x: number): number {
  let hx = highWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0;
  let lo = 0;
  let k = 0;

  if (hx >= 0x40862e42) {
    // |x| >= 709.78...
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0.0; // exp(+-inf) = {inf, 0}
    }
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }

  if (hx > 0x3fd62e42) {
    // |x| > 0.5 ln2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5 ln2. V8 returns e itself for exp(1).
      if (x === 1.0) return E;
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI;
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = (INVLN2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0;
      hi = x - k * LN2_HI; // exact here
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    // |x| < 2^-28
    if (HUGE + x > 1) return 1 + x;
  } else {
    k = 0;
  }

  const t = x * x;
  const twopk =
    k >= -1021
      ? fromWords((0x3ff00000 + (k << 20)) | 0, 0)
      : fromWords((0x3ff00000 + ((k + 1000) << 20)) | 0, 0);
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  const y = 1 - (lo - (x * c) / (2.0 - c) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2.0 * TWO1023;
    return y * twopk;
  }
  return y * twopk * TWOM1000;
}

/* ------------------------------------------------------------------ *
 * pow(x, y)
 * ------------------------------------------------------------------ */

const BP = [1.0, 1.5];
const DP_H = [0.0, 5.84962487220764160156e-1]; // 3fe2b803 40000000
const DP_L = [0.0, 1.35003920212974897128e-8]; // 3e4cfdeb 43cfd006
const L1 = 5.99999999999994648725e-1;
const L2 = 4.28571428578550184252e-1;
const L3 = 3.33333329818377432918e-1;
const L4 = 2.72728123808534006489e-1;
const L5 = 2.30660745775561754067e-1;
const L6 = 2.06975017800338417784e-1;
const LG2_FULL = 6.93147180559945286227e-1; // 3fe62e42 fefa39ef
const LG2_H = 6.93147182464599609375e-1; // 3fe62e43 00000000
const LG2_L = -1.90465429995776804525e-9; // be205c61 0ca86c39
const OVT = 8.008566259537294e-17; // -(1024-log2(ovfl+.5ulp))
const CP = 9.61796693925975554329e-1; // 2/(3 ln2)
const CP_H = 9.61796700954437255859e-1; // (float)cp
const CP_L = -7.02846165095275826516e-9; // tail of cp_h
const IVLN2 = 1.442695040888963387; // 1/ln2
const IVLN2_H = 1.44269502162933349609; // 24 bits of 1/ln2
const IVLN2_L = 1.92596299112661746887e-8; // tail of 1/ln2

/** x^y, bit-identical to V8's Math.pow on x86-64. */
export function pow(x: number, y: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  const hy = highWord(y);
  const ly = lowWord(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  // y == 0: x^0 = 1
  if ((iy | ly) === 0) return 1;

  // NaN in, NaN out
  if (
    ix > 0x7ff00000 ||
    (ix === 0x7ff00000 && lx !== 0) ||
    iy > 0x7ff00000 ||
    (iy === 0x7ff00000 && ly !== 0)
  ) {
    return x + y;
  }

  // yisint: 0 when y is not an integer, 1 for an odd one, 2 for an even one.
  // Only needed when x < 0.
  let yisint = 0;
  let k = 0;
  let j = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) {
      yisint = 2;
    } else if (iy >= 0x3ff00000) {
      k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        // ly is unsigned in C, so shift it as one.
        j = (ly >>> (52 - k)) | 0;
        if (j << (52 - k) === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }

  // Special values of y
  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // y is +-inf
      if (((ix - 0x3ff00000) | lx) === 0) return y - y; // (+-1)^+-inf is NaN
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0; // (|x|>1)^+-inf = inf, 0
      return hy < 0 ? -y : 0; // (|x|<1)^-,+inf = inf, 0
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x; // y is +-1
    if (hy === 0x40000000) return x * x; // y is 2
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x); // y is 0.5, x >= +0
  }

  let ax = Math.abs(x);
  // Special values of x
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    // x is +-0, +-inf or +-1
    let z = ax;
    if (hy < 0) z = 1 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) {
        z = NaN; // (-1)^non-int
      } else if (yisint === 1) {
        z = -z; // (x<0)^odd = -(|x|^odd)
      }
    }
    return z;
  }

  let n = (hx >> 31) + 1;

  // (x<0)^(non-int) is NaN
  if ((n | yisint) === 0) return NaN;

  // Sign of the result: negative for (-ve)^(odd int)
  let s = 1;
  if ((n | (yisint - 1)) === 0) s = -1;

  let t1: number;
  let t2: number;
  if (iy > 0x41e00000) {
    // |y| > 2^31
    if (iy > 0x43f00000) {
      // |y| > 2^64, must overflow or underflow
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
    }
    // Over or underflow if x is not close to one
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    // |1-x| <= 2^-20, so log(x) by x-x^2/2+x^3/3-x^4/4
    const t = ax - 1;
    const w = t * t * (0.5 - t * (0.3333333333333333 - t * 0.25));
    const u = IVLN2_H * t;
    const v = t * IVLN2_L - w * IVLN2;
    t1 = withLowWord(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    // Subnormal x
    if (ix < 0x00100000) {
      ax *= TWO53;
      n -= 53;
      ix = highWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    j = ix & 0x000fffff;
    // Determine the interval
    ix = j | 0x3ff00000;
    if (j <= 0x3988e) {
      k = 0; // |x| < sqrt(3/2)
    } else if (j < 0xbb67a) {
      k = 1; // |x| < sqrt(3)
    } else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = withHighWord(ax, ix);

    // ss = s_h + s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
    let u = ax - BP[k];
    let v = 1 / (ax + BP[k]);
    const ss = u * v;
    const sH = withLowWord(ss, 0);
    // t_h = ax + bp[k], high part
    let tH = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let tL = ax - (tH - BP[k]);
    const sL = v * (u - sH * tH - sH * tL);
    // log(ax)
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = withLowWord(3.0 + s2 + r, 0);
    tL = r - (tH - 3.0 - s2);
    // u + v = ss * (1 + ...)
    u = sH * tH;
    v = sL * tH + tL * ss;
    // 2/(3 log2) * (ss + ...)
    const pH = withLowWord(u + v, 0);
    const pL = v - (pH - u);
    const zH = CP_H * pH; // cp_h + cp_l = 2/(3 log2)
    const zL = CP_L * pH + pL * CP + DP_L[k];
    // log2(ax) = (ss + ...) * 2/(3 log2) = n + dp_h + z_h + z_l
    const t = n;
    t1 = withLowWord(zH + zL + DP_H[k] + t, 0);
    t2 = zL - (t1 - t - DP_H[k] - zH);
  }

  // Split y into y1 + y2 and compute (y1 + y2) * (t1 + t2)
  const y1 = withLowWord(y, 0);
  const pL = (y - y1) * t1 + y * t2;
  let pH = y1 * t1;
  let z = pL + pH;
  j = highWord(z);
  let i = lowWord(z);
  if (j >= 0x40900000) {
    // z >= 1024
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE; // overflow
    if (pL + OVT > z - pH) return s * HUGE * HUGE; // overflow
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z <= -1075
    if (((j - 0xc090cc00) | i) !== 0) return s * TINY * TINY; // underflow
    if (pL <= z - pH) return s * TINY * TINY; // underflow
  }

  // 2^(p_h + p_l)
  i = j & 0x7fffffff;
  k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) {
    // |z| > 0.5: n = [z + 0.5]
    n = (j + (0x00100000 >> (k + 1))) | 0;
    k = ((n & 0x7fffffff) >> 20) - 0x3ff; // new k for n
    const t = fromWords(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    pH -= t;
  }
  const t = withLowWord(pL + pH, 0);
  const u = t * LG2_H;
  const v = (pL - (t - pH)) * LG2_FULL + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const tz = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tz) / (tz - 2 - (w + z * w));
  z = 1 - (r - z);
  j = (highWord(z) + (n << 20)) | 0;
  if (j >> 20 <= 0) {
    z = scalbn(z, n); // subnormal output
  } else {
    z = withHighWord(z, (highWord(z) + (n << 20)) | 0);
  }
  return s * z;
}

/* ------------------------------------------------------------------ *
 * cos(x)
 * ------------------------------------------------------------------ */

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

/** cos on [-pi/4, pi/4], with y the tail of x. */
function kernelCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return 1; // |x| < 2^-27
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y)); // |x| < 0.3
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0); // x/4
  const iz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (iz - (z * r - x * y));
}

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

/** sin on [-pi/4, pi/4], with y the tail of x. Only the iy == 1 branch. */
function kernelSin(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000) return x; // |x| < 2^-27
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

// 2/pi to 396 hex digits, in 24-bit chunks.
const TWO_OVER_PI = new Int32Array([
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041,
  0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c,
  0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41,
  0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f,
  0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d,
  0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7, 0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08,
  0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e, 0xe61b08,
  0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca, 0x73a8c9,
  0x60e27b, 0xc08c6b,
]);

// High words of n*pi/2 for n = 1..32, to spot cancellation.
const NPIO2_HW = new Int32Array([
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb,
  0x402921fb, 0x402c463a, 0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb,
  0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a, 0x403dd85a, 0x403f6a7a, 0x40407e4c,
  0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac, 0x4045fdbb,
  0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
]);

const TWO24 = 1.6777216e7;
const TWON24 = 5.9604644775390625e-8;
const INVPIO2 = 6.36619772367581382433e-1; // 53 bits of 2/pi
const PIO2_1 = 1.57079632673412561417; // first 33 bits of pi/2
const PIO2_1T = 6.07710050650619224932e-11; // pi/2 - pio2_1
const PIO2_2 = 6.0771005063039659766e-11; // second 33 bits of pi/2
const PIO2_2T = 2.02226624879595063154e-21; // pi/2 - (pio2_1 + pio2_2)
const PIO2_3 = 2.0222662487111664558e-21; // third 33 bits of pi/2
const PIO2_3T = 8.47842766036889956997e-32; // pi/2 - (pio2_1 + pio2_2 + pio2_3)

// pi/2 in 24-bit pieces, for the large-argument reduction.
const PIO2 = [
  1.57079625129699707031, 7.54978941586159635335e-8, 5.39030252995776476554e-15,
  3.28200341580791294123e-22, 1.27065575308067607349e-29, 1.22933308981111328932e-36,
  2.73370053816464559624e-44, 2.16741683877804819444e-51,
];

// The reduced argument, as y0 + y1. Written by the reductions below.
let y0 = 0;
let y1 = 0;

// Scratch for kernelRemPio2. Module-level, so a reduction allocates nothing.
const TX = new Float64Array(3);
const IQ = new Int32Array(20);
const FF = new Float64Array(20);
const FQ = new Float64Array(20);
const QQ = new Float64Array(20);

/**
 * Reduce a large x (nx 24-bit chunks in TX, scaled by 2^e0) mod pi/2 into
 * y0 + y1 and return the low three bits of the quadrant. fdlibm's
 * __kernel_rem_pio2 at prec 2, the only precision cos uses.
 */
function kernelRemPio2(e0: number, nx: number): number {
  const jk = 4; // init_jk[2]
  const jp = jk;
  const jx = nx - 1;
  let jv = ((e0 - 3) / 24) | 0;
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);

  // f[0..jx+jk], where f[jx+jk] = ipio2[jv+jk]
  let j = jv - jx;
  const m = jx + jk;
  for (let i = 0; i <= m; i++, j++) FF[i] = j < 0 ? 0 : TWO_OVER_PI[j];

  // q[0..jk]
  for (let i = 0; i <= jk; i++) {
    let fw = 0;
    for (j = 0; j <= jx; j++) fw += TX[j] * FF[jx + i - j];
    QQ[i] = fw;
  }

  let jz = jk;
  let z = 0;
  let n = 0;
  let ih = 0;
  for (;;) {
    // Distill q[] into iq[], in reverse
    let i = 0;
    z = QQ[jz];
    for (j = jz; j > 0; i++, j--) {
      const fw = (TWON24 * z) | 0;
      IQ[i] = (z - TWO24 * fw) | 0;
      z = QQ[j - 1] + fw;
    }

    // n
    z = scalbn(z, q0);
    z -= 8.0 * Math.floor(z * 0.125); // trim off integer >= 8
    n = z | 0;
    z -= n;
    ih = 0;
    if (q0 > 0) {
      // iq[jz-1] is needed to determine n
      i = IQ[jz - 1] >> (24 - q0);
      n += i;
      IQ[jz - 1] -= i << (24 - q0);
      ih = IQ[jz - 1] >> (23 - q0);
    } else if (q0 === 0) {
      ih = IQ[jz - 1] >> 23;
    } else if (z >= 0.5) {
      ih = 2;
    }

    if (ih > 0) {
      // q > 0.5
      n += 1;
      let carry = 0;
      for (i = 0; i < jz; i++) {
        // 1 - q
        j = IQ[i];
        if (carry === 0) {
          if (j !== 0) {
            carry = 1;
            IQ[i] = 0x1000000 - j;
          }
        } else {
          IQ[i] = 0xffffff - j;
        }
      }
      if (q0 === 1) IQ[jz - 1] &= 0x7fffff;
      else if (q0 === 2) IQ[jz - 1] &= 0x3fffff;
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }

    // Recompute with more terms if the result cancelled to zero
    if (z !== 0) break;
    j = 0;
    for (i = jz - 1; i >= jk; i--) j |= IQ[i];
    if (j !== 0) break;
    let k = 1;
    while (jk >= k && IQ[jk - k] === 0) k++; // k = terms needed
    for (i = jz + 1; i <= jz + k; i++) {
      // add q[jz+1] to q[jz+k]
      FF[jx + i] = TWO_OVER_PI[jv + i];
      let fw = 0;
      for (j = 0; j <= jx; j++) fw += TX[j] * FF[jx + i - j];
      QQ[i] = fw;
    }
    jz += k;
  }

  // Chop off zero terms
  if (z === 0) {
    jz -= 1;
    q0 -= 24;
    while (IQ[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    // Break z into 24 bits if necessary
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      const fw = (TWON24 * z) | 0;
      IQ[jz] = (z - TWO24 * fw) | 0;
      jz += 1;
      q0 += 24;
      IQ[jz] = fw;
    } else {
      IQ[jz] = z | 0;
    }
  }

  // Integer chunks back to floating point
  let fw = scalbn(1, q0);
  for (let i = jz; i >= 0; i--) {
    QQ[i] = fw * IQ[i];
    fw *= TWON24;
  }

  // PIo2[0..jp] * q[jz..0]
  for (let i = jz; i >= 0; i--) {
    fw = 0;
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * QQ[i + k];
    FQ[jz - i] = fw;
  }

  // Compress fq[] into y0, y1
  fw = 0;
  for (let i = jz; i >= 0; i--) fw += FQ[i];
  y0 = ih === 0 ? fw : -fw;
  fw = FQ[0] - fw;
  for (let i = 1; i <= jz; i++) fw += FQ[i];
  y1 = ih === 0 ? fw : -fw;
  return n & 7;
}

/** Reduce x mod pi/2 into y0 + y1 and return the quadrant. |x| > pi/4. */
function remPio2(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix < 0x4002d97c) {
    // |x| < 3pi/4, n = +-1
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        // 33+53 bits of pi are enough
        y0 = z - PIO2_1T;
        y1 = z - y0 - PIO2_1T;
      } else {
        // near pi/2, use 33+33+53 bits
        z -= PIO2_2;
        y0 = z - PIO2_2T;
        y1 = z - y0 - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      y0 = z + PIO2_1T;
      y1 = z - y0 + PIO2_1T;
    } else {
      z += PIO2_2;
      y0 = z + PIO2_2T;
      y1 = z - y0 + PIO2_2T;
    }
    return -1;
  }
  if (ix <= 0x413921fb) {
    // |x| <= 2^19 * pi/2, medium size
    let t = Math.abs(x);
    const n = (t * INVPIO2 + 0.5) | 0;
    const fn = n;
    let r = t - fn * PIO2_1;
    let w = fn * PIO2_1T; // first round, good to 85 bits
    if (n < 32 && ix !== NPIO2_HW[n - 1]) {
      y0 = r - w; // no cancellation
    } else {
      const j = ix >> 20;
      y0 = r - w;
      let i = j - ((highWord(y0) >> 20) & 0x7ff);
      if (i > 16) {
        // second iteration, good to 118 bits
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - (t - r - w);
        y0 = r - w;
        i = j - ((highWord(y0) >> 20) & 0x7ff);
        if (i > 49) {
          // third iteration, 151 bits, covers every case
          t = r;
          w = fn * PIO2_3;
          r = t - w;
          w = fn * PIO2_3T - (t - r - w);
          y0 = r - w;
        }
      }
    }
    y1 = r - y0 - w;
    if (hx < 0) {
      y0 = -y0;
      y1 = -y1;
      return -n;
    }
    return n;
  }
  // Large arguments. cos has already returned for inf and NaN.
  // z = scalbn(|x|, ilogb(x) - 23)
  const e0 = (ix >> 20) - 1046;
  let z = fromWords(ix - (e0 << 20), lowWord(x));
  for (let i = 0; i < 2; i++) {
    TX[i] = z | 0;
    z = (z - TX[i]) * TWO24;
  }
  TX[2] = z;
  let nx = 3;
  while (TX[nx - 1] === 0) nx--; // skip zero terms
  const n = kernelRemPio2(e0, nx);
  if (hx < 0) {
    y0 = -y0;
    y1 = -y1;
    return -n;
  }
  return n;
}

/** Cosine, bit-identical to V8's Math.cos on x86-64 (Node's fdlibm build). */
export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0); // |x| <= pi/4
  if (ix >= 0x7ff00000) return x - x; // cos(inf or NaN) is NaN
  switch (remPio2(x) & 3) {
    case 0:
      return kernelCos(y0, y1);
    case 1:
      return -kernelSin(y0, y1);
    case 2:
      return -kernelCos(y0, y1);
    default:
      return kernelSin(y0, y1);
  }
}
