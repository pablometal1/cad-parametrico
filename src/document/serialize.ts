// Serialización JSON del documento, con validación estricta al leer.
import {
  DOCUMENT_FORMAT, DOCUMENT_VERSION, IMPLICIT_IDS, ORIGIN,
  type BasePlane, type CadDocument, type ExtrudeFeature, type Feature, type SketchConstraint,
  type SketchEntity, type SketchFeature, type SketchPlaneRef,
} from './types';

export function serializeDocument(doc: CadDocument): string {
  return JSON.stringify(doc, null, 2);
}

export class DocumentFormatError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'DocumentFormatError';
  }
}

/** Lee y valida un documento. Lanza DocumentFormatError indicando el campo problemático. */
export function parseDocument(text: string): CadDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DocumentFormatError('$', `JSON inválido (${(err as Error).message})`);
  }
  return validateDocument(raw);
}

export function validateDocument(raw: unknown): CadDocument {
  const o = obj(raw, '$');
  if (o.format !== DOCUMENT_FORMAT) throw new DocumentFormatError('$.format', `se esperaba "${DOCUMENT_FORMAT}"`);
  if (o.version !== DOCUMENT_VERSION) throw new DocumentFormatError('$.version', `versión no soportada: ${String(o.version)}`);
  if (o.units !== 'mm') throw new DocumentFormatError('$.units', 'solo se admite "mm"');
  if (!Array.isArray(o.features)) throw new DocumentFormatError('$.features', 'debe ser una lista');

  const features = o.features.map((f, i) => validateFeature(f, `$.features[${i}]`));
  const ids = new Set<string>();
  features.forEach((f, i) => {
    if (ids.has(f.id)) throw new DocumentFormatError(`$.features[${i}].id`, `ID duplicado "${f.id}"`);
    ids.add(f.id);
  });

  let rollback: number | null = null;
  if (o.rollback !== null && o.rollback !== undefined) {
    rollback = int(o.rollback, '$.rollback');
    if (rollback < 0 || rollback > features.length) throw new DocumentFormatError('$.rollback', 'fuera de rango');
    if (rollback === features.length) rollback = null;
  }
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, units: 'mm', features, rollback };
}

function validateFeature(raw: unknown, path: string): Feature {
  const o = obj(raw, path);
  const base = {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    suppressed: bool(o.suppressed, `${path}.suppressed`),
  };
  switch (o.type) {
    case 'sketch':
      return validateSketch(o, base, path);
    case 'extrude': {
      const f: ExtrudeFeature = {
        ...base,
        type: 'extrude',
        sketch: str(o.sketch, `${path}.sketch`),
        distance: num(o.distance, `${path}.distance`),
        direction: oneOf(o.direction, ['normal', 'reversed', 'symmetric'] as const, `${path}.direction`),
        operation: oneOf(o.operation, ['new', 'join', 'cut'] as const, `${path}.operation`),
      };
      return f;
    }
    default:
      throw new DocumentFormatError(`${path}.type`, `tipo de feature desconocido: ${String(o.type)}`);
  }
}

