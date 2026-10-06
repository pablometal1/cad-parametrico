import { describe, it, expect, beforeAll } from 'vitest';
import { SketchBuilder } from '../src/sketch/builders';
import { dist, lineEnds } from '../src/sketch/geometry';
import { SketchIndex } from '../src/sketch/model';
import { findProfiles } from '../src/sketch/profiles';
import { initSolver, solveSketch } from '../src/sketch/solver';

beforeAll(async () => {
  await initSolver();
}, 30_000);

const empty = () => new SketchBuilder({ entities: [], constraints: [] });

describe('herramientas de sketch', () => {
  it('rectángulo desde el centro: 4 grados de libertad, centrable en el origen', () => {
    const b = empty();
    const ids = b.centerRectangle([5, 3], [15, 8]);
    const center = ids[4];
    let r = solveSketch(b.data);
    expect(r.ok).toBe(true);
    expect(r.redundant).toEqual([]);
    expect(r.dof).toBe(4);
    b.constrain({ type: 'coincident', a: center, b: 'origin' });
    r = solveSketch(b.data);
    const idx = new SketchIndex(r.data);
    const [a, c] = lineEnds(idx, ids[0]);
    // Centrado en el origen: extremos simétricos.
    expect(a[0] + c[0]).toBeCloseTo(0, 6);
    expect(r.dof).toBe(2);
    expect(findProfiles(b.data).regions).toHaveLength(1); // las diagonales son de construcción
  });

  it('polígono regular (hexágono): lados iguales, 4 grados de libertad, un perfil', () => {
    const b = empty();
    const ids = b.polygon([0, 0], [10, 0], 6);
    const r = solveSketch(b.data);
    expect(r.ok).toBe(true);
    expect(r.redundant).toEqual([]);
    expect(r.dof).toBe(4);
    const idx = new SketchIndex(r.data);
    const sides = ids.slice(0, 6).map((l) => dist(...lineEnds(idx, l)));
    sides.forEach((s) => expect(s).toBeCloseTo(10, 6)); // hexágono de radio 10: lado 10
    const regions = findProfiles(r.data).regions;
    expect(regions).toHaveLength(1);
    expect(Math.abs(regions[0].outer.area)).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100, 4);
  });

  it('polígono con cantidad de lados fuera de rango se limita', () => {
    const b = empty();
    expect(b.polygon([0, 0], [5, 0], 2).length - 1).toBe(3);
  });

  it('ranura: 5 grados de libertad, perfil cerrado con el área correcta', () => {
    const b = empty();
    b.slot([0, 0], [20, 0], 5);
    const r = solveSketch(b.data);
    expect(r.ok).toBe(true);
    expect(r.conflicting).toEqual([]);
    expect(r.dof).toBe(5);
    const regions = findProfiles(r.data).regions;
    expect(regions).toHaveLength(1);
    expect(Math.abs(regions[0].outer.area)).toBeCloseTo(20 * 10 + Math.PI * 25, 0);
  });

  it('ranura inclinada y con centros coincidentes', () => {
    const b = empty();
    b.slot([0, 0], [10, 10], 2);
    expect(solveSketch(b.data).ok).toBe(true);
    expect(() => empty().slot([1, 1], [1, 1], 2)).toThrow(/no pueden coincidir/);
  });
});

describe('herramientas nuevas en la sesión del editor', () => {
  it('rectángulo desde el centro, polígono de 8 lados y ranura con clics', async () => {
    const { createRoot } = await import('solid-js');
    const { createSketchSession } = await import('../src/ui/sketch/session');
    const s = createRoot(() => createSketchSession({ entities: [], constraints: [] }));
    s.setTool('centerRect');
    s.click({ pos: [0, 0], pointId: 'origin' });
    s.click({ pos: [10, 5] });
    expect(s.data().entities.filter((e) => e.type === 'line')).toHaveLength(6); // 4 lados + 2 diagonales
    expect(s.info().dof).toBe(2); // centro enganchado al origen

    s.setTool('polygon');
    s.setPolygonSides(8);
    s.click({ pos: [40, 0] });
    s.click({ pos: [50, 0] });
    expect(s.data().entities.filter((e) => e.type === 'line' && !e.construction)).toHaveLength(4 + 8);

    s.setTool('slot');
    s.click({ pos: [0, 40] });
    s.click({ pos: [30, 40] });
    s.click({ pos: [15, 44] }); // ancho: radio 4
    const arcs = s.data().entities.filter((e) => e.type === 'arc');
    expect(arcs).toHaveLength(2);
    expect(s.pending()).toBeNull();
    expect(s.info().ok).toBe(true);
  });

  it('vista previa de las herramientas nuevas', async () => {
    const { previewSegments2D, previewLabel, slotOutline } = await import('../src/ui/draw3d/preview');
    expect(previewSegments2D({ tool: 'polygon', center: { pos: [0, 0] } }, [10, 0], 5)).toHaveLength(10);
    expect(previewLabel({ tool: 'centerRect', center: { pos: [0, 0] } }, [5, 2])).toBe('10 × 4 mm');
    expect(previewLabel({ tool: 'slot', c1: { pos: [0, 0] }, c2: { pos: [10, 0] } }, [5, 3])).toBe('ancho 6 mm');
    expect(slotOutline([0, 0], [10, 0], 2).length).toBeGreaterThan(20);
  });
});

describe('extrusión de las herramientas nuevas', () => {
  it('hexágono y ranura extruidos tienen el volumen esperado', async () => {
    const { initOCCT } = await import('../src/kernel/occt');
    const { RecomputeEngine } = await import('../src/kernel/recompute');
    const { volume } = await import('../src/kernel/features/measure');
    const { addFeature, emptyDocument, makeExtrude, makeSketch } = await import('../src/document/ops');
    await initOCCT();
    const extrude = (data: ReturnType<SketchBuilder['data']['valueOf']> & object, h: number) => {
      let doc = emptyDocument();
      const sk = makeSketch(doc, data as never);
      doc = addFeature(doc, sk);
      doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: h }));
      const e = new RecomputeEngine();
      const out = e.run(doc);
      const v = out.shape ? volume(out.shape.shape) : NaN;
      e.dispose();
      return { v, statuses: out.results.map((r) => r.status) };
    };
    const hex = empty();
    hex.polygon([0, 0], [10, 0], 6);
    const a = extrude(hex.data, 5);
    expect(a.statuses).toEqual(['ok', 'ok']);
    expect(a.v).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100 * 5, 3);

    const slot = empty();
    slot.slot([0, 0], [20, 0], 5);
    const b = extrude(slot.data, 3);
    expect(b.statuses).toEqual(['ok', 'ok']);
    expect(b.v).toBeCloseTo((20 * 10 + Math.PI * 25) * 3, 2);
  });
});
