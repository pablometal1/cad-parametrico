// Barrido (perfil a lo largo de una trayectoria) y solevación (superficie entre secciones).
import { assembleWire, cast, getOC, makeBSplineApproximation, makeCircle, makeCompound, makeLine, makeThreePointArc, makeVertex, type AnyShape, type Edge, type Face, type Vertex, type Wire } from 'replicad';
import { cross as cross3, dist3, toWorld, type Vec3 } from '../../document/planes';
import type { FeatureId, LoftFeature, LoftSection, SweepFeature } from '../../document/types';
import { arcParams } from '../../sketch/geometry';
import { SketchIndex } from '../../sketch/model';
import { historyOf, NameBuilder, resolveEdge, resolveFace, ShapeTable, type History, type NamedShape, type OcShape } from '../naming';
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
    const range = new oc.Message_ProgressRange();
    try {
      pipe.Build(range);
      if (!pipe.IsDone()) throw new FeatureError('No se pudo barrer el perfil por esa trayectoria');
      const result = cast(pipe.Shape());
      if (result.solids.length === 0 || !isValidShape(result)) {
        result.delete();
        throw new FeatureError('El barrido se cruza consigo mismo: probá con un perfil más chico o curvas más abiertas');
      }
      const nb = new NameBuilder(result);
      nameSweep(nb, historyOf(pipe), profile, shape, feature.id);
      nb.addCap(pipe.FirstShape(), `${feature.id}:start`);
      nb.addCap(pipe.LastShape(), `${feature.id}:end`);
      return nb.finish(feature.id);
    } finally {
      range.delete();
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
 * Sección ya resuelta: un sketch del documento, el contorno exterior de una cara del modelo, o una
 * cadena de aristas del modelo (el llamador es dueño del wire). `input` es el sólido de donde salen
 * la cara o las aristas (para continuar tangente a sus caras vecinas).
 */
export type LoftSectionInput =
  | { kind: 'sketch'; sketch: EvaluatedSketch }
  | { kind: 'face'; wire: Wire; faceIndex: number; input: NamedShape }
  | { kind: 'edges'; wire: Wire; input: NamedShape };

export function runLoft(feature: LoftFeature, sections: LoftSectionInput[], input: NamedShape | null, spine: EvaluatedSketch | null = null): NamedShape {
  if (feature.operation === 'cut' && !input) {
    throw new FeatureError('No hay un sólido previo para cortar');
  }
  const tool = buildLoftTool(feature, sections, spine);
  // Una superficie sin espesor va como cuerpo aparte (no se puede unir ni cortar).
  return combine(tool.shape.solids.length === 0 ? 'new' : feature.operation, input, tool, feature.id);
}

/** De dónde sale una sección del modelo (para continuar tangente a sus caras vecinas). */
type Source = { kind: 'face'; faceIndex: number; input: NamedShape } | { kind: 'edges'; input: NamedShape };

type Prepared =
  | { kind: 'wire'; wire: Wire; open: boolean; sketch: EvaluatedSketch | null; source?: Source }
  | { kind: 'vertex'; vertex: Vertex; at: Vec3 };

/** Una sección como wire (cerrado o abierto) o como punto. El llamador es dueño del resultado. */
function prepareSection(sec: LoftSectionInput, i: number): Prepared {
  const name = `La sección ${i + 1}`;
  if (sec.kind === 'face') return { kind: 'wire', wire: sec.wire.clone() as Wire, open: false, sketch: null, source: { kind: 'face', faceIndex: sec.faceIndex, input: sec.input } };
  if (sec.kind === 'edges') {
    return { kind: 'wire', wire: sec.wire.clone() as Wire, open: !sec.wire.isClosed, sketch: null, source: { kind: 'edges', input: sec.input } };
  }
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
    // Como en Plasticity: contornos de sketch o caras dan un sólido; curvas abiertas, aristas del
    // modelo o «solo superficie», una superficie (sin espesor, o engrosada si se pide).
    const surface = open || !!feature.surface || prepared.some((p) => p.kind === 'wire' && p.source?.kind === 'edges');
    const thickness = feature.thickness ?? 0;
    if (!(thickness >= 0)) throw new FeatureError(`El espesor no puede ser negativo (es ${thickness})`);

    if (!open) orientSections(prepared, closed, keep);

    // Continuidad: en los extremos que salen de una cara o de aristas del modelo, una sección auxiliar
    // desplazada en la dirección de la cara vecina hace que la superficie la continúe (tangente).
    // Dos secciones con continuidad: secciones intermedias sobre una Bézier cúbica entre ellas
    // (sin el sobrepaso que da interpolar las auxiliares).
    const bridged = feature.continuity && !spine && !feature.ruled && !closed && prepared.length === 2
      ? bridgeSections(prepared[0], prepared[1], feature.tensionStart ?? 1, feature.tensionEnd ?? 1, keep)
      : null;
    if (bridged) prepared.splice(1, 0, ...bridged.map((wire): Prepared => ({ kind: 'wire', wire, open, sketch: null })));
    if (!bridged && feature.continuity && !spine && !feature.ruled && !closed) {
      const ends = [0, prepared.length - 1];
      const aux = ends.map((i) => {
        const p = prepared[i];
        if (p.kind !== 'wire' || !p.source) return null;
        const other = prepared[i === 0 ? 1 : prepared.length - 2];
        const here = wireFrame(p.wire).center;
        const there = other.kind === 'wire' ? wireFrame(other.wire).center : other.at;
        const tension = (i === 0 ? feature.tensionStart : feature.tensionEnd) ?? 1;
        if (!(tension > 0)) throw new FeatureError(`La tensión tiene que ser mayor que 0 (es ${tension})`);
        const d = TENSION_SCALE * tension * dist3(there, here);
        let w = continuationWire(p.wire, p.source, there, d);
        keep.push(w);
        // Mismo sentido de recorrido que su sección (si no, la superficie se retuerce).
        if (!open) {
          const [a, b] = [wireFrame(p.wire).normal, wireFrame(w).normal];
          if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) {
            w = cast(w.wrapped.Reversed()) as Wire;
            keep.push(w);
          }
        }
        return w;
      });
      if (aux[1]) prepared.splice(prepared.length - 1, 0, { kind: 'wire', wire: aux[1], open, sketch: null });
      if (aux[0]) prepared.splice(1, 0, { kind: 'wire', wire: aux[0], open, sketch: null });
    }

    let result: AnyShape;
    let history: History;
    let maker: { FirstShape(): OcShape; LastShape(): OcShape };
    const range = new oc.Message_ProgressRange();
    keep.push(range);
    if (spine) {
      const path = buildPathWire(spine);
      keep.push(path);
      const pipe = new oc.BRepOffsetAPI_MakePipeShell(path.wrapped);
      keep.push(pipe);
      try {
        for (const p of prepared) pipe.Add(p.kind === 'wire' ? p.wire.wrapped : p.vertex.wrapped, false, false);
        pipe.Build(range);
      } catch (err) {
        throw new FeatureError(`No se pudo seguir la trayectoria central (${describeError(err)})`);
      }
      if (!pipe.IsDone()) throw new FeatureError('No se pudo seguir la trayectoria central: revisá que las secciones estén sobre ella y en orden');
      if (!surface && !pipe.MakeSolid()) throw new FeatureError('La solevación por la trayectoria no se pudo cerrar como sólido');
      result = cast(pipe.Shape());
      history = historyOf(pipe);
      maker = pipe;
    } else {
      const loft = new oc.BRepOffsetAPI_ThruSections(!surface, feature.ruled, 1e-6);
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
        loft.Build(range);
      } catch (err) {
        throw new FeatureError(`No se pudo hacer la solevación (${describeError(err)})`);
      }
      if (!loft.IsDone()) throw new FeatureError('No se pudo unir las secciones');
      result = cast(loft.Shape());
      history = historyOf(loft);
      maker = loft;
    }

    if (surface) {
      if (!isValidShape(result) || result.faces.length === 0) {
        result.delete();
        throw new FeatureError('La superficie de la solevación se cruza consigo misma: revisá el orden de las secciones');
      }
      const body = thickness > 0 ? thickenSheet(result, thickness, 'la solevación') : result;
      if (body !== result) result.delete();
      const nb = new NameBuilder(body);
      nb.addAll(body, `${feature.id}:sheet`);
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
    if (!closed) {
      nb.addCap(maker.FirstShape(), `${feature.id}:start`);
      nb.addCap(maker.LastShape(), `${feature.id}:end`);
    }
    return nb.finish(feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}

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

/** Índices de las caras (de la lista `faces`, leída una sola vez) que tocan la arista. */
function adjacentFaces(faces: Face[], edge: Edge): number[] {
  return faces.flatMap((f, i) => (f.edges.some((e) => e.isSame(edge)) ? [i] : []));
}

const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

/** Dirección que continúa la cara más allá de la arista: sobre la cara, perpendicular a la arista, hacia afuera. */
function outward(face: Face, edge: Edge, t: number): { at: Vec3; dir: Vec3 } {
  const at = edge.pointAt(t).toTuple() as Vec3;
  const tan = edge.tangentAt(t).toTuple() as Vec3;
  const pv = edge.pointAt(t);
  const n = face.normalAt(pv).toTuple() as Vec3;
  pv.delete();
  let dir = unit3(cross3(n, tan));
  const c = face.center.toTuple();
  if (dir[0] * (at[0] - c[0]) + dir[1] * (at[1] - c[1]) + dir[2] * (at[2] - c[2]) < 0) dir = [-dir[0], -dir[1], -dir[2]];
  return { at, dir };
}

/** Ordena tramos muestreados de las aristas de un wire en una sola cadena continua por sus extremos. */
function orderPointChains<T extends { base: Vec3[] }>(raw: T[], flip: (item: T) => T): T[] | null {
  if (!raw.length) return [];
  const near = (a: Vec3, b: Vec3) => dist3(a, b) < 1e-6;
  const left = raw.slice();
  const out = [left.shift()!];
  while (left.length) {
    const tail = out[out.length - 1].base.at(-1)!;
    const head = out[0].base[0];
    const i = left.findIndex((c) => near(c.base[0], tail) || near(c.base.at(-1)!, tail));
    if (i >= 0) {
      const c = left.splice(i, 1)[0];
      out.push(near(c.base[0], tail) ? c : flip(c));
      continue;
    }
    const j = left.findIndex((c) => near(c.base[0], head) || near(c.base.at(-1)!, head));
    if (j < 0) return null;
    const c = left.splice(j, 1)[0];
    out.unshift(near(c.base.at(-1)!, head) ? c : flip(c));
  }
  return out;
}

/** Promedia los extremos compartidos entre tramos consecutivos y construye una arista (recta o BSpline) por tramo. */
function chainsToEdges(chains: Vec3[][], closedLoop: boolean): Edge[] {
  const n = chains.length;
  const join = (x: Vec3[], y: Vec3[]) => {
    const m = [0, 1, 2].map((k) => (x[x.length - 1][k] + y[0][k]) / 2) as Vec3;
    x[x.length - 1] = m;
    y[0] = m;
  };
  for (let i = 0; i + 1 < n; i++) join(chains[i], chains[i + 1]);
  if (closedLoop && n > 1) join(chains[n - 1], chains[0]);
  if (closedLoop && n === 1) chains[0][chains[0].length - 1] = chains[0][0];
  return chains.map((pts) => {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const chord = [last[0] - first[0], last[1] - first[1], last[2] - first[2]] as Vec3;
    const l = Math.hypot(...chord);
    const off = l > 1e-9 ? Math.max(...pts.map((p) => Math.hypot(...cross3(chord, [p[0] - first[0], p[1] - first[1], p[2] - first[2]])) / l)) : Infinity;
    return off < 1e-7 ? makeLine(first, last) : makeBSplineApproximation(pts, { tolerance: 1e-4, degMax: 3, degMin: 2 });
  });
}

/**
 * Contorno auxiliar para la continuidad: cada arista de la sección desplazada `d` mm en la
 * dirección que continúa su cara vecina (de una cara elegida, la otra cara de cada arista; de
 * aristas sueltas, la cara que mira hacia la sección siguiente `toward`).
 */
function continuationWire(wire: Wire, source: Source, toward: Vec3, d: number): Wire {
  const N = 12;
  // Por arista: puntos originales (para encadenar) y desplazados.
  const raw: { base: Vec3[]; moved: Vec3[] }[] = [];
  // La lista de caras se lee una sola vez: volver a leerla invalida los objetos anteriores.
  const all = source.input.shape.faces;
  for (const e of wire.edges) {
    const face = continuationFace(all, e, source, toward);
    const base: Vec3[] = [];
    const moved: Vec3[] = [];
    for (let k = 0; k <= N; k++) {
      const { at, dir } = outward(face, e, k / N);
      base.push(at);
      moved.push([at[0] + dir[0] * d, at[1] + dir[1] * d, at[2] + dir[2] * d]);
    }
    raw.push({ base, moved });
  }
  const ordered = orderPointChains(raw, (r) => ({ base: r.base.slice().reverse(), moved: r.moved.slice().reverse() }));
  if (!ordered) throw new FeatureError('Las aristas de la sección no forman una cadena: no se puede armar la continuidad');
  const edges = chainsToEdges(ordered.map((r) => r.moved), wire.isClosed);
  try {
    return assembleWire(edges);
  } catch (err) {
    throw new FeatureError(`No se pudo armar la continuidad tangente (${describeError(err)})`);
  } finally {
    edges.forEach((e) => e.delete());
  }
}

/** Ordena aristas sueltas en una cadena continua y arma el wire (abierto o cerrado). */
export function chainWire(edges: Edge[]): Wire {
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
  const left = edges.slice();
  const order: Edge[] = [left.shift()!];
  let head = order[0].startPoint.toTuple();
  let tail = order[0].endPoint.toTuple();
  while (left.length) {
    const i = left.findIndex((e) => {
      const [a, b] = [e.startPoint.toTuple(), e.endPoint.toTuple()];
      return near(a, tail) || near(b, tail) || near(a, head) || near(b, head);
    });
    if (i < 0) throw new FeatureError('Las aristas de la sección no forman una sola cadena continua');
    const e = left.splice(i, 1)[0];
    const [a, b] = [e.startPoint.toTuple(), e.endPoint.toTuple()];
    if (near(a, tail)) [order.push(e), (tail = b)];
    else if (near(b, tail)) [order.push(e), (tail = a)];
    else if (near(b, head)) [order.unshift(e), (head = a)];
    else [order.unshift(e), (head = b)];
  }
  try {
    return assembleWire(order);
  } catch (err) {
    throw new FeatureError(`Las aristas de la sección no forman una cadena (${describeError(err)})`);
  }
}

/** Distancia de la sección auxiliar de continuidad, como fracción de la distancia a la sección vecina. */
const TENSION_SCALE = 0.3;

/** Cara cuya continuación sigue la superficie en la arista `e` de una sección del modelo. */
function continuationFace(all: Face[], e: Edge, source: Source, toward: Vec3): Face {
  const faces = adjacentFaces(all, e).filter((i) => source.kind !== 'face' || i !== source.faceIndex).map((i) => all[i]);
  if (!faces.length) throw new FeatureError('Una arista de la sección no toca ninguna cara del modelo: desactivá «Tangente a las caras»');
  if (source.kind !== 'edges' || faces.length === 1) return faces[0];
  const score = (f: Face) => {
    const { at, dir } = outward(f, e, 0.5);
    return dir[0] * (toward[0] - at[0]) + dir[1] * (toward[1] - at[1]) + dir[2] * (toward[2] - at[2]);
  };
  return faces.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/** Centro aproximado de una sección (para la distancia entre secciones y los manejadores). */
function sectionCenter(sec: LoftSection, input: NamedShape | null, sketches: Map<FeatureId, EvaluatedSketch>): Vec3 | null {
  if (typeof sec === 'string') {
    const s = sketches.get(sec);
    if (!s) return null;
    const pts = s.data.entities.filter((e) => e.type === 'point').map((p) => (p.type === 'point' ? toWorld(s.frame, p.x, p.y) : [0, 0, 0] as Vec3));
    if (!pts.length) return null;
    return [0, 1, 2].map((k) => pts.reduce((acc, p) => acc + p[k], 0) / pts.length) as Vec3;
  }
  if (!input) return null;
  const w = modelSectionWire(sec, input);
  try {
    return wireFrame(w.wire).center;
  } finally {
    w.wire.delete();
  }
}

function modelSectionWire(sec: Exclude<LoftSection, string>, input: NamedShape): { wire: Wire; source: Source } {
  if ('edges' in sec) {
    const table = ShapeTable.edges(input.shape);
    return { wire: chainWire([...new Set(sec.edges.map((r) => resolveEdge(input, r)))].map((k) => table.items[k])), source: { kind: 'edges', input } };
  }
  const faceIndex = resolveFace(input, sec.face);
  return { wire: input.shape.faces[faceIndex].outerWire(), source: { kind: 'face', faceIndex, input } };
}

/**
 * Manejadores de tensión de una solevación con continuidad: en cada extremo que sale de una cara o
 * de aristas del modelo, el centro de la sección, la dirección en que la superficie continúa la cara
 * y cuántos mm mueve una unidad de tensión.
 */
export function loftTensionHandles(feature: LoftFeature, input: NamedShape | null, sketches: Map<FeatureId, EvaluatedSketch>):
  { param: 'tensionStart' | 'tensionEnd'; center: Vec3; dir: Vec3; scale: number; value: number }[] {
  if (!feature.continuity || feature.spine || feature.ruled || feature.closed || !input || feature.sections.length < 2) return [];
  const n = feature.sections.length;
  const out: ReturnType<typeof loftTensionHandles> = [];
  for (const [i, param] of [[0, 'tensionStart'], [n - 1, 'tensionEnd']] as const) {
    const sec = feature.sections[i];
    if (typeof sec === 'string') continue;
    const toward = sectionCenter(feature.sections[i === 0 ? 1 : n - 2], input, sketches);
    if (!toward) continue;
    const { wire, source } = modelSectionWire(sec, input);
    try {
      const all = input.shape.faces;
      const sum: Vec3 = [0, 0, 0];
      for (const e of wire.edges) {
        const { dir } = outward(continuationFace(all, e, source, toward), e, 0.5);
        for (let k = 0; k < 3; k++) sum[k] += dir[k];
      }
      const center = wireFrame(wire).center;
      const dist = dist3(toward, center);
      const dir = unit3(sum);
      if (Math.hypot(...dir) < 0.5 || dist < 1e-9) continue;
      out.push({ param, center, dir, scale: TENSION_SCALE * dist, value: feature[param] ?? 1 });
    } finally {
      wire.delete();
    }
  }
  return out;
}

type Chain = { base: Vec3[]; dir: Vec3[] | null };

/**
 * Muestras de una sección en orden de recorrido: por arista, puntos y (si sale del modelo) la
 * dirección que continúa su cara vecina en cada uno.
 */
function sectionChains(wire: Wire, source: Source | undefined, toward: Vec3, N: number): Chain[] {
  const all = source ? source.input.shape.faces : [];
  const raw: Chain[] = wire.edges.map((e) => {
    const face = source ? continuationFace(all, e, source, toward) : null;
    const base: Vec3[] = [];
    const dir: Vec3[] = [];
    for (let k = 0; k <= N; k++) {
      if (face) {
        const o = outward(face, e, k / N);
        base.push(o.at);
        dir.push(o.dir);
      } else base.push(e.pointAt(k / N).toTuple() as Vec3);
    }
    return { base, dir: face ? dir : null };
  });
  return orderPointChains(raw, (c) => ({ base: c.base.slice().reverse(), dir: c.dir ? c.dir.slice().reverse() : null })) ?? [];
}

/**
 * Secciones intermedias entre dos secciones con la misma cantidad de aristas: cada punto recorre
 * una Bézier cúbica de su punto en A a su par en B, con controles en la dirección que continúa la
 * cara vecina (o un tercio del camino si ese extremo no sale del modelo). null si no se pueden
 * emparejar (distinta cantidad de aristas, o un punto como sección).
 */
function bridgeSections(a: Prepared, b: Prepared, tensionA: number, tensionB: number, keep: { delete(): void }[]): Wire[] | null {
  if (a.kind !== 'wire' || b.kind !== 'wire' || (!a.source && !b.source)) return null;
  if (!(tensionA > 0) || !(tensionB > 0)) throw new FeatureError('La tensión tiene que ser mayor que 0');
  const N = 12;
  const ca = wireFrame(a.wire).center;
  const cb = wireFrame(b.wire).center;
  const A = sectionChains(a.wire, a.source, cb, N);
  let B = sectionChains(b.wire, b.source, ca, N);
  if (!A.length || A.length !== B.length) return null;
  const n = A.length;
  const closedLoop = !a.open;
  const mid = (c: Chain) => c.base[N >> 1];
  // Emparejar: mismo sentido de recorrido y el corrimiento de aristas que deja los pares más cerca.
  const reversed = (cs: Chain[]): Chain[] => cs.slice().reverse().map((c) => ({ base: c.base.slice().reverse(), dir: c.dir ? c.dir.slice().reverse() : null }));
  const score = (cs: Chain[], shift: number) => A.reduce((acc, c, i) => acc + dist3(mid(c), mid(cs[(i + shift) % n])) + dist3(c.base[0], cs[(i + shift) % n].base[0]), 0);
  let best = { cs: B, shift: 0, v: Infinity };
  for (const cs of [B, reversed(B)]) {
    for (let sh = 0; sh < (closedLoop ? n : 1); sh++) {
      const v = score(cs, sh);
      if (v < best.v) best = { cs, shift: sh, v };
    }
  }
  B = A.map((_, i) => best.cs[(i + best.shift) % n]);
  const d = TENSION_SCALE * dist3(ca, cb);
  const wires: Wire[] = [];
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    const chains = A.map((ch, i) => ch.base.map((P, k) => {
      const Q = B[i].base[k];
      const c1 = ch.dir ? P.map((v, m) => v + ch.dir![k][m] * d * tensionA) : P.map((v, m) => v + (Q[m] - v) / 3);
      const c2 = B[i].dir ? Q.map((v, m) => v + B[i].dir![k][m] * d * tensionB) : Q.map((v, m) => v + (P[m] - v) / 3);
      return [0, 1, 2].map((m) => w[0] * P[m] + w[1] * c1[m] + w[2] * c2[m] + w[3] * Q[m]) as Vec3;
    }));
    const edges = chainsToEdges(chains, closedLoop);
    try {
      const wire = assembleWire(edges);
      keep.push(wire);
      wires.push(wire);
    } catch {
      return null;
    } finally {
      edges.forEach((e) => e.delete());
    }
  }
  return wires;
}
