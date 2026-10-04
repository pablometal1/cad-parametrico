// Lógica del kernel, independiente del transporte: la usan el worker y los tests en Node.
import { measureArea } from 'replicad';
import type { CadDocument, EdgeRef, FaceRef } from '../document/types';
import { initSolver } from '../sketch/solver';
import { initOCCT } from './occt';
import { shapeToMesh } from './mesh';
import { edgeRefOf, faceRefOf, type NamedShape } from './naming';
import { RecomputeEngine } from './recompute';
import { sketchSegments } from './sketchLines';
import type { EdgeInfo, FaceInfo, KernelApi, RecomputeResult, SurfaceType } from './protocol';

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
    const mesh = shape ? shapeToMesh(shape.shape) : null;
    return {
      features: results,
      mesh,
      sketches: [...sketches].map(([id, s]) => ({ id, ...sketchSegments(s), reference: new Float32Array(s.reference) })),
      totalMs: Math.round(performance.now() - t0),
    };
  }

  faceInfo(faceIndex: number): FaceInfo {
    const shape = this.requireShape();
    const faces = shape.shape.faces;
    const face = faces[faceIndex];
    if (!face) throw new Error(`Cara ${faceIndex} fuera de rango (el sólido tiene ${faces.length})`);
    const center = face.center;
    const normal = face.normalAt(center);
    return {
      index: faceIndex,
      surfaceType: face.geomType as SurfaceType,
      area: measureArea(face),
      center: center.toTuple(),
      normal: normal.toTuple(),
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
    return indices.map((i) => edgeRefOf(shape, i));
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
