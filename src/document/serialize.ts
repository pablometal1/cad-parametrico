// Serialización JSON del documento, con validación estricta al leer.
import {
  DOCUMENT_FORMAT, DOCUMENT_VERSION, IMPLICIT_IDS, ORIGIN,
  type BasePlane, type CadDocument, type ExtrudeFeature, type Feature, type SketchConstraint,
  type SketchEntity, type SketchFeature, type SketchPlaneRef, type RevolveFeature, type FaceRef, type EdgeRef, type Vec3,
  type Parameter, type PlaneReference, type SketchSpline, type LoftFeature, type LoftSection, type Curve3dFeature, type Curve3dHandles, NURBS_MAX_DEGREE,
} from './types';
import { isValidName } from './expressions';

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

  const parameters = validateParameters(o.parameters);
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
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, units: 'mm', parameters, features, rollback };
}

function validateFeature(raw: unknown, path: string): Feature {
  const o = obj(raw, path);
  const base: { id: string; name: string; suppressed: boolean; exprs?: Record<string, string> } = {
    id: str(o.id, `${path}.id`),
    name: str(o.name, `${path}.name`),
    suppressed: bool(o.suppressed, `${path}.suppressed`),
  };
  if (o.exprs !== undefined) {
    const e = obj(o.exprs, `${path}.exprs`);
    base.exprs = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, str(v, `${path}.exprs.${k}`)]));
  }
  switch (o.type) {
    case 'sketch':
      return validateSketch(o, base, path);
    case 'revolve': {
      const ax = obj(o.axis, `${path}.axis`);
      const axis: RevolveFeature['axis'] =
        ax.kind === 'sketchAxis'
          ? { kind: 'sketchAxis', axis: oneOf(ax.axis, ['u', 'v'] as const, `${path}.axis.axis`) }
          : ax.kind === 'sketchLine'
            ? { kind: 'sketchLine', line: str(ax.line, `${path}.axis.line`) }
            : (() => { throw new DocumentFormatError(`${path}.axis.kind`, 'debe ser sketchAxis o sketchLine'); })();
      return {
        ...base, type: 'revolve', sketch: str(o.sketch, `${path}.sketch`), axis,
        angle: num(o.angle, `${path}.angle`),
        operation: oneOf(o.operation, ['new', 'join', 'cut', 'intersect'] as const, `${path}.operation`),
      };
    }
    case 'fillet':
      return {
        ...base, type: 'fillet', edges: list(o.edges, `${path}.edges`, edgeRef), radius: num(o.radius, `${path}.radius`),
        ...(o.radius2 !== undefined ? { radius2: num(o.radius2, `${path}.radius2`) } : {}),
      };
    case 'chamfer':
      return { ...base, type: 'chamfer', edges: list(o.edges, `${path}.edges`, edgeRef), distance: num(o.distance, `${path}.distance`) };
    case 'pattern':
      return {
        ...base, type: 'pattern', source: str(o.source, `${path}.source`),
        kind: oneOf(o.kind, ['linear', 'circular'] as const, `${path}.kind`),
        axis: oneOf(o.axis, ['X', 'Y', 'Z'] as const, `${path}.axis`),
        count: num(o.count, `${path}.count`),
        spacing: num(o.spacing, `${path}.spacing`),
        angle: num(o.angle, `${path}.angle`),
      };
    case 'mirror':
      return {
        ...base, type: 'mirror', source: str(o.source, `${path}.source`),
        plane: oneOf(o.plane, ['XY', 'XZ', 'YZ'] as const, `${path}.plane`),
      };
    case 'shell':
      return { ...base, type: 'shell', faces: list(o.faces, `${path}.faces`, faceRef), thickness: num(o.thickness, `${path}.thickness`) };
    case 'sweep':
      return {
        ...base, type: 'sweep', profile: str(o.profile, `${path}.profile`), path: str(o.path, `${path}.path`),
        operation: oneOf(o.operation, ['new', 'join', 'cut', 'intersect'] as const, `${path}.operation`),
      };
    case 'pushpull':
      return { ...base, type: 'pushpull', faces: list(o.faces, `${path}.faces`, faceRef), distance: num(o.distance, `${path}.distance`) };
    case 'draft':
      return {
        ...base, type: 'draft', faces: list(o.faces, `${path}.faces`, faceRef), neutral: faceRef(o.neutral, `${path}.neutral`),
        angle: num(o.angle, `${path}.angle`),
      };
    case 'combine':
      return {
        ...base, type: 'combine', target: faceRef(o.target, `${path}.target`), tools: list(o.tools, `${path}.tools`, faceRef),
        operation: oneOf(o.operation, ['join', 'cut', 'intersect'] as const, `${path}.operation`),
        keepTools: bool(o.keepTools, `${path}.keepTools`),
      };
    case 'split':
      return {
        ...base, type: 'split', plane: planeReference(o.plane, `${path}.plane`), offset: num(o.offset, `${path}.offset`),
        ...(o.body !== undefined ? { body: faceRef(o.body, `${path}.body`) } : {}),
      };
    case 'move':
      return {
        ...base, type: 'move', bodies: list(o.bodies, `${path}.bodies`, faceRef),
        dx: num(o.dx, `${path}.dx`), dy: num(o.dy, `${path}.dy`), dz: num(o.dz, `${path}.dz`),
        axis: oneOf(o.axis, ['X', 'Y', 'Z'] as const, `${path}.axis`), angle: num(o.angle, `${path}.angle`),
        copy: bool(o.copy, `${path}.copy`),
      };
    case 'curve3d': {
      const points = list(o.points, `${path}.points`, (v, p) => {
        const r = obj(v, p);
        const pt = list(r.point, `${p}.point`, num);
        if (pt.length !== 3) throw new DocumentFormatError(`${p}.point`, 'debe tener 3 números');
        const edges = list(r.edges, `${p}.edges`, edgeRef);
        if (!edges.length) throw new DocumentFormatError(`${p}.edges`, 'un vértice necesita al menos una arista');
        return { edges, point: pt as [number, number, number] };
      });
      const curve: Curve3dFeature = { ...base, type: 'curve3d', points, closed: bool(o.closed, `${path}.closed`) };
      if (o.smooth !== undefined) curve.smooth = bool(o.smooth, `${path}.smooth`);
      if (o.handles !== undefined) {
        curve.handles = list(o.handles, `${path}.handles`, (v, p): Curve3dHandles | null =>
          v === null ? null : (() => {
            const pair = list(v, p, vec3);
            if (pair.length !== 2) throw new DocumentFormatError(p, 'un tramo tiene dos asas');
            return [pair[0], pair[1]];
          })());
      }
      return curve;
    }
    case 'patch':
      return {
        ...base, type: 'patch', edges: list(o.edges, `${path}.edges`, edgeRef), height: num(o.height, `${path}.height`),
        ...(o.curves !== undefined ? { curves: list(o.curves, `${path}.curves`, str) } : {}),
        thickness: num(o.thickness, `${path}.thickness`), operation: oneOf(o.operation, ['new', 'join', 'cut'] as const, `${path}.operation`),
        ...(o.tangent !== undefined ? { tangent: bool(o.tangent, `${path}.tangent`) } : {}),
      };
    case 'dome':
      return { ...base, type: 'dome', face: faceRef(o.face, `${path}.face`), height: num(o.height, `${path}.height`) };
    case 'plane': {
      const reference = planeReference(o.reference, `${path}.reference`);
      return {
        ...base, type: 'plane', reference,
        axis: oneOf(o.axis, ['none', 'X', 'Y', 'Z', 'edge'] as const, `${path}.axis`),
        ...(o.axisEdge !== undefined ? { axisEdge: edgeRef(o.axisEdge, `${path}.axisEdge`) } : {}),
        angle: num(o.angle, `${path}.angle`),
        distance: num(o.distance, `${path}.distance`),
      };
    }
    case 'hole':
      return {
        ...base, type: 'hole', sketch: str(o.sketch, `${path}.sketch`),
        kind: oneOf(o.kind, ['simple', 'counterbore', 'countersink'] as const, `${path}.kind`),
        diameter: num(o.diameter, `${path}.diameter`),
        extent: oneOf(o.extent, ['distance', 'through'] as const, `${path}.extent`),
        depth: num(o.depth, `${path}.depth`),
        tip: oneOf(o.tip, ['flat', 'drill'] as const, `${path}.tip`),
        cbDiameter: num(o.cbDiameter, `${path}.cbDiameter`),
        cbDepth: num(o.cbDepth, `${path}.cbDepth`),
        csDiameter: num(o.csDiameter, `${path}.csDiameter`),
        csAngle: num(o.csAngle, `${path}.csAngle`),
        reversed: bool(o.reversed, `${path}.reversed`),
        // Archivos de antes de la rosca: sin rosca.
        thread: o.thread === undefined ? false : bool(o.thread, `${path}.thread`),
        threadPitch: o.threadPitch === undefined ? 1.25 : num(o.threadPitch, `${path}.threadPitch`),
        threadClearance: o.threadClearance === undefined ? 0.2 : num(o.threadClearance, `${path}.threadClearance`),
      };
    case 'import': {
      const v3 = (v: unknown, p: string) => {
        const a = list(v, p, num);
        if (a.length !== 3) throw new DocumentFormatError(p, 'debe tener 3 números');
        return a as [number, number, number];
      };
      return {
        ...base, type: 'import', fileName: str(o.fileName, `${path}.fileName`),
        format: oneOf(o.format, ['stl', 'step'] as const, `${path}.format`), data: str(o.data, `${path}.data`),
        operation: oneOf(o.operation, ['reference', 'new', 'join', 'cut', 'intersect'] as const, `${path}.operation`),
        position: v3(o.position, `${path}.position`), rotation: v3(o.rotation, `${path}.rotation`), scale: num(o.scale, `${path}.scale`),
      };
    }
    case 'thread':
      return {
        ...base, type: 'thread', face: faceRef(o.face, `${path}.face`),
        pitch: num(o.pitch, `${path}.pitch`), clearance: num(o.clearance, `${path}.clearance`),
        length: num(o.length, `${path}.length`), fromStart: bool(o.fromStart, `${path}.fromStart`),
      };
    case 'loft': {
      const loft: LoftFeature = {
        ...base, type: 'loft',
        sections: list(o.sections, `${path}.sections`, (v, p): LoftSection => {
          if (typeof v === 'string') return v;
          const r = obj(v, p);
          if (r.edges !== undefined) return { edges: list(r.edges, `${p}.edges`, edgeRef) };
          return { face: faceRef(r.face, `${p}.face`) };
        }),
        ruled: bool(o.ruled, `${path}.ruled`),
        operation: oneOf(o.operation, ['new', 'join', 'cut', 'intersect'] as const, `${path}.operation`),
      };
      if (o.closed !== undefined) loft.closed = bool(o.closed, `${path}.closed`);
      if (o.spine !== undefined) loft.spine = str(o.spine, `${path}.spine`);
      if (o.thickness !== undefined) loft.thickness = num(o.thickness, `${path}.thickness`);
      if (o.surface !== undefined) loft.surface = bool(o.surface, `${path}.surface`);
      if (o.continuity !== undefined) loft.continuity = bool(o.continuity, `${path}.continuity`);
      if (o.tensionStart !== undefined) loft.tensionStart = num(o.tensionStart, `${path}.tensionStart`);
      if (o.tensionEnd !== undefined) loft.tensionEnd = num(o.tensionEnd, `${path}.tensionEnd`);
      return loft;
    }
    case 'extrude': {
      const f: ExtrudeFeature = {
        ...base,
        type: 'extrude',
        sketch: str(o.sketch, `${path}.sketch`),
        distance: num(o.distance, `${path}.distance`),
        direction: oneOf(o.direction, ['normal', 'reversed', 'symmetric'] as const, `${path}.direction`),
        operation: oneOf(o.operation, ['new', 'join', 'cut', 'intersect'] as const, `${path}.operation`),
        ...(o.thin !== undefined ? { thin: num(o.thin, `${path}.thin`) } : {}),
      };
      return f;
    }
    default:
      throw new DocumentFormatError(`${path}.type`, `tipo de feature desconocido: ${String(o.type)}`);
  }
}

