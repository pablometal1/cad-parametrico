import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeCurve3d, makePatch, updateFeature } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, ExtrudeFeature, VertexRef } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { KernelService } from '../src/kernel/service';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

async function service() {
  const k = new KernelService();
  await k.init();
  return k;
}

/** Índice del vértice en `pos` dentro de la lista del kernel. */
function vertexAt(list: Float32Array, pos: [number, number, number]) {
  for (let i = 0; i < list.length / 3; i++) {
    if (Math.hypot(list[3 * i] - pos[0], list[3 * i + 1] - pos[1], list[3 * i + 2] - pos[2]) < 1e-4) return i;
  }
  throw new Error(`No hay vértice en ${pos}`);
}

/** Caja 20 × 20 × 10 centrada en XY y referencias a los vértices pedidos. */
async function boxWith(points: [number, number, number][]) {
  const k = await service();
  const doc = build({ profile: rect(20, 20), distance: 10 });
  k.recompute(doc);
  const list = k.vertices();
  const refs = k.vertexRefs(points.map((p) => vertexAt(list, p)));
  return { k, doc, list, refs };
}

const segmentsOf = (r: ReturnType<KernelService['recompute']>, id: string) => r.sketches.find((s) => s.id === id)?.segments;

describe('curvas 3D', () => {
  it('los vértices de una caja son 8', async () => {
    const { list } = await boxWith([]);
    expect(list.length / 3).toBe(8);
  });

  it('une vértices con líneas y se dibuja como segmentos', async () => {
    const { k, doc, refs } = await boxWith([[-10, -10, 10], [10, 10, 0], [10, -10, 10]]);
    const d = addFeature(doc, makeCurve3d(doc, refs));
    const r = k.recompute(d);
    const f = d.features[d.features.length - 1];
    expect(r.features[r.features.length - 1].status).toBe('ok');
    const seg = segmentsOf(r, f.id)!;
    expect(seg.length).toBe(2 * 2 * 3);
    expect([...seg.slice(0, 6)]).toEqual([-10, -10, 10, 10, 10, 0]);
  });

  it('sigue a los vértices cuando cambian las medidas de la pieza', async () => {
    const { k, doc, refs } = await boxWith([[-10, -10, 10], [10, 10, 10]]);
    let d = addFeature(doc, makeCurve3d(doc, refs));
    const ext = d.features.find((x) => x.type === 'extrude') as ExtrudeFeature;
    d = updateFeature<ExtrudeFeature>(d, ext.id, { distance: 25 });
    const r = k.recompute(d);
    const seg = segmentsOf(r, d.features[d.features.length - 1].id)!;
    expect(seg[2]).toBeCloseTo(25, 6);
    expect(seg[5]).toBeCloseTo(25, 6);
  });

  it('cerrada sobre tres vértices de la tapa: un parche triangular', async () => {
    const { k, doc, refs } = await boxWith([[-10, -10, 10], [10, -10, 10], [10, 10, 10]]);
    let d = addFeature(doc, makeCurve3d(doc, refs, true));
    const curve = d.features[d.features.length - 1];
    d = addFeature(d, makePatch(d, [], { curves: [curve.id], height: 3, thickness: 1, operation: 'new' }));
    const r = k.recompute(d);
    expect(r.features.map((x) => x.error ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(k.massProperties().bodies).toBe(2);
  });

  it('vértices repetidos o pocos dan un mensaje', async () => {
    const { k, doc, refs } = await boxWith([[-10, -10, 10], [-10, -10, 10]]);
    const r = k.recompute(addFeature(doc, makeCurve3d(doc, refs)));
    expect(r.features[r.features.length - 1].error).toMatch(/coinciden/);
    const r2 = k.recompute(addFeature(doc, makeCurve3d(doc, refs.slice(0, 1))));
    expect(r2.features[r2.features.length - 1].error).toMatch(/al menos 2/);
  });

  it('se guarda y se vuelve a abrir', async () => {
    const { doc, refs } = await boxWith([[-10, -10, 10], [10, -10, 10], [10, 10, 10]]);
    let d: CadDocument = addFeature(doc, makeCurve3d(doc, refs as VertexRef[], true));
    d = addFeature(d, makePatch(d, [], { curves: [d.features[d.features.length - 1].id] }));
    expect(parseDocument(serializeDocument(d))).toEqual(d);
  });
});
