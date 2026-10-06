// Detección de perfiles cerrados en un sketch: contornos (lazos) y regiones con agujeros.
import type { SketchCircle, SketchCurve, SketchData, SketchEntityId } from '../document/types';
import { dist, pointInPolygon, sampleCurve, signedArea } from './geometry';
import { SketchIndex, type Vec2 } from './model';

/** Tramo de un contorno: la curva y si se recorre al revés (de p2 a p1 / de end a start). */
export interface LoopEdge {
  curve: SketchCurve;
  reversed: boolean;
}

export interface ProfileLoop {
  edges: LoopEdge[];
  /** Polilínea del contorno en el sentido del recorrido. */
  polygon: Vec2[];
  /** Área con signo del recorrido (positiva = antihorario). */
  area: number;
}

export interface ProfileRegion {
  /** Contorno exterior, orientado antihorario. */
  outer: ProfileLoop;
  /** Agujeros, orientados horario. */
  holes: ProfileLoop[];
}

export interface ProfileAnalysis {
  regions: ProfileRegion[];
  /** Cadenas abiertas (se ignoran para extruir). */
  openChains: number;
  /** Hay regiones que se superponen: el cuerpo es la unión de sus extrusiones. */
  overlapping: boolean;
}

/** Tolerancia para considerar que dos extremos coinciden (mm). */
const JOIN_TOL = 1e-6;

export class ProfileError extends Error {}

/**
 * Encuentra las regiones extruibles. Lanza ProfileError si la topología no es soportada
 * (más de dos curvas en un mismo vértice).
 */
export function findProfiles(data: SketchData): ProfileAnalysis {
  const index = new SketchIndex(data);
  const curves = index.curves().filter((c) => !c.construction);

  const loops: ProfileLoop[] = [];
  for (const c of curves) if (c.type === 'circle') loops.push(circleLoop(index, c));

  const segs = curves.filter((c) => c.type !== 'circle' && curveLength(index, c) > JOIN_TOL);
  const ends = (c: SketchCurve): [SketchEntityId, SketchEntityId] =>
    c.type === 'line' ? [c.p1, c.p2] : c.type === 'arc' ? [c.start, c.end] : [c.center, c.center];

  // Agrupa extremos por posición: puntos distintos en el mismo lugar son el mismo vértice.
  const node = clusterPoints(index, segs.flatMap(ends));
  const adjacency = new Map<number, { curve: SketchCurve; at: 0 | 1 }[]>();
  for (const c of segs) {
    const [a, b] = ends(c).map((p) => node.get(p)!);
    for (const [n, at] of [[a, 0], [b, 1]] as const) {
      if (!adjacency.has(n)) adjacency.set(n, []);
      adjacency.get(n)!.push({ curve: c, at });
    }
  }
  for (const [n, list] of adjacency) {
    if (list.length > 2) {
      const p = representative(index, node, n);
      throw new ProfileError(
        `En (${p[0].toFixed(2)}, ${p[1].toFixed(2)}) se unen ${list.length} curvas; ` +
          'los perfiles deben ser contornos simples (marcá las curvas sobrantes como construcción)',
      );
    }
  }

  // Recorre cada componente conexa.
  const visited = new Set<SketchEntityId>();
  let openChains = 0;
  for (const start of segs) {
    if (visited.has(start.id)) continue;
    const component = collectComponent(start, adjacency, node, ends);
    component.forEach((c) => visited.add(c.id));
    const isClosed = component.every((c) => ends(c).every((p) => adjacency.get(node.get(p)!)!.length === 2));
    if (!isClosed) {
      openChains++;
      continue;
    }
    loops.push(walkLoop(index, start, adjacency, node, ends));
  }

  const regions = nestLoops(loops);
  return { regions, openChains, overlapping: regionsOverlap(regions) };
}

function curveLength(index: SketchIndex, c: SketchCurve): number {
  if (c.type === 'line') return dist(index.point(c.p1), index.point(c.p2));
  if (c.type === 'circle') return 2 * Math.PI * c.radius;
  return dist(index.point(c.start), index.point(c.end)) + dist(index.point(c.center), index.point(c.start));
}

function circleLoop(index: SketchIndex, c: SketchCircle): ProfileLoop {
  const polygon = sampleCurve(index, c).slice(0, -1);
  return { edges: [{ curve: c, reversed: false }], polygon, area: signedArea(polygon) };
}

function clusterPoints(index: SketchIndex, ids: SketchEntityId[]): Map<SketchEntityId, number> {
  const unique = [...new Set(ids)];
  const result = new Map<SketchEntityId, number>();
  const reps: Vec2[] = [];
  for (const id of unique) {
    const p = index.point(id);
    let n = reps.findIndex((r) => dist(r, p) <= JOIN_TOL);
    if (n < 0) {
      n = reps.length;
      reps.push(p);
    }
    result.set(id, n);
  }
  return result;
}

function representative(index: SketchIndex, node: Map<SketchEntityId, number>, n: number): Vec2 {
  for (const [id, m] of node) if (m === n) return index.point(id);
  return [0, 0];
}

