import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeExtrude, makeRevolve, makeSketch } from '../src/document/ops';
import type { SketchData } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { SketchBuilder } from '../src/sketch/builders';
import { findProfiles } from '../src/sketch/profiles';
import { initSolver } from '../src/sketch/solver';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function extrude(data: SketchData, h = 10, revolve = false) {
  let doc = emptyDocument();
  const sk = makeSketch(doc, data);
  doc = addFeature(doc, sk);
  doc = addFeature(doc, revolve ? makeRevolve(doc, sk, { axis: { kind: 'sketchAxis', axis: 'v' } }) : makeExtrude(doc, sk.id, { distance: h }));
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const res = { statuses: out.results.map((r) => r.status), error: out.results[1].error, volume: out.shape ? volume(out.shape.shape) : 0, solids: out.shape?.shape.solids.length ?? 0 };
  e.dispose();
  return res;
}

describe('perfiles superpuestos', () => {
  it('dos rectángulos encimados se unen', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([0, 0], [10, 10]);
    b.rectangle([5, 5], [15, 15]);
    const a = findProfiles(b.data);
    expect(a.regions).toHaveLength(2);
    expect(a.overlapping).toBe(true);
    const r = extrude(b.data);
    expect(r.statuses).toEqual(['ok', 'ok']);
    expect(r.volume).toBeCloseTo((100 + 100 - 25) * 10, 4);
    expect(r.solids).toBe(1);
  });

  it('un círculo que cruza el borde de un rectángulo suma su área (no es agujero)', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([0, 0], [20, 10]);
    b.circle([10, 10], 4); // mitad adentro, mitad afuera
    const r = extrude(b.data, 5);
    expect(r.statuses).toEqual(['ok', 'ok']);
    expect(r.volume).toBeCloseTo((200 + (Math.PI * 16) / 2) * 5, 2);
  });

  it('un círculo entero adentro sigue siendo agujero; regiones separadas no se mezclan', () => {
    const hole = new SketchBuilder({ entities: [], constraints: [] });
    hole.rectangle([0, 0], [20, 10]);
    hole.circle([10, 5], 3);
    expect(findProfiles(hole.data).overlapping).toBe(false);
    expect(extrude(hole.data, 2).volume).toBeCloseTo((200 - Math.PI * 9) * 2, 3);

    const apart = new SketchBuilder({ entities: [], constraints: [] });
    apart.rectangle([0, 0], [10, 10]);
    apart.rectangle([20, 0], [30, 10]);
    expect(findProfiles(apart.data).overlapping).toBe(false);
    expect(extrude(apart.data).solids).toBe(2);
  });

  it('revolución de perfiles superpuestos', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([5, 0], [10, 4]);
    b.rectangle([8, 2], [12, 6]);
    const r = extrude(b.data, 0, true);
    expect(r.statuses).toEqual(['ok', 'ok']);
    // Unión: anillo 5..10 × 0..4 más 8..12 × 2..6 menos la intersección 8..10 × 2..4.
    const ring = (r0: number, r1: number, h: number) => Math.PI * (r1 * r1 - r0 * r0) * h;
    expect(r.volume).toBeCloseTo(ring(5, 10, 4) + ring(8, 12, 4) - ring(8, 10, 2), 2);
  });
});
