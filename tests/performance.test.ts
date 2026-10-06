// Pieza de 100 features: qué se recalcula en cada caso (sin medir tiempos, que dependen de la máquina).
import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeExtrude, makeSketch, updateFeature } from '../src/document/ops';
import type { CadDocument, ExtrudeFeature, SketchFeature } from '../src/document/types';
import { KernelService } from '../src/kernel/service';
import { SketchBuilder } from '../src/sketch/builders';

/** Placa + 49 pares sketch/extrusión: tetones (unir) y bolsillos (cortar) en una grilla 7×7. */
function hundredFeatures(): CadDocument {
  let doc = emptyDocument();
  const base = new SketchBuilder({ entities: [], constraints: [] });
  base.rectangle([-100, -100], [100, 100]);
  const s0 = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, ...base.data });
  doc = addFeature(doc, s0);
  doc = addFeature(doc, makeExtrude(doc, s0.id, { distance: 20 }));
  for (let i = 0; i < 49; i++) {
    const x = -84 + (i % 7) * 28;
    const y = -84 + Math.floor(i / 7) * 28;
    const b = new SketchBuilder({ entities: [], constraints: [] });
    if (i % 2 === 0) b.circle([x, y], 6);
    else b.rectangle([x - 6, y - 6], [x + 6, y + 6]);
    const sk = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 20 }, ...b.data });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, i % 2 === 0
      ? { distance: 8, operation: 'join' }
      : { distance: 6, operation: 'cut', direction: 'reversed' }));
  }
  return doc;
}

let k: KernelService;
const doc = hundredFeatures();
beforeAll(async () => {
  k = new KernelService();
  await k.init();
  k.recompute(doc);
}, 120_000);

const computed = (d: CadDocument) => k.recompute(d).features.filter((f) => f.status === 'ok' && !f.cached).length;

describe('rendimiento con 100 features', () => {
  it('el volumen es el esperado (25 tetones Ø12×8, 24 bolsillos 12×12×6)', () => {
    const v = k.massProperties().volume;
    expect(v).toBeCloseTo(200 * 200 * 20 + 25 * Math.PI * 36 * 8 - 24 * 144 * 6, 1);
  });

  it('sin cambios, deshacer y rehacer no recalculan nada', () => {
    expect(computed(doc)).toBe(0);
    const last = doc.features[99] as ExtrudeFeature;
    const edited = updateFeature<ExtrudeFeature>(doc, last.id, { distance: 5 });
    expect(computed(edited)).toBe(1);
    expect(computed(doc)).toBe(0);
    expect(computed(edited)).toBe(0);
  });

  it('editar una del medio recalcula solo las extrusiones posteriores, no los sketches', () => {
    const mid = doc.features[51] as ExtrudeFeature;
    // De la #52 a la #100 hay 25 extrusiones (incluida ella) y 24 sketches que no dependen del sólido.
    expect(computed(updateFeature<ExtrudeFeature>(doc, mid.id, { distance: 7 }))).toBe(25);
  });

  it('cambiar la placa recalcula su sketch y las 50 extrusiones', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([-105, -100], [100, 100]);
    expect(computed(updateFeature<SketchFeature>(doc, doc.features[0].id, b.data))).toBe(51);
  });
});
