// Constructores de geometría del sketch. Los usan las herramientas de dibujo y los tests.
import type { SketchConstraint, SketchData, SketchEntityId } from '../document/types';
import { dist } from './geometry';
import { idAllocator, type Vec2 } from './model';

/** Un extremo puede ser un punto existente (id) o una posición nueva. */
export type PointInput = SketchEntityId | Vec2;

type ConstraintInput = SketchConstraint extends infer C ? (C extends unknown ? Omit<C, 'id'> : never) : never;

export interface BuildResult {
  data: SketchData;
  /** Ids creados, en orden de creación. */
  created: SketchEntityId[];
}

/** Acumulador para varias operaciones con ids únicos. */
export class SketchBuilder {
  private entities;
  private constraints;
  private readonly alloc;
  readonly created: SketchEntityId[] = [];

  constructor(data: SketchData) {
    this.entities = data.entities.slice();
    this.constraints = data.constraints.slice();
    this.alloc = idAllocator(data);
  }

  get data(): SketchData {
    return { entities: this.entities, constraints: this.constraints };
  }

  point(p: PointInput): SketchEntityId {
    if (typeof p === 'string') return p;
    const id = this.alloc('p');
    this.entities.push({ id, type: 'point', x: p[0], y: p[1] });
    this.created.push(id);
    return id;
  }

  line(a: PointInput, b: PointInput, construction = false): SketchEntityId {
    const p1 = this.point(a);
    const p2 = this.point(b);
    const id = this.alloc('l');
    this.entities.push({ id, type: 'line', p1, p2, construction });
    this.created.push(id);
    return id;
  }

  circle(center: PointInput, radius: number, construction = false): SketchEntityId {
    const c = this.point(center);
    const id = this.alloc('c');
    this.entities.push({ id, type: 'circle', center: c, radius, construction });
    this.created.push(id);
    return id;
  }

  /** Arco antihorario de `start` a `end`. El extremo final se proyecta sobre el radio de `start`. */
  arc(center: Vec2 | SketchEntityId, start: PointInput, end: PointInput, construction = false, positions?: Map<string, Vec2>): SketchEntityId {
    const pos = (p: PointInput): Vec2 => (typeof p === 'string' ? positions?.get(p) ?? this.position(p) : p);
    const c = pos(center);
    let e = end;
    if (typeof end !== 'string') {
      const r = dist(c, pos(start));
      const ang = Math.atan2(end[1] - c[1], end[0] - c[0]);
      e = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
    }
    const cId = this.point(center);
    const sId = this.point(start);
    const eId = this.point(e);
    const id = this.alloc('a');
    this.entities.push({ id, type: 'arc', center: cId, start: sId, end: eId, construction });
    this.created.push(id);
    return id;
  }

  /** Rectángulo alineado a los ejes: 4 líneas con extremos compartidos, 2 horizontales y 2 verticales. */
  rectangle(c1: Vec2, c2: Vec2, construction = false): SketchEntityId[] {
    const [x0, x1] = [Math.min(c1[0], c2[0]), Math.max(c1[0], c2[0])];
    const [y0, y1] = [Math.min(c1[1], c2[1]), Math.max(c1[1], c2[1])];
    const a = this.point([x0, y0]);
    const b = this.point([x1, y0]);
    const c = this.point([x1, y1]);
    const d = this.point([x0, y1]);
    const bottom = this.line(a, b, construction);
    const right = this.line(b, c, construction);
    const top = this.line(c, d, construction);
    const left = this.line(d, a, construction);
    this.constrain({ type: 'horizontal', line: bottom });
    this.constrain({ type: 'horizontal', line: top });
    this.constrain({ type: 'vertical', line: right });
    this.constrain({ type: 'vertical', line: left });
    return [bottom, right, top, left];
  }

  constrain(c: ConstraintInput): string {
    const id = this.alloc('k');
    this.constraints.push({ ...c, id } as SketchConstraint);
    this.created.push(id);
    return id;
  }

  private position(id: SketchEntityId): Vec2 {
    if (id === 'origin') return [0, 0];
    const e = this.entities.find((x) => x.id === id);
    if (!e || e.type !== 'point') throw new Error(`El punto ${id} no existe`);
    return [e.x, e.y];
  }
}
