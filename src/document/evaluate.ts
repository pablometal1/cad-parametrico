// Evaluación de parámetros y expresiones: produce un documento con números listo para el kernel.
import { solverAngleFromStored } from '../sketch/geometry';
import { SketchIndex } from '../sketch/model';
import { ExpressionError, evaluateExpr, parseExpression, plainNumber, referencedNames, type Expr } from './expressions';
import type { CadDocument, Feature, Parameter, SketchConstraint, SketchFeature } from './types';

export interface ParameterValue {
  id: string;
  name: string;
  value?: number;
  error?: string;
}

export interface EvaluatedDocument {
  /** Documento con cada campo con expresión reemplazado por su valor. */
  doc: CadDocument;
  /** Errores de expresión por feature (la feature no se calcula y queda en error). */
  errors: Map<string, string>;
  parameters: ParameterValue[];
  /** Valor de cada parámetro válido, por nombre. */
  scope: Map<string, number>;
}

/** Nombre legible de cada ruta de campo, para los mensajes. */
export function fieldLabel(path: string): string {
  const labels: Record<string, string> = {
    distance: 'la distancia',
    radius: 'el radio',
    radius2: 'el radio final',
    angle: 'el ángulo',
    thickness: 'el espesor',
    count: 'la cantidad',
    spacing: 'la separación',
    'plane.offset': 'el desplazamiento',
    diameter: 'el diámetro',
    depth: 'la profundidad',
    cbDiameter: 'el diámetro del cajeado',
    cbDepth: 'la profundidad del cajeado',
    csDiameter: 'el diámetro del avellanado',
    csAngle: 'el ángulo del avellanado',
    threadPitch: 'el paso de la rosca',
    threadClearance: 'la holgura de la rosca',
    pitch: 'el paso',
    clearance: 'la holgura',
    length: 'el largo',
    scale: 'la escala',
    offset: 'el desplazamiento',
    dx: 'la traslación en X',
    dy: 'la traslación en Y',
    dz: 'la traslación en Z',
  };
  if (path.startsWith('constraint:')) return `la cota ${path.slice(11)}`;
  return labels[path] ?? path;
}

/** Evalúa la tabla de parámetros, detectando nombres desconocidos y referencias circulares. */
export function evaluateParameters(params: Parameter[]): { values: ParameterValue[]; scope: Map<string, number> } {
  const byName = new Map(params.map((p) => [p.name, p]));
  const parsed = new Map<string, Expr | ExpressionError>();
  for (const p of params) {
    try {
      parsed.set(p.name, parseExpression(p.expression));
    } catch (err) {
      parsed.set(p.name, err instanceof ExpressionError ? err : new ExpressionError(String(err)));
    }
  }
  const result = new Map<string, { value?: number; error?: string }>();
  const visiting: string[] = [];

  const resolve = (name: string): { value?: number; error?: string } => {
    const done = result.get(name);
    if (done) return done;
    if (visiting.includes(name)) {
      const cycle = [...visiting.slice(visiting.indexOf(name)), name].join(' → ');
      return { error: `Referencia circular: ${cycle}` };
    }
    const e = parsed.get(name)!;
    if (e instanceof ExpressionError) {
      const r = { error: e.message };
      result.set(name, r);
      return r;
    }
    visiting.push(name);
    let r: { value?: number; error?: string };
    try {
      for (const dep of referencedNames(e)) {
        if (!byName.has(dep)) throw new ExpressionError(`No existe el parámetro "${dep}"`);
        const d = resolve(dep);
        if (d.error) throw new ExpressionError(d.error.startsWith('Referencia circular') ? d.error : `"${dep}" tiene un error`);
      }
      r = { value: evaluateExpr(e, (n) => result.get(n)!.value!) };
    } catch (err) {
      r = { error: (err as Error).message };
    }
    visiting.pop();
    result.set(name, r);
    return r;
  };

  const values = params.map((p) => ({ id: p.id, name: p.name, ...resolve(p.name) }));
  const scope = new Map<string, number>();
  for (const v of values) if (v.value !== undefined) scope.set(v.name, v.value);
  return { values, scope };
}

/** Evalúa un texto (número suelto o expresión) con los parámetros dados. */
export function evaluateText(text: string, scope: ReadonlyMap<string, number>): number {
  const n = plainNumber(text);
  if (n !== null) return n;
  const e = parseExpression(text);
  return evaluateExpr(e, (name) => {
    const v = scope.get(name);
    if (v === undefined) throw new ExpressionError(`No existe el parámetro "${name}" (o tiene un error)`);
    return v;
  });
}

export function evaluateDocument(doc: CadDocument): EvaluatedDocument {
  const { values, scope } = evaluateParameters(doc.parameters ?? []);
  const errors = new Map<string, string>();
  const features = doc.features.map((f) => {
    if (!f.exprs || Object.keys(f.exprs).length === 0) return f;
    let out = f;
    for (const [path, text] of Object.entries(f.exprs)) {
      try {
        out = setFieldValue(out, path, evaluateText(text, scope));
      } catch (err) {
        if (!errors.has(f.id)) errors.set(f.id, `Expresión de ${fieldLabel(path)} ("${text}"): ${(err as Error).message}`);
      }
    }
    return out;
  });
  return { doc: { ...doc, features }, errors, parameters: values, scope };
}

/** Valor numérico actual de un campo (por ruta). */
export function getFieldValue(f: Feature, path: string): number | undefined {
  if (path === 'plane.offset') return f.type === 'sketch' ? f.plane.offset : undefined;
  if (path.startsWith('constraint:')) {
    if (f.type !== 'sketch') return undefined;
    const c = f.constraints.find((x) => x.id === path.slice(11));
    return c && 'value' in c ? c.value : undefined;
  }
  const v = (f as unknown as Record<string, unknown>)[path];
  return typeof v === 'number' ? v : undefined;
}

/**
 * Asigna un valor numérico a un campo. Para cotas de ángulo, `value` es el ángulo visible
 * (interior) y se convierte al valor con signo del solver.
 */
export function setFieldValue<F extends Feature>(f: F, path: string, value: number): F {
  if (path === 'plane.offset') {
    if (f.type !== 'sketch') throw new Error('El desplazamiento solo existe en sketches');
    return { ...f, plane: { ...f.plane, offset: value } };
  }
  if (path.startsWith('constraint:')) {
    if (f.type !== 'sketch') throw new Error('Las cotas solo existen en sketches');
    const sk = f as SketchFeature;
    const id = path.slice(11);
    const c = sk.constraints.find((x) => x.id === id);
    if (!c || !('value' in c)) throw new Error(`La cota ${id} ya no existe`);
    const next: SketchConstraint =
      c.type === 'angle' ? { ...c, value: solverAngleFromStored(new SketchIndex(sk), c.a, c.b, c.value, Math.abs(value)) } : { ...c, value };
    return { ...sk, constraints: sk.constraints.map((x) => (x.id === id ? next : x)) } as F;
  }
  if (!(path in f)) throw new Error(`Campo desconocido ${path}`);
  return { ...f, [path]: value };
}
