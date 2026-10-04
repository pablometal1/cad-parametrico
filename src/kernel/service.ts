// Lógica del kernel, independiente del transporte: la usan el worker y los tests en Node.
import { measureArea } from 'replicad';
import type { CadDocument, EdgeRef, FaceRef } from '../document/types';
import { initSolver } from '../sketch/solver';
import { initOCCT } from './occt';
import { shapeToMesh } from './mesh';
import { EDGE_NORMAL, EDGE_SEAM, EDGE_TANGENT, edgeKinds, edgeRefOf, faceRefOf, type NamedShape } from './naming';
import { RecomputeEngine } from './recompute';
import { sketchSegments } from './sketchLines';
import type { EdgeInfo, FaceInfo, KernelApi, Manipulator, RecomputeResult, SurfaceType } from './protocol';
import type { EvaluatedSketch } from './features/sketch';
import { manipulatorFor } from './manipulators';

export class KernelService implements Record<keyof KernelApi, (...a: never[]) => unknown> {
  private readonly engine = new RecomputeEngine();
  /** Sólido final del último recálculo, con nombres (propiedad del motor). */
  private current: NamedShape | null = null;

  constructor(private readonly wasmUrl?: string, private readonly solverWasmUrl?: string) {}

  async init(): Promise<{ occtLoadMs: number }> {
    const t0 = performance.now();
    await Promise.all([initOCCT(this.wasmUrl), initSolver(this.solverWasmUrl)]);
    return { occtLoadMs: Math.round(performance.now() - t0) };
  }

  recompute(doc: CadDocument): RecomputeResult {
    const t0 = performance.now();
    const { results, shape, sketches } = this.engine.run(doc);
    this.current = shape;
    const mesh = shape ? shapeToMesh(shape.shape, edgeKinds(shape)) : null;
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
      totalMs: Math.round(performance.now() - t0),
    };
  }

  faceInfo(faceIndex: number): FaceInfo {
    const shape = this.requireShape();
    const faces = shape.shape.faces;
    const face = faces[faceIndex];
    if (!face) throw new Error(`Cara ${faceIndex} fuera de rango (el sólido tiene ${faces.length})`);
    const center = face.center;
    // En caras curvas el centro de masa no está sobre la superficie: normalAt lo proyecta,
    // pero el vector no viene unitario.
    const [nx, ny, nz] = face.normalAt(center).toTuple();
    const len = Math.hypot(nx, ny, nz) || 1;
    return {
      index: faceIndex,
      surfaceType: face.geomType as SurfaceType,
      area: measureArea(face),
      center: center.toTuple(),
      normal: [nx / len, ny / len, nz / len],
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

  manipulator(featureId: string): Manipulator | null {
    const ctx = this.engine.contextOf(featureId);
    const feature = ctx?.doc.features.find((f) => f.id === featureId);
    return ctx && feature ? manipulatorFor(feature, ctx) : null;
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
