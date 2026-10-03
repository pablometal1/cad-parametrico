import { describe, it, expect, beforeAll } from 'vitest';
import type { SketchConstraint } from '../src/document/types';
import { SketchBuilder } from '../src/sketch/builders';
import { signedAngleDeg } from '../src/sketch/geometry';
import { SketchIndex } from '../src/sketch/model';
import { constraintFromSelection, dimensionText, displayValue, withValue } from '../src/sketch/rules';
import { initSolver, solveSketch } from '../src/sketch/solver';

beforeAll(async () => {
  await initSolver();
}, 30_000);

describe('reglas de restricciones desde la selección', () => {
  it('pistas cuando la selección no sirve', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l = b.line([0, 0], [10, 0]);
    const c = b.circle([5, 5], 2);
    const r1 = constraintFromSelection('parallel', b.data, [l]);
    expect(r1.ok).toBe(false);
    expect(constraintFromSelection('radius', b.data, [l])).toMatchObject({ ok: false, hint: expect.stringMatching(/círculo/) });
    expect(constraintFromSelection('tangent', b.data, [l, c])).toMatchObject({ ok: true });
    expect(constraintFromSelection('equal', b.data, [l, c]).ok).toBe(false);
  });

  it('coincidente acepta punto+curva en cualquier orden y normaliza', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l = b.line([0, 0], [10, 0]);
    const p = b.point([3, 3]);
    const r = constraintFromSelection('coincident', b.data, [l, p]);
    expect(r).toMatchObject({ ok: true, constraints: [{ type: 'coincident', a: p, b: l }] });
  });

  it('horizontal sobre varias líneas crea una restricción por línea', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l1 = b.line([0, 0], [10, 1]);
    const l2 = b.line([0, 5], [10, 6]);
    const r = constraintFromSelection('horizontal', b.data, [l1, l2]);
    expect(r.ok && r.constraints).toHaveLength(2);
  });

  it('cotas: proponen el valor medido', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l = b.line([0, 0], [3, 4]);
    const c = b.circle([0, 0], 2.5);
    expect(constraintFromSelection('distance', b.data, [l])).toMatchObject({ ok: true, value: 5 });
    expect(constraintFromSelection('radius', b.data, [c])).toMatchObject({ ok: true, value: 2.5 });
  });
});

describe('ángulo interior entre líneas que comparten vértice', () => {
  // Triángulo A(0,0) → B(10,0) → C(0,10): ángulo interior en B = 45°.
  const triangle = () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const A = b.point([0, 0]);
    const B = b.point([10, 0]);
    const C = b.point([0, 10]);
    const ab = b.line(A, B);
    const bc = b.line(B, C);
    const ca = b.line(C, A);
    return { b, ab, bc, ca };
  };

  it('propone el ángulo interior aunque las líneas estén encadenadas', () => {
    const { b, ab, bc } = triangle();
    const r = constraintFromSelection('angle', b.data, [ab, bc]);
    expect(r.ok && r.value).toBeCloseTo(45, 9);
    // El ángulo entre las direcciones p1→p2 es el exterior (135°).
    expect(Math.abs(signedAngleDeg(new SketchIndex(b.data), ab, bc))).toBeCloseTo(135, 9);
  });

  it('el valor escrito por el usuario es el ángulo interior resultante', () => {
    const { b, ab, bc } = triangle();
    const r = constraintFromSelection('angle', b.data, [ab, bc]);
    if (!r.ok) throw new Error(r.hint);
    b.constrain({ type: 'horizontal', line: ab });
    b.constrain(withValue(r.constraints[0], 60, b.data));
    const solved = solveSketch(b.data);
    expect(solved.ok).toBe(true);
    const k = solved.data.constraints.find((c) => c.type === 'angle') as SketchConstraint;
    expect(displayValue(k, solved.data)).toBeCloseTo(60, 6);
    expect(dimensionText(k, solved.data)).toBe('60°');
    // Verificación geométrica: el ángulo interior en B mide 60°.
    const idx = new SketchIndex(solved.data);
    const A = idx.point('p1');
    const B = idx.point('p2');
    const C = idx.point('p3');
    const v1 = [A[0] - B[0], A[1] - B[1]];
    const v2 = [C[0] - B[0], C[1] - B[1]];
    const ang = (Math.acos((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2))) * 180) / Math.PI;
    expect(ang).toBeCloseTo(60, 6);
  });

  it('líneas sin vértice común: ángulo entre sus direcciones', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l1 = b.line([0, 0], [10, 0]);
    const l2 = b.line([20, 0], [20 + 5, 5]);
    expect(constraintFromSelection('angle', b.data, [l1, l2])).toMatchObject({ ok: true, value: expect.closeTo(45, 9) });
  });
});
