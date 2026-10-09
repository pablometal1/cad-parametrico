// Feature de sketch en el kernel: resuelve las restricciones y construye las caras de sus perfiles.
import { assembleWire, cast, getOC, makeBezierCurve, makeCircle, makeFace, makeLine, makeThreePointArc, type AnyShape, type Edge, type Face } from 'replicad';
import { flattenContour, signedArea, textContours, textRegions, type TextContour } from '../../sketch/text';
import type { Vec2 } from '../../sketch/model';
import { basePlaneFrame, faceFrame, offsetFrame, scale, toPlane, toWorld, type PlaneFrame, type Vec3 } from '../../document/planes';
import type { FeatureId, SketchData, SketchFeature } from '../../document/types';
import { arcParams, curveDistance } from '../../sketch/geometry';
import { SketchIndex } from '../../sketch/model';
import { findChains, findProfiles, ProfileError, type LoopEdge, type ProfileLoop, type ProfileRegion } from '../../sketch/profiles';
import { solveSketch } from '../../sketch/solver';
import { splineBeziers } from '../../sketch/spline';
import { resolveFace, type History, type NameBuilder, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';

/** Resultado de evaluar un sketch: lo que necesitan las features que lo usan. */
export interface EvaluatedSketch {
  frame: PlaneFrame;
  data: SketchData;
  regions: ProfileRegion[];
  openChains: number;
  /** Regiones superpuestas: los cuerpos de cada región se unen. */
  overlapping: boolean;
  dof: number;
  /** Contorno de la cara de apoyo en coordenadas del sketch (pares u,v por segmento). */
  reference: number[];
  /** Textos del sketch: contornos de las letras en coordenadas del sketch. */
  text: { id: string; contours: TextContour[] }[];
}

/** ¿El sketch tiene algo para extruir/revolucionar? (perfiles cerrados o texto) */
export function hasProfiles(s: EvaluatedSketch) {
  return s.regions.length > 0 || s.text.some((t) => t.contours.length > 0);
}

export function evaluateSketch(
  feature: SketchFeature, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame> = new Map(),
): EvaluatedSketch {
  const { frame, reference } = sketchFrame(feature, input, planes);
  let solved;
  try {
    solved = solveSketch(feature);
  } catch (err) {
    throw new FeatureError((err as Error).message);
  }
  if (!solved.ok) {
    const detail = solved.conflicting.length ? `: en conflicto ${solved.conflicting.join(', ')}` : '';
    throw new FeatureError(`Las restricciones no tienen solución${detail}`);
  }
  if (solved.conflicting.length) {
    throw new FeatureError(`Restricciones en conflicto: ${solved.conflicting.join(', ')}`);
  }
  let analysis;
  try {
    analysis = findProfiles(solved.data);
  } catch (err) {
    if (err instanceof ProfileError) throw new FeatureError(err.message);
    throw err;
  }
  const index = new SketchIndex(solved.data);
  let text: EvaluatedSketch['text'];
  try {
    text = index.texts().map((t) => ({ id: t.id, contours: t.text.trim() ? textContours(t, index.point(t.point)) : [] }));
  } catch (err) {
    throw new FeatureError(`No se pudo armar el texto (${(err as Error).message})`);
  }
  const hasText = text.some((t) => t.contours.length > 0);
  return {
    frame,
    reference,
    data: solved.data,
    regions: analysis.regions,
    openChains: analysis.openChains,
    // Texto junto a otros perfiles: cada región se barre por separado y se unen.
    overlapping: analysis.overlapping || (hasText && (analysis.regions.length > 0 || text.length > 1)),
    dof: solved.dof,
    text,
  };
}

/** Plano del sketch: base, o la cara plana referenciada del sólido de entrada. */
function sketchFrame(
  feature: SketchFeature, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame>,
): { frame: PlaneFrame; reference: number[] } {
  const plane = feature.plane;
  if (plane.kind === 'base') return { frame: basePlaneFrame(plane), reference: [] };
  if (plane.kind === 'plane') {
    const f = planes.get(plane.plane);
    if (!f) throw new FeatureError('El plano de construcción del sketch no está disponible (borrado, suprimido, con error o más abajo en el historial)');
    return { frame: offsetFrame(f, plane.offset), reference: [] };
  }
  if (!input) throw new FeatureError('No hay un sólido donde apoyar el sketch');
  const face = input.shape.faces[resolveFace(input, plane.face)];
  if (face.geomType !== 'PLANE') throw new FeatureError('La cara de apoyo del sketch ya no es plana');
  const c = face.center;
  const frame = faceFrame(c.toTuple(), face.normalAt(c).toTuple(), plane.offset);
  return { frame, reference: outline(face, frame) };
}

/** Bordes de una cara proyectados al plano del sketch, como segmentos (u1,v1,u2,v2,…). */
function outline(face: Face, frame: PlaneFrame): number[] {
  const out: number[] = [];
  for (const e of face.edges) {
    const n = e.geomType === 'LINE' ? 1 : 32;
    let prev = toPlane(frame, e.pointAt(0).toTuple());
    for (let i = 1; i <= n; i++) {
      const p = toPlane(frame, e.pointAt(i / n).toTuple());
      out.push(prev[0], prev[1], p[0], p[1]);
      prev = p;
    }
  }
  return out;
}

/**
 * Nombra las caras laterales de un barrido (prisma o revolución) según la curva del sketch
 * que generó cada arista del perfil: `<feature>:side:<curva>`.
 */
export function nameSweep(nb: NameBuilder, history: History, s: EvaluatedSketch, profile: AnyShape, featureId: string, tolerance = 1e-4) {
  const index = new SketchIndex(s.data);
  const curves = index.curves().filter((c) => !c.construction);
  for (const edge of profile.edges) {
    const [u, v] = toPlane(s.frame, edge.pointAt(0.5).toTuple());
    let best: { id: string; d: number } | null = null;
    for (const c of curves) {
      const d = curveDistance(index, c, [u, v]);
      if (!best || d < best.d) best = { id: c.id, d };
    }
    if (best && best.d < tolerance) nb.generated(history, edge.wrapped, `${featureId}:side:${best.id}`);
  }
}

/** Texto informativo para el historial. */
export function describeSketch(s: EvaluatedSketch): string {
  if (s.data.entities.length === 0) return 'Vacío';
  const def = s.dof === 0 ? 'Totalmente definido' : `${s.dof} grado${s.dof === 1 ? '' : 's'} de libertad`;
  const texts = s.text.filter((t) => t.contours.length > 0).length;
  const profiles = (s.regions.length === 1 ? '1 perfil' : `${s.regions.length} perfiles`) + (texts ? ` · ${texts} texto${texts === 1 ? '' : 's'}` : '');
  const open = s.openChains > 0 ? ` · ${s.openChains} abierto${s.openChains === 1 ? '' : 's'}` : '';
  return `${def} · ${profiles}${open}`;
}

/**
 * Construye las caras planas de todas las regiones, desplazadas `offset` mm sobre la normal.
 * El llamador es dueño de las caras devueltas.
 */
export function buildSketchFaces(s: EvaluatedSketch, offset = 0): Face[] {
  const frame: PlaneFrame = { ...s.frame, origin: s.frame.origin.map((v, i) => v + s.frame.normal[i] * offset) as PlaneFrame['origin'] };
  const index = new SketchIndex(s.data);
  const faces: Face[] = [];
  for (const region of s.regions) {
    const outer = buildWire(index, frame, region.outer);
    const holes = region.holes.map((h) => buildWire(index, frame, h));
    let face: Face;
    try {
      face = makeFace(outer, holes);
    } catch {
      throw new FeatureError('No se pudo construir la cara de un perfil del sketch');
    } finally {
      outer.delete();
      holes.forEach((h) => h.delete());
    }
    if (!isValidShape(face)) {
      face.delete();
      throw new FeatureError('Un perfil del sketch se cruza consigo mismo o con otro perfil');
    }
    faces.push(face);
  }
  for (const t of s.text) faces.push(...buildTextFaces(t.contours, frame));
  return faces;
}

/** Caras planas de las letras (curvas de Bézier exactas), con sus agujeros. */
function buildTextFaces(contours: TextContour[], frame: PlaneFrame): Face[] {
  const faces: Face[] = [];
  const P = ([u, v]: Vec2) => toWorld(frame, u, v);
  const wire = (c: TextContour, ccw: boolean) => {
    // Exteriores antihorarios y agujeros horarios (en el plano del sketch).
    const poly = flattenContour(c);
    const reverse = signedArea(poly) > 0 !== ccw;
    const segs = reverse ? [...c].reverse().map((s) => [...s].reverse()) : c;
    const edges: Edge[] = segs.map((s) => (s.length === 2 ? makeLine(P(s[0]), P(s[1])) : makeBezierCurve(s.map(P))));
    try {
      return assembleWire(edges);
    } finally {
      edges.forEach((e) => e.delete());
    }
  };
  for (const region of textRegions(contours)) {
    const outer = wire(region.outer, true);
    const holes = region.holes.map((h) => wire(h, false));
    try {
      const face = makeFace(outer, holes);
      if (!isValidShape(face)) {
        face.delete();
        throw new FeatureError('Una letra del texto salió inválida');
      }
      faces.push(face);
    } finally {
      outer.delete();
      holes.forEach((h) => h.delete());
    }
  }
  return faces;
}

/** Wire del contorno exterior de cada región (para solevaciones). El llamador es dueño. */
export function buildOuterWires(s: EvaluatedSketch) {
  const index = new SketchIndex(s.data);
  return s.regions.map((r) => buildWire(index, s.frame, r.outer));
}

function buildWire(index: SketchIndex, frame: PlaneFrame, loop: ProfileLoop) {
  const edges = loopEdges(index, frame, loop.edges, loop.area < 0);
  try {
    return assembleWire(edges);
  } catch (err) {
    throw new FeatureError(`El contorno del sketch no forma un wire cerrado (${(err as Error).message})`);
  } finally {
    edges.forEach((e) => e.delete());
  }
}

/** Aristas 3D de una secuencia de curvas del sketch. `isHole`: los círculos van en sentido horario. */
function loopEdges(index: SketchIndex, frame: PlaneFrame, loopEdgeList: LoopEdge[], isHole: boolean): Edge[] {
  const P = (id: string) => {
    const [u, v] = index.point(id);
    return toWorld(frame, u, v);
  };
  return loopEdgeList.flatMap(({ curve, reversed }): Edge | Edge[] => {
    switch (curve.type) {
      case 'spline': {
        // Los mismos tramos de Bézier que dibuja el editor.
        const segs = splineBeziers(curve.points.map((id) => index.point(id)), curve.closed);
        const ordered = reversed ? segs.slice().reverse().map((sg) => sg.slice().reverse()) : segs;
        return ordered.map((sg) => makeBezierCurve(sg.map(([u, v]) => toWorld(frame, u, v))));
      }
      case 'line':
        return reversed ? makeLine(P(curve.p2), P(curve.p1)) : makeLine(P(curve.p1), P(curve.p2));
      case 'circle': {
        const [cu, cv] = index.point(curve.center);
        // Un círculo de agujero se recorre en sentido horario: normal invertida.
        return makeCircle(curve.radius, toWorld(frame, cu, cv), isHole ? scale(frame.normal, -1) : frame.normal);
      }
      case 'arc': {
        const ap = arcParams(index, curve);
        const mid = (ap.startAngle + ap.endAngle) / 2;
        const m = toWorld(frame, ap.center[0] + ap.radius * Math.cos(mid), ap.center[1] + ap.radius * Math.sin(mid));
        return reversed ? makeThreePointArc(P(curve.end), m, P(curve.start)) : makeThreePointArc(P(curve.start), m, P(curve.end));
      }
    }
  });
}

/**
 * Caras de una extrusión delgada: cada cadena del sketch se engrosa `thickness` mm, centrada en
 * la curva. Abierta: los dos lados unidos con tapas rectas; cerrada: una pared con su hueco.
 */
export function buildThinFaces(s: EvaluatedSketch, thickness: number, offset = 0): Face[] {
  const oc = getOC();
  if (!(thickness > 0)) throw new FeatureError(`El espesor debe ser mayor que 0 (es ${thickness})`);
  const frame: PlaneFrame = { ...s.frame, origin: s.frame.origin.map((v, i) => v + s.frame.normal[i] * offset) as PlaneFrame['origin'] };
  const index = new SketchIndex(s.data);
  let chains;
  try {
    chains = findChains(s.data);
  } catch (err) {
    if (err instanceof ProfileError) throw new FeatureError(err.message);
    throw err;
  }
  if (!chains.length) throw new FeatureError('El sketch no tiene curvas para engrosar');
  const h = thickness / 2;
  const faces: Face[] = [];
  const side = (wire: AnyShape, d: number, open: boolean): AnyShape => {
    const mo = new oc.BRepOffsetAPI_MakeOffset(wire.wrapped as never, oc.GeomAbs_JoinType.GeomAbs_Intersection as never, open);
    try {
      mo.Perform(d, 0);
      if (!mo.IsDone()) throw new FeatureError('No se pudo engrosar una curva (¿el espesor es mayor que un radio de curvatura?)');
      return cast(mo.Shape());
    } finally {
      mo.delete();
    }
  };
  for (const chain of chains) {
    const straight = straightChain(index, chain.edges);
    if (straight) {
      // Líneas alineadas: OCCT no encuentra el plano para desfasarlas; el rectángulo es directo.
      const [a, b] = straight;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n: Vec2 = [(-(b[1] - a[1]) / L) * h, ((b[0] - a[0]) / L) * h];
      const W = (p: Vec2) => toWorld(frame, p[0], p[1]);
      const corners: Vec2[] = [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]];
      const lines = corners.map((c, i) => makeLine(W(c), W(corners[(i + 1) % 4])));
      const wire = assembleWire(lines);
      lines.forEach((l) => l.delete());
      faces.push(makeFace(wire));
      wire.delete();
      continue;
    }
    const edges = loopEdges(index, frame, chain.edges, false);
    let spine: AnyShape;
    try {
      spine = assembleWire(edges);
    } catch (err) {
      throw new FeatureError(`Una cadena del sketch no se puede unir (${(err as Error).message})`);
    } finally {
      edges.forEach((e) => e.delete());
    }
    const parts: AnyShape[] = [];
    try {
      const a = side(spine, h, !chain.closed);
      const b = side(spine, -h, !chain.closed);
      parts.push(a, b);
      let face: Face;
      if (chain.closed) {
        // El contorno más grande es el exterior.
        const size = (w: AnyShape) => {
          const [lo, hi] = w.boundingBox.bounds;
          return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        };
        const [outer, inner] = size(a) >= size(b) ? [a, b] : [b, a];
        // El agujero va en sentido contrario al exterior.
        const hole = cast(inner.wrapped.Reversed());
        parts.push(hole);
        face = makeFace(outer as never, [hole as never]);
      } else {
        // Abierta: un lado, la tapa del final, el otro lado y la tapa del inicio. OCCT no devuelve
        // las aristas en orden: se ordenan desde el extremo que queda junto al inicio de la curva.
        const start = spine.edges[0].startPoint.toTuple() as Vec3;
        const A = ordered(a.edges, start);
        const B = ordered(b.edges, start);
        const capEnd = makeLine(A.last, B.last);
        const capStart = makeLine(B.first, A.first);
        const wire = assembleWire([...A.edges, capEnd, ...B.edges.slice().reverse(), capStart]);
        parts.push(capEnd, capStart, wire);
        face = makeFace(wire);
      }
      if (!isValidShape(face)) {
        // Las curvas desfasadas de Bézier (splines) suelen necesitar un arreglo de tolerancias.
        const fix = new oc.ShapeFix_Face(oc.TopoDS.Face(face.wrapped) as never);
        fix.Perform();
        const fixed = cast(fix.Face()) as Face;
        fix.delete();
        face.delete();
        face = fixed;
      }
      if (!isValidShape(face)) {
        face.delete();
        throw new FeatureError('La pared se cruza consigo misma: probá con un espesor menor');
      }
      faces.push(face);
    } finally {
      parts.forEach((p) => p.delete());
      spine.delete();
    }
  }
  return faces;
}