function planeReference(raw: unknown, path: string): PlaneReference {
  const r = obj(raw, path);
  if (r.kind === 'base') return { kind: 'base', plane: oneOf(r.plane, ['XY', 'XZ', 'YZ'] as const, `${path}.plane`) };
  if (r.kind === 'plane') return { kind: 'plane', plane: str(r.plane, `${path}.plane`) };
  if (r.kind === 'face') return { kind: 'face', face: faceRef(r.face, `${path}.face`) };
  throw new DocumentFormatError(`${path}.kind`, 'debe ser base, plane o face');
}

function validateSketch(
  o: Record<string, unknown>,
  base: Pick<SketchFeature, 'id' | 'name' | 'suppressed'>,
  path: string,
): SketchFeature {
  const po = obj(o.plane, `${path}.plane`);
  let plane: SketchPlaneRef;
  if (po.kind === 'base') {
    plane = {
      kind: 'base',
      plane: oneOf(po.plane, ['XY', 'XZ', 'YZ'] as const satisfies readonly BasePlane[], `${path}.plane.plane`),
      offset: num(po.offset, `${path}.plane.offset`),
    };
  } else if (po.kind === 'face') {
    plane = { kind: 'face', face: faceRef(po.face, `${path}.plane.face`), offset: num(po.offset, `${path}.plane.offset`) };
  } else if (po.kind === 'plane') {
    plane = { kind: 'plane', plane: str(po.plane, `${path}.plane.plane`), offset: num(po.offset, `${path}.plane.offset`) };
  } else {
    throw new DocumentFormatError(`${path}.plane.kind`, 'debe ser "base", "face" o "plane"');
  }
  if (!Array.isArray(o.entities)) throw new DocumentFormatError(`${path}.entities`, 'debe ser una lista');
  if (!Array.isArray(o.constraints)) throw new DocumentFormatError(`${path}.constraints`, 'debe ser una lista');

  const entities = o.entities.map((e, i) => validateEntity(e, `${path}.entities[${i}]`));
  const kinds = new Map<string, string>(IMPLICIT_IDS.map((id) => [id, id === ORIGIN ? 'point' : 'line']));
  entities.forEach((e, i) => {
    if (kinds.has(e.id)) throw new DocumentFormatError(`${path}.entities[${i}].id`, `ID duplicado o reservado "${e.id}"`);
    kinds.set(e.id, e.type);
  });
  entities.forEach((e, i) => {
    const refs = e.type === 'line' ? [e.p1, e.p2] : e.type === 'circle' ? [e.center] : e.type === 'arc' ? [e.center, e.start, e.end]
      : e.type === 'spline' ? e.points : e.type === 'text' ? [e.point] : [];
    for (const r of refs) {
      if (kinds.get(r) !== 'point') throw new DocumentFormatError(`${path}.entities[${i}]`, `referencia a un punto inexistente "${r}"`);
    }
  });
  const constraints = o.constraints.map((c, i) => validateConstraint(c, `${path}.constraints[${i}]`));
  constraints.forEach((c, i) => {
    if (kinds.has(c.id)) throw new DocumentFormatError(`${path}.constraints[${i}].id`, `ID duplicado "${c.id}"`);
    const refs = c.type === 'symmetric' ? [c.a, c.b, c.line]
      : 'line' in c ? [c.line] : 'curve' in c ? [c.curve] : 'b' in c && c.b !== undefined ? [c.a, c.b] : [c.a];
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
    case 'spline': {
      const points = list(o.points, `${path}.points`, str);
      if (points.length < 2) throw new DocumentFormatError(`${path}.points`, 'una spline necesita al menos 2 puntos');
      const spline: SketchSpline = { id, type: 'spline', points, closed: bool(o.closed, `${path}.closed`), construction: construction() };
      if (o.kind !== undefined) spline.kind = oneOf(o.kind, ['fit', 'control'] as const, `${path}.kind`);
      if (o.degree !== undefined) {
        const degree = num(o.degree, `${path}.degree`);
        if (!Number.isInteger(degree) || degree < 1 || degree > NURBS_MAX_DEGREE) {
          throw new DocumentFormatError(`${path}.degree`, `el grado tiene que ser un entero entre 1 y ${NURBS_MAX_DEGREE}`);
        }
        spline.degree = degree;
      }
      return spline;
    }
    case 'text':
      return {
        id, type: 'text', point: str(o.point, `${path}.point`), text: typeof o.text === 'string' ? o.text : str(o.text, `${path}.text`),
        height: num(o.height, `${path}.height`), angle: num(o.angle, `${path}.angle`), bold: bool(o.bold, `${path}.bold`),
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
    case 'symmetric':
      return { id, type: 'symmetric', a: a(), b: b(), line: str(o.line, `${path}.line`) };
    default:
      throw new DocumentFormatError(`${path}.type`, `tipo de restricción desconocido: ${String(o.type)}`);
  }
}

/** Parámetros con nombre (opcional en el archivo: falta = tabla vacía). */
function validateParameters(raw: unknown): Parameter[] {
  if (raw === undefined) return [];
  const params = list(raw, '$.parameters', (x, p) => {
    const o = obj(x, p);
    const param: Parameter = { id: str(o.id, `${p}.id`), name: str(o.name, `${p}.name`), expression: str(o.expression, `${p}.expression`) };
    if (!isValidName(param.name)) throw new DocumentFormatError(`${p}.name`, `nombre de parámetro inválido "${param.name}"`);
    if (o.comment !== undefined) {
      if (typeof o.comment !== 'string') throw new DocumentFormatError(`${p}.comment`, 'debe ser un texto');
      param.comment = o.comment;
    }
    return param;
  });
  const names = new Set<string>();
  const ids = new Set<string>();
  params.forEach((prm, i) => {
    if (names.has(prm.name)) throw new DocumentFormatError(`$.parameters[${i}].name`, `nombre repetido "${prm.name}"`);
    if (ids.has(prm.id)) throw new DocumentFormatError(`$.parameters[${i}].id`, `ID duplicado "${prm.id}"`);
    names.add(prm.name);
    ids.add(prm.id);
  });
  return params;
}

function vec3(v: unknown, path: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) throw new DocumentFormatError(path, 'debe ser [x, y, z]');
  return [num(v[0], `${path}[0]`), num(v[1], `${path}[1]`), num(v[2], `${path}[2]`)];
}

function faceRef(raw: unknown, path: string): FaceRef {
  const o = obj(raw, path);
  const ref: FaceRef = {
    name: str(o.name, `${path}.name`),
    type: str(o.type, `${path}.type`),
    center: vec3(o.center, `${path}.center`),
    area: num(o.area, `${path}.area`),
  };
  if (o.normal !== undefined) ref.normal = vec3(o.normal, `${path}.normal`);
  return ref;
}

function edgeRef(raw: unknown, path: string): EdgeRef {
  const o = obj(raw, path);
  return { name: str(o.name, `${path}.name`), center: vec3(o.center, `${path}.center`), length: num(o.length, `${path}.length`) };
}

function list<T>(v: unknown, path: string, item: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v)) throw new DocumentFormatError(path, 'debe ser una lista');
  return v.map((x, i) => item(x, `${path}[${i}]`));
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
