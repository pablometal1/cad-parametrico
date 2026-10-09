// Nombrado topológico: cada cara del sólido lleva nombres derivados de la historia que la creó.
//
// Estrategia:
// - Las caras nuevas se nombran según lo que las generó: `<feature>:side:<curva del sketch>`,
//   `<feature>:start`, `<feature>:end`, `<feature>:fillet:<arista>`, etc.
// - En cada operación los nombres se propagan con la historia de OCCT (Modified/IsDeleted/IsSame).
//   Una cara puede acumular varios nombres (p. ej. al unificar caras coplanares); el primero es el principal.
// - Las aristas se nombran por el par de caras que separan: `nombreA|nombreB` (ordenado).
// - Toda referencia guarda además una huella geométrica (centro, normal, área/longitud) que desempata
//   cuando varias entidades comparten nombre (una cara partida en dos) y permite un último recurso
//   puramente geométrico si el nombre desaparece pero la geometría es idéntica.
import { getOC, measureArea, type AnyShape, type Edge, type Face } from 'replicad';
import type { EdgeRef, FaceRef, Vec3, VertexRef } from '../document/types';
import { FeatureError } from './occtUtils';

/** Nombres por cara, en el orden de `shape.faces`. */
export type FaceNames = string[][];

export interface NamedShape {
  shape: AnyShape;
  names: FaceNames;
}

export type OcShape = Face['wrapped'] | Edge['wrapped'] | AnyShape['wrapped'];

/** Índice de caras (o aristas) de un sólido para buscar por identidad topológica (IsSame). */
export class ShapeTable<T extends Face | Edge> {
  private readonly byHash = new Map<number, number[]>();
  constructor(readonly items: T[]) {
    items.forEach((it, i) => {
      const h = it.hashCode;
      const list = this.byHash.get(h);
      if (list) list.push(i);
      else this.byHash.set(h, [i]);
    });
  }
  static faces(shape: AnyShape) {
    return new ShapeTable<Face>(shape.faces);
  }
  static edges(shape: AnyShape) {
    return new ShapeTable<Edge>(shape.edges);
  }
  /** Índice del elemento que es el mismo (IsSame) que `s`, o -1. */
  indexOf(s: OcShape, hash: number): number {
    for (const i of this.byHash.get(hash) ?? []) {
      if (this.items[i].wrapped.IsSame(s)) return i;
    }
    return -1;
  }
}

/** Historia mínima que exponen las operaciones de OCCT. */
export interface History {
  modified(s: OcShape): OcShape[];
  generated(s: OcShape): OcShape[];
  isDeleted(s: OcShape): boolean;
}

export function listToArray(list: { Size(): number; First(): OcShape; RemoveFirst(): void; delete(): void }): OcShape[] {
  const out: OcShape[] = [];
  while (list.Size() > 0) {
    out.push(list.First());
    list.RemoveFirst();
  }
  list.delete();
  return out;
}

/** Adapta un builder de OCCT (BRepAlgoAPI, BRepFilletAPI, etc.) a la interfaz History. */
export function historyOf(builder: {
  Modified(s: never): unknown;
  Generated(s: never): unknown;
  IsDeleted(s: never): boolean;
}): History {
  type L = Parameters<typeof listToArray>[0];
  return {
    modified: (s) => listToArray(builder.Modified(s as never) as L),
    generated: (s) => listToArray(builder.Generated(s as never) as L),
    isDeleted: (s) => builder.IsDeleted(s as never),
  };
}

/** Acumula nombres para las caras de un sólido resultante. */
export class NameBuilder {
  readonly table: ShapeTable<Face>;
  readonly names: FaceNames;

  constructor(readonly shape: AnyShape) {
    this.table = ShapeTable.faces(shape);
    this.names = this.table.items.map(() => []);
  }

  /** Agrega un nombre a la cara del resultado que sea la misma que `face`. */
  add(face: OcShape, name: string) {
    const i = this.table.indexOf(face, hashOf(face));
    if (i >= 0 && !this.names[i].includes(name)) this.names[i].push(name);
  }

  /** Propaga los nombres de las caras de un sólido de entrada a través de una operación. */
  carry(source: NamedShape, history: History | null, opts: { skip?: Set<number> } = {}) {
    source.shape.faces.forEach((face, i) => {
      if (opts.skip?.has(i)) return;
      const names = source.names[i] ?? [];
      if (history?.isDeleted(face.wrapped)) return;
      const mods = history ? history.modified(face.wrapped) : [];
      const targets = mods.length ? mods : [face.wrapped];
      for (const t of targets) for (const n of names) this.add(t, n);
    });
  }

