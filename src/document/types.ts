// Modelo del documento: única fuente de verdad del proyecto. Datos planos, inmutables y serializables a JSON.

export const DOCUMENT_FORMAT = 'cad-parametrico';
export const DOCUMENT_VERSION = 1;

export type FeatureId = string;

export type BasePlane = 'XY' | 'XZ' | 'YZ';

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------- Referencias topológicas

/**
 * Referencia a una cara del sólido: nombre topológico (derivado de la historia) más una huella
 * geométrica para desempatar o recuperar la cara si el nombre cambia.
 */
export interface FaceRef {
  name: string;
  /** Tipo de superficie de OCCT (PLANE, CYLINDRE…). */
  type: string;
  center: Vec3;
  /** Solo para caras planas. */
  normal?: Vec3;
  area: number;
}

/** Referencia a una arista: nombre (par de caras vecinas) más huella geométrica. */
export interface EdgeRef {
  name: string;
  center: Vec3;
  length: number;
}

// ---------------------------------------------------------------- Sketch

/** Plano de un sketch: un plano base, una cara plana del sólido o un plano de construcción. */
export type SketchPlaneRef =
  | {
      kind: 'base';
      plane: BasePlane;
      /** Desplazamiento a lo largo de la normal del plano (mm). */
      offset: number;
    }
  | {
      kind: 'face';
      face: FaceRef;
      offset: number;
    }
  | {
      kind: 'plane';
      /** Feature de plano de construcción (tiene que estar antes en el historial). */
      plane: FeatureId;
      offset: number;
    };

/** De qué parte un plano de construcción. */
export type PlaneReference =
  | { kind: 'base'; plane: BasePlane }
  | { kind: 'plane'; plane: FeatureId }
  | { kind: 'face'; face: FaceRef };

export type SketchEntityId = string;

/**
 * Entidades implícitas de todo sketch: origen fijo y ejes. Se pueden usar en restricciones
 * pero no se guardan en `entities`.
 */
export const ORIGIN = 'origin';
export const AXIS_X = 'axisX';
export const AXIS_Y = 'axisY';
export const IMPLICIT_IDS: readonly SketchEntityId[] = [ORIGIN, AXIS_X, AXIS_Y];

export interface SketchPoint {
  id: SketchEntityId;
  type: 'point';
  x: number;
  y: number;
}

interface CurveBase {
  id: SketchEntityId;
  /** Geometría auxiliar: participa del solver pero no de los perfiles. */
  construction: boolean;
}

export interface SketchLine extends CurveBase {
  type: 'line';
  p1: SketchEntityId;
  p2: SketchEntityId;
}

export interface SketchCircle extends CurveBase {
  type: 'circle';
  center: SketchEntityId;
  radius: number;
}

/** Arco antihorario desde `start` hasta `end` alrededor de `center`. */
export interface SketchArc extends CurveBase {
  type: 'arc';
  center: SketchEntityId;
  start: SketchEntityId;
  end: SketchEntityId;
}

export type SketchCurve = SketchLine | SketchCircle | SketchArc;
export type SketchEntity = SketchPoint | SketchCurve;

export type SketchConstraint =
  /** Punto-punto, o punto sobre línea/círculo/arco (`b` es la curva). */
  | { id: string; type: 'coincident'; a: SketchEntityId; b: SketchEntityId }
  | { id: string; type: 'horizontal'; line: SketchEntityId }
  | { id: string; type: 'vertical'; line: SketchEntityId }
  | { id: string; type: 'parallel'; a: SketchEntityId; b: SketchEntityId }
  | { id: string; type: 'perpendicular'; a: SketchEntityId; b: SketchEntityId }
  /** Línea-círculo/arco o círculo/arco entre sí. */
  | { id: string; type: 'tangent'; a: SketchEntityId; b: SketchEntityId }
  /** Misma longitud (líneas) o mismo radio (círculos/arcos). */
  | { id: string; type: 'equal'; a: SketchEntityId; b: SketchEntityId }
  /** Longitud de una línea (sin `b`), punto-punto, punto-línea o línea-línea paralelas (mm). */
  | { id: string; type: 'distance'; a: SketchEntityId; b?: SketchEntityId; value: number }
  | { id: string; type: 'radius'; curve: SketchEntityId; value: number }
  /** Ángulo con signo de la línea `a` a la línea `b`, en grados (antihorario positivo). */
  | { id: string; type: 'angle'; a: SketchEntityId; b: SketchEntityId; value: number };

