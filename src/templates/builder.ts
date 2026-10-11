// Constructor de plantillas paramétricas: arma el historial paso a paso con todas las medidas como
// expresiones de la tabla de parámetros (cambiar un parámetro regenera el modelo entero).
import { evaluateText } from '../document/evaluate';
import {
  addFeature, addParameter, emptyDocument, makeChamfer, makeExtrude, makeFillet, makeMirror, makePattern, makeSketch,
} from '../document/ops';
import { AXIS_X, AXIS_Y, type BasePlane, type CadDocument, type EdgeRef, type ExtrudeFeature, type Feature, type FeatureId, type PatternFeature } from '../document/types';
import type { EdgeInfo, RecomputeResult } from '../kernel/protocol';
import { SketchBuilder } from '../sketch/builders';

/** Lo que una plantilla necesita del kernel para elegir aristas sobre el sólido ya calculado. */
export interface TemplateKernel {
  recompute(doc: CadDocument): RecomputeResult;
  edgeInfo(index: number): EdgeInfo;
  edgeRefs(indices: number[]): EdgeRef[];
}

/** Coordenada o medida: un número o una expresión con parámetros (`largo / 2 - borde`). */
export type Ex = string | number;

/** Contorno cerrado de un sketch, con coordenadas (u, v) del plano como expresiones. */
export type Shape2d =
  | { kind: 'poly'; points: [Ex, Ex][] }
  | { kind: 'circle'; center: [Ex, Ex]; r: Ex };

const str = (e: Ex) => (typeof e === 'number' ? String(e) : e);