type Adjacency = Map<number, { curve: SketchCurve; at: 0 | 1 }[]>;
type Ends = (c: SketchCurve) => [SketchEntityId, SketchEntityId];

function collectComponent(start: SketchCurve, adj: Adjacency, node: Map<SketchEntityId, number>, ends: Ends): SketchCurve[] {
  const seen = new Set<SketchEntityId>([start.id]);
  const stack = [start];
  const out: SketchCurve[] = [];
  while (stack.length) {
    const c = stack.pop()!;
    out.push(c);
    for (const p of ends(c)) {
      for (const { curve } of adj.get(node.get(p)!)!) {
        if (!seen.has(curve.id)) {
          seen.add(curve.id);
          stack.push(curve);
        }
      }
    }
  }
  return out;
}

function walkLoop(index: SketchIndex, start: SketchCurve, adj: Adjacency, node: Map<SketchEntityId, number>, ends: Ends): ProfileLoop {
  const edges: LoopEdge[] = [];
  let curve = start;
  let reversed = false;
  for (let guard = 0; guard < 100_000; guard++) {
    edges.push({ curve, reversed });
    const exit: SketchEntityId = ends(curve)[reversed ? 0 : 1];
    const exitNode: number = node.get(exit)!;
    const options: { curve: SketchCurve; at: 0 | 1 }[] = adj.get(exitNode)!;
    const next = options.find((x) => x.curve.id !== curve.id) ?? options[0];
    if (next.curve.id === start.id) break;
    curve = next.curve;
    // Si entramos por el extremo 1 de la siguiente curva, la recorremos al revés.
    reversed = next.at === 1;
  }
  const polygon: Vec2[] = [];
  for (const e of edges) {
    const pts = sampleCurve(index, e.curve);
    if (e.reversed) pts.reverse();
    polygon.push(...pts.slice(0, -1));
  }
  return { edges, polygon, area: signedArea(polygon) };
}

function reverseLoop(loop: ProfileLoop): ProfileLoop {
  return {
    edges: loop.edges.slice().reverse().map((e) => ({ curve: e.curve, reversed: !e.reversed })),
    polygon: loop.polygon.slice().reverse(),
    area: -loop.area,
  };
}

/** Anida contornos: profundidad par = exterior, impar = agujero de su contenedor inmediato. */
function nestLoops(loops: ProfileLoop[]): ProfileRegion[] {
  const containers = loops.map((l, i) =>
    loops
      .map((other, j) => ({ other, j }))
      // Es agujero solo si queda entero adentro: si los contornos se cruzan, ambos son exteriores
      // (sus extrusiones se unen).
      .filter(({ other, j }) => j !== i && Math.abs(other.area) > Math.abs(l.area) && insideEntirely(l.polygon, other.polygon))
      .map(({ j }) => j),
  );
  const depth = containers.map((c) => c.length);
  const parent = containers.map((c) =>
    c.length === 0 ? -1 : c.reduce((best, j) => (Math.abs(loops[j].area) < Math.abs(loops[best].area) ? j : best)),
  );

  const regions: ProfileRegion[] = [];
  const regionOf = new Map<number, ProfileRegion>();
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) {
      const r: ProfileRegion = { outer: l.area >= 0 ? l : reverseLoop(l), holes: [] };
      regions.push(r);
      regionOf.set(i, r);
    }
  });
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 1) regionOf.get(parent[i])!.holes.push(l.area <= 0 ? l : reverseLoop(l));
  });
  return regions;
}

function insideEntirely(inner: Vec2[], outer: Vec2[]): boolean {
  return inner.every((p) => pointInPolygon(p, outer)) && !polygonsCross(inner, outer);
}

/** ¿Algún par de regiones exteriores se cruza o se contiene parcialmente? */
function regionsOverlap(regions: ProfileRegion[]): boolean {
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i].outer.polygon;
      const b = regions[j].outer.polygon;
      if (polygonsCross(a, b) || pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
    }
  }
  return false;
}

/** ¿Se cortan o se tocan los bordes de dos polígonos? */
function polygonsCross(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i];
    const p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(p1, p2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

function segmentsCross(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): boolean {
  const o = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(q, q2, p);
  const d2 = o(q, q2, p2);
  const d3 = o(p, p2, q);
  const d4 = o(p, p2, q2);
  // Inclusivo: también cuenta cruces justo en un vértice y bordes que se tocan
  // (dos regiones que comparten un lado se unen).
  const eps = 1e-12;
  if (Math.abs(d1) < eps && Math.abs(d2) < eps) {
    // Colineales: se tocan si sus proyecciones se superponen.
    const ax = Math.abs(p2[0] - p[0]) > Math.abs(p2[1] - p[1]) ? 0 : 1;
    const [a0, a1] = [Math.min(p[ax], p2[ax]), Math.max(p[ax], p2[ax])];
    const [b0, b1] = [Math.min(q[ax], q2[ax]), Math.max(q[ax], q2[ax])];
    return a0 <= b1 + eps && b0 <= a1 + eps;
  }
  return d1 * d2 <= eps * eps && d3 * d4 <= eps * eps;
}
