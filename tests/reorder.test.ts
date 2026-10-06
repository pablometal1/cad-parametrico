import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeExtrude, makeFillet, makeSketch, moveBlocker, moveFeature, requiredFeatures, setRollback } from '../src/document/ops';
import { parseDocument } from '../src/document/serialize';
import type { CadDocument, SketchFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { edgeRefOf, type NamedShape } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import twoBodiesShell from './fixtures/two-bodies-shell.json?raw';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const r = { statuses: out.results.map((x) => x.status), vol: out.shape ? volume(out.shape.shape) : 0 };
  e.dispose();
  return r;
}
function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}
const names = (doc: CadDocument) => doc.features.map((f) => f.name);

/** Caja 40×30×20, agujero pasante y redondeo de una arista exterior de la caja. */
function boxHoleFillet() {
  let doc = build({ profile: rect(40, 30), distance: 20 });
  const ref = withShape(doc, (s) => {
    const i = s.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[1] + 15) < 1e-6 && Math.abs(m[2] - 20) < 1e-6;
    });
    return edgeRefOf(s, i);
  });
  const hb = new SketchBuilder({ entities: [], constraints: [] });
  hb.circle([0, 0], 4);
  const hole = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, ...hb.data });
  doc = addFeature(doc, hole);
  doc = addFeature(doc, makeExtrude(doc, hole.id, { operation: 'cut', distance: 50, direction: 'symmetric' }));
  doc = addFeature(doc, makeFillet(doc, [ref], 3));
  return doc;
}

describe('mover features en el historial', () => {
  it('dependencias: sketches, origen y caras/aristas referenciadas', () => {
    const doc = boxHoleFillet();
    const [sk1, ext1, , cut, fillet] = doc.features;
    expect(requiredFeatures(ext1)).toEqual(new Set([sk1.id]));
    // El redondeo depende de la extrusión que creó su arista, no del agujero.
    expect(requiredFeatures(fillet)).toEqual(new Set([ext1.id]));
    expect(requiredFeatures(cut).has(doc.features[2].id)).toBe(true);
  });

  it('bloquea moves que romperían dependencias, con un motivo claro', () => {
    const doc = boxHoleFillet();
    const [, ext1, sk2, cut, fillet] = doc.features;
    expect(moveBlocker(doc, ext1.id, 0)).toMatch(/usa "Sketch1"/);
    expect(moveBlocker(doc, sk2.id, 4)).toMatch(/"Extrusión2" usa "Sketch2"/);
    expect(moveBlocker(doc, fillet.id, 1)).toMatch(/usa "Extrusión1"/);
    expect(() => moveFeature(doc, cut.id, 1)).toThrow(/Sketch2/);
    // Permitidos: el redondeo puede ir antes del agujero, el sketch del agujero al principio.
    expect(moveBlocker(doc, fillet.id, 2)).toBeNull();
    expect(moveBlocker(doc, sk2.id, 0)).toBeNull();
  });

  it('el redondeo antes del agujero da la misma pieza', () => {
    const doc = boxHoleFillet();
    const fillet = doc.features[4];
    const moved = moveFeature(doc, fillet.id, 2);
    expect(names(moved)).toEqual(['Sketch1', 'Extrusión1', 'Redondeo1', 'Sketch2', 'Extrusión2']);
    const a = run(doc);
    const b = run(moved);
    expect(b.statuses.every((s) => s === 'ok')).toBe(true);
    expect(b.vol).toBeCloseTo(a.vol, 6);
  });

  it('el marcador sigue a las mismas features', () => {
    const doc = setRollback(boxHoleFillet(), 3); // activas: Sketch1, Extrusión1, Sketch2
    const fillet = doc.features[4];
    // El redondeo (inactivo) sube por encima del marcador: pasa a estar activo.
    const up = moveFeature(doc, fillet.id, 2);
    expect(up.rollback).toBe(4);
    expect(names(up).slice(0, 4)).toEqual(['Sketch1', 'Extrusión1', 'Redondeo1', 'Sketch2']);
    // Con el marcador antes del redondeo, el agujero (activo) baja por debajo: queda inactivo.
    const doc4 = setRollback(boxHoleFillet(), 4);
    const cut = doc4.features[3];
    const down = moveFeature(doc4, cut.id, 4);
    expect(names(down)).toEqual(['Sketch1', 'Extrusión1', 'Sketch2', 'Redondeo1', 'Extrusión2']);
    expect(down.rollback).toBe(3);
  });

  it('documento real: el vaciado de la caja se puede mover después del tubo', () => {
    const base = parseDocument(twoBodiesShell);
    const doc: CadDocument = { ...base, features: base.features.filter((f) => f.type !== 'fillet' && f.name !== 'Vaciado3') };
    const shell1 = doc.features.find((f) => f.name === 'Vaciado1')!;
    const ext2 = doc.features.findIndex((f) => f.name === 'Extrusión2');
    expect(moveBlocker(doc, shell1.id, ext2)).toBeNull();
    const moved = moveFeature(doc, shell1.id, ext2);
    expect(names(moved)).toEqual(['Sketch1', 'Extrusión1', 'Sketch2', 'Extrusión2', 'Vaciado1', 'Vaciado2']);
    expect(run(moved).statuses.every((s) => s === 'ok')).toBe(true);
  });

  it('un sketch sobre una cara no puede subir antes de la feature que la creó', () => {
    let doc = build({ profile: rect(10, 10), distance: 10 });
    const ext = doc.features[1];
    const sk: SketchFeature = makeSketch(doc, {
      plane: { kind: 'face', face: { name: `${ext.id}:end`, type: 'PLANE', center: [0, 0, 10], area: 100, normal: [0, 0, 1] }, offset: 0 },
    });
    doc = addFeature(doc, sk);
    expect(moveBlocker(doc, sk.id, 1)).toMatch(/usa "Extrusión1"/);
    expect(moveBlocker(doc, sk.id, 0)).toMatch(/usa "Extrusión1"/);
  });
});

describe('unir sin sólido previo', () => {
  it('crea el cuerpo (pasa al reordenar: la primera feature de cuerpo queda con "Unir")', () => {
    let doc = build({ profile: rect(10, 10), distance: 10 });
    const ext = doc.features[1];
    doc = { ...doc, features: doc.features.map((f) => (f.id === ext.id ? { ...f, operation: 'join' as const } : f)) };
    const r = run(doc);
    expect(r.statuses).toEqual(['ok', 'ok']);
    expect(r.vol).toBeCloseTo(1000, 6);
    // Cortar sin nada antes sigue siendo un error.
    const cut = { ...doc, features: doc.features.map((f) => (f.id === ext.id ? { ...f, operation: 'cut' as const } : f)) };
    expect(run(cut).statuses).toEqual(['ok', 'error']);
  });
});
