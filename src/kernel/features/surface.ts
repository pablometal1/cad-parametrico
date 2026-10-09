// Superficies libres (estilo hard surface): parche que rellena un contorno de aristas y abombado
// de una cara plana. La superficie se arma con BRepOffsetAPI_MakeFilling.
import { cast, getOC, makeLine, type AnyShape, type Edge, type Face } from 'replicad';
import type { Curve3dFeature, DomeFeature, PatchFeature, Vec3 } from '../../document/types';
import { NameBuilder, resolveEdge, resolveFace, resolveVertex, ShapeTable, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';
import { combine } from './boolean';
import { volume } from './measure';

type Keep = { delete(): void };

/** Superficie que pasa por las aristas (cerradas en un contorno) y, si se da, por un punto. */
function fillSurface(edges: Edge[], point: Vec3 | null, keep: Keep[]): AnyShape {
  const oc = getOC();
  const mf = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
  keep.push(mf);
  for (const e of edges) mf.Add(oc.TopoDS.Edge(e.wrapped), oc.GeomAbs_Shape.GeomAbs_C0, true);
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
 * Parche: superficie que rellena un contorno cerrado de aristas del modelo (abombada `height` mm
 * en el centro si no es 0), engrosada `thickness` mm y combinada con el sólido.
 */
export function runPatch(feature: PatchFeature, input: NamedShape | null, curves: Vec3[][] = []): NamedShape {
  const oc = getOC();
  const curveEdges = curves.flatMap((pts) => pts.slice(1).map((p, i) => makeLine(pts[i], p)));
  if (!input && !curveEdges.length) throw new FeatureError('No hay aristas ni curvas para el parche');
  if (feature.edges.length + curveEdges.length < 2) throw new FeatureError('Elegí las aristas o curvas de un contorno cerrado (al menos 2)');
  if (!(feature.thickness > 0)) throw new FeatureError(`El espesor debe ser mayor que 0 (es ${feature.thickness})`);
  if (!Number.isFinite(feature.height)) throw new FeatureError('La altura no es un número válido');
  const table = input ? ShapeTable.edges(input.shape) : null;
  const modelEdges = input ? [...new Set(feature.edges.map((r) => resolveEdge(input, r)))].map((i) => table!.items[i]) : [];
  const edges = [...modelEdges, ...curveEdges];
  const keep: Keep[] = [...curveEdges];
  try {
    const { center, normal } = loopFrame(edges);
    const point = Math.abs(feature.height) > 1e-9 ? (center.map((v, k) => v + normal[k] * feature.height) as Vec3) : null;
    const surface = fillSurface(edges, point, keep);
    keep.push(surface);
    const ts = new oc.BRepOffsetAPI_MakeThickSolid();
    keep.push(ts);
    try {
      ts.MakeThickSolidBySimple(surface.wrapped, feature.thickness);
      const r = new oc.Message_ProgressRange();
      keep.push(r);
      ts.Build(r);
    } catch {
      throw new FeatureError('No se pudo engrosar el parche: probá con un espesor menor');
    }
    if (!ts.IsDone()) throw new FeatureError('No se pudo engrosar el parche: probá con un espesor menor');
    let solid = cast(ts.Shape());
    if (volume(solid) < 0) {
      const flipped = cast(solid.wrapped.Reversed());
      solid.delete();
      solid = flipped;
    }
    if (!isValidShape(solid) || solid.solids.length === 0) {
      solid.delete();
      throw new FeatureError('El parche engrosado no es un sólido válido');
    }
    const nb = new NameBuilder(solid);
    nb.add(solid.faces[0].wrapped, `${feature.id}:patch`);
    const tool = nb.finish(feature.id);
    return combine(feature.operation, input, tool, feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}

/** Puntos de una curva 3D en el sólido de entrada (cerrada: el último repite el primero). */
export function evaluateCurve3d(feature: Curve3dFeature, input: NamedShape | null): Vec3[] {
  if (feature.points.length < 2) throw new FeatureError('Una curva 3D necesita al menos 2 vértices');
  if (!input) throw new FeatureError('No hay un modelo con vértices para la curva');
  const pts = feature.points.map((v) => resolveVertex(input, v));
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) < 1e-6) {
      throw new FeatureError(`Los vértices ${i} y ${i + 1} de la curva coinciden`);
    }
  }
  if (feature.closed && pts.length < 3) throw new FeatureError('Una curva cerrada necesita al menos 3 vértices');
  return feature.closed ? [...pts, pts[0]] : pts;
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
    const surface = fillSurface(face.edges, top, keep);
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
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(s.wrapped, props, false, false, false);
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
