import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeFillet, makeRevolve, makeShell, makeSketch, updateFeature } from '../src/document/ops';
import type { ExtrudeFeature } from '../src/document/types';
import { KernelService } from '../src/kernel/service';
import { initOCCT } from '../src/kernel/occt';
import { edgeRefOf, faceRefOf } from '../src/kernel/naming';
import { RecomputeEngine } from '../src/kernel/recompute';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

/** Posición del asa de un manipulador lineal. */
const handle = (m: { origin: number[]; dir: number[]; value: number; factor: number }) =>
  m.origin.map((o, i) => o + m.dir[i] * m.value * m.factor);

async function service() {
  const k = new KernelService();
  await k.init();
  return k;
}

describe('manipuladores 3D', () => {
  it('extrusión: el asa queda en la cara final, sobre el centro del perfil', async () => {
    const k = await service();
    const doc = build({ profile: rect(40, 30, [10, 5]), distance: 20 });
    k.recompute(doc);
    const ext = doc.features[1] as ExtrudeFeature;
    const m = k.manipulator(ext.id)!;
    expect(m.kind).toBe('linear');
    if (m.kind !== 'linear') return;
    expect(m.param).toBe('distance');
    handle(m).forEach((v, i) => expect(v).toBeCloseTo([10, 5, 20][i], 6));

    // Invertida: apunta hacia -Z. Simétrica: el asa queda en la mitad de la distancia.
    const rev = updateFeature<ExtrudeFeature>(doc, ext.id, { direction: 'reversed' });
    k.recompute(rev);
    expect(handle(k.manipulator(ext.id) as never)[2]).toBeCloseTo(-20, 6);
    const sym = updateFeature<ExtrudeFeature>(doc, ext.id, { direction: 'symmetric' });
    k.recompute(sym);
    expect(handle(k.manipulator(ext.id) as never)[2]).toBeCloseTo(10, 6);
    k.dispose();
  });

  it('redondeo: el asa sale de la arista hacia adentro del material', async () => {
    const k = await service();
    const e = new RecomputeEngine();
    let doc = build({ profile: rect(40, 30), distance: 20 });
    const s = e.run(doc).shape!;
    const ei = s.shape.edges.findIndex((x) => {
      const p = x.pointAt(0.5).toTuple();
      return Math.abs(p[1] + 15) < 1e-6 && Math.abs(p[2] - 20) < 1e-6;
    });
    const fillet = makeFillet(doc, [edgeRefOf(s, ei)], 3);
    doc = addFeature(doc, fillet);
    e.dispose();
    k.recompute(doc);
    const m = k.manipulator(fillet.id)!;
    if (m.kind !== 'linear') throw new Error('se esperaba lineal');
    expect(m.param).toBe('radius');
    expect(m.value).toBe(3);
    // Arista en y=-15, z=20: hacia adentro es (0, +1, -1)/√2.
    expect(m.dir[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(m.dir[2]).toBeCloseTo(-Math.SQRT1_2, 6);
    k.dispose();
  });

  it('vaciado: el asa entra desde la cara quitada', async () => {
    const k = await service();
    const e = new RecomputeEngine();
    let doc = build({ profile: rect(40, 30), distance: 20 });
    const s = e.run(doc).shape!;
    const top = faceRefOf(s, s.shape.faces.findIndex((f) => Math.abs(f.center.z - 20) < 1e-6));
    const shell = makeShell(doc, [top], 2);
    doc = addFeature(doc, shell);
    e.dispose();
    k.recompute(doc);
    const m = k.manipulator(shell.id)!;
    if (m.kind !== 'linear') throw new Error('se esperaba lineal');
    expect(handle(m)[2]).toBeCloseTo(18, 6);
    k.dispose();
  });

  it('revolución: asa angular alrededor del eje', async () => {
    const k = await service();
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([5, 0], [10, 4]);
    let doc = build();
    const sk = makeSketch(doc, b.data);
    doc = addFeature(doc, sk);
    const rev = makeRevolve(doc, sk, { angle: 90 });
    doc = addFeature(doc, rev);
    k.recompute(doc);
    const m = k.manipulator(rev.id)!;
    if (m.kind !== 'angular') throw new Error('se esperaba angular');
    expect(m.value).toBe(90);
    expect(m.axis.map(Math.abs)).toEqual([0, 1, 0]); // eje v del plano XY = Y
    expect(m.radius).toBeCloseTo(7.5, 6);
    k.dispose();
  });

  it('sin manipulador para sketches, features retrocedidas o con referencia perdida', async () => {
    const k = await service();
    const doc = build({ profile: rect(10, 10), distance: 5 });
    k.recompute({ ...doc, rollback: 1 });
    expect(k.manipulator(doc.features[0].id)).toBeNull();
    expect(k.manipulator(doc.features[1].id)).toBeNull();
    k.dispose();
  });
});
