// Barrido (perfil a lo largo de una trayectoria) y solevación (superficie entre secciones).
import { assembleWire, cast, getOC, makeCircle, makeCompound, makeLine, makeThreePointArc, type Edge, type Face } from 'replicad';
import { toWorld } from '../../document/planes';
import type { LoftFeature, SweepFeature } from '../../document/types';
import { arcParams } from '../../sketch/geometry';
import { SketchIndex } from '../../sketch/model';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { describeError, FeatureError, isValidShape } from '../occtUtils';
import { combine, sweepRegions } from './boolean';
import { buildOuterWires, buildSketchFaces, nameSweep, type EvaluatedSketch } from './sketch';

/** Tolerancia para unir extremos de la trayectoria (mm). */
const JOIN_TOL = 1e-6;

export function runSweep(feature: SweepFeature, profile: EvaluatedSketch, path: EvaluatedSketch, input: NamedShape | null): NamedShape {
  if (feature.operation === 'cut' && !input) {
    throw new FeatureError('No hay un sólido previo para cortar');
  }
  return combine(feature.operation, input, buildSweepTool(feature, profile, path), feature.id);
}

/** Cuerpo del barrido, antes de combinarlo con el sólido previo. */
export function buildSweepTool(feature: SweepFeature, profile: EvaluatedSketch, path: EvaluatedSketch): NamedShape {
  const oc = getOC();
  if (feature.profile === feature.path) throw new FeatureError('El perfil y la trayectoria tienen que ser sketches distintos');
  if (profile.regions.length === 0) throw new FeatureError('El sketch del perfil no tiene contornos cerrados');
  const spine = buildPathWire(path);
  const faces = buildSketchFaces(profile);
  const sweep = (group: Face[]): NamedShape => {
    const shape = group.length === 1 ? group[0] : makeCompound(group);
    let pipe: InstanceType<typeof oc.BRepOffsetAPI_MakePipe>;
    try {
      // Modo por defecto de OCCT: Frenet corregido (el perfil gira con la curva sin retorcerse).
      pipe = new oc.BRepOffsetAPI_MakePipe(spine.wrapped, shape.wrapped);
    } catch (err) {
      shape.delete();
      throw new FeatureError(`No se pudo barrer el perfil (${describeError(err)})`);
    }
    try {
      pipe.Build(new oc.Message_ProgressRange());
      if (!pipe.IsDone()) throw new FeatureError('No se pudo barrer el perfil por esa trayectoria');
      const result = cast(pipe.Shape());
      if (result.solids.length === 0 || !isValidShape(result)) {
        result.delete();
        throw new FeatureError('El barrido se cruza consigo mismo: probá con un perfil más chico o curvas más abiertas');
      }
      const nb = new NameBuilder(result);
      nameSweep(nb, historyOf(pipe), profile, shape, feature.id);
      nb.addAll(cast(pipe.FirstShape()), `${feature.id}:start`);
      nb.addAll(cast(pipe.LastShape()), `${feature.id}:end`);
      return nb.finish(feature.id);
    } finally {
      pipe.delete();
      shape.delete();
    }
  };
  try {
    return sweepRegions(faces, profile.overlapping, sweep, feature.id);
  } finally {
    spine.delete();
  }
}

/**
 * Trayectoria: las curvas (no de construcción) del sketch, ordenadas en una sola cadena
 * continua de líneas y arcos (abierta o cerrada), o un único círculo.
 */
