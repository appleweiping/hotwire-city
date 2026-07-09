// utils.js — dependency-free math and helper functions.

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;

export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
};
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));
export const len = (x, y) => Math.sqrt(x * x + y * y);

// Normalize angle to (-PI, PI]
export const normAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
};
export const angleDiff = (from, to) => normAngle(to - from);

// mulberry32 — tiny seedable PRNG so the city is identical for every player.
export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rngRange = (rng, lo, hi) => lo + rng() * (hi - lo);
export const rngInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive
export const rngPick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// Weighted pick from [[value, weight], ...]
export function rngWeighted(rng, pairs) {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let roll = rng() * total;
  for (const [v, w] of pairs) {
    roll -= w;
    if (roll <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

// Circle vs axis-aligned rect overlap test
export function circleRectOverlap(cx, cy, r, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  return dist2(cx, cy, nx, ny) < r * r;
}

// Segment (a→b) vs circle: returns t in [0,1] of first intersection, or -1.
export function segCircleHit(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax, dy = by - ay;
  const fx = ax - cx, fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a === 0) return dist2(ax, ay, cx, cy) <= r * r ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2; // ray started inside the circle
  return -1;
}

// Exponential smoothing factor that is framerate-independent.
// Usage: x = lerp(x, target, expFactor(rate, dt))
export const expFactor = (rate, dt) => 1 - Math.exp(-rate * dt);

export function formatMoney(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}
