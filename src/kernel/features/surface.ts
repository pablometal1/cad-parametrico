// Superficies libres (estilo hard surface): parche que rellena un contorno de aristas y abombado
// de una cara plana. La superficie se arma con BRepOffsetAPI_MakeFilling.
import { cast, getOC, makeBezierCurve, makeLine, type AnyShape, type Edge, type Face } from 'replicad';
import { curveSegments, isStraight, segmentCount, type BezierSegment } from '../../document/curve3d';
import type { Curve3dFeature, DomeFeature, PatchFeature, Vec3 } from '../../document/types';
import { historyOf, NameBuilder, resolveEdge, resolveFace, resolveVertex, ShapeTable, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';
import { combine } from './boolean';
import { volume, volumeProps } from './measure';

type Keep = { delete(): void };

/** Arista del borde de un parche; con `support`, la superficie sale tangente a esa cara. */
type Boundary = { edge: Edge; support: Face | null };

/** Superficie que pasa por las aristas (cerradas en un contorno) y, si se da, por un punto. */
function fillSurface(boundary: Boundary[], point: Vec3 | null, keep: Keep[]): AnyShape {
  const oc = getOC();
  const mf = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
  keep.push(mf);
  for (const b of boundary) {
    if (b.support) mf.Add(oc.TopoDS.Edge(b.edge.wrapped), oc.TopoDS.Face(b.support.wrapped), oc.GeomAbs_Shape.GeomAbs_G1, true);
    else mf.Add(oc.TopoDS.Edge(b.edge.wrapped), oc.GeomAbs_Shape.GeomAbs_C0, true);
  }
  if (point) {
    const p = new oc.gp_Pnt(...point);
    keep.push(p);
    mf.Add(p);
  }
  const range = new oc.Message_ProgressRange();
  keep.push(range);
  try {
    mf.Build(range);
  } catch {
    throw new FeatureError('No se pudo armar la superficie: las aristas tienen que formar un contorno cerrado');
  }
  if (!mf.IsDone()) throw new FeatureError('No se pudo armar la superficie: las aristas tienen que formar un contorno cerrado');
  const s = cast(mf.Shape());
  if (s.faces.length !== 1) {
    s.delete();
    throw new FeatureError('La superficie no salió de una sola cara: revisá que las aristas formen un solo contorno');
  }
  return s;
}

/**
 * Cara del modelo a la que la superficie sale tangente en una arista: de las caras que la tocan,
 * la más "parada" respecto del contorno (en la tapa de una caja, la pared y no la tapa misma).
 */
function supportFace(input: NamedShape, edge: Edge, loopNormal: Vec3): Face | null {
  const mid = edge.pointAt(0.5);
  let best: { face: Face; score: number } | null = null;
  for (const face of input.shape.faces) {
    if (!face.edges.some((e) => e.isSame(edge))) continue;
    const n = face.normalAt(mid).toTuple();
    const score = Math.abs(n[0] * loopNormal[0] + n[1] * loopNormal[1] + n[2] * loopNormal[2]);
    if (!best || score < best.score) best = { face, score };
  }
  mid.delete();
  return best?.face ?? null;
}

/** ¿La superficie tiene normales bien definidas? (tangente a paredes que no la dejan cerrar, degenera). */
function smoothSurface(surface: AnyShape): boolean {
  const f = surface.faces[0];
  for (const [u, v] of [[0.5, 0.5], [0.25, 0.5], [0.5, 0.25], [0.75, 0.75], [0.1, 0.5], [0.5, 0.9]]) {
    const p = f.pointOnSurface(u, v);
    const n = f.normalAt(p).toTuple();
    p.delete();
    if (Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-3) return false;
  }
  return isValidShape(surface);
}

/** Arista recta del modelo con esos extremos (un tramo recto de una curva 3D que va por ella). */
function modelEdgeAlong(table: ShapeTable<Edge>, s: BezierSegment): Edge | null {
  if (!isStraight(s)) return null;
  const near = (p: number[], q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
  for (const e of table.items) {
    if (e.geomType !== 'LINE') continue;
    const [a, b] = [e.startPoint.toTuple(), e.endPoint.toTuple()];
    if ((near(a, s[0]) && near(b, s[3])) || (near(a, s[3]) && near(b, s[0]))) return e;
  }
  return null;
}

/** Centro y normal media de un contorno (normal de Newell sobre puntos de las aristas). */
function loopFrame(edges: Edge[]): { center: Vec3; normal: Vec3 } {
  const pts: Vec3[] = [];
  for (const e of edges) for (let i = 0; i < 8; i++) pts.push(e.pointAt(i / 8).toTuple() as Vec3);
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length) as Vec3;
  // Puntos en orden de recorrido no garantizado: alcanza con una normal promedio por triángulos al centro.
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i].map((v, k) => v - c[k]);
    const b = pts[(i + 1) % pts.length].map((v, k) => v - c[k]);
    n[0] += a[1] * b[2] - a[2] * b[1];
    n[1] += a[2] * b[0] - a[0] * b[2];
    n[2] += a[0] * b[1] - a[1] * b[0];
  }
  const L = Math.hypot(...n) || 1;
  return { center: c, normal: [n[0] / L, n[1] / L, n[2] / L] };
}

