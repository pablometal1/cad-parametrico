// Operaciones puras sobre los datos de un sketch (entidades y restricciones).
import {
  AXIS_X, AXIS_Y, IMPLICIT_IDS, ORIGIN,
  type SketchConstraint, type SketchCurve, type SketchData, type SketchEntity, type SketchEntityId,
  type SketchPoint,
} from '../document/types';

export type Vec2 = [number, number];

export const emptySketchData = (): SketchData => ({ entities: [], constraints: [] });

export class SketchIndex {
  private readonly byId = new Map<SketchEntityId, SketchEntity>();
  constructor(readonly data: SketchData) {
    for (const e of data.entities) this.byId.set(e.id, e);
  }
  get(id: SketchEntityId): SketchEntity | undefined {
    return this.byId.get(id);
  }
  has(id: SketchEntityId): boolean {
    return this.byId.has(id) || IMPLICIT_IDS.includes(id);
  }
  /** Coordenadas de un punto (incluye el origen implícito). */
  point(id: SketchEntityId): Vec2 {
    if (id === ORIGIN) return [0, 0];
    const e = this.byId.get(id);
    if (!e || e.type !== 'point') throw new Error(`El punto ${id} no existe en el sketch`);
    return [e.x, e.y];
  }
  /** Tipo de entidad, incluyendo las implícitas (los ejes se comportan como líneas). */
  kind(id: SketchEntityId): SketchEntity['type'] | undefined {
    if (id === ORIGIN) return 'point';
    if (id === AXIS_X || id === AXIS_Y) return 'line';
    return this.byId.get(id)?.type;
  }
  curves(): SketchCurve[] {
    return this.data.entities.filter((e): e is SketchCurve => e.type !== 'point');
  }
  points(): SketchPoint[] {
    return this.data.entities.filter((e): e is SketchPoint => e.type === 'point');
  }
}

/** Puntos que definen una curva. */
export function curvePoints(c: SketchCurve): SketchEntityId[] {
  switch (c.type) {
    case 'line': return [c.p1, c.p2];
    case 'circle': return [c.center];
    case 'arc': return [c.center, c.start, c.end];
  }
}

/** Entidades a las que hace referencia una restricción. */
export function constraintRefs(c: SketchConstraint): SketchEntityId[] {
  switch (c.type) {
    case 'horizontal':
    case 'vertical':
      return [c.line];
    case 'radius':
      return [c.curve];
    case 'distance':
      return c.b ? [c.a, c.b] : [c.a];
    default:
      return [c.a, c.b];
  }
}

/** Genera un id libre con el prefijo dado (p1, p2, l1…). */
export function nextId(data: SketchData, prefix: string, taken: Set<string> = new Set()): string {
  const used = new Set<string>([...data.entities.map((e) => e.id), ...data.constraints.map((c) => c.id), ...taken]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Crea ids consecutivos sin repetir dentro de una misma operación. */
export function idAllocator(data: SketchData) {
  const taken = new Set<string>();
  return (prefix: string) => {
    const id = nextId(data, prefix, taken);
    taken.add(id);
    return id;
  };
}

/**
 * Borra entidades y restricciones. Al borrar curvas se eliminan también los puntos que
 * quedan sin usar, y toda restricción que referencie algo borrado.
 */
export function removeItems(data: SketchData, ids: Iterable<string>): SketchData {
  const remove = new Set(ids);
  for (const id of IMPLICIT_IDS) remove.delete(id);

  const removedCurves = data.entities.filter((e) => e.type !== 'point' && remove.has(e.id)) as SketchCurve[];
  let entities = data.entities.filter((e) => !remove.has(e.id));

  // Puntos huérfanos de las curvas borradas.
  const stillUsed = new Set(
    entities.filter((e): e is SketchCurve => e.type !== 'point').flatMap(curvePoints),
  );
  const orphan = new Set(removedCurves.flatMap(curvePoints).filter((p) => !stillUsed.has(p)));
  // Un punto también se borra si se pidió explícitamente y ninguna curva restante lo usa.
  for (const id of remove) if (!stillUsed.has(id)) orphan.add(id);
  // Si se pidió borrar un punto que una curva sigue usando, se borra la curva también.
  const forcedCurves = entities.filter(
    (e): e is SketchCurve => e.type !== 'point' && curvePoints(e).some((p) => remove.has(p)),
  );
  if (forcedCurves.length > 0) {
    return removeItems(data, [...remove, ...forcedCurves.map((c) => c.id)]);
  }
  entities = entities.filter((e) => !orphan.has(e.id));

  const alive = new Set(entities.map((e) => e.id));
  const constraints = data.constraints.filter(
    (c) => !remove.has(c.id) && constraintRefs(c).every((r) => alive.has(r) || IMPLICIT_IDS.includes(r)),
  );
  return { entities, constraints };
}

/** Reemplaza las coordenadas de puntos y radios con valores resueltos. */
export function withSolvedValues(
  data: SketchData,
  points: ReadonlyMap<SketchEntityId, Vec2>,
  radii: ReadonlyMap<SketchEntityId, number>,
): SketchData {
  return {
    constraints: data.constraints,
    entities: data.entities.map((e) => {
      if (e.type === 'point') {
        const p = points.get(e.id);
        return p ? { ...e, x: p[0], y: p[1] } : e;
      }
      if (e.type === 'circle') {
        const r = radii.get(e.id);
        return r !== undefined ? { ...e, radius: r } : e;
      }
      return e;
    }),
  };
}
