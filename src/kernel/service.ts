// Lógica del kernel, independiente del transporte: la usan el worker y los tests en Node.
import { cylinderOf } from './features/thread';
import { checkPart } from './features/check';
import { loadFonts } from '../sketch/text';
import { measureArea } from 'replicad';
import type { CadDocument, EdgeRef, FaceRef } from '../document/types';
import { initSolver } from '../sketch/solver';
import { evaluateDocument } from '../document/evaluate';
import { initOCCT } from './occt';
import { copyMesh, displayMeshOptions, shapeToMesh } from './mesh';
import { describeError } from './occtUtils';
import { EDGE_NORMAL, EDGE_SEAM, EDGE_TANGENT, edgeKinds, edgeRefOf, faceRefOf, type NamedShape } from './naming';
import { RecomputeEngine } from './recompute';
import { sketchSegments } from './sketchLines';
import type {
  EdgeInfo, ExportFormat, ExportQuality, ExportResult, FaceInfo, KernelApi, Manipulator, MassProperties, Measurement, MeshPayload, RecomputeResult,
  SurfaceType,
} from './protocol';
import { getOC } from 'replicad';
import { checkWatertight, to3MF, toBinarySTL, weldMesh } from './export/meshExport';

/** Tolerancias de teselado para exportar (desvío lineal en mm, angular en radianes). */
const EXPORT_QUALITY: Record<ExportQuality, { tolerance: number; angularTolerance: number }> = {
  low: { tolerance: 0.1, angularTolerance: 0.5 },
  medium: { tolerance: 0.02, angularTolerance: 0.2 },
  high: { tolerance: 0.005, angularTolerance: 0.1 },
};
import type { EvaluatedSketch } from './features/sketch';
import { manipulatorFor } from './manipulators';

export class KernelService implements Record<keyof KernelApi, (...a: never[]) => unknown> {
  private readonly engine = new RecomputeEngine();
  /** Sólido final del último recálculo, con nombres (propiedad del motor). */
  private current: NamedShape | null = null;
  /** Resultados por sólido (el motor reutiliza el mismo objeto mientras no cambie). */
  private meshes = new WeakMap<NamedShape, MeshPayload>();
  private mass = new WeakMap<NamedShape, MassProperties>();

  constructor(private readonly wasmUrl?: string, private readonly solverWasmUrl?: string) {}

  async init(): Promise<{ occtLoadMs: number }> {
    const t0 = performance.now();
    await Promise.all([initOCCT(this.wasmUrl), initSolver(this.solverWasmUrl), loadFonts()]);
    return { occtLoadMs: Math.round(performance.now() - t0) };
  }

  recompute(doc: CadDocument): RecomputeResult {
    const t0 = performance.now();
    const evaluated = evaluateDocument(doc);
    const { results, shape, sketches, planes, references } = this.engine.run(evaluated.doc, evaluated.errors);
    this.current = shape;
    // El motor devuelve el mismo objeto si el sólido no cambió (o al deshacer): no se vuelve a mallar.
    const mesh = shape ? copyMesh(memo(this.meshes, shape, () => meshForDisplay(shape))) : null;
    return {
      features: results,
      mesh,
      sketches: [...sketches].map(([id, s]) => ({
        id,
        ...sketchSegments(s),
        reference: new Float32Array(s.reference),
        plane: { origin: s.frame.origin, xDir: s.frame.xDir, yDir: s.frame.yDir, normal: s.frame.normal },
        bounds: sketchBounds(s),
      })),
      parameters: evaluated.parameters,
      planes: [...planes].map(([id, f]) => ({ id, frame: { origin: f.origin, xDir: f.xDir, yDir: f.yDir, normal: f.normal } })),
      references: references.flatMap((r) => {
        try {
          const m = memo(this.meshes, r.shape, () => shapeToMesh(r.shape.shape, undefined, displayMeshOptions(r.shape.shape, true)));
          return [{ id: r.id, mesh: copyMesh(m) }];
        } catch {
          return [];
        }
      }),
      totalMs: Math.round(performance.now() - t0),
    };
  }

  faceInfo(faceIndex: number): FaceInfo {
    const shape = this.requireShape();
    const faces = shape.shape.faces;
    const face = faces[faceIndex];
    if (!face) throw new Error(`Cara ${faceIndex} fuera de rango (el sólido tiene ${faces.length})`);
    const center = face.center;
    // En caras curvas el centro de masa no está sobre la superficie (en un cilindro completo cae
    // sobre el eje y proyectarlo falla): la normal se toma en un punto de la propia superficie.
    const onSurface = face.geomType === 'PLANE' ? center : face.pointOnSurface(0.5, 0.5);
    const [nx, ny, nz] = face.normalAt(onSurface).toTuple();
    const len = Math.hypot(nx, ny, nz) || 1;
    return {
      index: faceIndex,
      surfaceType: face.geomType as SurfaceType,
      area: measureArea(face),
      center: center.toTuple(),
      normal: [nx / len, ny / len, nz / len],
      cylinder: cylinderInfo(face),
    };
  }

