// Splines del sketch: Catmull-Rom centrípeta que pasa por los puntos, expresada exactamente como
// tramos de Bézier cúbicos. El editor 2D y el kernel usan los mismos tramos, así lo que se ve es
// lo que se extruye.
import { NURBS_MAX_DEGREE } from '../document/types';
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

// ---------------------------------------------------------------------------------------------
// Curvas NURBS por puntos de control (B-spline no racional, uniforme). Abierta: sujeta en los
// extremos (empieza y termina en el primer y último punto, tangente al primer y último tramo del
// polígono de control). Cerrada: periódica, continua de grado − 1 en toda la vuelta.

export { NURBS_MAX_DEGREE };

/** Datos de la B-spline tal como los pide OpenCascade (nudos distintos con multiplicidades). */
export interface BSplineData {
  poles: Vec2[];
  knots: number[];
  mults: number[];
  degree: number;
  periodic: boolean;
}

/** Grado efectivo: el pedido, limitado por la cantidad de puntos. */
export function nurbsDegree(count: number, degree = 3): number {
  return Math.max(1, Math.min(Math.round(degree), NURBS_MAX_DEGREE, count - 1));
}

export function bsplineData(pts: Vec2[], closed: boolean, degree = 3): BSplineData {
  const n = pts.length;
  const p = nurbsDegree(n, degree);
  if (closed) {
    const knots = Array.from({ length: n + 1 }, (_, i) => i / n);
    return { poles: pts.slice(), knots, mults: knots.map(() => 1), degree: p, periodic: true };
  }
  const interior = n - p - 1;
  const knots = Array.from({ length: interior + 2 }, (_, i) => i / (interior + 1));
  const mults = knots.map((_, i) => (i === 0 || i === knots.length - 1 ? p + 1 : 1));
  return { poles: pts.slice(), knots, mults, degree: p, periodic: false };
}

/** Vector de nudos completo y polos equivalentes (una periódica se "desenrolla" repitiendo polos). */
function flatten(d: BSplineData): { poles: Vec2[]; flat: number[] } {
  if (!d.periodic) {
    const flat = d.knots.flatMap((k, i) => Array<number>(d.mults[i]).fill(k));
    return { poles: d.poles, flat };
  }
  const n = d.poles.length;
  const p = d.degree;
  const poles = [...d.poles, ...d.poles.slice(0, p)];
  const flat = Array.from({ length: n + 2 * p + 1 }, (_, i) => (i - p) / n);
  return { poles, flat };
}

/** Punto de la curva en t ∈ [0, 1] (algoritmo de De Boor). */
function deBoor(poles: Vec2[], flat: number[], p: number, t: number): Vec2 {
  const last = poles.length - 1;
  let s = p;
  while (s < last && t >= flat[s + 1]) s++;
  const d: Vec2[] = [];
  for (let j = 0; j <= p; j++) d.push([...poles[s - p + j]] as Vec2);
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = s - p + j;
      const den = flat[i + p - r + 1] - flat[i];
      const a = den === 0 ? 0 : (t - flat[i]) / den;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
    }
  }
  return d[p];
}

/** Polilínea de una curva NURBS (`perSpan` puntos por tramo entre nudos). */
export function sampleNurbs(pts: Vec2[], closed: boolean, degree = 3, perSpan = 24): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const d = bsplineData(pts, closed, degree);
  const { poles, flat } = flatten(d);
  const spans = d.knots.length - 1;
  const total = spans * perSpan;
  const out: Vec2[] = [];
  for (let i = 0; i <= total; i++) out.push(deBoor(poles, flat, d.degree, i / total));
  return out;
}

/**
 * Peine de curvatura de una polilínea densa: en cada punto, la curvatura (1/radio, con signo) y
 * la normal hacia el centro de curvatura. Sirve para ver la suavidad de una curva.
 */
export function curvatureComb(pts: Vec2[], closed: boolean): { at: Vec2; normal: Vec2; k: number }[] {
  const n = pts.length - (closed ? 1 : 0);
  const out: { at: Vec2; normal: Vec2; k: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const b = pts[i];
    const c = closed ? pts[(i + 1) % n] : pts[Math.min(pts.length - 1, i + 1)];
    if (a === b || b === c) continue;
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    // Curvatura de Menger: 4·área / (producto de los lados); signo según el giro.
    const k = ab * bc * ca > 1e-12 ? (2 * cross) / (ab * bc * ca) : 0;
    const tx = (c[0] - a[0]) / (ca || 1);
    const ty = (c[1] - a[1]) / (ca || 1);
    out.push({ at: b, normal: [-ty, tx], k });
  }
  return out;
}
