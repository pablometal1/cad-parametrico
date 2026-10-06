// Geometría 2D del sketch: medidas, muestreo de curvas y distancias para selección.
import type { SketchArc, SketchCurve, SketchEntityId } from '../document/types';
import { AXIS_X, AXIS_Y } from '../document/types';
import type { SketchIndex, Vec2 } from './model';

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => len(sub(a, b));
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

const TAU = Math.PI * 2;

/** Normaliza un ángulo a [0, 2π). */
export function normAngle(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

export interface ArcParams {
  center: Vec2;
  radius: number;
  startAngle: number;
  /** Siempre mayor que startAngle (barrido antihorario en (0, 2π]). */
  endAngle: number;
}

export function arcParams(index: SketchIndex, arc: SketchArc): ArcParams {
  const c = index.point(arc.center);
  const s = index.point(arc.start);
  const e = index.point(arc.end);
  const startAngle = Math.atan2(s[1] - c[1], s[0] - c[0]);
  let endAngle = Math.atan2(e[1] - c[1], e[0] - c[0]);
  while (endAngle <= startAngle + 1e-12) endAngle += TAU;
  return { center: c, radius: dist(c, s), startAngle, endAngle };
}

/** Extremos de una línea, incluidos los ejes implícitos (de longitud unitaria). */
export function lineEnds(index: SketchIndex, id: SketchEntityId): [Vec2, Vec2] {
  if (id === AXIS_X) return [[0, 0], [1, 0]];
  if (id === AXIS_Y) return [[0, 0], [0, 1]];
  const e = index.get(id);
  if (!e || e.type !== 'line') throw new Error(`${id} no es una línea`);
  return [index.point(e.p1), index.point(e.p2)];
}

/** Ángulo con signo (grados, en (-180, 180]) desde la dirección de la línea a hasta la de b. */
export function signedAngleDeg(index: SketchIndex, a: SketchEntityId, b: SketchEntityId): number {
  const [a1, a2] = lineEnds(index, a);
  const [b1, b2] = lineEnds(index, b);
  const da = sub(a2, a1);
  const db = sub(b2, b1);
  return (Math.atan2(cross(da, db), dot(da, db)) * 180) / Math.PI;
}

/**
 * Si las dos líneas comparten un vértice, indica cuáles apuntan hacia él (de p1 a p2).
 * Sirve para medir el ángulo "interior" con ambas direcciones saliendo del vértice.
 */
function sharedVertexFlips(index: SketchIndex, a: SketchEntityId, b: SketchEntityId): { flipA: boolean; flipB: boolean } | null {
  const la = index.get(a);
  const lb = index.get(b);
  if (la?.type !== 'line' || lb?.type !== 'line') return null;
  for (const shared of [la.p1, la.p2]) {
    if (shared === lb.p1 || shared === lb.p2) return { flipA: la.p2 === shared, flipB: lb.p2 === shared };
  }
  return null;
}

/** Normaliza grados a (-180, 180]. */
function wrapDeg(d: number): number {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
}

/**
 * Ángulo que ve el usuario (0..180): si las líneas comparten un vértice, el ángulo entre
 * ambas direcciones saliendo de ese vértice; si no, el ángulo entre sus direcciones.
 */
export function displayAngleDeg(index: SketchIndex, a: SketchEntityId, b: SketchEntityId, solverDeg?: number): number {
  const theta = solverDeg ?? signedAngleDeg(index, a, b);
  const f = sharedVertexFlips(index, a, b);
  const away = f && f.flipA !== f.flipB ? wrapDeg(theta + 180) : theta;
  return Math.abs(away);
}

/**
 * Como solverAngleDeg, pero tomando el sentido del valor guardado en lugar de la geometría actual
 * (lo usa la evaluación de expresiones, que no resuelve el sketch).
 */
export function solverAngleFromStored(index: SketchIndex, a: SketchEntityId, b: SketchEntityId, stored: number, display: number): number {
  const f = sharedVertexFlips(index, a, b);
  const offset = f && f.flipA !== f.flipB ? 180 : 0;
  const sign = wrapDeg(stored + offset) < 0 ? -1 : 1;
  return wrapDeg(sign * display - offset);
}

/** Convierte el ángulo que escribe el usuario al valor con signo que usa el solver (l2l_angle_ll). */
export function solverAngleDeg(index: SketchIndex, a: SketchEntityId, b: SketchEntityId, display: number): number {
  const theta = signedAngleDeg(index, a, b);
  const f = sharedVertexFlips(index, a, b);
  const offset = f && f.flipA !== f.flipB ? 180 : 0;
  const awayNow = wrapDeg(theta + offset);
  const sign = awayNow < 0 ? -1 : 1;
  return wrapDeg(sign * display - offset);
}

/** Distancia de un punto a la recta infinita que contiene la línea. */
export function pointLineDistance(p: Vec2, l1: Vec2, l2: Vec2): number {
  const d = sub(l2, l1);
  const L = len(d);
  if (L < 1e-12) return dist(p, l1);
  return Math.abs(cross(d, sub(p, l1))) / L;
}

/** Distancia de un punto al segmento (para selección con el mouse). */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const d = sub(b, a);
  const L2 = dot(d, d);
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), d) / L2));
  return dist(p, add(a, mul(d, t)));
}

