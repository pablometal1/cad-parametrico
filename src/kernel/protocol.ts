// Tipos compartidos entre el hilo principal y el worker del kernel.
import type { CadDocument } from '../document/types';

/** Malla lista para Three.js. Los buffers se transfieren (sin copia) desde el worker. */
export interface MeshPayload {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Por cara B-rep: [inicioIndice, cantidadIndices] consecutivos. La cara i ocupa faceRanges[2i], faceRanges[2i+1]. */
  faceRanges: Uint32Array;
  /** Segmentos de aristas: pares de puntos xyz. */
  edgePositions: Float32Array;
  /** Por arista B-rep: [inicioPunto, cantidadPuntos]. */
  edgeRanges: Uint32Array;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export type SurfaceType =
  | 'PLANE' | 'CYLINDRE' | 'CONE' | 'SPHERE' | 'TORUS'
  | 'BEZIER_SURFACE' | 'BSPLINE_SURFACE' | 'REVOLUTION_SURFACE'
  | 'EXTRUSION_SURFACE' | 'OFFSET_SURFACE' | 'OTHER_SURFACE';

export interface FaceInfo {
  index: number;
  surfaceType: SurfaceType;
  area: number;
  center: [number, number, number];
  /** Normal en el centro de la cara (orientada hacia afuera del sólido). */
  normal: [number, number, number];
}

export type FeatureStatus = 'ok' | 'error' | 'suppressed' | 'rolledBack';

export interface FeatureResult {
  id: string;
  status: FeatureStatus;
  /** Mensaje para el timeline cuando status = 'error'. */
  error?: string;
  timeMs: number;
  /** true si se reutilizó el resultado del recálculo anterior. */
  cached: boolean;
}

export interface RecomputeResult {
  features: FeatureResult[];
  /** null si no hay sólido (documento vacío o todo suprimido/retrocedido). */
  mesh: MeshPayload | null;
  totalMs: number;
}

/** API que expone el worker. Todos los métodos son asíncronos vistos desde la UI. */
export interface KernelApi {
  init(): { occtLoadMs: number };
  recompute(doc: CadDocument): RecomputeResult;
  faceInfo(faceIndex: number): FaceInfo;
}

export type KernelMethod = keyof KernelApi;

export interface RpcRequest {
  id: number;
  method: KernelMethod;
  args: unknown[];
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
