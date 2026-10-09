import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeExtrude, makeSketch } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, SketchData } from '../src/document/types';
import { volume } from '../src/kernel/features/measure';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function result(doc: CadDocument) {
  const e = new RecomputeEngine();
  try {
    const out = e.run(doc);
    const last = out.results[out.results.length - 1];
    return { status: last.status, error: last.error ?? '', vol: out.shape ? volume(out.shape.shape) : 0, solids: out.shape?.shape.solids.length ?? 0 };
  } finally {
    e.dispose();
  }
}

/** Sketch con la geometría dada y una extrusión delgada de ella. */
function thinDoc(draw: (b: SketchBuilder) => void, thin: number, distance = 10, base?: CadDocument) {
  const b = new SketchBuilder({ entities: [], constraints: [] } as SketchData);
  draw(b);
  let doc = base ?? emptyDocument();
  const sk = makeSketch(doc, b.data);
  doc = addFeature(doc, sk);
  return addFeature(doc, { ...makeExtrude(doc, sk.id, { distance, operation: base ? 'join' : 'new' }), thin });
}

describe('extrusión delgada', () => {
  it('una línea suelta: pared de largo × espesor × altura, con tapas rectas', () => {
    const r = result(thinDoc((b) => b.line([0, 0], [30, 0]), 2));
    expect(r.error).toBe('');
    expect(r.vol).toBeCloseTo(30 * 2 * 10, 6);
  });

  it('una L: la esquina se une en ángulo (sin huecos ni solapes)', () => {
    const r = result(thinDoc((b) => {
      const p = b.point([20, 0]);
      b.line([0, 0], p);
      b.line(p, [20, 15]);
    }, 2));
    expect(r.error).toBe('');
    // Línea media de 20 + 15 mm; en la esquina exterior se agrega y en la interior se quita lo mismo.
    expect(r.vol).toBeCloseTo((20 + 15) * 2 * 10, 6);
    expect(r.solids).toBe(1);
  });

  it('un rectángulo cerrado: pared con hueco (como una caja sin tapa ni fondo)', () => {
    const r = result(thinDoc((b) => b.rectangle([0, 0], [40, 30]), 2));
    expect(r.error).toBe('');
    expect(r.vol).toBeCloseTo((42 * 32 - 38 * 28) * 10, 6);
  });

  it('un círculo: tubo', () => {
    const r = result(thinDoc((b) => b.circle([0, 0], 10), 2));
    expect(r.vol).toBeCloseTo(Math.PI * (11 * 11 - 9 * 9) * 10, 4);
  });

  it('un arco y una spline abiertos', () => {
    const arc = result(thinDoc((b) => b.arc([0, 0], [10, 0], [0, 10]), 1));
    expect(arc.vol).toBeCloseTo((Math.PI / 2) * (10.5 * 10.5 - 9.5 * 9.5) / 2 * 10, 4);
    const sp = result(thinDoc((b) => b.spline([[0, 0], [10, 6], [20, 0], [30, 5]]), 1.5));
    expect(sp.error).toBe('');
    expect(sp.vol).toBeGreaterThan(30 * 1.5 * 10);
  });

  it('nervio: una línea unida a una placa', () => {
    const base = build({ profile: rect(40, 40), distance: 3 });
    const r = result(thinDoc((b) => b.line([-15, 0], [15, 0]), 2, 10, base));
    expect(r.error).toBe('');
    expect(r.solids).toBe(1);
    // El nervio arranca en z = 0: los primeros 3 mm quedan dentro de la placa.
    expect(r.vol).toBeCloseTo(40 * 40 * 3 + 30 * 2 * 7, 4);
  });

  it('se guarda y se vuelve a abrir', () => {
    const doc = thinDoc((b) => b.line([0, 0], [5, 0]), 1);
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });
});
