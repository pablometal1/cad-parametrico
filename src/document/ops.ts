// Operaciones puras sobre el documento. Nunca mutan: devuelven un documento nuevo.
import { isValidName, parseExpression, referencedNames, renameInExpression } from './expressions';
import {
  DOCUMENT_FORMAT, DOCUMENT_VERSION,
  type CadDocument, type ChamferFeature, type EdgeRef, type ExtrudeFeature, type FaceRef, type Feature, type FeatureId,
  type FeatureType, type FilletFeature, type Parameter, type ProfileFeature, type RevolveFeature, type ShellFeature, type SketchFeature,
} from './types';

export function emptyDocument(): CadDocument {
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, units: 'mm', parameters: [], features: [], rollback: null };
}

/** Cantidad de features por encima del marcador de retroceso. */
export function activeCount(doc: CadDocument): number {
  return doc.rollback ?? doc.features.length;
}

export function isRolledBack(doc: CadDocument, index: number): boolean {
  return index >= activeCount(doc);
}

export function findFeature(doc: CadDocument, id: FeatureId): Feature | undefined {
  return doc.features.find((f) => f.id === id);
}

function indexOrThrow(doc: CadDocument, id: FeatureId): number {
  const i = doc.features.findIndex((f) => f.id === id);
  if (i < 0) throw new Error(`No existe la feature ${id}`);
  return i;
}

function normalizeRollback(rollback: number | null, length: number): number | null {
  if (rollback === null || rollback >= length) return null;
  return Math.max(0, rollback);
}

/**
 * Inserta una feature en la posición del marcador (al final si no hay retroceso).
 * Si hay retroceso, el marcador avanza para quedar justo después de la nueva feature.
 */
export function addFeature(doc: CadDocument, feature: Feature): CadDocument {
  if (doc.features.some((f) => f.id === feature.id)) throw new Error(`ID duplicado: ${feature.id}`);
  const at = activeCount(doc);
  const features = [...doc.features.slice(0, at), feature, ...doc.features.slice(at)];
  const rollback = doc.rollback === null ? null : normalizeRollback(at + 1, features.length);
  return { ...doc, features, rollback };
}

/**
 * Reemplaza campos de una feature. El id y el tipo no se pueden cambiar.
 * Si el parche no cambia ningún valor, devuelve el mismo documento (misma referencia).
 */
export function updateFeature<F extends Feature>(
  doc: CadDocument,
  id: FeatureId,
  patch: Partial<Omit<F, 'id' | 'type'>>,
): CadDocument {
  const i = indexOrThrow(doc, id);
  const current = doc.features[i];
  const updated = { ...current, ...patch, id: current.id, type: current.type } as Feature;
  if (JSON.stringify(updated) === JSON.stringify(current)) return doc;
  const features = doc.features.slice();
  features[i] = updated;
  return { ...doc, features };
}

export function deleteFeature(doc: CadDocument, id: FeatureId): CadDocument {
  const i = indexOrThrow(doc, id);
  const features = doc.features.filter((_, j) => j !== i);
  let rollback = doc.rollback;
  if (rollback !== null && i < rollback) rollback -= 1;
  return { ...doc, features, rollback: normalizeRollback(rollback, features.length) };
}

export function setSuppressed(doc: CadDocument, id: FeatureId, suppressed: boolean): CadDocument {
  return updateFeature(doc, id, { suppressed });
}

/**
 * Mueve el marcador de retroceso para que queden activas las primeras `count` features.
 * `null` o un valor >= cantidad de features lo lleva al final.
 */
export function setRollback(doc: CadDocument, count: number | null): CadDocument {
  if (count !== null && (!Number.isInteger(count) || count < 0)) throw new Error(`Posición de retroceso inválida: ${count}`);
  return { ...doc, rollback: normalizeRollback(count, doc.features.length) };
}

/** Deja el marcador justo después de la feature indicada. */
export function rollbackAfter(doc: CadDocument, id: FeatureId): CadDocument {
  return setRollback(doc, indexOrThrow(doc, id) + 1);
}

export const TYPE_LABELS: Record<FeatureType, string> = {
  sketch: 'Sketch',
  extrude: 'Extrusión',
  revolve: 'Revolución',
  fillet: 'Redondeo',
  chamfer: 'Chaflán',
  shell: 'Vaciado',
};

