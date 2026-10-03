// Operaciones puras sobre el documento. Nunca mutan: devuelven un documento nuevo.
import {
  DOCUMENT_FORMAT, DOCUMENT_VERSION,
  type CadDocument, type ExtrudeFeature, type Feature, type FeatureId, type FeatureType,
} from './types';

export function emptyDocument(): CadDocument {
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, units: 'mm', features: [], rollback: null };
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

const TYPE_LABELS: Record<FeatureType, string> = { extrude: 'Extrusión' };

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

/** Extrusión con valores por defecto, lista para insertar. */
export function makeExtrude(doc: CadDocument, overrides: Partial<Omit<ExtrudeFeature, 'type'>> = {}): ExtrudeFeature {
  const hasSolid = doc.features.slice(0, activeCount(doc)).some((f) => !f.suppressed);
  return {
    id: newFeatureId(),
    type: 'extrude',
    name: nextFeatureName(doc, 'extrude'),
    suppressed: false,
    profile: { kind: 'rectangle', plane: 'XY', offset: 0, center: [0, 0], width: 40, height: 30 },
    distance: 20,
    direction: 'normal',
    operation: hasSolid ? 'join' : 'new',
    ...overrides,
  };
}
