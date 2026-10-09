// Qué restricción se puede crear a partir de la selección del usuario, y con qué valor inicial.
import type { SketchConstraint, SketchConstraintType, SketchData, SketchEntityId } from '../document/types';
import { arcParams, displayAngleDeg, dist, lineEnds, pointLineDistance, signedAngleDeg, solverAngleDeg } from './geometry';
import { SketchIndex } from './model';

type NewConstraint = SketchConstraint extends infer C ? (C extends unknown ? Omit<C, 'id'> : never) : never;

export type RuleResult =
  | { ok: true; constraints: NewConstraint[]; /** Para cotas: el valor medido, que el usuario puede cambiar. */ value?: number }
  | { ok: false; hint: string };

export const CONSTRAINT_LABELS: Record<SketchConstraintType, string> = {
  coincident: 'Coincidente',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Paralela',
  perpendicular: 'Perpendicular',
  tangent: 'Tangente',
  equal: 'Igual',
  distance: 'Distancia',
  radius: 'Radio',
  angle: 'Ángulo',
  symmetric: 'Simétrico',
};

export const DIMENSIONAL: ReadonlySet<SketchConstraintType> = new Set(['distance', 'radius', 'angle']);

/**
 * Construye la restricción pedida con las entidades seleccionadas (en orden de selección).
 * Devuelve una pista legible si la selección no sirve.
 */
export function constraintFromSelection(
  type: SketchConstraintType,
  data: SketchData,
  selection: SketchEntityId[],
): RuleResult {
  const index = new SketchIndex(data);
  const kinds = selection.map((id) => index.kind(id));
  if (kinds.some((k) => k === undefined)) return { ok: false, hint: 'La selección incluye elementos que no son geometría' };
  const is = (i: number, ...k: string[]) => k.includes(kinds[i]!);
  const n = selection.length;
  const [a, b] = selection;
  const isCurve = (i: number) => is(i, 'circle', 'arc');

  switch (type) {
    case 'coincident':
      if (n === 2 && is(0, 'point') && is(1, 'point')) return ok({ type, a, b });
      if (n === 2 && is(0, 'point') && is(1, 'line', 'circle', 'arc')) return ok({ type, a, b });
      if (n === 2 && is(1, 'point') && is(0, 'line', 'circle', 'arc')) return ok({ type, a: b, b: a });
      return hint('Elegí dos puntos, o un punto y una curva');

    case 'horizontal':
    case 'vertical':
      if (n >= 1 && kinds.every((k) => k === 'line')) return { ok: true, constraints: selection.map((line) => ({ type, line })) };
      return hint('Elegí una o más líneas');

    case 'parallel':
    case 'perpendicular':
      if (n === 2 && is(0, 'line') && is(1, 'line')) return ok({ type, a, b });
      return hint('Elegí dos líneas');

    case 'tangent':
      if (n === 2 && (isCurve(0) || isCurve(1)) && kinds.every((k) => k === 'line' || k === 'circle' || k === 'arc')) return ok({ type, a, b });
      return hint('Elegí una línea y un círculo/arco, o dos círculos/arcos');

    case 'equal':
      if (n === 2 && is(0, 'line') && is(1, 'line')) return ok({ type, a, b });
      if (n === 2 && isCurve(0) && isCurve(1)) return ok({ type, a, b });
      return hint('Elegí dos líneas, o dos círculos/arcos');

    case 'distance': {
      if (n === 1 && is(0, 'line')) {
        const value = dist(...lineEnds(index, a));
        return { ok: true, constraints: [{ type, a, value }], value };
      }
      if (n === 2 && is(0, 'point') && is(1, 'point')) {
        const value = dist(index.point(a), index.point(b));
        return { ok: true, constraints: [{ type, a, b, value }], value };
      }
      const pl = is(0, 'point') && is(1, 'line') ? [a, b] : is(1, 'point') && is(0, 'line') ? [b, a] : null;
      if (n === 2 && pl) {
        const value = pointLineDistance(index.point(pl[0]), ...lineEnds(index, pl[1]));
        return { ok: true, constraints: [{ type, a: pl[0], b: pl[1], value }], value };
      }
      if (n === 2 && is(0, 'line') && is(1, 'line')) {
        const value = pointLineDistance(lineEnds(index, b)[0], ...lineEnds(index, a));
        return { ok: true, constraints: [{ type, a, b, value }], value };
      }
      return hint('Elegí una línea, dos puntos, un punto y una línea, o dos líneas paralelas');
    }

    case 'radius': {
      if (n === 1 && isCurve(0)) {
        const e = index.get(a)!;
        const value = e.type === 'circle' ? e.radius : arcParams(index, e as never).radius;
        return { ok: true, constraints: [{ type, curve: a, value }], value };
      }
      return hint('Elegí un círculo o un arco');
    }

    case 'symmetric':
      if (n === 3 && is(0, 'point') && is(1, 'point') && is(2, 'line')) return ok({ type, a, b, line: selection[2] });
      return hint('Elegí dos puntos y después la línea de simetría');

    case 'angle': {
      if (n === 2 && is(0, 'line') && is(1, 'line')) {
        const value = signedAngleDeg(index, a, b);
        return { ok: true, constraints: [{ type, a, b, value }], value: displayAngleDeg(index, a, b) };
      }
      return hint('Elegí dos líneas');
    }
  }
}

/**
 * Aplica el valor que escribió el usuario. Para ángulos, convierte el ángulo visible
 * (interior si las líneas comparten vértice) al valor con signo del solver.
 */
export function withValue<C extends NewConstraint>(c: C, value: number, data: SketchData): C {
  if (c.type === 'angle') return { ...c, value: solverAngleDeg(new SketchIndex(data), c.a, c.b, Math.abs(value)) };
  if (c.type === 'distance' || c.type === 'radius') return { ...c, value };
  return c;
}

/** Valor de la cota tal como lo ve el usuario. */
export function displayValue(c: SketchConstraint, data: SketchData): number {
  if (c.type === 'angle') return displayAngleDeg(new SketchIndex(data), c.a, c.b, c.value);
  if (c.type === 'distance' || c.type === 'radius') return c.value;
  return NaN;
}

function ok(c: NewConstraint): RuleResult {
  return { ok: true, constraints: [c] };
}
function hint(h: string): RuleResult {
  return { ok: false, hint: h };
}

/** Texto de una cota para mostrar en el sketch. */
export function dimensionText(c: SketchConstraint, data: SketchData): string {
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  if (c.type === 'radius') return `R${fmt(c.value)}`;
  if (c.type === 'angle') return `${fmt(displayValue(c, data))}°`;
  if (c.type === 'distance') return fmt(c.value);
  return '';
}