/** Nombre libre con numeración incremental por tipo: Extrusión1, Extrusión2… */
export function nextFeatureName(doc: CadDocument, type: FeatureType): string {
  const base = TYPE_LABELS[type];
  const used = new Set(doc.features.map((f) => f.name));
  let n = 1;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function newFeatureId(): FeatureId {
  return 'f_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/** Sketch vacío sobre un plano base. */
export function makeSketch(doc: CadDocument, overrides: Partial<Omit<SketchFeature, 'type'>> = {}): SketchFeature {
  return {
    id: newFeatureId(),
    type: 'sketch',
    name: nextFeatureName(doc, 'sketch'),
    suppressed: false,
    plane: { kind: 'base', plane: 'XY', offset: 0 },
    entities: [],
    constraints: [],
    ...overrides,
  };
}

/** Extrusión de un sketch con valores por defecto, lista para insertar. */
export function makeExtrude(
  doc: CadDocument,
  sketch: FeatureId,
  overrides: Partial<Omit<ExtrudeFeature, 'type' | 'sketch'>> = {},
): ExtrudeFeature {
  return {
    ...base(doc, 'extrude'),
    sketch,
    distance: 20,
    direction: 'normal',
    operation: hasSolidBefore(doc) ? 'join' : 'new',
    ...overrides,
  };
}

/** ¿La feature consume un sketch (extrusión o revolución)? */
export function isProfileFeature(f: Feature): f is ProfileFeature {
  return f.type === 'extrude' || f.type === 'revolve';
}

/**
 * Features que dependen directamente de la indicada por id (las que usan un sketch).
 * Las referencias a caras/aristas son por nombre y no se listan acá.
 */
export function dependents(doc: CadDocument, id: FeatureId): Feature[] {
  return doc.features.filter((f) => isProfileFeature(f) && f.sketch === id);
}

/** Sketches activos que todavía no usa ninguna feature activa. */
export function unusedSketches(doc: CadDocument): SketchFeature[] {
  const active = doc.features.slice(0, activeCount(doc)).filter((f) => !f.suppressed);
  const used = new Set(active.flatMap((f) => (isProfileFeature(f) ? [f.sketch] : [])));
  return active.filter((f): f is SketchFeature => f.type === 'sketch' && !used.has(f.id));
}

function hasSolidBefore(doc: CadDocument): boolean {
  return doc.features.slice(0, activeCount(doc)).some((f) => isProfileFeature(f) && !f.suppressed);
}

function base<T extends FeatureType>(doc: CadDocument, type: T) {
  return { id: newFeatureId(), type, name: nextFeatureName(doc, type), suppressed: false };
}

export function makeRevolve(
  doc: CadDocument,
  sketch: SketchFeature,
  overrides: Partial<Omit<RevolveFeature, 'type' | 'sketch'>> = {},
): RevolveFeature {
  // Eje por defecto: la primera línea de construcción del sketch, o su eje vertical.
  const axisLine = sketch.entities.find((e) => e.type === 'line' && e.construction);
  return {
    ...base(doc, 'revolve'),
    sketch: sketch.id,
    axis: axisLine ? { kind: 'sketchLine', line: axisLine.id } : { kind: 'sketchAxis', axis: 'v' },
    angle: 360,
    operation: hasSolidBefore(doc) ? 'join' : 'new',
    ...overrides,
  };
}

export function makeFillet(doc: CadDocument, edges: EdgeRef[], radius = 2): FilletFeature {
  return { ...base(doc, 'fillet'), edges, radius };
}

export function makeChamfer(doc: CadDocument, edges: EdgeRef[], distance = 1): ChamferFeature {
  return { ...base(doc, 'chamfer'), edges, distance };
}

export function makeShell(doc: CadDocument, faces: FaceRef[], thickness = 2): ShellFeature {
  return { ...base(doc, 'shell'), faces, thickness };
}

// ---------------------------------------------------------------- parámetros

function newParamId(doc: CadDocument): string {
  const used = new Set(doc.parameters.map((p) => p.id));
  let n = doc.parameters.length + 1;
  while (used.has(`p${n}`)) n++;
  return `p${n}`;
}

/** Nombre libre: ancho, ancho2… */
export function nextParameterName(doc: CadDocument, base = 'param'): string {
  const used = new Set(doc.parameters.map((p) => p.name));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function addParameter(doc: CadDocument, name: string, expression: string, comment?: string): CadDocument {
  checkParameterName(doc, name);
  const p: Parameter = { id: newParamId(doc), name, expression };
  if (comment) p.comment = comment;
  return { ...doc, parameters: [...doc.parameters, p] };
}

export function updateParameter(doc: CadDocument, id: string, patch: Partial<Pick<Parameter, 'expression' | 'comment'>>): CadDocument {
  const i = doc.parameters.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`No existe el parámetro ${id}`);
  const current = doc.parameters[i];
  const next = { ...current, ...patch };
  if (JSON.stringify(next) === JSON.stringify(current)) return doc;
  const parameters = doc.parameters.slice();
  parameters[i] = next;
  return { ...doc, parameters };
}

/** Renombra un parámetro y actualiza todas las expresiones que lo usan. */
export function renameParameter(doc: CadDocument, id: string, name: string): CadDocument {
  const p = doc.parameters.find((x) => x.id === id);
  if (!p) throw new Error(`No existe el parámetro ${id}`);
  if (p.name === name) return doc;
  checkParameterName(doc, name, id);
  const from = p.name;
  const rename = (text: string) => renameInExpression(text, from, name);
  return {
    ...doc,
    parameters: doc.parameters.map((x) => ({ ...x, name: x.id === id ? name : x.name, expression: rename(x.expression) })),
    features: doc.features.map((f) =>
      f.exprs ? ({ ...f, exprs: Object.fromEntries(Object.entries(f.exprs).map(([k, v]) => [k, rename(v)])) } as Feature) : f,
    ),
  };
}

export function deleteParameter(doc: CadDocument, id: string): CadDocument {
  return { ...doc, parameters: doc.parameters.filter((p) => p.id !== id) };
}

/** Dónde se usa un parámetro (nombres de parámetros y de features). */
export function parameterUsage(doc: CadDocument, name: string): string[] {
  const uses = (text: string) => {
    try {
      return referencedNames(parseExpression(text)).has(name);
    } catch {
      return false;
    }
  };
  return [
    ...doc.parameters.filter((p) => p.name !== name && uses(p.expression)).map((p) => p.name),
    ...doc.features.filter((f) => f.exprs && Object.values(f.exprs).some(uses)).map((f) => f.name),
  ];
}

function checkParameterName(doc: CadDocument, name: string, exceptId?: string) {
  if (!isValidName(name)) {
    throw new Error(`"${name}" no es un nombre válido: usá letras, números y _ (sin empezar con número ni usar nombres de funciones)`);
  }
  if (doc.parameters.some((p) => p.name === name && p.id !== exceptId)) throw new Error(`Ya existe un parámetro "${name}"`);
}