/**
 * Parche: superficie que rellena un contorno cerrado de aristas del modelo y curvas 3D (abombada
 * `height` mm en el centro si no es 0). Con espesor 0 queda como superficie (sin volumen, como en
 * Plasticity); si no, se engrosa hacia afuera de la pieza y se combina. Con `tangent`, sale
 * tangente a las caras del modelo que tocan el borde.
 */
export function runPatch(feature: PatchFeature, input: NamedShape | null, curves: BezierSegment[][] = []): NamedShape {
  if (!input && !curves.length) throw new FeatureError('No hay aristas ni curvas para el parche');
  if (feature.edges.length + curves.reduce((n, c) => n + c.length, 0) < 2) throw new FeatureError('Elegí las aristas o curvas de un contorno cerrado (al menos 2)');
  if (!(feature.thickness >= 0)) throw new FeatureError(`El espesor no puede ser negativo (es ${feature.thickness})`);
  const sheet = feature.thickness === 0;
  if (sheet && feature.operation !== 'new') {
    throw new FeatureError('Una superficie sin espesor no puede unirse ni cortar: indicá un espesor, o usá «Cuerpo nuevo»');
  }
  if (!Number.isFinite(feature.height)) throw new FeatureError('La altura no es un número válido');
  const table = input ? ShapeTable.edges(input.shape) : null;
  const modelEdges = input ? [...new Set(feature.edges.map((r) => resolveEdge(input, r)))].map((i) => table!.items[i]) : [];
  const keep: Keep[] = [];
  try {
    // Un tramo recto de curva que va justo por una arista del modelo usa esa arista (así puede
    // salir tangente a su cara).
    const curveBoundary: { edge: Edge; model: boolean }[] = curves.flatMap((segs) => segs.map((sg) => {
      const along = table && feature.tangent ? modelEdgeAlong(table, sg) : null;
      if (along) return { edge: along, model: true };
      const [e] = segmentEdges([sg]);
      keep.push(e);
      return { edge: e, model: false };
    }));
    const all = [...modelEdges.map((edge) => ({ edge, model: true })), ...curveBoundary];
    const { center, normal } = loopFrame(all.map((b) => b.edge));
    const boundary: Boundary[] = all.map((b) => ({
      edge: b.edge,
      support: feature.tangent && b.model && input ? supportFace(input, b.edge, normal) : null,
    }));
    const point = Math.abs(feature.height) > 1e-9 ? (center.map((v, k) => v + normal[k] * feature.height) as Vec3) : null;
    const surface = fillSurface(boundary, point, keep);
    if (boundary.some((b) => b.support) && !point && !smoothSurface(surface)) {
      surface.delete();
      throw new FeatureError('Tangente a esas caras la superficie no cierra plana: poné un abombado (por ejemplo la mitad del ancho)');
    }
    if (sheet) {
      const nb = new NameBuilder(surface);
      nb.add(surface.faces[0].wrapped, `${feature.id}:patch`);
      return combine('new', input, nb.finish(feature.id), feature.id);
    }
    keep.push(surface);
    // Se engrosa hacia afuera de la pieza (lejos de su centro), así la superficie queda a la vista
    // y no se mete dentro del sólido.
    let side = 1;
    if (input) {
      const [lo, hi] = input.shape.boundingBox.bounds;
      const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
      const f = surface.faces[0];
      const c = f.center;
      const nrm = f.normalAt(c).toTuple();
      const out = c.toTuple().map((v, k) => v - mid[k]);
      if (nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2] < 0) side = -1;
    }
    const solid = thickenSheet(surface, side * feature.thickness, 'el parche');
    const nb = new NameBuilder(solid);
    nb.add(solid.faces[0].wrapped, `${feature.id}:patch`);
    const tool = nb.finish(feature.id);
    return combine(feature.operation, input, tool, feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}

/**
 * Engrosa una superficie abierta `thickness` mm hacia el lado de su normal (negativo: al otro lado). `what` nombra la pieza
 * en los mensajes ("el parche", "la solevación"). El llamador es dueño del sólido devuelto.
 */
export function thickenSheet(sheet: AnyShape, thickness: number, what: string): AnyShape {
  const oc = getOC();
  if (!(Math.abs(thickness) > 0)) throw new FeatureError(`El espesor debe ser mayor que 0 (es ${thickness})`);
  const ts = new oc.BRepOffsetAPI_MakeThickSolid();
  const r = new oc.Message_ProgressRange();
  try {
    try {
      ts.MakeThickSolidBySimple(sheet.wrapped, thickness);
      ts.Build(r);
    } catch {
      throw new FeatureError(`No se pudo engrosar ${what}: probá con un espesor menor`);
    }
    if (!ts.IsDone()) throw new FeatureError(`No se pudo engrosar ${what}: probá con un espesor menor`);
    let solid = cast(ts.Shape());
    if (volume(solid) < 0) {
      const flipped = cast(solid.wrapped.Reversed());
      solid.delete();
      solid = flipped;
    }
    if (!isValidShape(solid) || solid.solids.length === 0) {
      solid.delete();
      throw new FeatureError(`${what[0].toUpperCase()}${what.slice(1)} engrosad${what.startsWith('la ') ? 'a' : 'o'} no es un sólido válido`);
    }
    return solid;
  } finally {
    ts.delete();
    r.delete();
  }
}

/** Aristas de los tramos de una curva 3D: líneas o Bézier cúbicas. El llamador es dueño. */
export function segmentEdges(segs: BezierSegment[]): Edge[] {
  return segs.map((s) => (isStraight(s) ? makeLine(s[0], s[3]) : makeBezierCurve(s)));
}

/** Curva 3D evaluada: los vértices del modelo por los que pasa y sus tramos Bézier. */
export interface Curve3dGeometry {
  vertices: Vec3[];
  segments: BezierSegment[];
}

/** Vértices y tramos de una curva 3D en el sólido de entrada. */
export function evaluateCurve3d(feature: Curve3dFeature, input: NamedShape | null): Curve3dGeometry {
  if (feature.points.length < 2) throw new FeatureError('Una curva 3D necesita al menos 2 vértices');
  if (!input) throw new FeatureError('No hay un modelo con vértices para la curva');
  const pts = feature.points.map((v) => resolveVertex(input, v));
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) < 1e-6) {
      throw new FeatureError(`Los vértices ${i} y ${i + 1} de la curva coinciden`);
    }
  }
  if (feature.closed && pts.length < 3) throw new FeatureError('Una curva cerrada necesita al menos 3 vértices');
  const n = segmentCount(pts.length, feature.closed);
  if (feature.handles && feature.handles.length !== n) {
    throw new FeatureError(`La curva tiene ${n} tramos pero guarda asas para ${feature.handles.length}: volvé a crearla`);
  }
  return { vertices: pts, segments: curveSegments(pts, feature.closed, !!feature.smooth, feature.handles) };
}

