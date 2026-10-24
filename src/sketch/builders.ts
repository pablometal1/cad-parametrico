// Constructores de geometría del sketch. Los usan las herramientas de dibujo y los tests.
import type { SketchConstraint, SketchData, SketchEntityId, SketchSpline } from '../document/types';
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

  /**
   * Spline por los puntos dados (existentes o nuevos), en orden. Con `kind` 'control' los puntos
   * son el polígono de control de una curva NURBS de grado `degree`.
   */
  spline(points: PointInput[], closed = false, construction = false, shape: { kind?: 'fit' | 'control'; degree?: number } = {}): SketchEntityId {
    const ids = points.map((p) => this.point(p));
    const id = this.alloc('s');
    const e: SketchSpline = { id, type: 'spline', points: ids, closed, construction };
    if (shape.kind === 'control') {
      e.kind = 'control';
      if (shape.degree !== undefined) e.degree = shape.degree;
    }
    this.entities.push(e);
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

  /**
   * Rectángulo por centro y esquina: diagonales de construcción y el punto central sobre ambas.
   * Así queda con 4 grados de libertad, igual que un rectángulo común, y el centro se puede
   * enganchar al origen. Devuelve [abajo, derecha, arriba, izquierda, centro].
   */
  centerRectangle(center: PointInput, corner: Vec2, construction = false): SketchEntityId[] {
    const c = typeof center === 'string' ? this.position(center) : center;
    const dx = Math.abs(corner[0] - c[0]);
    const dy = Math.abs(corner[1] - c[1]);
    const lines = this.rectangle([c[0] - dx, c[1] - dy], [c[0] + dx, c[1] + dy], construction);
    const corners = lines.map((l) => (this.entities.find((e) => e.id === l) as { p1: string }).p1);
    const d1 = this.line(corners[0], corners[2], true);
    const d2 = this.line(corners[1], corners[3], true);
    const centerId = this.point(center);
    this.constrain({ type: 'coincident', a: centerId, b: d1 });
    this.constrain({ type: 'coincident', a: centerId, b: d2 });
    return [...lines, centerId];
  }

  /**
   * Polígono regular de `sides` lados inscripto en un círculo de construcción, con un vértice en
   * `vertex`. Vértices sobre el círculo y lados iguales: queda regular con 4 grados de libertad
   * (centro, tamaño y giro). Devuelve [lados…, círculo].
   */
  polygon(center: PointInput, vertex: Vec2, sides: number, construction = false): SketchEntityId[] {
    const n = Math.max(3, Math.min(64, Math.round(sides)));
    const c = typeof center === 'string' ? this.position(center) : center;
    const r = dist(c, vertex);
    const a0 = Math.atan2(vertex[1] - c[1], vertex[0] - c[0]);
    const centerId = this.point(center);
    const circle = this.circle(centerId, r, true);
    const pts: SketchEntityId[] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (2 * Math.PI * i) / n;
      pts.push(this.point([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]));
    }
    const lines = pts.map((p, i) => this.line(p, pts[(i + 1) % n], construction));
    for (const p of pts) this.constrain({ type: 'coincident', a: p, b: circle });
    for (let i = 1; i < n; i++) this.constrain({ type: 'equal', a: lines[0], b: lines[i] });
    return [...lines, circle];
  }

  /**
   * Ranura (slot): dos semicírculos de radio `radius` centrados en `c1` y `c2`, unidos por líneas
   * tangentes. Queda con 5 grados de libertad (los dos centros y el radio).
   * Devuelve [línea inferior, arco en c2, línea superior, arco en c1].
   */
  slot(c1: PointInput, c2: PointInput, radius: number, construction = false): SketchEntityId[] {
    const p1 = typeof c1 === 'string' ? this.position(c1) : c1;
    const p2 = typeof c2 === 'string' ? this.position(c2) : c2;
    const len = dist(p1, p2);
    if (len < 1e-9) throw new Error('Los centros de la ranura no pueden coincidir');
    const d: Vec2 = [(p2[0] - p1[0]) / len, (p2[1] - p1[1]) / len];
    const nrm: Vec2 = [-d[1], d[0]];
    const off = (p: Vec2, s: number): Vec2 => [p[0] + nrm[0] * radius * s, p[1] + nrm[1] * radius * s];
    const id1 = this.point(c1);
    const id2 = this.point(c2);
    const A = this.point(off(p1, 1));
    const B = this.point(off(p2, 1));
    const C = this.point(off(p2, -1));
    const D = this.point(off(p1, -1));
    const positions = new Map<string, Vec2>([[id1, p1], [id2, p2]]);
    const bottom = this.line(D, C, construction);
    const arc2 = this.arc(id2, C, B, construction, positions);
    const top = this.line(B, A, construction);
    const arc1 = this.arc(id1, A, D, construction, positions);
    // La tangencia línea-arco con el extremo compartido es degenerada para el solver (se reporta
    // redundante). Equivalente regular: en cada centro, un diámetro de construcción perpendicular a
    // la línea central, y radios iguales; los lados quedan paralelos y tangentes por geometría.
    const center = this.line(id1, id2, true);
    const d1 = this.line(A, D, true);
    const d2 = this.line(B, C, true);
    this.constrain({ type: 'perpendicular', a: d1, b: center });
    this.constrain({ type: 'coincident', a: id1, b: d1 });
    this.constrain({ type: 'perpendicular', a: d2, b: center });
    this.constrain({ type: 'coincident', a: id2, b: d2 });
    this.constrain({ type: 'equal', a: arc1, b: arc2 });
    return [bottom, arc2, top, arc1];
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