export type SketchConstraintType = SketchConstraint['type'];

export interface SketchData {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

// ---------------------------------------------------------------- Features

interface FeatureBase {
  id: FeatureId;
  name: string;
  suppressed: boolean;
  /**
   * Expresiones de campos numéricos, por ruta: `distance`, `radius`, `angle`, `thickness`,
   * `plane.offset` o `constraint:<id>` (cota de un sketch). El número guardado en el campo es
   * el último valor evaluado; la expresión manda.
   */
  exprs?: Record<string, string>;
}

/** Parámetro con nombre de la tabla de parámetros (ej. `ancho = largo / 2`). */
export interface Parameter {
  id: string;
  name: string;
  expression: string;
  comment?: string;
}

export interface SketchFeature extends FeatureBase, SketchData {
  type: 'sketch';
  plane: SketchPlaneRef;
}

export type ExtrudeDirection = 'normal' | 'reversed' | 'symmetric';
export type BooleanOperation = 'new' | 'join' | 'cut';

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  /** Sketch cuyos perfiles cerrados se extruyen. Debe estar antes en el historial. */
  sketch: FeatureId;
  /** Distancia total de extrusión (mm), > 0. */
  distance: number;
  direction: ExtrudeDirection;
  operation: BooleanOperation;
}

/** Eje de revolución: un eje del propio sketch o una de sus líneas. */
export type RevolveAxis =
  | { kind: 'sketchAxis'; axis: 'u' | 'v' }
  | { kind: 'sketchLine'; line: SketchEntityId };

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  sketch: FeatureId;
  axis: RevolveAxis;
  /** Ángulo en grados (0, 360]. */
  angle: number;
  operation: BooleanOperation;
}

export interface FilletFeature extends FeatureBase {
  type: 'fillet';
  edges: EdgeRef[];
  radius: number;
}

export interface ChamferFeature extends FeatureBase {
  type: 'chamfer';
  edges: EdgeRef[];
  distance: number;
}

/** Vaciado hacia adentro, quitando las caras indicadas. */
export interface ShellFeature extends FeatureBase {
  type: 'shell';
  faces: FaceRef[];
  thickness: number;
}

export type GlobalAxis = 'X' | 'Y' | 'Z';

/**
 * Patrón: repite el cuerpo de una extrusión o revolución anterior y lo combina con la misma
 * operación. Lineal: `count` copias separadas `spacing` mm a lo largo de un eje global.
 * Circular: `count` copias alrededor de un eje global (por el origen) repartidas en `angle` grados.
 */
export interface PatternFeature extends FeatureBase {
  type: 'pattern';
  source: FeatureId;
  kind: 'linear' | 'circular';
  axis: GlobalAxis;
  count: number;
  /** Lineal: distancia entre copias (mm, puede ser negativa para el otro sentido). */
  spacing: number;
  /** Circular: ángulo total (360 = vuelta completa, copias equiespaciadas). */
  angle: number;
}

/** Simetría: refleja el cuerpo de una extrusión o revolución respecto de un plano base. */
export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  source: FeatureId;
  plane: BasePlane;
}

/**
 * Barrido: el perfil cerrado de un sketch recorre la trayectoria de otro sketch (una cadena de
 * líneas y arcos, abierta o cerrada). La orientación del perfil acompaña la curva (Frenet corregido).
 */