/**
 * Marca la curva sobre el modelo: los tramos que van por una cara la parten en dos (como dibujar una
 * línea sobre una cara en SketchUp), así cada parte se puede empujar, inclinar o redondear aparte.
 * Devuelve null si ningún tramo toca una cara (el modelo queda igual).
 */
export function imprintCurve(featureId: string, input: NamedShape, curve: Curve3dGeometry): NamedShape | null {
  const oc = getOC();
  const keep: Keep[] = [];
  try {
    const lines = segmentEdges(curve.segments);
    keep.push(...lines);
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    const splitter = new oc.BRepAlgoAPI_Splitter();
    const range = new oc.Message_ProgressRange();
    keep.push(args, tools, splitter, range);
    args.Append(input.shape.wrapped);
    for (const l of lines) tools.Append(l.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build(range);
    if (!splitter.IsDone() || splitter.HasErrors()) throw new FeatureError('No se pudo marcar la curva sobre el modelo');
    const result = cast(splitter.Shape());
    if (result.faces.length <= input.shape.faces.length || result.solids.length !== input.shape.solids.length || !isValidShape(result)) {
      result.delete();
      return null;
    }
    const history = historyOf(splitter);
    const nb = new NameBuilder(result);
    // Las dos partes de una cara partida heredan su nombre; se distinguen por la huella geométrica.
    nb.carry(input, history);
    return nb.finish(featureId);
  } finally {
    keep.forEach((k) => k.delete());
  }
}

/**
 * Abombar una cara plana: su borde queda fijo y el centro sube (o baja, si es negativa) `height` mm
 * con una superficie suave. Se arma un prisma de la cara, se parte con la superficie y la parte que
 * toca la cara se une (o se resta) al sólido.
 */
export function runDome(feature: DomeFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay un sólido para abombar');
  const h = feature.height;
  if (!(Math.abs(h) > 1e-9) || !Number.isFinite(h)) throw new FeatureError(`La altura no puede ser 0 (es ${h})`);
  const face = input.shape.faces[resolveFace(input, feature.face)] as Face;
  if (face.geomType !== 'PLANE') throw new FeatureError('Abombar funciona con caras planas');
  if (face.wires.length !== 1) throw new FeatureError('La cara tiene agujeros: abombar necesita una cara con un solo contorno');
  const c = face.center.toTuple() as Vec3;
  const n = face.normalAt(face.center).toTuple() as Vec3;
  const keep: Keep[] = [];
  try {
    const top = c.map((v, k) => v + n[k] * h) as Vec3;
    const surface = fillSurface(face.edges.map((edge) => ({ edge, support: null })), top, keep);
    keep.push(surface);
    // Prisma de la cara hacia el lado del abombado, más alto que la superficie.
    const reach = (Math.abs(h) * 1.5 + 1) * Math.sign(h);
    const vec = new oc.gp_Vec(n[0] * reach, n[1] * reach, n[2] * reach);
    const prism = new oc.BRepPrimAPI_MakePrism(face.wrapped, vec, false, true);
    keep.push(vec, prism);
    if (!prism.IsDone()) throw new FeatureError('No se pudo armar el volumen del abombado');
    const args = new oc.NCollection_List_TopoDS_Shape();
    const tools = new oc.NCollection_List_TopoDS_Shape();
    const splitter = new oc.BRepAlgoAPI_Splitter();
    const range = new oc.Message_ProgressRange();
    keep.push(args, tools, splitter, range);
    args.Append(prism.Shape());
    tools.Append(surface.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build(range);
    if (!splitter.IsDone() || splitter.HasErrors()) throw new FeatureError('No se pudo recortar el abombado');
    const pieces = cast(splitter.Shape());
    keep.push(pieces);
    if (pieces.solids.length < 2) throw new FeatureError('La superficie del abombado no se separa de la cara: probá con otra altura');
    // La parte del abombado es la que queda más cerca del plano de la cara.
    const along = (s: AnyShape) => {
      const props = volumeProps(s);
      const g = props.CentreOfMass();
      const d = (g.X() - c[0]) * n[0] + (g.Y() - c[1]) * n[1] + (g.Z() - c[2]) * n[2];
      g.delete();
      props.delete();
      return Math.abs(d);
    };
    const dome = pieces.solids.reduce((best, s) => (along(s) < along(best) ? s : best));
    const nb = new NameBuilder(dome);
    for (const f of dome.faces) if (f.geomType !== 'PLANE') nb.add(f.wrapped, `${feature.id}:dome`);
    const tool = nb.finish(feature.id);
    return combine(h > 0 ? 'join' : 'cut', input, tool, feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}