export function buildPathWire(s: EvaluatedSketch) {
  const index = new SketchIndex(s.data);
  const curves = index.curves().filter((c) => !c.construction);
  if (curves.length === 0) throw new FeatureError('El sketch de la trayectoria está vacío');
  const P3 = (u: number, v: number) => toWorld(s.frame, u, v);
  const circles = curves.filter((c) => c.type === 'circle');
  if (circles.length > 0) {
    if (curves.length > 1) throw new FeatureError('La trayectoria tiene que ser una sola cadena: un círculo solo, o líneas y arcos unidos');
    const c = circles[0];
    const [cu, cv] = index.point(c.center);
    const edge = makeCircle(c.radius, P3(cu, cv), s.frame.normal);
    try {
      return assembleWire([edge]);
    } finally {
      edge.delete();
    }
  }

  // Extremos de cada curva (en coordenadas del sketch) y armado de la cadena.
  type Seg = { id: string; a: [number, number]; b: [number, number]; make: (rev: boolean) => Edge };
  const segs: Seg[] = curves.map((c) => {
    if (c.type === 'line') {
      const a = index.point(c.p1) as [number, number];
      const b = index.point(c.p2) as [number, number];
      return { id: c.id, a, b, make: (rev) => (rev ? makeLine(P3(...b), P3(...a)) : makeLine(P3(...a), P3(...b))) };
    }
    if (c.type !== 'arc') throw new FeatureError('Curva no soportada en la trayectoria');
    const ap = arcParams(index, c);
    const a = index.point(c.start) as [number, number];
    const b = index.point(c.end) as [number, number];
    const mid = (ap.startAngle + ap.endAngle) / 2;
    const m = P3(ap.center[0] + ap.radius * Math.cos(mid), ap.center[1] + ap.radius * Math.sin(mid));
    return { id: c.id, a, b, make: (rev) => (rev ? makeThreePointArc(P3(...b), m, P3(...a)) : makeThreePointArc(P3(...a), m, P3(...b))) };
  });
  const same = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN_TOL;
  const degree = (p: [number, number]) => segs.reduce((n, s2) => n + (same(s2.a, p) ? 1 : 0) + (same(s2.b, p) ? 1 : 0), 0);
  for (const sg of segs) {
    if (degree(sg.a) > 2 || degree(sg.b) > 2) throw new FeatureError('La trayectoria se ramifica: tiene que ser una sola cadena sin bifurcaciones');
  }
  // Empieza por un extremo libre (cadena abierta) o por cualquiera (cerrada).
  const startSeg = segs.find((sg) => degree(sg.a) === 1) ?? segs.find((sg) => degree(sg.b) === 1) ?? segs[0];
  let cursor = degree(startSeg.a) === 1 || degree(startSeg.b) !== 1 ? startSeg.a : startSeg.b;
  const left = new Set(segs);
  const edges: Edge[] = [];
  try {
    while (left.size > 0) {
      const next = [...left].find((sg) => same(sg.a, cursor) || same(sg.b, cursor));
      if (!next) throw new FeatureError('La trayectoria tiene partes sueltas: tiene que ser una sola cadena continua');
      const rev = !same(next.a, cursor);
      edges.push(next.make(rev));
      cursor = rev ? next.a : next.b;
      left.delete(next);
    }
    return assembleWire(edges);
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw new FeatureError(`No se pudo armar la trayectoria (${describeError(err)})`);
  } finally {
    edges.forEach((e) => e.delete());
  }
}

export function runLoft(feature: LoftFeature, sections: EvaluatedSketch[], input: NamedShape | null): NamedShape {
  if (feature.operation === 'cut' && !input) {
    throw new FeatureError('No hay un sólido previo para cortar');
  }
  return combine(feature.operation, input, buildLoftTool(feature, sections), feature.id);
}

/** Cuerpo de la solevación, antes de combinarlo con el sólido previo. */
export function buildLoftTool(feature: LoftFeature, sections: EvaluatedSketch[]): NamedShape {
  const oc = getOC();
  if (sections.length < 2) throw new FeatureError('Una solevación necesita al menos dos secciones');
  if (new Set(feature.sections).size !== feature.sections.length) throw new FeatureError('Hay secciones repetidas');
  sections.forEach((s, i) => {
    if (s.regions.length !== 1) {
      throw new FeatureError(`La sección ${i + 1} tiene que tener exactamente un contorno cerrado (tiene ${s.regions.length})`);
    }
    if (s.regions[0].holes.length > 0) throw new FeatureError(`La sección ${i + 1} tiene agujeros: la solevación usa solo el contorno exterior`);
  });
  const wires = sections.map((s) => buildOuterWires(s)[0]);
  const loft = new oc.BRepOffsetAPI_ThruSections(true, feature.ruled, 1e-6);
  try {
    for (const w of wires) loft.AddWire(w.wrapped);
    // Ajusta secciones con distinta cantidad de aristas (por ejemplo, cuadrado a círculo).
    loft.CheckCompatibility(true);
    loft.Build(new oc.Message_ProgressRange());
    if (!loft.IsDone()) throw new FeatureError('No se pudo unir las secciones');
    const result = cast(loft.Shape());
    if (result.solids.length === 0 || !isValidShape(result)) {
      result.delete();
      throw new FeatureError('La solevación se cruza consigo misma: revisá que las secciones no se superpongan y estén en orden');
    }
    const nb = new NameBuilder(result);
    // Caras laterales: por la curva de la primera sección que las generó.
    nameSweep(nb, historyOf(loft), sections[0], wires[0], feature.id);
    nb.addAll(cast(loft.FirstShape()), `${feature.id}:start`);
    nb.addAll(cast(loft.LastShape()), `${feature.id}:end`);
    return nb.finish(feature.id);
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw new FeatureError(`No se pudo hacer la solevación (${describeError(err)})`);
  } finally {
    loft.delete();
    wires.forEach((w) => w.delete());
  }
}