export interface SweepFeature extends FeatureBase {
  type: 'sweep';
  profile: FeatureId;
  path: FeatureId;
  operation: BooleanOperation;
}

/**
 * Solevación: une dos o más secciones (un perfil cerrado por sketch, en orden) con una superficie
 * suave, o con caras planas entre sección y sección si `ruled`.
 */
export interface LoftFeature extends FeatureBase {
  type: 'loft';
  sections: FeatureId[];
  ruled: boolean;
  operation: BooleanOperation;
}

/**
 * Plano de construcción (como en Fusion): parte de una referencia, se gira `angle` grados
 * alrededor de un eje paralelo a X/Y/Z que pasa por el origen de la referencia, y se desplaza
 * `distance` mm a lo largo de su nueva normal. No cambia el sólido; sirve de apoyo a sketches.
 */
export interface PlaneFeature extends FeatureBase {
  type: 'plane';
  reference: PlaneReference;
  axis: 'none' | GlobalAxis;
  angle: number;
  distance: number;
}

/**
 * Agujero en cada centro del sketch (puntos sueltos y centros de círculos), perpendicular a su
 * plano y hacia adentro del material (contra la normal del sketch, o a favor si `reversed`).
 */
export interface HoleFeature extends FeatureBase {
  type: 'hole';
  sketch: FeatureId;
  kind: 'simple' | 'counterbore' | 'countersink';
  diameter: number;
  /** Hasta una profundidad o pasante (atraviesa todo el sólido). */
  extent: 'distance' | 'through';
  depth: number;
  /** Fondo plano o punta de mecha (118°); solo con profundidad. */
  tip: 'flat' | 'drill';
  /** Cajeado: diámetro y profundidad del alojamiento de la cabeza. */
  cbDiameter: number;
  cbDepth: number;
  /** Avellanado: diámetro en la superficie y ángulo del cono (90° para tornillos métricos). */
  csDiameter: number;
  csAngle: number;
  reversed: boolean;
  /**
   * Rosca modelada (métrica, 60°): `diameter` pasa a ser el nominal (M8 = 8); se perfora al
   * diámetro menor y se talla el hilo. `threadClearance` agranda todo (diametral) para que enrosque impreso.
   */
  thread: boolean;
  threadPitch: number;
  threadClearance: number;
}

/**
 * Rosca sobre una cara cilíndrica: interna si es un agujero (su diámetro es el menor), externa si
 * es una barra (su diámetro es el mayor). `length` 0 = toda la cara; si no, desde un extremo.
 */
export interface ThreadFeature extends FeatureBase {
  type: 'thread';
  face: FaceRef;
  pitch: number;
  clearance: number;
  length: number;
  fromStart: boolean;
}

export type Feature =
  | SketchFeature | ExtrudeFeature | RevolveFeature | FilletFeature | ChamferFeature | ShellFeature
  | PatternFeature | MirrorFeature | SweepFeature | LoftFeature | PlaneFeature | HoleFeature | ThreadFeature;
/** Features que repiten o reflejan otra. */
export type CopyFeature = PatternFeature | MirrorFeature;
/** Features que consumen un sketch. */
export type ProfileFeature = ExtrudeFeature | RevolveFeature;
/** Features que crean cuerpo a partir de sketches (para dependencias y operación por defecto). */
export type BodyFeature = ProfileFeature | SweepFeature | LoftFeature;
export type FeatureType = Feature['type'];

export interface CadDocument {
  format: typeof DOCUMENT_FORMAT;
  version: typeof DOCUMENT_VERSION;
  units: 'mm';
  /** Tabla de parámetros con nombre, usables en las expresiones de las features. */
  parameters: Parameter[];
  features: Feature[];
  /**
   * Marcador de retroceso: cantidad de features activas desde el principio.
   * `null` = el marcador está al final (todas activas).
   */
  rollback: number | null;
}
