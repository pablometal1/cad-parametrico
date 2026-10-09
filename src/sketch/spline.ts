// Splines del sketch: Catmull-Rom centrípeta que pasa por los puntos, expresada exactamente como
// tramos de Bézier cúbicos. El editor 2D y el kernel usan los mismos tramos, así lo que se ve es
// lo que se extruye.
import type { Vec2 } from './model';

/** Puntos de control de cada tramo (4 por tramo: inicio, dos de control, fin). */
export function splineBeziers(pts: Vec2[], closed: boolean): Vec2[][] {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number): Vec2 => {
    if (closed) return pts[((i % n) + n) % n];
    // Abierta: puntos fantasma reflejados en los extremos.
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const segs: Vec2[][] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    segs.push([p1, ...controls(p0, p1, p2, p3), p2]);
  }
  return segs;
}

/** Puntos de control de Bézier del tramo p1→p2 de una Catmull-Rom centrípeta (α = 0,5). */
function controls(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): [Vec2, Vec2] {
  const d = (a: Vec2, b: Vec2) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]));
  const [d1, d2, d3] = [d(p0, p1), d(p1, p2), d(p2, p3)];
  const third = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (d2 < 1e-12) return [p1, p2];
  const b1: Vec2 = d1 < 1e-12
    ? third(p1, p2, 1 / 3)
    : [0, 1].map((k) => (d1 * d1 * p2[k] - d2 * d2 * p0[k] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[k]) / (3 * d1 * (d1 + d2))) as Vec2;
  const b2: Vec2 = d3 < 1e-12
    ? third(p2, p1, 1 / 3)
    : [0, 1].map((k) => (d3 * d3 * p1[k] - d2 * d2 * p3[k] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[k]) / (3 * d3 * (d3 + d2))) as Vec2;
  return [b1, b2];
}

export function bezierPoint(c: Vec2[], t: number): Vec2 {
  const u = 1 - t;
  const [a, b, d, e] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

/** Polilínea de la spline (para dibujar, elegir y detectar perfiles). */
export function sampleSpline(pts: Vec2[], closed: boolean, perSegment = 24): Vec2[] {
  const segs = splineBeziers(pts, closed);
  if (!segs.length) return pts.slice();
  const out: Vec2[] = [segs[0][0]];
  for (const s of segs) for (let i = 1; i <= perSegment; i++) out.push(bezierPoint(s, i / perSegment));
  return out;
}