/** ¿El ángulo θ cae dentro del barrido del arco? */
export function angleInArc(theta: number, ap: ArcParams): boolean {
  const t = normAngle(theta - ap.startAngle);
  return t <= ap.endAngle - ap.startAngle + 1e-12;
}

/** Distancia de un punto a una curva del sketch (para selección). */
export function curveDistance(index: SketchIndex, c: SketchCurve, p: Vec2): number {
  switch (c.type) {
    case 'line':
      return pointSegmentDistance(p, index.point(c.p1), index.point(c.p2));
    case 'circle':
      return Math.abs(dist(p, index.point(c.center)) - c.radius);
    case 'arc': {
      const ap = arcParams(index, c);
      const theta = Math.atan2(p[1] - ap.center[1], p[0] - ap.center[0]);
      if (angleInArc(theta, ap)) return Math.abs(dist(p, ap.center) - ap.radius);
      return Math.min(dist(p, index.point(c.start)), dist(p, index.point(c.end)));
    }
  }
}

/** Polilínea que aproxima una curva (para dibujar y para detectar contención de perfiles). */
export function sampleCurve(index: SketchIndex, c: SketchCurve, maxSegmentAngle = Math.PI / 36): Vec2[] {
  switch (c.type) {
    case 'line':
      return [index.point(c.p1), index.point(c.p2)];
    case 'circle': {
      const ctr = index.point(c.center);
      return sampleArc(ctr, c.radius, 0, TAU, maxSegmentAngle);
    }
    case 'arc': {
      const ap = arcParams(index, c);
      return sampleArc(ap.center, ap.radius, ap.startAngle, ap.endAngle, maxSegmentAngle);
    }
  }
}

function sampleArc(c: Vec2, r: number, a0: number, a1: number, maxStep: number): Vec2[] {
  const n = Math.max(2, Math.ceil((a1 - a0) / maxStep));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Punto medio sobre la curva (para ubicar etiquetas). */
export function curveMidpoint(index: SketchIndex, c: SketchCurve): Vec2 {
  switch (c.type) {
    case 'line':
      return lerp(index.point(c.p1), index.point(c.p2), 0.5);
    case 'circle': {
      const ctr = index.point(c.center);
      return [ctr[0] + c.radius * Math.SQRT1_2, ctr[1] + c.radius * Math.SQRT1_2];
    }
    case 'arc': {
      const ap = arcParams(index, c);
      const m = (ap.startAngle + ap.endAngle) / 2;
      return [ap.center[0] + ap.radius * Math.cos(m), ap.center[1] + ap.radius * Math.sin(m)];
    }
  }
}

/** Área con signo de un polígono (positiva si es antihorario). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
