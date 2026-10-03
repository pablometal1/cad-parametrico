// Modelo del documento: única fuente de verdad del proyecto. Datos planos, inmutables y serializables a JSON.

export const DOCUMENT_FORMAT = 'cad-parametrico';
export const DOCUMENT_VERSION = 1;

export type FeatureId = string;

export type BasePlane = 'XY' | 'XZ' | 'YZ';

/**
 * Perfil provisorio de la fase 2 (rectángulo o círculo sobre un plano base).
 * En la fase 3 se reemplaza por una referencia a una feature de sketch.
 */
export type Profile =
  | {
      kind: 'rectangle';
      plane: BasePlane;
      /** Desplazamiento del plano a lo largo de su normal (mm). */
      offset: number;
      /** Centro en coordenadas del plano (mm). */
      center: [number, number];
      width: number;
      height: number;
    }
  | {
      kind: 'circle';
      plane: BasePlane;
      offset: number;
      center: [number, number];
      radius: number;
    };

export type ExtrudeDirection = 'normal' | 'reversed' | 'symmetric';
export type BooleanOperation = 'new' | 'join' | 'cut';

interface FeatureBase {
  id: FeatureId;
  name: string;
  suppressed: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  profile: Profile;
  /** Distancia total de extrusión (mm), > 0. */
  distance: number;
  direction: ExtrudeDirection;
  operation: BooleanOperation;
}

export type Feature = ExtrudeFeature;
export type FeatureType = Feature['type'];

export interface CadDocument {
  format: typeof DOCUMENT_FORMAT;
  version: typeof DOCUMENT_VERSION;
  units: 'mm';
  features: Feature[];
  /**
   * Marcador de retroceso: cantidad de features activas desde el principio.
   * `null` = el marcador está al final (todas activas).
   */
  rollback: number | null;
}
