// Serialización JSON del documento, con validación estricta al leer.
import {
  DOCUMENT_FORMAT, DOCUMENT_VERSION,
  type BasePlane, type CadDocument, type ExtrudeFeature, type Feature, type Profile,
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
    case 'extrude': {
      const f: ExtrudeFeature = {
        ...base,
        type: 'extrude',
        profile: validateProfile(o.profile, `${path}.profile`),
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

function validateProfile(raw: unknown, path: string): Profile {
  const o = obj(raw, path);
  const plane = oneOf(o.plane, ['XY', 'XZ', 'YZ'] as const satisfies readonly BasePlane[], `${path}.plane`);
  const offset = num(o.offset, `${path}.offset`);
  const center = vec2(o.center, `${path}.center`);
  switch (o.kind) {
    case 'rectangle':
      return { kind: 'rectangle', plane, offset, center, width: num(o.width, `${path}.width`), height: num(o.height, `${path}.height`) };
    case 'circle':
      return { kind: 'circle', plane, offset, center, radius: num(o.radius, `${path}.radius`) };
    default:
      throw new DocumentFormatError(`${path}.kind`, `tipo de perfil desconocido: ${String(o.kind)}`);
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
function vec2(v: unknown, path: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new DocumentFormatError(path, 'debe ser [x, y]');
  return [num(v[0], `${path}[0]`), num(v[1], `${path}[1]`)];
}
function oneOf<T extends string>(v: unknown, options: readonly T[], path: string): T {
  if (!options.includes(v as T)) throw new DocumentFormatError(path, `debe ser uno de: ${options.join(', ')}`);
  return v as T;
}
