import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { addFeature, makeFillet, makeMirror, makePattern, updateFeature } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, ExtrudeFeature, PatternFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { edgeRefOf } from '../src/kernel/naming';
import { initSolver } from '../src/sketch/solver';
import { build, circle, extrudeIds, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

let engine: RecomputeEngine;
afterEach(() => engine?.dispose());
const run = (doc: CadDocument) => {
  const out = engine.run(doc);
  return { ...out, volume: out.shape ? volume(out.shape.shape) : 0, statuses: out.results.map((r) => r.status) };
};
const PI = Math.PI;

/** Placa 60×30×10 con un agujero pasante r=3 en x=-20. */
const plateWithHole = () => build(
  { profile: rect(60, 30), distance: 10 },
  { profile: circle(3, [-20, 0]), distance: 30, operation: 'cut', direction: 'symmetric' },
);
const holeArea = PI * 9;

describe('patrón', () => {
  it('lineal: tres agujeros a lo largo de X', () => {
    engine = new RecomputeEngine();
    let doc = plateWithHole();
    const hole = extrudeIds(doc)[1];
    doc = addFeature(doc, makePattern(doc, hole, { kind: 'linear', axis: 'X', count: 3, spacing: 20 }));
    const r = run(doc);
    expect(r.statuses.at(-1)).toBe('ok');
    expect(r.volume).toBeCloseTo(60 * 30 * 10 - 3 * holeArea * 10, 2);
  });

  it('circular: cuatro salientes alrededor de Z', () => {
    engine = new RecomputeEngine();
    let doc = build(
      { profile: circle(20), distance: 5 },
      { profile: rect(4, 4, [15, 0]), offset: 5, distance: 3, operation: 'join' },
    );
    const boss = extrudeIds(doc)[1];
    doc = addFeature(doc, makePattern(doc, boss, { kind: 'circular', axis: 'Z', count: 4, angle: 360 }));
    const r = run(doc);
    expect(r.statuses.at(-1)).toBe('ok');
    expect(r.volume).toBeCloseTo(PI * 400 * 5 + 4 * 16 * 3, 2);
    // Ángulo parcial: 3 copias de 0° a 90° (0, 45, 90).
    const partial = updateFeature<PatternFeature>(doc, doc.features.at(-1)!.id, { count: 3, angle: 90 });
    expect(run(partial).volume).toBeCloseTo(PI * 400 * 5 + 3 * 16 * 3, 2);
  });

  it('con operación "nuevo" crea cuerpos separados', () => {
    engine = new RecomputeEngine();
    let doc = build({ profile: rect(10, 10), distance: 5 });
    doc = addFeature(doc, makePattern(doc, extrudeIds(doc)[0], { count: 4, spacing: 15 }));
    const r = run(doc);
    expect(r.shape!.shape.solids.length).toBe(4);
    expect(r.volume).toBeCloseTo(4 * 500, 4);
  });

  it('cambiar la feature de origen actualiza el patrón', () => {
    engine = new RecomputeEngine();
    let doc = plateWithHole();
    const hole = extrudeIds(doc)[1];
    doc = addFeature(doc, makePattern(doc, hole, { count: 3, spacing: 20 }));
    run(doc);
    // El agujero de origen pasa a ser simétrico de solo 4 mm (z de -2 a 2): no atraviesa la placa (z 0..10).
    const shallow = updateFeature<ExtrudeFeature>(doc, hole, { distance: 4 });
    expect(run(shallow).volume).toBeCloseTo(60 * 30 * 10 - 3 * holeArea * 2, 2);
  });

  it('errores: cantidad inválida, origen que no se puede repetir, origen borrado', () => {
    engine = new RecomputeEngine();
    let doc = plateWithHole();
    const hole = extrudeIds(doc)[1];
    const p = makePattern(doc, hole, { count: 1 });
    doc = addFeature(doc, p);
    expect(run(doc).results.at(-1)!.error).toMatch(/al menos 2/);

    const sketchId = doc.features[0].id;
    const bad = updateFeature<PatternFeature>(doc, p.id, { count: 3, source: sketchId });
    expect(run(bad).results.at(-1)!.error).toMatch(/Solo se pueden repetir/);

    const noSpacing = updateFeature<PatternFeature>(doc, p.id, { count: 3, spacing: 0 });
    expect(run(noSpacing).results.at(-1)!.error).toMatch(/separación/);
  });

  it('una referencia a una arista de una copia sobrevive al cambiar la separación', () => {
    engine = new RecomputeEngine();
    let doc = build(
      { profile: rect(60, 20), distance: 5 },
      { profile: rect(6, 6, [-20, 0]), offset: 5, distance: 6, operation: 'join' },
    );
    const boss = extrudeIds(doc)[1];
    const pattern = makePattern(doc, boss, { count: 3, spacing: 20 });
    doc = addFeature(doc, pattern);
    const s = run(doc).shape!;
    // Arista superior de la copia del medio (x de -3 a 3, y = -3, z = 11).
    const ei = s.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[0]) < 1e-6 && Math.abs(m[1] + 3) < 1e-6 && Math.abs(m[2] - 11) < 1e-6;
    });
    expect(ei).toBeGreaterThanOrEqual(0);
    doc = addFeature(doc, makeFillet(doc, [edgeRefOf(s, ei)], 1));
    expect(run(doc).statuses.at(-1)).toBe('ok');
    const wider = updateFeature<PatternFeature>(doc, pattern.id, { spacing: 22 });
    expect(run(wider).statuses.at(-1)).toBe('ok');
  });
});

describe('simetría', () => {
  it('refleja un saliente respecto del plano YZ', () => {
    engine = new RecomputeEngine();
    let doc = build(
      { profile: rect(60, 20), distance: 5 },
      { profile: rect(6, 6, [20, 0]), offset: 5, distance: 6, operation: 'join' },
    );
    doc = addFeature(doc, makeMirror(doc, extrudeIds(doc)[1], 'YZ'));
    const r = run(doc);
    expect(r.statuses.at(-1)).toBe('ok');
    expect(r.volume).toBeCloseTo(60 * 20 * 5 + 2 * 36 * 6, 3);
    const [min, max] = r.shape!.shape.boundingBox.bounds;
    expect(min[2]).toBeCloseTo(0, 6);
    expect(max[2]).toBeCloseTo(11, 6);
  });

  it('simetría de un corte respecto de XZ', () => {
    engine = new RecomputeEngine();
    let doc = build(
      { profile: rect(40, 40), distance: 10 },
      { profile: circle(3, [0, 10]), distance: 30, operation: 'cut', direction: 'symmetric' },
    );
    doc = addFeature(doc, makeMirror(doc, extrudeIds(doc)[1], 'XZ'));
    expect(run(doc).volume).toBeCloseTo(1600 * 10 - 2 * holeArea * 10, 2);
  });

  it('serialización de patrón y simetría', () => {
    let doc = plateWithHole();
    doc = addFeature(doc, makePattern(doc, extrudeIds(doc)[1], { kind: 'circular', axis: 'Y', count: 5, angle: 180 }));
    doc = addFeature(doc, makeMirror(doc, extrudeIds(doc)[1], 'XY'));
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });
});
