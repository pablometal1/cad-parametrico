// Tipos compartidos entre el hilo principal y el worker del kernel.
import type { CadDocument, EdgeRef, FaceRef } from '../document/types';

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
  /** Por arista: 0 normal, 1 tangente (unión suave), 2 costura (no se dibuja ni se elige). */
  edgeKinds: Uint8Array;
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

export interface SketchLines {
  id: string;
  /** Curvas del sketch en 3D: segmentos xyz consecutivos. */
  segments: Float32Array;
  construction: Float32Array;
  /** Contorno de la cara de apoyo en coordenadas del sketch (u1,v1,u2,v2…); vacío en planos base. */
  reference: Float32Array;
  /** Plano del sketch y extensión de su geometría (u0, v0, u1, v1), para dibujarlo en 3D. */
  plane: { origin: V3; xDir: V3; yDir: V3; normal: V3 };
  bounds: [number, number, number, number];
}

type V3 = [number, number, number];

/**
 * Asa para modificar un parámetro arrastrando en 3D.
 * - lineal: el asa está en `origin + dir · value · factor`; arrastrar a lo largo de `dir` cambia el valor.
 * - angular: el asa gira alrededor de `axis` (por `center`), desde `startDir`, a distancia `radius`.
 */
export type Manipulator =
  | {
      kind: 'linear';
      featureId: string;
      param: 'distance' | 'radius' | 'thickness';
      label: string;
      origin: V3;
      dir: V3;
      factor: number;
      value: number;
      min: number;
    }
  | {
      kind: 'angular';
      featureId: string;
      param: 'angle';
      label: string;
      center: V3;
      axis: V3;
      startDir: V3;
      radius: number;
      value: number;
      /** Largo con el que dibujar el eje de revolución. */
      axisLength: number;
    };

export interface EdgeInfo {
  index: number;
  curveType: string;
  length: number;
  midpoint: [number, number, number];
}

export type FeatureStatus = 'ok' | 'error' | 'suppressed' | 'rolledBack';

export interface FeatureResult {
  id: string;
  status: FeatureStatus;
  /** Mensaje para el timeline cuando status = 'error'. */
  error?: string;
  /** Información adicional (por ejemplo, grados de libertad de un sketch). */
  info?: string;
  timeMs: number;
  /** true si se reutilizó el resultado del recálculo anterior. */
  cached: boolean;
}

export interface RecomputeResult {
  features: FeatureResult[];
  /** null si no hay sólido (documento vacío o todo suprimido/retrocedido). */
  mesh: MeshPayload | null;
  /** Curvas de los sketches evaluados, en 3D (segmentos xyz consecutivos), para dibujarlas en el viewport. */
  sketches: SketchLines[];
  /** Valor (o error) de cada parámetro de la tabla. */
  parameters: { id: string; name: string; value?: number; error?: string }[];
  totalMs: number;
}

/** API que expone el worker. Todos los métodos son asíncronos vistos desde la UI. */
export interface KernelApi {
  init(): { occtLoadMs: number };
  recompute(doc: CadDocument): RecomputeResult;
  faceInfo(faceIndex: number): FaceInfo;
  edgeInfo(edgeIndex: number): EdgeInfo;
  /** Referencias topológicas (nombre + huella) de caras del sólido mostrado. */
  faceRefs(indices: number[]): FaceRef[];
  /** Referencias topológicas de aristas del sólido mostrado. */
  edgeRefs(indices: number[]): EdgeRef[];
  /** Manipulador 3D de una feature (null si no tiene o no se evaluó). */
  manipulator(featureId: string): Manipulator | null;
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
