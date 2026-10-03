// Lógica del kernel, independiente del transporte: la usan el worker y los tests en Node.
import { makeBaseBox, measureArea, type AnyShape } from 'replicad';
import { initOCCT } from './occt';
import { shapeToMesh } from './mesh';
import type { FaceInfo, KernelApi, MeshPayload, SurfaceType } from './protocol';

export class KernelService implements Record<keyof KernelApi, (...a: never[]) => unknown> {
  private current: AnyShape | null = null;

  constructor(private readonly wasmUrl?: string) {}

  async init(): Promise<{ occtLoadMs: number }> {
    const t0 = performance.now();
    await initOCCT(this.wasmUrl);
    return { occtLoadMs: Math.round(performance.now() - t0) };
  }

  buildBox(width: number, depth: number, height: number): MeshPayload {
    for (const [name, v] of [['ancho', width], ['profundidad', depth], ['alto', height]] as const) {
      if (!(Number.isFinite(v) && v > 0)) throw new Error(`La ${name} de la caja debe ser > 0 (recibido ${v})`);
    }
    const shape = makeBaseBox(width, depth, height);
    this.replaceCurrent(shape);
    return shapeToMesh(shape);
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

  private replaceCurrent(shape: AnyShape) {
    this.current?.delete();
    this.current = shape;
  }
}
