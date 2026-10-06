import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeFillet, makeShell } from '../src/document/ops';
import type { CadDocument } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { largestThatWorks } from '../src/kernel/features/dressup';
import { edgeRefOf, faceRefOf, type NamedShape } from '../src/kernel/naming';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function edgeIdx(s: NamedShape, p: [number, number, number]) {
  const i = s.shape.edges.findIndex((e) => {
    const m = e.pointAt(0.5).toTuple();
    return Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]) < 1e-6;
  });
  if (i < 0) throw new Error(`No hay arista en ${p}`);
  return i;
}
const topFace = (s: NamedShape) =>
  faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[2] - 20) < 1e-6));

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const res = { status: last.status, error: last.error ?? '' };
  e.dispose();
  return res;
}

/** Calcula el documento y usa el sólido antes de liberarlo. */
function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}

/** El "≈ X mm" que sugiere el mensaje de error. */
function suggested(error: string) {
  const m = error.match(/≈ ([\d.]+) mm/);
  if (!m) throw new Error(`El mensaje no sugiere un máximo: ${error}`);
  return Number(m[1]);
}

describe('límites de redondeo y vaciado', () => {
  it('bisección: encuentra el mayor valor que funciona', () => {
    const v = largestThatWorks(10, (x) => x <= 3.7)!;
    expect(v).toBeLessThanOrEqual(3.7);
    expect(v).toBeGreaterThan(3.65);
    expect(largestThatWorks(10, () => false)).toBeNull();
  });

  it('pared de 0,2 mm: el redondeo exterior dice cuánto entra, y ese valor funciona', () => {
    const base = build({ profile: rect(10, 10), distance: 20 });
    const doc = addFeature(base, makeShell(base, [withShape(base, topFace)], 0.2));

    // Arista vertical exterior: el arco no puede atravesar la esquina interior.
    // Límite geométrico: r·(1 − 1/√2) = 0,2 → r ≈ 0,683.
    const vertical = withShape(doc, (s) => edgeRefOf(s, edgeIdx(s, [5, 5, 10])));
    const failed = run(addFeature(doc, makeFillet(doc, [vertical], 2)));
    expect(failed.status).toBe('error');
    expect(failed.error).toMatch(/pared/);
    const max = suggested(failed.error);
    expect(max).toBeGreaterThan(0.6);
    expect(max).toBeLessThan(0.69);
    expect(run(addFeature(doc, makeFillet(doc, [vertical], max))).status).toBe('ok');

    // Borde superior: la cara del borde mide 0,2 mm de ancho.
    const rim = withShape(doc, (s) => edgeRefOf(s, edgeIdx(s, [0, -5, 20])));
    const rimMax = suggested(run(addFeature(doc, makeFillet(doc, [rim], 2))).error);
    expect(rimMax).toBeLessThan(0.2);
    expect(rimMax).toBeGreaterThan(0.15);
    expect(run(addFeature(doc, makeFillet(doc, [rim], rimMax))).status).toBe('ok');
  });

  it('vaciado después de un redondeo de 1 mm: el espesor tiene que ser menor que el radio', () => {
    const base = build({ profile: rect(10, 10), distance: 20 });
    const verticals = withShape(base, (s) => [[5, 5], [-5, 5], [5, -5], [-5, -5]].map(([x, y]) => edgeRefOf(s, edgeIdx(s, [x, y, 10]))));
    const doc = addFeature(base, makeFillet(base, verticals, 1));
    const top = withShape(doc, topFace);

    const failed = run(addFeature(doc, makeShell(doc, [top], 1.5)));
    expect(failed.status).toBe('error');
    const max = suggested(failed.error);
    expect(max).toBeGreaterThan(0.9);
    expect(max).toBeLessThan(1);
    expect(run(addFeature(doc, makeShell(doc, [top], max))).status).toBe('ok');

    // En el orden inverso (redondeo primero) un radio de 2 con pared de 0,2 sí funciona.
    const doc2 = addFeature(base, makeFillet(base, verticals, 2));
    expect(run(addFeature(doc2, makeShell(doc2, [withShape(doc2, topFace)], 0.2))).status).toBe('ok');
  });
});