  /** Nombra las caras que generó una entidad de entrada (arista, cara…). */
  generated(history: History, from: OcShape, name: string) {
    for (const g of history.generated(from)) this.add(g, name);
  }

  /** Nombra todas las caras contenidas en `shape` (FirstShape/LastShape de un barrido). */
  addAll(shape: AnyShape, name: string) {
    for (const f of shape.faces) this.add(f.wrapped, name);
  }

  /** Caras sin nombre: nombre genérico de la feature (se distinguen por la huella geométrica). */
  finish(featureId: string): NamedShape {
    this.names.forEach((n) => {
      if (n.length === 0) n.push(`${featureId}:face`);
    });
    return { shape: this.shape, names: this.names };
  }

}

/** Mismo hash que `Shape.hashCode` de replicad, sin necesidad de envolver el objeto. */
const HASH_CODE_MAX = 2147483647;
function hashOf(s: OcShape): number {
  return getOC().ReplicadShapeHasher.HashCode(s, HASH_CODE_MAX);
}

// ---------------------------------------------------------------- aristas

/** Nombre de cada arista: par ordenado de los nombres principales de sus caras vecinas. */
export function edgeNames(named: NamedShape): { table: ShapeTable<Edge>; names: string[] } {
  const table = ShapeTable.edges(named.shape);
  const adjacent: number[][] = table.items.map(() => []);
  named.shape.faces.forEach((face, fi) => {
    for (const e of face.edges) {
      const ei = table.indexOf(e.wrapped, e.hashCode);
      if (ei >= 0 && !adjacent[ei].includes(fi)) adjacent[ei].push(fi);
    }
  });
  const names = adjacent.map((faces) => {
    const ns = faces.map((fi) => named.names[fi][0]).sort();
    if (ns.length === 1) ns.push(ns[0]); // costura: misma cara a ambos lados
    return ns.join('|');
  });
  return { table, names };
}

/** Índices de las caras vecinas a cada arista (en el orden de `shape.edges`). */
export function edgeAdjacency(named: NamedShape): { table: ShapeTable<Edge>; adjacent: number[][] } {
  const table = ShapeTable.edges(named.shape);
  const adjacent: number[][] = table.items.map(() => []);
  named.shape.faces.forEach((face, fi) => {
    for (const e of face.edges) {
      const ei = table.indexOf(e.wrapped, e.hashCode);
      if (ei >= 0 && !adjacent[ei].includes(fi)) adjacent[ei].push(fi);
    }
  });
  return { table, adjacent };
}

/** Tipo de arista para mostrar y elegir: 0 = normal, 1 = tangente (unión suave), 2 = costura. */
export const EDGE_NORMAL = 0;
export const EDGE_TANGENT = 1;
export const EDGE_SEAM = 2;

/** Ángulo máximo entre normales para considerar tangentes a dos caras vecinas (≈1°). */
const TANGENT_SIN = Math.sin((1 * Math.PI) / 180);

/**
 * Clasifica las aristas: una costura tiene la misma cara a ambos lados (cierre de un cilindro,
 * p. ej.); una arista tangente separa dos caras con la misma normal en su punto medio.
 * Ninguna de las dos se puede redondear ni achaflanar.
 */
export function edgeKinds(named: NamedShape): Uint8Array {
  const table = ShapeTable.edges(named.shape);
  const faces = named.shape.faces;
  const adjacent: number[][] = table.items.map(() => []);
  faces.forEach((face, fi) => {
    for (const e of face.edges) {
      const ei = table.indexOf(e.wrapped, e.hashCode);
      if (ei >= 0 && !adjacent[ei].includes(fi)) adjacent[ei].push(fi);
    }
  });
  return Uint8Array.from(adjacent, (adj, ei) => {
    if (adj.length === 1) return EDGE_SEAM;
    if (adj.length !== 2) return EDGE_NORMAL;
    try {
      const p = table.items[ei].pointAt(0.5);
      // normalAt no devuelve vectores unitarios en caras curvas: se normalizan.
      const a = unit(faces[adj[0]].normalAt(p).toTuple());
      const b = unit(faces[adj[1]].normalAt(p).toTuple());
      const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
      const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return cross < TANGENT_SIN && dot > 0 ? EDGE_TANGENT : EDGE_NORMAL;
    } catch {
      return EDGE_NORMAL;
    }
  });
}

// ---------------------------------------------------------------- huellas y referencias

export function faceRefOf(named: NamedShape, index: number): FaceRef {
  const face = named.shape.faces[index];
  if (!face) throw new FeatureError(`La cara ${index} no existe`);
  return { name: named.names[index][0], ...faceFingerprint(face) };
}