function validateSketch(
  o: Record<string, unknown>,
  base: Pick<SketchFeature, 'id' | 'name' | 'suppressed'>,
  path: string,
): SketchFeature {
  const po = obj(o.plane, `${path}.plane`);
  if (po.kind !== 'base') throw new DocumentFormatError(`${path}.plane.kind`, 'solo se admiten planos base');
  const plane: SketchPlaneRef = {
    kind: 'base',
    plane: oneOf(po.plane, ['XY', 'XZ', 'YZ'] as const satisfies readonly BasePlane[], `${path}.plane.plane`),
    offset: num(po.offset, `${path}.plane.offset`),
  };
  if (!Array.isArray(o.entities)) throw new DocumentFormatError(`${path}.entities`, 'debe ser una lista');
  if (!Array.isArray(o.constraints)) throw new DocumentFormatError(`${path}.constraints`, 'debe ser una lista');

  const entities = o.entities.map((e, i) => validateEntity(e, `${path}.entities[${i}]`));
  const kinds = new Map<string, string>(IMPLICIT_IDS.map((id) => [id, id === ORIGIN ? 'point' : 'line']));
  entities.forEach((e, i) => {
    if (kinds.has(e.id)) throw new DocumentFormatError(`${path}.entities[${i}].id`, `ID duplicado o reservado "${e.id}"`);
    kinds.set(e.id, e.type);
  });
  entities.forEach((e, i) => {
    const refs = e.type === 'line' ? [e.p1, e.p2] : e.type === 'circle' ? [e.center] : e.type === 'arc' ? [e.center, e.start, e.end] : [];
    for (const r of refs) {
      if (kinds.get(r) !== 'point') throw new DocumentFormatError(`${path}.entities[${i}]`, `referencia a un punto inexistente "${r}"`);
    }
  });
  const constraints = o.constraints.map((c, i) => validateConstraint(c, `${path}.constraints[${i}]`));
  constraints.forEach((c, i) => {
    if (kinds.has(c.id)) throw new DocumentFormatError(`${path}.constraints[${i}].id`, `ID duplicado "${c.id}"`);
    const refs = 'line' in c ? [c.line] : 'curve' in c ? [c.curve] : 'b' in c && c.b !== undefined ? [c.a, c.b] : [c.a];
    for (const r of refs) {
      if (!kinds.has(r)) throw new DocumentFormatError(`${path}.constraints[${i}]`, `referencia a una entidad inexistente "${r}"`);
    }
  });
  constraints.forEach((c) => kinds.set(c.id, 'constraint'));
  return { ...base, type: 'sketch', plane, entities, constraints };
}

function validateEntity(raw: unknown, path: string): SketchEntity {
  const o = obj(raw, path);
  const id = str(o.id, `${path}.id`);
  const construction = () => bool(o.construction, `${path}.construction`);
  switch (o.type) {
    case 'point':
      return { id, type: 'point', x: num(o.x, `${path}.x`), y: num(o.y, `${path}.y`) };
    case 'line':
      return { id, type: 'line', p1: str(o.p1, `${path}.p1`), p2: str(o.p2, `${path}.p2`), construction: construction() };
    case 'circle':
      return { id, type: 'circle', center: str(o.center, `${path}.center`), radius: num(o.radius, `${path}.radius`), construction: construction() };
    case 'arc':
      return {
        id, type: 'arc', center: str(o.center, `${path}.center`), start: str(o.start, `${path}.start`),
        end: str(o.end, `${path}.end`), construction: construction(),
      };
    default:
      throw new DocumentFormatError(`${path}.type`, `tipo de entidad desconocido: ${String(o.type)}`);
  }
}

function validateConstraint(raw: unknown, path: string): SketchConstraint {
  const o = obj(raw, path);
  const id = str(o.id, `${path}.id`);
  const a = () => str(o.a, `${path}.a`);
  const b = () => str(o.b, `${path}.b`);
  switch (o.type) {
    case 'coincident':
    case 'parallel':
    case 'perpendicular':
    case 'tangent':
    case 'equal':
      return { id, type: o.type, a: a(), b: b() };
    case 'horizontal':
    case 'vertical':
      return { id, type: o.type, line: str(o.line, `${path}.line`) };
    case 'distance':
      return o.b === undefined
        ? { id, type: 'distance', a: a(), value: num(o.value, `${path}.value`) }
        : { id, type: 'distance', a: a(), b: b(), value: num(o.value, `${path}.value`) };
    case 'radius':
      return { id, type: 'radius', curve: str(o.curve, `${path}.curve`), value: num(o.value, `${path}.value`) };
    case 'angle':
      return { id, type: 'angle', a: a(), b: b(), value: num(o.value, `${path}.value`) };
    default:
      throw new DocumentFormatError(`${path}.type`, `tipo de restricción desconocido: ${String(o.type)}`);
  }
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new DocumentFormatError(path, 'debe ser un objeto');
  return v as Record<string, unknown>;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new DocumentFormatError(path, 'debe ser un texto no vacío');
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new DocumentFormatError(path, 'debe ser true o false');
  return v;
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DocumentFormatError(path, 'debe ser un número finito');
  return v;
}
function int(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) throw new DocumentFormatError(path, 'debe ser un entero');
  return n;
}
function oneOf<T extends string>(v: unknown, options: readonly T[], path: string): T {
  if (!options.includes(v as T)) throw new DocumentFormatError(path, `debe ser uno de: ${options.join(', ')}`);
  return v as T;
}
