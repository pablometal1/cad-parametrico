// Barrido (perfil a lo largo de una trayectoria) y solevación (superficie entre secciones).
import { assembleWire, cast, getOC, makeCircle, makeCompound, makeLine, makeThreePointArc, makeVertex, type AnyShape, type Edge, type Face, type Vertex, type Wire } from 'replicad';
import { toWorld, type Vec3 } from '../../document/planes';
import type { LoftFeature, SweepFeature } from '../../document/types';
import { arcParams } from '../../sketch/geometry';
import { SketchIndex } from '../../sketch/model';
import { historyOf, NameBuilder, type History, type NamedShape } from '../naming';
import { thickenSheet } from './surface';
import { describeError, FeatureError, isValidShape } from '../occtUtils';
import { combine, sweepRegions } from './boolean';
import { buildOuterWires, buildSketchFaces, curveEdges, hasProfiles, nameSweep, type EvaluatedSketch } from './sketch';

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
  if (!hasProfiles(profile)) throw new FeatureError('El sketch del perfil no tiene contornos cerrados');
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
 * continua de líneas, arcos y splines (abierta o cerrada), o un único círculo o spline cerrada.
 */
export function buildPathWire(s: EvaluatedSketch) {
  const index = new SketchIndex(s.data);
  const curves = index.curves().filter((c) => !c.construction);
  if (curves.length === 0) throw new FeatureError('El sketch de la trayectoria está vacío');
  const P3 = (u: number, v: number) => toWorld(s.frame, u, v);
  const loops = curves.filter((c) => c.type === 'circle' || (c.type === 'spline' && c.closed));
  if (loops.length > 0) {
    if (curves.length > 1) throw new FeatureError('La trayectoria tiene que ser una sola cadena: un círculo o spline cerrada sola, o líneas, arcos y splines unidos');
    const c = loops[0];
    const edges = c.type === 'circle' ? [makeCircle(c.radius, P3(...index.point(c.center)), s.frame.normal)] : curveEdges(index, s.frame, c, false);
    try {
      return assembleWire(edges);
    } finally {
      edges.forEach((e) => e.delete());
    }
  }

  // Extremos de cada curva (en coordenadas del sketch) y armado de la cadena.
  type Seg = { id: string; a: [number, number]; b: [number, number]; make: (rev: boolean) => Edge | Edge[] };
  const segs: Seg[] = curves.map((c) => {
    if (c.type === 'spline') {
      const a = index.point(c.points[0]) as [number, number];
      const b = index.point(c.points[c.points.length - 1]) as [number, number];
      return { id: c.id, a, b, make: (rev) => curveEdges(index, s.frame, c, rev) };
    }
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
      edges.push(...[next.make(rev)].flat());
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

/**
 * Sección ya resuelta: un sketch del documento, o el contorno exterior de una cara del modelo
 * (el llamador es dueño del wire).
 */
export type LoftSectionInput = { kind: 'sketch'; sketch: EvaluatedSketch } | { kind: 'face'; wire: Wire };

export function runLoft(feature: LoftFeature, sections: LoftSectionInput[], input: NamedShape | null, spine: EvaluatedSketch | null = null): NamedShape {
  if (feature.operation === 'cut' && !input) {
    throw new FeatureError('No hay un sólido previo para cortar');
  }
  return combine(feature.operation, input, buildLoftTool(feature, sections, spine), feature.id);
}

type Prepared =
  | { kind: 'wire'; wire: Wire; open: boolean; sketch: EvaluatedSketch | null }
  | { kind: 'vertex'; vertex: Vertex; at: Vec3 };

/** Una sección como wire (cerrado o abierto) o como punto. El llamador es dueño del resultado. */
function prepareSection(sec: LoftSectionInput, i: number): Prepared {
  const name = `La sección ${i + 1}`;
  if (sec.kind === 'face') return { kind: 'wire', wire: sec.wire.clone() as Wire, open: false, sketch: null };
  const s = sec.sketch;
  if (s.regions.length > 1) {
    throw new FeatureError(`${name} tiene que tener exactamente un contorno cerrado, una curva abierta o un punto (tiene ${s.regions.length} contornos)`);
  }
  if (s.regions.length === 1) {
    if (s.regions[0].holes.length > 0) throw new FeatureError(`${name} tiene agujeros: la solevación usa solo el contorno exterior`);
    return { kind: 'wire', wire: buildOuterWires(s)[0], open: false, sketch: s };
  }
  const index = new SketchIndex(s.data);
  if (index.curves().some((c) => !c.construction)) {
    try {
      return { kind: 'wire', wire: buildPathWire(s), open: true, sketch: s };
    } catch (err) {
      if (err instanceof FeatureError) throw new FeatureError(`${name} tiene que ser un contorno cerrado, una sola curva abierta continua o un punto`);
      throw err;
    }
  }
  const points = s.data.entities.filter((e) => e.type === 'point');
  const p = points[0];
  if (points.length === 1 && p.type === 'point') {
    const at = toWorld(s.frame, p.x, p.y);
    return { kind: 'vertex', vertex: makeVertex(at), at };
  }
  throw new FeatureError(`${name} está vacía o tiene varios puntos sueltos: dibujá un contorno cerrado, una curva abierta o un solo punto`);
}

/** Cuerpo de la solevación, antes de combinarlo con el sólido previo. */
export function buildLoftTool(feature: LoftFeature, sections: LoftSectionInput[], spine: EvaluatedSketch | null = null): NamedShape {
  const oc = getOC();
  const closed = !!feature.closed;
  if (sections.length < 2) throw new FeatureError('Una solevación necesita al menos dos secciones');
  const sketchIds = feature.sections.filter((x) => typeof x === 'string');
  if (new Set(sketchIds).size !== sketchIds.length) throw new FeatureError('Hay secciones repetidas');
  if (closed && sections.length < 3) throw new FeatureError('Para cerrar la solevación en un anillo hacen falta al menos tres secciones');
  if (closed && spine) throw new FeatureError('Una solevación con trayectoria central no se puede cerrar en anillo');

  const prepared: Prepared[] = [];
  const keep: { delete(): void }[] = [];
  try {
    sections.forEach((sec, i) => {
      const p = prepareSection(sec, i);
      prepared.push(p);
      keep.push(p.kind === 'wire' ? p.wire : p.vertex);
    });
    const wires = prepared.filter((p): p is Extract<Prepared, { kind: 'wire' }> => p.kind === 'wire');
    prepared.forEach((p, i) => {
      if (p.kind === 'vertex' && i !== 0 && i !== prepared.length - 1) {
        throw new FeatureError(`La sección ${i + 1} es un punto: un punto solo puede ser la primera o la última sección`);
      }
    });
    if (wires.length === 0) throw new FeatureError('Hace falta al menos una sección que no sea un punto');
    if (closed && wires.length !== prepared.length) throw new FeatureError('Una solevación cerrada en anillo no puede tener puntos como sección');
    const open = wires[0].open;
    if (wires.some((w) => w.open !== open)) {
      throw new FeatureError('Las secciones tienen que ser todas contornos cerrados (sólido) o todas curvas abiertas (superficie)');
    }
    if (open && wires.length !== prepared.length) throw new FeatureError('Con secciones abiertas (superficie) no se puede terminar en un punto');
    if (open && !(feature.thickness !== undefined && feature.thickness > 0)) {
      throw new FeatureError('Con secciones abiertas la solevación es una superficie: indicá un espesor mayor que 0');
    }

    if (!open) orientSections(prepared, closed, keep);

    let result: AnyShape;
    let history: History;
    let caps: { first: AnyShape | null; last: AnyShape | null } | null = null;
    if (spine) {
      const path = buildPathWire(spine);
      keep.push(path);
      const pipe = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
      keep.push(pipe);
      try {
        for (const p of prepared) pipe.Add(p.kind === 'wire' ? p.wire.wrapped : p.vertex.wrapped, false, false);
        pipe.Build(new oc.Message_ProgressRange());
      } catch (err) {
        throw new FeatureError(`No se pudo seguir la trayectoria central (${describeError(err)})`);
      }
      if (!pipe.IsDone()) throw new FeatureError('No se pudo seguir la trayectoria central: revisá que las secciones estén sobre ella y en orden');
      if (!open && !pipe.MakeSolid()) throw new FeatureError('La solevación por la trayectoria no se pudo cerrar como sólido');
      result = cast(pipe.Shape());
      history = historyOf(pipe);
      if (!open) caps = capsOf(pipe);
    } else {
      const loft = new oc.BRepOffsetAPI_ThruSections(!open, feature.ruled, 1e-6);
      keep.push(loft);
      try {
        for (const p of prepared) {
          if (p.kind === 'wire') loft.AddWire(p.wire.wrapped);
          else loft.AddVertex(p.vertex.wrapped);
        }
        // Anillo: repetir la primera sección hace que OCCT arme una superficie periódica (suave).
        if (closed) loft.AddWire(wires[0].wire.wrapped);
        // Ajusta secciones con distinta cantidad de aristas (por ejemplo, cuadrado a círculo).
        loft.CheckCompatibility(true);
        loft.Build(new oc.Message_ProgressRange());
      } catch (err) {
        throw new FeatureError(`No se pudo hacer la solevación (${describeError(err)})`);
      }
      if (!loft.IsDone()) throw new FeatureError('No se pudo unir las secciones');
      result = cast(loft.Shape());
      history = historyOf(loft);
      if (!open && !closed) caps = capsOf(loft);
    }
    if (caps) keep.push(...[caps.first, caps.last].filter((c): c is AnyShape => !!c));

    if (open) {
      if (!isValidShape(result) || result.faces.length === 0) {
        result.delete();
        throw new FeatureError('La superficie de la solevación se cruza consigo misma: revisá el orden de las secciones');
      }
      const solid = thickenSheet(result, feature.thickness!, 'la solevación');
      result.delete();
      const nb = new NameBuilder(solid);
      nb.addAll(solid, `${feature.id}:sheet`);
      return nb.finish(feature.id);
    }
    if (result.solids.length === 0 || !isValidShape(result)) {
      result.delete();
      throw new FeatureError('La solevación se cruza consigo misma: revisá que las secciones no se superpongan y estén en orden');
    }
    const nb = new NameBuilder(result);
    // Caras laterales: por la curva de la primera sección de sketch que las generó.
    const named = wires.find((w) => w.sketch);
    if (named?.sketch) nameSweep(nb, history, named.sketch, named.wire, feature.id);
    if (caps?.first) nb.addAll(caps.first, `${feature.id}:start`);
    if (caps?.last) nb.addAll(caps.last, `${feature.id}:end`);
    return nb.finish(feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}

/** Tapas de inicio y fin (una sección que es un punto no tiene tapa). */
function capsOf(maker: { FirstShape(): OcShape; LastShape(): OcShape }): { first: AnyShape | null; last: AnyShape | null } {
  const get = (sh: OcShape) => (sh.IsNull() ? null : cast(sh));
  return { first: get(maker.FirstShape()), last: get(maker.LastShape()) };
}

type OcShape = ReturnType<Wire['wrapped']['Reversed']>;

/** Centro y normal (de Newell, según el sentido de recorrido) de un contorno cerrado. */
function wireFrame(w: Wire): { center: Vec3; normal: Vec3 } {
  const pts: Vec3[] = [];
  for (const e of w.edges) {
    const reversed = e.orientation === 'backward';
    for (let k = 0; k < 16; k++) {
      const t = reversed ? 1 - k / 16 : k / 16;
      pts.push(e.pointAt(t).toTuple() as Vec3);
    }
  }
  const center = [0, 1, 2].map((i) => pts.reduce((acc, p) => acc + p[i], 0) / pts.length) as Vec3;
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return { center, normal: n };
}

/**
 * Da vuelta los contornos que giran al revés respecto del recorrido: cada sketch tiene la normal
 * de su plano, y dos planos enfrentados (por ejemplo a los dos lados de un anillo) dejan contornos
 * con sentidos opuestos, lo que retuerce o anula la superficie.
 */
function orientSections(prepared: Prepared[], closed: boolean, keep: { delete(): void }[]) {
  const n = prepared.length;
  const pos = prepared.map((p) => (p.kind === 'wire' ? wireFrame(p.wire) : { center: p.at, normal: [0, 0, 0] as Vec3 }));
  prepared.forEach((p, i) => {
    if (p.kind !== 'wire') return;
    const prev = closed ? pos[(i - 1 + n) % n].center : pos[Math.max(0, i - 1)].center;
    const next = closed ? pos[(i + 1) % n].center : pos[Math.min(n - 1, i + 1)].center;
    const dir = [0, 1, 2].map((k) => next[k] - prev[k]);
    const nn = pos[i].normal;
    if (dir[0] * nn[0] + dir[1] * nn[1] + dir[2] * nn[2] < 0) {
      const flipped = cast(p.wire.wrapped.Reversed()) as Wire;
      keep.push(flipped);
      p.wire = flipped;
    }
  });
}