  edgeInfo(edgeIndex: number): EdgeInfo {
    const edges = this.requireShape().shape.edges;
    const e = edges[edgeIndex];
    if (!e) throw new Error(`Arista ${edgeIndex} fuera de rango (el sólido tiene ${edges.length})`);
    return { index: edgeIndex, curveType: e.geomType, length: e.length, midpoint: e.pointAt(0.5).toTuple() };
  }

  faceRefs(indices: number[]): FaceRef[] {
    const shape = this.requireShape();
    return indices.map((i) => faceRefOf(shape, i));
  }

  edgeRefs(indices: number[]): EdgeRef[] {
    const shape = this.requireShape();
    const kinds = edgeKinds(shape);
    const bad = indices.filter((i) => kinds[i] !== EDGE_NORMAL);
    if (bad.length) {
      const what = bad.every((i) => kinds[i] === EDGE_SEAM)
        ? 'es una costura de la superficie, no un borde real'
        : bad.every((i) => kinds[i] === EDGE_TANGENT)
          ? 'une dos caras tangentes (transición suave)'
          : 'es tangente o una costura';
      const n = bad.length === 1 ? 'Una de las aristas elegidas' : `${bad.length} de las aristas elegidas`;
      throw new Error(`${n} ${what}: no se puede redondear ni achaflanar. Elegí bordes con esquina viva.`);
    }
    return indices.map((i) => edgeRefOf(shape, i));
  }

  async exportModel(format: ExportFormat, quality: ExportQuality): Promise<ExportResult> {
    const shape = this.requireShape().shape;
    const solids = shape.solids;
    if (solids.length === 0) throw new Error('No hay sólidos para exportar');
    if (format === 'step') {
      const blob = shape.blobSTEP();
      return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'model/step', extension: 'step', bodies: solids.length };
    }
    const opts = EXPORT_QUALITY[quality];
    const meshes = solids.map((s) => {
      const m = s.mesh(opts);
      return weldMesh(m.vertices, m.triangles);
    });
    const triangles = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
    const openEdges = meshes.reduce((n, m) => {
      const c = checkWatertight(m);
      return n + c.boundaryEdges + c.nonManifoldEdges;
    }, 0);
    const data = format === 'stl' ? toBinarySTL(meshes) : to3MF(meshes, meshes.map((_, i) => `Cuerpo ${i + 1}`));
    return {
      data,
      mime: format === 'stl' ? 'model/stl' : 'model/3mf',
      extension: format,
      triangles,
      openEdges,
      bodies: solids.length,
    };
  }

  measure(faceIdx: number[], edgeIdx: number[]): Measurement {
    const shape = this.requireShape().shape;
    const faces = shape.faces;
    const edges = shape.edges;
    const items = [
      ...faceIdx.map((i) => ({ kind: 'face' as const, s: faces[i] })),
      ...edgeIdx.map((i) => ({ kind: 'edge' as const, s: edges[i] })),
    ];
    if (items.length !== 2 || items.some((x) => !x.s)) throw new Error('Para medir elegí exactamente dos elementos (caras o aristas)');
    const oc = getOC();
    const range = new oc.Message_ProgressRange();
    const ext = new oc.BRepExtrema_DistShapeShape(items[0].s.wrapped, items[1].s.wrapped, undefined, undefined, range);
    try {
      if (!ext.IsDone() || ext.NbSolution() < 1) throw new Error('No se pudo medir la distancia');
      const a = ext.PointOnShape1(1);
      const b = ext.PointOnShape2(1);
      const result: Measurement = { distance: ext.Value(), p1: [a.X(), a.Y(), a.Z()], p2: [b.X(), b.Y(), b.Z()] };
      a.delete();
      b.delete();
      // Direcciones: normal de cara plana o dirección de arista recta.
      const dirOf = (x: (typeof items)[number]): { v: [number, number, number]; plane: boolean } | null => {
        if (x.kind === 'face') {
          const f = x.s as (typeof faces)[number];
          if (f.geomType !== 'PLANE') return null;
          return { v: unit(f.normalAt(f.center).toTuple()), plane: true };
        }
        const e = x.s as (typeof edges)[number];
        if (e.geomType !== 'LINE') return null;
        const p0 = e.pointAt(0).toTuple();
        const p1 = e.pointAt(1).toTuple();
        return { v: unit([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]), plane: false };
      };
      const d1 = dirOf(items[0]);
      const d2 = dirOf(items[1]);
      if (d1 && d2) {
        const dot = Math.abs(d1.v[0] * d2.v[0] + d1.v[1] * d2.v[1] + d1.v[2] * d2.v[2]);
        let deg = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
        // Recta contra plano: el ángulo es el complemento del ángulo con la normal.
        if (d1.plane !== d2.plane) deg = 90 - deg;
        result.angle = Math.abs(deg) < 1e-9 ? 0 : deg;
        if (d1.plane && d2.plane && dot > 1 - 1e-9) {
          const f1 = items[0].s as (typeof faces)[number];
          const f2 = items[1].s as (typeof faces)[number];
          const c1 = f1.center.toTuple();
          const c2 = f2.center.toTuple();
          result.planeDistance = Math.abs((c2[0] - c1[0]) * d1.v[0] + (c2[1] - c1[1]) * d1.v[1] + (c2[2] - c1[2]) * d1.v[2]);
        }
      }
      return result;
    } finally {
      ext.delete();
      range.delete();
    }
  }

  massProperties(): MassProperties {
    const named = this.requireShape();
    return memo(this.mass, named, () => this.computeMassProperties(named.shape));
  }

  private computeMassProperties(shape: NamedShape['shape']): MassProperties {
    const oc = getOC();
    const vol = new oc.GProp_GProps();
    const surf = new oc.GProp_GProps();
    try {
      oc.BRepGProp.VolumeProperties(shape.wrapped, vol, false, false, false);
      oc.BRepGProp.SurfaceProperties(shape.wrapped, surf, false, false);
      const c = vol.CentreOfMass();
      const center: [number, number, number] = [c.X(), c.Y(), c.Z()];
      c.delete();
      const [min, max] = shape.boundingBox.bounds;
      return {
        volume: vol.Mass(),
        area: surf.Mass(),
        bodies: shape.solids.length,
        center,
        bboxMin: [min[0], min[1], min[2]],
        bboxMax: [max[0], max[1], max[2]],
        check: checkPart(shape),
      };
    } finally {
      vol.delete();
      surf.delete();
    }
  }

  manipulator(featureId: string): Manipulator[] {
    const ctx = this.engine.contextOf(featureId);
    const feature = ctx?.doc.features.find((f) => f.id === featureId);
    const m = ctx && feature ? manipulatorFor(feature, ctx) : null;
    return m === null ? [] : Array.isArray(m) ? m : [m];
  }

  dispose() {
    this.engine.dispose();
    this.current = null;
  }

  private requireShape(): NamedShape {
    if (!this.current) throw new Error('No hay sólido cargado');
    return this.current;
  }
}

