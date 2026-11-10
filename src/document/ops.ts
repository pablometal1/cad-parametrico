// Operaciones puras sobre el documento. Nunca mutan: devuelven un documento nuevo.
import { isValidName, parseExpression, plainNumber, referencedNames, renameInExpression } from './expressions';
import {
  DOCUMENT_FORMAT, DOCUMENT_VERSION,
  type CadDocument, type ChamferFeature, type EdgeRef, type ExtrudeFeature, type FaceRef, type Feature, type FeatureId,
  type FeatureType, type FilletFeature, type Parameter, type PatternFeature, type MirrorFeature, type BasePlane, type ProfileFeature, type RevolveFeature, type BodyFeature, type SweepFeature, type LoftFeature, type LoftSection, type PlaneFeature, type PlaneReference, type HoleFeature, type ThreadFeature, type ImportFeature, type ShellFeature, type SketchFeature,
  type PushPullFeature, type DraftFeature, type PatchFeature, type DomeFeature, type Curve3dFeature, type VertexRef, type CombineFeature, type SplitFeature, type MoveFeature, type LengthUnit,
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
  pattern: 'Patrón',
  mirror: 'Simetría',
  sweep: 'Barrido',
  loft: 'Solevación',
  plane: 'Plano',
  hole: 'Agujero',
  thread: 'Rosca',
  import: 'Importado',
  pushpull: 'Empujar',
  draft: 'Desmoldeo',
  combine: 'Combinar',
  split: 'División',
  move: 'Mover',
  patch: 'Parche',
  dome: 'Abombado',
  curve3d: 'Curva3D',
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

/** Sketches que usa una feature (extrusión, revolución, barrido o solevación). */
export function sketchesUsedBy(f: Feature): FeatureId[] {
  switch (f.type) {
    case 'extrude':
    case 'revolve':
      return [f.sketch];
    case 'sweep':
      return [f.profile, f.path];
    case 'loft':
      return [...f.sections.filter((x): x is FeatureId => typeof x === 'string'), ...(f.spine ? [f.spine] : [])];
    case 'hole':
      return [f.sketch];
    default:
      return [];
  }
}

export function isBodyFeature(f: Feature): f is BodyFeature {
  return isProfileFeature(f) || f.type === 'sweep' || f.type === 'loft';
}

/**
 * Features que dependen directamente de la indicada por id (las que usan un sketch).
 * Las referencias a caras/aristas son por nombre y no se listan acá.
 */
export function dependents(doc: CadDocument, id: FeatureId): Feature[] {
  return doc.features.filter(
    (f) =>
      sketchesUsedBy(f).includes(id) ||
      ((f.type === 'pattern' || f.type === 'mirror') && f.source === id) ||
      (f.type === 'patch' && !!f.curves?.includes(id)) ||
      (f.type === 'sketch' && f.plane.kind === 'plane' && f.plane.plane === id) ||
      (f.type === 'plane' && f.reference.kind === 'plane' && f.reference.plane === id) ||
      (f.type === 'split' && f.plane.kind === 'plane' && f.plane.plane === id),
  );
}

/** Sketches activos que todavía no usa ninguna feature activa. */
export function unusedSketches(doc: CadDocument): SketchFeature[] {
  const active = doc.features.slice(0, activeCount(doc)).filter((f) => !f.suppressed);
  const used = new Set(active.flatMap(sketchesUsedBy));
  return active.filter((f): f is SketchFeature => f.type === 'sketch' && !used.has(f.id));
}

function hasSolidBefore(doc: CadDocument): boolean {
  return doc.features.slice(0, activeCount(doc)).some((f) => isBodyFeature(f) && !f.suppressed);
}

// ---------------------------------------------------------------- mover en el historial

/** Ids de features que aparecen en un nombre de cara/arista (`f_abc:side:l1|f_def:end`). */
function idsInRefName(name: string): FeatureId[] {
  return name.split('|').flatMap((part) => {
    const id = part.split(':')[0];
    return id.startsWith('f_') ? [id] : [];
  });
}

/**
 * Features de las que depende `f` y que por eso tienen que quedar antes en el historial:
 * los sketches que usa, el origen de un patrón/simetría y las features que crearon las caras o
 * aristas que referencia (por el nombre topológico).
 */
export function requiredFeatures(f: Feature): Set<FeatureId> {
  const req = new Set<FeatureId>(sketchesUsedBy(f));
  if (f.type === 'pattern' || f.type === 'mirror') req.add(f.source);
  const names: string[] = [];
  if (f.type === 'sketch' && f.plane.kind === 'face') names.push(f.plane.face.name);
  if (f.type === 'sketch' && f.plane.kind === 'plane') req.add(f.plane.plane);
  if (f.type === 'plane' && f.reference.kind === 'plane') req.add(f.reference.plane);
  if (f.type === 'plane' && f.reference.kind === 'face') names.push(f.reference.face.name);
  if (f.type === 'plane' && f.axis === 'edge' && f.axisEdge) names.push(f.axisEdge.name);
  if (f.type === 'fillet' || f.type === 'chamfer') names.push(...f.edges.map((e) => e.name));
  if (f.type === 'shell') names.push(...f.faces.map((x) => x.name));
  if (f.type === 'thread') names.push(f.face.name);
  if (f.type === 'pushpull') names.push(...f.faces.map((x) => x.name));
  if (f.type === 'draft') names.push(...f.faces.map((x) => x.name), f.neutral.name);
  if (f.type === 'combine') names.push(f.target.name, ...f.tools.map((x) => x.name));
  if (f.type === 'split') {
    if (f.body) names.push(f.body.name);
    if (f.plane.kind === 'face') names.push(f.plane.face.name);
    if (f.plane.kind === 'plane') req.add(f.plane.plane);
  }
  if (f.type === 'move') names.push(...f.bodies.map((x) => x.name));
  if (f.type === 'patch') {
    names.push(...f.edges.map((x) => x.name));
    for (const c of f.curves ?? []) req.add(c);
  }
  if (f.type === 'loft') {
    for (const s of f.sections) {
      if (typeof s === 'string') continue;
      if ('face' in s) names.push(s.face.name);
      else names.push(...s.edges.map((e) => e.name));
    }
  }
  if (f.type === 'curve3d') names.push(...f.points.flatMap((p) => p.edges.map((e) => e.name)));
  if (f.type === 'dome') names.push(f.face.name);
  for (const n of names) for (const id of idsInRefName(n)) req.add(id);
  req.delete(f.id);
  return req;
}

/** Motivo por el que no se puede mover la feature a `toIndex` (null si se puede). */
export function moveBlocker(doc: CadDocument, id: FeatureId, toIndex: number): string | null {
  const from = doc.features.findIndex((f) => f.id === id);
  if (from < 0) return 'La feature no existe';
  if (toIndex < 0 || toIndex >= doc.features.length) return 'Posición fuera del historial';
  if (toIndex === from) return null;
  const f = doc.features[from];
  if (toIndex < from) {
    // Sube: no puede pasar por encima de algo que necesita.
    const req = requiredFeatures(f);
    const blocker = doc.features.slice(toIndex, from).find((x) => req.has(x.id));
    if (blocker) return `"${f.name}" usa "${blocker.name}": tiene que quedar después`;
  } else {
    // Baja: no puede pasar por debajo de algo que la necesita.
    const blocker = doc.features.slice(from + 1, toIndex + 1).find((x) => requiredFeatures(x).has(f.id));
    if (blocker) return `"${blocker.name}" usa "${f.name}": tiene que quedar antes`;
  }
  return null;
}

/**
 * Mueve una feature a la posición `toIndex` (índice final en la lista). El marcador de historial
 * sigue a las mismas features: si estaba activa sigue activa y viceversa.
 */
export function moveFeature(doc: CadDocument, id: FeatureId, toIndex: number): CadDocument {
  const reason = moveBlocker(doc, id, toIndex);
  if (reason) throw new Error(reason);
  const from = doc.features.findIndex((f) => f.id === id);
  if (from === toIndex) return doc;
  const features = doc.features.slice();
  const [f] = features.splice(from, 1);
  features.splice(toIndex, 0, f);
  let rollback = doc.rollback;
  if (rollback !== null) {
    const wasActive = from < rollback;
    const nowActive = toIndex < rollback;
    // Sale de la zona activa (baja más allá del marcador) o entra (sube por encima).
    if (wasActive && !nowActive) rollback--;
    else if (!wasActive && nowActive) rollback++;
    // El marcador al final equivale a "sin marcador".
    if (rollback >= features.length) rollback = null;
  }
  return { ...doc, features, rollback };
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

export function makePattern(doc: CadDocument, source: FeatureId, overrides: Partial<Omit<PatternFeature, 'type' | 'source'>> = {}): PatternFeature {
  return { ...base(doc, 'pattern'), source, kind: 'linear', axis: 'X', count: 3, spacing: 20, angle: 360, ...overrides };
}

export function makeMirror(doc: CadDocument, source: FeatureId, plane: BasePlane = 'YZ'): MirrorFeature {
  return { ...base(doc, 'mirror'), source, plane };
}

export function makePushPull(doc: CadDocument, faces: FaceRef[], distance = 5): PushPullFeature {
  return { ...base(doc, 'pushpull'), faces, distance };
}

export function makeDraft(doc: CadDocument, faces: FaceRef[], neutral: FaceRef, angle = 3): DraftFeature {
  return { ...base(doc, 'draft'), faces, neutral, angle };
}

export function makeCombine(doc: CadDocument, target: FaceRef, tools: FaceRef[], operation: CombineFeature['operation'] = 'join'): CombineFeature {
  return { ...base(doc, 'combine'), target, tools, operation, keepTools: false };
}

export function makeSplit(doc: CadDocument, plane: PlaneReference = { kind: 'base', plane: 'XY' }, overrides: Partial<Omit<SplitFeature, 'type'>> = {}): SplitFeature {
  return { ...base(doc, 'split'), plane, offset: 0, ...overrides };
}

export function makeMove(doc: CadDocument, bodies: FaceRef[] = [], overrides: Partial<Omit<MoveFeature, 'type'>> = {}): MoveFeature {
  return { ...base(doc, 'move'), bodies, dx: 10, dy: 0, dz: 0, axis: 'Z', angle: 0, copy: false, ...overrides };
}

export function makePatch(doc: CadDocument, edges: EdgeRef[], overrides: Partial<Omit<PatchFeature, 'type'>> = {}): PatchFeature {
  return { ...base(doc, 'patch'), edges, height: 0, thickness: 2, operation: hasSolidBefore(doc) ? 'join' : 'new', ...overrides };
}

export function makeCurve3d(doc: CadDocument, points: VertexRef[], closed = false): Curve3dFeature {
  return { ...base(doc, 'curve3d'), points, closed };
}

export function makeDome(doc: CadDocument, face: FaceRef, height = 3): DomeFeature {
  return { ...base(doc, 'dome'), face, height };
}

/** Plano de construcción: por defecto, XY desplazado 20 mm. */
export function makePlane(doc: CadDocument, reference: PlaneReference = { kind: 'base', plane: 'XY' }, overrides: Partial<Omit<PlaneFeature, 'type'>> = {}): PlaneFeature {
  return { ...base(doc, 'plane'), reference, axis: 'none', angle: 0, distance: 20, ...overrides };
}

/** Agujero M3 de paso libre, pasante, en los centros del sketch. */
export function makeHole(doc: CadDocument, sketch: FeatureId, overrides: Partial<Omit<HoleFeature, 'type'>> = {}): HoleFeature {
  return {
    ...base(doc, 'hole'), sketch, kind: 'simple', diameter: 3.4, extent: 'through', depth: 10, tip: 'flat',
    cbDiameter: 6.5, cbDepth: 3.3, csDiameter: 6.7, csAngle: 90, reversed: false,
    thread: false, threadPitch: 1.25, threadClearance: 0.2, ...overrides,
  };
}

/** Rosca sobre una cara cilíndrica, con el paso grueso ISO más cercano a su diámetro. */
export function makeThread(doc: CadDocument, face: FaceRef, pitch: number, overrides: Partial<Omit<ThreadFeature, 'type'>> = {}): ThreadFeature {
  return { ...base(doc, 'thread'), face, pitch, clearance: 0.2, length: 0, fromStart: false, ...overrides };
}

export function makeImport(doc: CadDocument, fileName: string, format: ImportFeature['format'], data: string): ImportFeature {
  return {
    ...base(doc, 'import'), fileName, format, data, operation: 'new',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: 1,
  };
}

export function makeSweep(doc: CadDocument, profile: FeatureId, path: FeatureId, overrides: Partial<Omit<SweepFeature, 'type'>> = {}): SweepFeature {
  return { ...base(doc, 'sweep'), profile, path, operation: hasSolidBefore(doc) ? 'join' : 'new', ...overrides };
}

export function makeLoft(doc: CadDocument, sections: LoftSection[], overrides: Partial<Omit<LoftFeature, 'type'>> = {}): LoftFeature {
  return { ...base(doc, 'loft'), sections, ruled: false, operation: hasSolidBefore(doc) ? 'join' : 'new', ...overrides };
}

/** ¿Se puede repetir/reflejar esta feature? (por ahora, extrusiones y revoluciones). */
export function isCopyable(f: Feature | undefined): f is ProfileFeature {
  return !!f && isProfileFeature(f);
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


// ------------------------------------------------------------ Unidades y escala

export const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
};

export const UNIT_LABELS: Record<LengthUnit, string> = {
  mm: 'Milímetros (mm)',
  cm: 'Centímetros (cm)',
  m: 'Metros (m)',
  in: 'Pulgadas (in)',
};

export const UNIT_SYMBOLS: Record<LengthUnit, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  in: 'in',
};

function scaleVec3(v: [number, number, number], s: (n: number) => number): [number, number, number] {
  return [s(v[0]), s(v[1]), s(v[2])];
}

function scaleFaceRef(f: FaceRef, s: (n: number) => number, factor: number): FaceRef {
  return {
    ...f,
    center: scaleVec3(f.center, s),
    area: Number((f.area * factor * factor).toPrecision(12)),
  };
}

function scaleEdgeRef(e: EdgeRef, s: (n: number) => number): EdgeRef {
  return {
    ...e,
    center: scaleVec3(e.center, s),
    length: s(e.length),
  };
}

function scalePlaneReference(p: PlaneReference, s: (n: number) => number, factor: number): PlaneReference {
  if (p.kind === 'face') {
    return { kind: 'face', face: scaleFaceRef(p.face, s, factor) };
  }
  return p;
}

function scaleVertexRef(v: VertexRef, s: (n: number) => number): VertexRef {
  return {
    point: scaleVec3(v.point, s),
    edges: v.edges.map((e) => scaleEdgeRef(e, s)),
  };
}

/**
 * Escala todas las dimensiones lineales y posiciones geométricas del documento por un factor.
 * Los ángulos se conservan. Los parámetros con expresiones numéricas directas también se escalan.
 */
export function scaleDocument(doc: CadDocument, factor: number): CadDocument {
  if (factor === 1 || !(factor > 0) || !Number.isFinite(factor)) return doc;

  const s = (v: number) => Number((v * factor).toPrecision(12));

  // Escalar parámetros que sean números simples
  const parameters = doc.parameters.map((p) => {
    const n = plainNumber(p.expression);
    if (n !== null) {
      return { ...p, expression: String(s(n)) };
    }
    return p;
  });

  // Escalar cada feature según su tipo
  const features = doc.features.map((f): Feature => {
    // Si tiene expresiones numéricas simples guardadas en f.exprs, escalarlas también
    let nextExprs = f.exprs;
    if (f.exprs) {
      let changed = false;
      const copy: Record<string, string> = { ...f.exprs };
      for (const [k, exprStr] of Object.entries(f.exprs)) {
        const n = plainNumber(exprStr);
        if (n !== null) {
          copy[k] = String(s(n));
          changed = true;
        }
      }
      if (changed) nextExprs = copy;
    }

    const baseScaled = nextExprs !== f.exprs ? { ...f, exprs: nextExprs } : { ...f };

    switch (baseScaled.type) {
      case 'sketch': {
        const sk = baseScaled as SketchFeature;
        let plane = sk.plane;
        if (sk.plane.kind === 'face') {
          plane = { ...sk.plane, face: scaleFaceRef(sk.plane.face, s, factor), offset: s(sk.plane.offset) };
        } else if (sk.plane.offset !== undefined) {
          plane = { ...sk.plane, offset: s(sk.plane.offset) };
        }
        const entities = sk.entities.map((ent) => {
          if (ent.type === 'point') return { ...ent, x: s(ent.x), y: s(ent.y) };
          if (ent.type === 'circle') return { ...ent, radius: s(ent.radius) };
          if ('height' in ent && typeof (ent as any).height === 'number') {
            return { ...ent, height: s((ent as any).height) };
          }
          return ent;
        });
        const constraints = sk.constraints.map((c) => {
          if (c.type === 'distance' || c.type === 'radius') {
            return { ...c, value: s(c.value) };
          }
          return c;
        });
        return { ...sk, plane, entities, constraints } as Feature;
      }
      case 'extrude': {
        const ext = baseScaled as ExtrudeFeature;
        return {
          ...ext,
          distance: s(ext.distance),
          thin: ext.thin !== undefined ? s(ext.thin) : undefined,
        } as Feature;
      }
      case 'fillet': {
        const fil = baseScaled as FilletFeature;
        return {
          ...fil,
          radius: s(fil.radius),
          radius2: fil.radius2 !== undefined ? s(fil.radius2) : undefined,
          edges: fil.edges.map((e) => scaleEdgeRef(e, s)),
        } as Feature;
      }
      case 'chamfer': {
        const ch = baseScaled as ChamferFeature;
        return {
          ...ch,
          distance: s(ch.distance),
          edges: ch.edges.map((e) => scaleEdgeRef(e, s)),
        } as Feature;
      }
      case 'shell': {
        const sh = baseScaled as ShellFeature;
        return {
          ...sh,
          thickness: s(sh.thickness),
          faces: sh.faces.map((face) => scaleFaceRef(face, s, factor)),
        } as Feature;
      }
      case 'hole': {
        const h = baseScaled as HoleFeature;
        return {
          ...h,
          diameter: s(h.diameter),
          depth: s(h.depth),
          threadPitch: h.threadPitch !== undefined ? s(h.threadPitch) : undefined,
          threadClearance: h.threadClearance !== undefined ? s(h.threadClearance) : undefined,
          cbDiameter: h.cbDiameter !== undefined ? s(h.cbDiameter) : undefined,
          cbDepth: h.cbDepth !== undefined ? s(h.cbDepth) : undefined,
          csDiameter: h.csDiameter !== undefined ? s(h.csDiameter) : undefined,
        } as Feature;
      }
      case 'thread': {
        const th = baseScaled as ThreadFeature;
        return {
          ...th,
          face: scaleFaceRef(th.face, s, factor),
          pitch: s(th.pitch),
          clearance: s(th.clearance),
          length: s(th.length),
        } as Feature;
      }
      case 'pushpull': {
        const pp = baseScaled as PushPullFeature;
        return {
          ...pp,
          distance: s(pp.distance),
          faces: pp.faces.map((face) => scaleFaceRef(face, s, factor)),
        } as Feature;
      }
      case 'draft': {
        const dr = baseScaled as DraftFeature;
        return {
          ...dr,
          neutral: scaleFaceRef(dr.neutral, s, factor),
          faces: dr.faces.map((face) => scaleFaceRef(face, s, factor)),
        } as Feature;
      }
      case 'move': {
        const mv = baseScaled as MoveFeature;
        return {
          ...mv,
          dx: s(mv.dx),
          dy: s(mv.dy),
          dz: s(mv.dz),
          bodies: mv.bodies.map((b) => scaleFaceRef(b, s, factor)),
        } as Feature;
      }
      case 'patch': {
        const pa = baseScaled as PatchFeature;
        return {
          ...pa,
          height: s(pa.height),
          thickness: s(pa.thickness),
          edges: pa.edges.map((e) => scaleEdgeRef(e, s)),
        } as Feature;
      }
      case 'dome': {
        const dm = baseScaled as DomeFeature;
        return {
          ...dm,
          height: s(dm.height),
          face: scaleFaceRef(dm.face, s, factor),
        } as Feature;
      }
      case 'plane': {
        const pl = baseScaled as PlaneFeature;
        return {
          ...pl,
          distance: s(pl.distance),
          reference: scalePlaneReference(pl.reference, s, factor),
          axisEdge: pl.axisEdge ? scaleEdgeRef(pl.axisEdge, s) : undefined,
        } as Feature;
      }
      case 'pattern': {
        const pat = baseScaled as PatternFeature;
        if (pat.kind === 'linear') {
          return {
            ...pat,
            spacing: s(pat.spacing),
          } as Feature;
        }
        return pat as Feature;
      }
      case 'curve3d': {
        const c3 = baseScaled as Curve3dFeature;
        return {
          ...c3,
          points: c3.points.map((p) => scaleVertexRef(p, s)),
          handles: c3.handles?.map((h) =>
            h ? [scaleVec3(h[0], s), scaleVec3(h[1], s)] : null
          ),
        } as Feature;
      }
      case 'combine': {
        const cb = baseScaled as CombineFeature;
        return {
          ...cb,
          target: scaleFaceRef(cb.target, s, factor),
          tools: cb.tools.map((t) => scaleFaceRef(t, s, factor)),
        } as Feature;
      }
      case 'split': {
        const sp = baseScaled as SplitFeature;
        return {
          ...sp,
          offset: s(sp.offset),
          plane: scalePlaneReference(sp.plane, s, factor),
          body: sp.body ? scaleFaceRef(sp.body, s, factor) : undefined,
        } as Feature;
      }
      case 'loft': {
        const lf = baseScaled as LoftFeature;
        return {
          ...lf,
          thickness: lf.thickness !== undefined ? s(lf.thickness) : undefined,
          sections: lf.sections.map((sec) => {
            if (typeof sec === 'string') return sec;
            if ('face' in sec) return { face: scaleFaceRef(sec.face, s, factor) };
            if ('edges' in sec) return { edges: sec.edges.map((e) => scaleEdgeRef(e, s)) };
            return sec;
          }),
        } as Feature;
      }
      case 'import': {
        const imp = baseScaled as ImportFeature;
        return {
          ...imp,
          position: scaleVec3(imp.position, s),
        } as Feature;
      }
      default:
        return baseScaled;
    }
  });

  return {
    ...doc,
    parameters,
    features,
  };
}

/**
 * Ajusta la unidad del documento ('mm', 'cm', 'm', 'in').
 * Si convertGeometry es true (por defecto), reescala automáticamente todas las dimensiones del
 * modelo para preservar el tamaño físico real (ej. 25.4 mm -> 1 in).
 * Si convertGeometry es false, reinterpreta los números existentes bajo la nueva unidad.
 */
export function setDocumentUnits(
  doc: CadDocument,
  newUnits: LengthUnit,
  convertGeometry = true
): CadDocument {
  if (doc.units === newUnits) return doc;
  if (!convertGeometry) {
    return { ...doc, units: newUnits };
  }
  const factor = MM_PER_UNIT[doc.units] / MM_PER_UNIT[newUnits];
  const scaled = scaleDocument(doc, factor);
  return { ...scaled, units: newUnits };
}