/** Si la cadena son solo líneas alineadas (y abierta), sus dos extremos. */
function straightChain(index: SketchIndex, edges: LoopEdge[]): [Vec2, Vec2] | null {
  if (!edges.every((e) => e.curve.type === 'line')) return null;
  const pts = edges.flatMap((e) => {
    const l = e.curve as { p1: string; p2: string };
    const [p, q] = [index.point(l.p1), index.point(l.p2)];
    return e.reversed ? [q, p] : [p, q];
  });
  const a = pts[0];
  const b = pts[pts.length - 1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-9) return null;
  const off = (p: Vec2) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / L;
  return pts.every((p) => off(p) < 1e-9 * Math.max(1, L)) ? [a, b] : null;
}

/**
 * Ordena las aristas de una cadena abierta empezando por el extremo libre más cercano a `near`.
 * Devuelve también el primer y el último punto del recorrido.
 */
function ordered(edges: Edge[], near: Vec3): { edges: Edge[]; first: Vec3; last: Vec3 } {
  const ends = edges.map((e) => [e.startPoint.toTuple(), e.endPoint.toTuple()] as [Vec3, Vec3]);
  const d = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const tol = 1e-4;
  // Extremos libres: los que no coinciden con ningún extremo de otra arista.
  const free = ends.flatMap(([p, q], i) =>
    [p, q].filter((x) => !ends.some(([r, s], j) => j !== i && (d(x, r) < tol || d(x, s) < tol))));
  let cur = (free.length ? free : [ends[0][0]]).reduce((best, p) => (d(p, near) < d(best, near) ? p : best));
  const first = cur;
  const left = edges.map((_, i) => i);
  const out: Edge[] = [];
  while (left.length) {
    const j = left.findIndex((i) => d(ends[i][0], cur) < tol || d(ends[i][1], cur) < tol);
    if (j < 0) break;
    const i = left.splice(j, 1)[0];
    out.push(edges[i]);
    cur = d(ends[i][0], cur) < tol ? ends[i][1] : ends[i][0];
  }
  return { edges: out, first, last: cur };
}