export function edgeRefOf(named: NamedShape, index: number): EdgeRef {
  const { table, names } = edgeNames(named);
  const edge = table.items[index];
  if (!edge) throw new FeatureError(`La arista ${index} no existe`);
  return { name: names[index], ...edgeFingerprint(edge) };
}

function faceFingerprint(face: Face): Omit<FaceRef, 'name'> {
  const c = face.center;
  const fp: Omit<FaceRef, 'name'> = { type: face.geomType, center: round3(c.toTuple()), area: round(measureArea(face)) };
  if (face.geomType === 'PLANE') fp.normal = round3(face.normalAt(c).toTuple());
  return fp;
}

function edgeFingerprint(edge: Edge): Omit<EdgeRef, 'name'> {
  return { center: round3(edge.pointAt(0.5).toTuple()), length: round(edge.length) };
}

/** Referencia a un vértice: las aristas que llegan a él y su posición. */
export function vertexRefOf(named: NamedShape, edgeIndices: number[], point: Vec3): VertexRef {
  return { edges: edgeIndices.map((i) => edgeRefOf(named, i)), point: round3(point) };
}

/**
 * Posición actual de un vértice: el extremo común de sus aristas (las que todavía existen). Con una
 * sola arista, el extremo más cercano a donde estaba.
 */
export function resolveVertex(named: NamedShape, ref: VertexRef): Vec3 {
  const { table } = edgeNames(named);
  const ends: [Vec3, Vec3][] = [];
  for (const er of ref.edges) {
    try {
      const e = table.items[resolveEdge(named, er)];
      ends.push([e.startPoint.toTuple() as Vec3, e.endPoint.toTuple() as Vec3]);
    } catch {
      // Una arista que ya no existe no impide ubicar el vértice con las demás.
    }
  }
  if (!ends.length) throw new FeatureError('Referencia perdida: un vértice de la curva ya no existe');
  const tol = 1e-6;
  const candidates = ends[0].filter((p) => ends.every((pair) => pair.some((q) => dist3(p, q) < tol)));
  const pool = candidates.length ? candidates : ends[0];
  return pool.reduce((best, p) => (dist3(p, ref.point) < dist3(best, ref.point) ? p : best));
}

/** Resuelve una referencia a cara: por nombre, desempatando por huella; si no, por geometría idéntica. */
export function resolveFace(named: NamedShape, ref: FaceRef): number {
  const faces = named.shape.faces;
  const score = (i: number) => faceScore(faceFingerprint(faces[i]), ref);
  const candidates = faces.map((_, i) => i).filter((i) => named.names[i].includes(ref.name));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return minBy(candidates, score);
  // Último recurso: una cara geométricamente idéntica (mismo tipo, centro, normal y área).
  const exact = faces.map((_, i) => i).filter((i) => score(i) < 1e-6);
  if (exact.length === 1) return exact[0];
  throw new FeatureError(`Referencia perdida: la cara "${shortName(ref.name)}" ya no existe`);
}

export function resolveEdge(named: NamedShape, ref: EdgeRef): number {
  const { table, names } = edgeNames(named);
  const score = (i: number) => edgeScore(edgeFingerprint(table.items[i]), ref);
  const candidates = names.map((_, i) => i).filter((i) => names[i] === ref.name);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return minBy(candidates, score);
  const exact = names.map((_, i) => i).filter((i) => score(i) < 1e-6);
  if (exact.length === 1) return exact[0];
  throw new FeatureError(`Referencia perdida: la arista entre ${shortName(ref.name)} ya no existe`);
}

function faceScore(fp: Omit<FaceRef, 'name'>, ref: FaceRef): number {
  if (fp.type !== ref.type) return Infinity;
  const scale = Math.sqrt(Math.max(ref.area, 1e-9));
  let s = dist3(fp.center, ref.center) / scale + Math.abs(fp.area - ref.area) / Math.max(ref.area, 1e-9);
  if (fp.normal && ref.normal) s += dist3(fp.normal, ref.normal);
  return s;
}

function edgeScore(fp: Omit<EdgeRef, 'name'>, ref: EdgeRef): number {
  const scale = Math.max(ref.length, 1e-9);
  return dist3(fp.center, ref.center) / scale + Math.abs(fp.length - ref.length) / scale;
}

function minBy(items: number[], f: (i: number) => number): number {
  let best = items[0];
  let bestV = f(best);
  for (const i of items.slice(1)) {
    const v = f(i);
    if (v < bestV) {
      best = i;
      bestV = v;
    }
  }
  return best;
}

function unit(v: number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0; // + 0 convierte -0 en 0
const round3 = (v: number[]): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/** Nombre legible para mensajes: sin los ids internos de features. */
export function shortName(name: string): string {
  return name.replace(/f_[0-9a-f]{12}:/g, '');
}