/** Extensión (u0, v0, u1, v1) de la geometría y del contorno de referencia de un sketch, con margen. */
function sketchBounds(s: EvaluatedSketch): [number, number, number, number] {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  const grow = (u: number, v: number) => {
    u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v);
  };
  for (const e of s.data.entities) if (e.type === 'point') grow(e.x, e.y);
  for (const e of s.data.entities) {
    if (e.type !== 'circle') continue;
    const c = s.data.entities.find((p) => p.id === e.center);
    if (c?.type === 'point') {
      grow(c.x - e.radius, c.y - e.radius);
      grow(c.x + e.radius, c.y + e.radius);
    }
  }
  for (let i = 0; i + 1 < s.reference.length; i += 2) grow(s.reference[i], s.reference[i + 1]);
  if (!Number.isFinite(u0)) return [-25, -25, 25, 25];
  const m = Math.max(5, 0.15 * Math.max(u1 - u0, v1 - v0));
  return [u0 - m, v0 - m, u1 + m, v1 + m];
}

function unit(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cylinderInfo(face: Parameters<typeof cylinderOf>[0]): FaceInfo['cylinder'] {
  if (face.geomType !== 'CYLINDRE') return undefined;
  try {
    const c = cylinderOf(face);
    return { radius: c.radius, internal: c.internal, length: c.z1 - c.z0 };
  } catch {
    return undefined;
  }
}

/**
 * Malla para el viewport, con precisión según el tamaño. Si OpenCascade falla con la fina
 * (pasa con superficies complejas, como roscas largas), se intenta una más gruesa.
 */
const MAX_DISPLAY_TRIANGLES = 150_000;

function meshForDisplay(shape: NamedShape): MeshPayload {
  const kinds = edgeKinds(shape);
  try {
    const fine = shapeToMesh(shape.shape, kinds, displayMeshOptions(shape.shape));
    if (fine.indices.length / 3 <= MAX_DISPLAY_TRIANGLES) return fine;
    // Demasiados triángulos (superficies como roscas de paso grande): una más gruesa, si es menor.
    const coarse = shapeToMesh(shape.shape, kinds, displayMeshOptions(shape.shape, true));
    return coarse.indices.length < fine.indices.length ? coarse : fine;
  } catch {
    try {
      return shapeToMesh(shape.shape, kinds, displayMeshOptions(shape.shape, true));
    } catch (err) {
      throw new Error(`No se pudo generar la malla para mostrar la pieza (${describeError(err)})`);
    }
  }
}

function memo<K extends object, V>(map: WeakMap<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}