/** Rectángulo centrado en (cx, cy). */
export function rectC(cx: Ex, cy: Ex, w: Ex, h: Ex): Shape2d {
  const x0 = `(${str(cx)}) - (${str(w)}) / 2`, x1 = `(${str(cx)}) + (${str(w)}) / 2`;
  const y0 = `(${str(cy)}) - (${str(h)}) / 2`, y1 = `(${str(cy)}) + (${str(h)}) / 2`;
  return { kind: 'poly', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

/** Rectángulo centrado en el origen con las esquinas achaflanadas `c` (octógono). */
export function octagon(w: Ex, h: Ex, c: Ex): Shape2d {
  const a = `(${str(w)}) / 2`, b = `(${str(h)}) / 2`;
  const ai = `${a} - (${str(c)})`, bi = `${b} - (${str(c)})`;
  return {
    kind: 'poly',
    points: [
      [`-(${ai})`, `-(${b})`], [ai, `-(${b})`], [a, `-(${bi})`], [a, bi],
      [ai, b], [`-(${ai})`, b], [`-(${a})`, bi], [`-(${a})`, `-(${bi})`],
    ],
  };
}

export const circle = (cx: Ex, cy: Ex, r: Ex): Shape2d => ({ kind: 'circle', center: [cx, cy], r });

export interface ExtrudeOpts {
  distance: Ex;
  direction?: ExtrudeFeature['direction'];
  operation?: ExtrudeFeature['operation'];
  /** Extrusión delgada: pared de este espesor centrada en el contorno. */
  thin?: Ex;
}

export class TemplateBuilder {
  doc: CadDocument = emptyDocument();
  private scope = new Map<string, number>();

  constructor(private readonly kernel: TemplateKernel) {}

  /** Parámetro de la tabla (`fx`). */
  param(name: string, expression: Ex, comment?: string) {
    this.doc = addParameter(this.doc, name, str(expression), comment);
    this.scope.set(name, this.value(expression));
    return name;
  }

  value(e: Ex): number {
    return typeof e === 'number' ? e : evaluateText(e, this.scope);
  }

  /**
   * Sketch sobre un plano base desplazado `offset`. Cada punto queda fijado con cotas a los ejes
   * cuyas expresiones dependen de los parámetros: el sketch queda totalmente definido.
   */
  sketch(name: string, plane: BasePlane, offset: Ex, shapes: Shape2d[]): FeatureId {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const exprs: Record<string, string> = {};
    const pin = (p: string, x: Ex, y: Ex) => {
      exprs[`constraint:${b.constrain({ type: 'distance', a: p, b: AXIS_Y, value: Math.abs(this.value(x)) })}`] = `abs(${str(x)})`;
      exprs[`constraint:${b.constrain({ type: 'distance', a: p, b: AXIS_X, value: Math.abs(this.value(y)) })}`] = `abs(${str(y)})`;
    };
    for (const s of shapes) {
      if (s.kind === 'circle') {
        const c = b.point([this.value(s.center[0]), this.value(s.center[1])]);
        pin(c, s.center[0], s.center[1]);
        const id = b.circle(c, this.value(s.r));
        exprs[`constraint:${b.constrain({ type: 'radius', curve: id, value: this.value(s.r) })}`] = str(s.r);
        continue;
      }
      const ids = s.points.map(([x, y]) => {
        const p = b.point([this.value(x), this.value(y)]);
        pin(p, x, y);
        return p;
      });
      ids.forEach((p, i) => b.line(p, ids[(i + 1) % ids.length]));
    }
    if (typeof offset === 'string') exprs['plane.offset'] = offset;
    const f = makeSketch(this.doc, { name, plane: { kind: 'base', plane, offset: this.value(offset) }, ...b.data, exprs });
    return this.add(f);
  }

  extrude(name: string, sketch: FeatureId, o: ExtrudeOpts): FeatureId {
    const exprs: Record<string, string> = {};
    if (typeof o.distance === 'string') exprs.distance = o.distance;
    if (typeof o.thin === 'string') exprs.thin = o.thin;
    const f = makeExtrude(this.doc, sketch, {
      name,
      distance: this.value(o.distance),
      direction: o.direction ?? 'normal',
      operation: o.operation ?? 'join',
      ...(o.thin !== undefined ? { thin: this.value(o.thin) } : {}),
      exprs,
    });
    return this.add(f);
  }

  /** Sketch + extrusión en un paso (el sketch toma el nombre de la extrusión). */
  feature(name: string, plane: BasePlane, offset: Ex, shapes: Shape2d[], o: ExtrudeOpts): FeatureId {
    return this.extrude(name, this.sketch(`${name} (sketch)`, plane, offset, shapes), o);
  }

  mirror(name: string, source: FeatureId, plane: BasePlane): FeatureId {
    return this.add({ ...makeMirror(this.doc, source, plane), name });
  }

  pattern(name: string, source: FeatureId, o: Partial<Pick<PatternFeature, 'kind' | 'axis'>> & { count: Ex; spacing: Ex }): FeatureId {
    const exprs: Record<string, string> = {};
    if (typeof o.count === 'string') exprs.count = o.count;
    if (typeof o.spacing === 'string') exprs.spacing = o.spacing;
    const f = makePattern(this.doc, source, { kind: o.kind ?? 'linear', axis: o.axis ?? 'X', count: this.value(o.count), spacing: this.value(o.spacing) });
    return this.add({ ...f, name, exprs });
  }

  /** Chaflán en las aristas del sólido actual que cumplan `pick`. */
  chamfer(name: string, pick: (e: EdgeInfo) => boolean, distance: Ex): FeatureId {
    const f = makeChamfer(this.doc, this.edges(pick, name), this.value(distance));
    return this.add({ ...f, name, ...(typeof distance === 'string' ? { exprs: { distance } } : {}) });
  }

  fillet(name: string, pick: (e: EdgeInfo) => boolean, radius: Ex): FeatureId {
    const f = makeFillet(this.doc, this.edges(pick, name), this.value(radius));
    return this.add({ ...f, name, ...(typeof radius === 'string' ? { exprs: { radius } } : {}) });
  }

  /** Recalcula y verifica que todo el historial haya salido bien (si no, la plantilla está mal). */
  check(): RecomputeResult {
    const r = this.kernel.recompute(this.doc);
    const bad = r.features.find((f) => f.status === 'error');
    if (bad) {
      const f = this.doc.features.find((x) => x.id === bad.id);
      throw new Error(`Plantilla: falló «${f?.name}»: ${bad.error ?? 'error'}`);
    }
    return r;
  }

  private edges(pick: (e: EdgeInfo) => boolean, what: string): EdgeRef[] {
    this.check();
    const found: number[] = [];
    for (let i = 0; ; i++) {
      let e: EdgeInfo;
      try {
        e = this.kernel.edgeInfo(i);
      } catch {
        break;
      }
      if (pick(e)) found.push(i);
    }
    if (found.length === 0) throw new Error(`Plantilla: «${what}» no encontró aristas`);
    return this.kernel.edgeRefs(found);
  }

  private add(f: Feature): FeatureId {
    this.doc = addFeature(this.doc, f);
    return f.id;
  }
}
