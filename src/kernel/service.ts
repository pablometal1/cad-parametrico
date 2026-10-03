// Lógica del kernel, independiente del transporte: la usan el worker y los tests en Node.
import { measureArea, type AnyShape } from 'replicad';
import type { CadDocument } from '../document/types';
import { initOCCT } from './occt';
import { shapeToMesh } from './mesh';
import { RecomputeEngine } from './recompute';
import { sketchSegments } from './sketchLines';
import { initSolver } from '../sketch/solver';
import type { FaceInfo, KernelApi, RecomputeResult, SurfaceType } from './protocol';

export class KernelService implements Record<keyof KernelApi, (...a: never[]) => unknown> {
  private readonly engine = new RecomputeEngine();
  /** Sólido final del último recálculo (propiedad del motor). */
  private current: AnyShape | null = null;

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
    const mesh = shape ? shapeToMesh(shape) : null;
    return {
      features: results,
      mesh,
      sketches: [...sketches].map(([id, s]) => ({ id, ...sketchSegments(s) })),
      totalMs: Math.round(performance.now() - t0),
    };
  }

  faceInfo(faceIndex: number): FaceInfo {
    if (!this.current) throw new Error('No hay sólido cargado');
    const faces = this.current.faces;
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

  dispose() {
    this.engine.dispose();
    this.current = null;
  }
}
