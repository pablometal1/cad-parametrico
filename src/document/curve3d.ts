// Geometría de las curvas 3D entre vértices del modelo: un tramo por par de vértices seguidos,
// cada uno una Bézier cúbica [inicio, control 1, control 2, fin]. La usan el kernel (aristas del
// parche) y el visor (asas arrastrables y vista previa), así lo que se ve es lo que se construye.
import type { Curve3dHandles, Vec3 } from './types';

/** Tramo: inicio, control de salida, control de llegada, fin. */
export type BezierSegment = [Vec3, Vec3, Vec3, Vec3];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};

/** Cantidad de tramos de una curva de `n` vértices. */
export const segmentCount = (n: number, closed: boolean) => (closed ? n : n - 1);

/**
 * Tramos de la curva. Un tramo con asas guardadas usa esos desplazamientos (control 1 respecto del
 * inicio, control 2 respecto del fin: siguen al modelo si los vértices se mueven). Sin asas: recto,
 * o con tangentes automáticas suaves si `smooth` (la dirección en cada vértice es la del vecino
 * anterior al siguiente; el largo, un tercio del tramo).
 */
export function curveSegments(pts: Vec3[], closed: boolean, smooth: boolean, handles: (Curve3dHandles | null)[] = []): BezierSegment[] {
  const n = pts.length;
  const at = (i: number) => pts[((i % n) + n) % n];
  const tangent = (i: number): Vec3 => {
    if (!closed && i === 0) return unit(sub(pts[1], pts[0]));
    if (!closed && i === n - 1) return unit(sub(pts[n - 1], pts[n - 2]));
    return unit(sub(at(i + 1), at(i - 1)));
  };
  const segs: BezierSegment[] = [];
  for (let i = 0; i < segmentCount(n, closed); i++) {
    const a = at(i);
    const b = at(i + 1);
    const h = handles[i];
    if (h) {
      segs.push([a, add(a, h[0]), add(b, h[1]), b]);
      continue;
    }
    const d = len(sub(b, a));
    if (smooth && n > 2) segs.push([a, add(a, mul(tangent(i), d / 3)), sub(b, mul(tangent(i + 1), d / 3)), b]);
    else segs.push([a, add(a, mul(sub(b, a), 1 / 3)), add(a, mul(sub(b, a), 2 / 3)), b]);
  }
  return segs;
}

/** ¿El tramo es recto (los controles sobre la cuerda)? Entonces se construye como línea. */
export function isStraight(s: BezierSegment): boolean {
  const chord = sub(s[3], s[0]);
  const l = len(chord);
  if (l < 1e-12) return true;
  const u = mul(chord, 1 / l);
  const off = (p: Vec3) => {
    const v = sub(p, s[0]);
    const along = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
    return len(sub(v, mul(u, along))) + Math.max(0, -along) + Math.max(0, along - l);
  };
  return off(s[1]) < 1e-9 * Math.max(1, l) && off(s[2]) < 1e-9 * Math.max(1, l);
}

export function bezierAt(s: BezierSegment, t: number): Vec3 {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1, 2].map((k) => a * s[0][k] + b * s[1][k] + c * s[2][k] + d * s[3][k]) as Vec3;
}

/** Polilínea para dibujar (el primer punto de cada tramo no se repite). */
export function sampleSegments(segs: BezierSegment[], perSegment = 24): Vec3[] {
  if (!segs.length) return [];
  const out: Vec3[] = [segs[0][0]];
  for (const s of segs) {
    if (isStraight(s)) out.push(s[3]);
    else for (let i = 1; i <= perSegment; i++) out.push(bezierAt(s, i / perSegment));
  }
  return out;
}

/**
 * Mueve un control (`end` 0: el de salida del tramo, 1: el de llegada) a `pos`. Con `keepTangent`,
 * el control del tramo vecino en el mismo vértice gira para quedar alineado (tangente continua,
 * como un punto suave en Plasticity) y conserva su largo. Devuelve los tramos nuevos y cuáles cambiaron.
 */
export function moveHandle(segs: BezierSegment[], closed: boolean, seg: number, end: 0 | 1, pos: Vec3, keepTangent: boolean): { segs: BezierSegment[]; touched: number[] } {
  const next = segs.map((s) => s.slice() as BezierSegment);
  next[seg][end === 0 ? 1 : 2] = pos;
  const touched = [seg];
  if (keepTangent) {
    const n = segs.length;
    const neighbor = end === 0 ? (seg > 0 ? seg - 1 : closed ? n - 1 : -1) : (seg < n - 1 ? seg + 1 : closed ? 0 : -1);
    if (neighbor >= 0 && neighbor !== seg) {
      const vertex = end === 0 ? next[seg][0] : next[seg][3];
      const dir = unit(sub(vertex, pos));
      const slot = end === 0 ? 2 : 1;
      const keep = len(sub(next[neighbor][slot], vertex));
      if (len(dir) > 0) {
        next[neighbor][slot] = add(vertex, mul(dir, keep));
        touched.push(neighbor);
      }
    }
  }
  return { segs: next, touched };
}

/** Asas a guardar: los tramos tocados quedan fijos (desplazamientos), los demás como estaban. */
export function handlesAfter(segs: BezierSegment[], touched: number[], previous: (Curve3dHandles | null)[] = []): (Curve3dHandles | null)[] {
  return segs.map((s, i) => (touched.includes(i) ? [sub(s[1], s[0]), sub(s[2], s[3])] : previous[i] ?? null));
}
