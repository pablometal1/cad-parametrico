import { describe, it, expect, beforeAll } from 'vitest';
import { createRoot } from 'solid-js';
import { addFeature, emptyDocument, makeExtrude, makeSketch } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { SketchData, SketchSpline } from '../src/document/types';
import { volume } from '../src/kernel/features/measure';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { SketchBuilder } from '../src/sketch/builders';
import { mirrorCurves } from '../src/sketch/edit';
import { curveDistance } from '../src/sketch/geometry';
import { SketchIndex } from '../src/sketch/model';
import { findProfiles } from '../src/sketch/profiles';
import { initSolver, solveSketch } from '../src/sketch/solver';
import { bezierPoint, sampleSpline, splineBeziers } from '../src/sketch/spline';
import { createSketchSession } from '../src/ui/sketch/session';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

const empty = (): SketchData => ({ entities: [], constraints: [] });

describe('geometría de la spline', () => {
  it('pasa por todos sus puntos y es suave en ellos', () => {
    const pts: [number, number][] = [[0, 0], [10, 5], [20, -3], [35, 4]];
    const segs = splineBeziers(pts, false);
    expect(segs.length).toBe(3);
    segs.forEach((s, i) => {
      expect(s[0]).toEqual(pts[i]);
      expect(s[3]).toEqual(pts[i + 1]);
    });
    // Tangente continua: el control de salida y el de llegada están alineados con el punto.
    for (let i = 0; i + 1 < segs.length; i++) {
      const p = segs[i][3];
      const a = [p[0] - segs[i][2][0], p[1] - segs[i][2][1]];
      const b = [segs[i + 1][1][0] - p[0], segs[i + 1][1][1] - p[1]];
      expect(a[0] * b[1] - a[1] * b[0]).toBeCloseTo(0, 9);
      expect(a[0] * b[0] + a[1] * b[1]).toBeGreaterThan(0);
    }
  });

  it('dos puntos: un segmento recto', () => {
    const s = splineBeziers([[0, 0], [9, 0]], false)[0];
    for (const t of [0.25, 0.5, 0.75]) expect(bezierPoint(s, t)[1]).toBeCloseTo(0, 12);
  });

  it('cerrada: vuelve al primer punto', () => {
    const pts = sampleSpline([[0, 0], [10, 0], [10, 10], [0, 10]], true);
    expect(pts[pts.length - 1][0]).toBeCloseTo(0, 12);
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 12);
  });
});

describe('spline en el sketch', () => {
  it('cerrada: es un perfil; sus puntos se acotan como cualquier punto', () => {
    const b = new SketchBuilder(empty());
    const s = b.spline([[0, 0], [20, 0], [20, 10], [0, 10]], true);
    const sp = b.data.entities.find((e) => e.id === s) as SketchSpline;
    b.constrain({ type: 'coincident', a: sp.points[0], b: 'origin' });
    b.constrain({ type: 'distance', a: sp.points[0], b: sp.points[1], value: 30 });
    const r = solveSketch(b.data);
    expect(r.ok).toBe(true);
    // 4 puntos (8) − coincidente (2) − distancia (1).
    expect(r.dof).toBe(5);
    expect(findProfiles(r.data).regions.length).toBe(1);
  });

  it('abierta + línea que la cierra: un perfil', () => {
    const b = new SketchBuilder(empty());
    const s = b.spline([[0, 0], [10, 8], [20, 0]]);
    const sp = b.data.entities.find((e) => e.id === s) as SketchSpline;
    b.line(sp.points[2], sp.points[0]);
    const { regions } = findProfiles(b.data);
    expect(regions.length).toBe(1);
    expect(regions[0].outer.area).toBeGreaterThan(50);
  });

  it('se elige con el mouse cerca de la curva (no de la cuerda)', () => {
    const b = new SketchBuilder(empty());
    const s = b.spline([[0, 0], [10, 8], [20, 0]]);
    const idx = new SketchIndex(b.data);
    const c = idx.get(s) as SketchSpline;
    expect(curveDistance(idx, c, [10, 8])).toBeLessThan(1e-9);
    expect(curveDistance(idx, c, [10, 0])).toBeGreaterThan(5);
  });

  it('simetría: la copia queda vinculada por sus puntos', () => {
    const b = new SketchBuilder(empty());
    const s = b.spline([[2, 0], [8, 5], [3, 10]]);
    const r = mirrorCurves(b.data, [s], 'axisY');
    if (!r.ok) throw new Error(r.error);
    const solved = solveSketch(r.data);
    expect(solved.redundant).toEqual([]);
    expect(r.data.constraints.filter((k) => k.type === 'symmetric').length).toBe(3);
  });

  it('se guarda y se vuelve a abrir', () => {
    const b = new SketchBuilder(empty());
    b.spline([[0, 0], [5, 5], [10, 0]], false, true);
    let doc = emptyDocument();
    doc = addFeature(doc, makeSketch(doc, b.data));
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });
});

describe('spline en 3D', () => {
  it('extrudir una spline cerrada da el área de su contorno por la altura', () => {
    const b = new SketchBuilder(empty());
    const pts: [number, number][] = [[0, 0], [20, -2], [24, 10], [10, 16], [-4, 8]];
    b.spline(pts, true);
    let doc = emptyDocument();
    const sk = makeSketch(doc, b.data);
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 5 }));
    const e = new RecomputeEngine();
    try {
      const out = e.run(doc);
      expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok']);
      const poly = sampleSpline(pts, true, 400);
      let area = 0;
      for (let i = 0; i + 1 < poly.length; i++) area += poly[i][0] * poly[i + 1][1] - poly[i + 1][0] * poly[i][1];
      expect(volume(out.shape!.shape)).toBeCloseTo((Math.abs(area) / 2) * 5, 1);
    } finally {
      e.dispose();
    }
  });
});

describe('herramienta Spline del editor', () => {
  it('clics en cada punto, Enter termina; clic en el primero la cierra', () => {
    const s = createRoot(() => createSketchSession(empty()));
    s.setTool('spline');
    for (const p of [[0, 0], [10, 5], [20, 0]] as [number, number][]) s.click({ pos: p });
    s.finishPending();
    const open = s.data().entities.find((e) => e.type === 'spline') as SketchSpline;
    expect(open.points.length).toBe(3);
    expect(open.closed).toBe(false);

    s.setTool('spline');
    const first = { pos: [0, 20] as [number, number] };
    s.click(first);
    s.click({ pos: [10, 25] });
    s.click({ pos: [20, 20] });
    s.click(first);
    const closed = s.data().entities.filter((e) => e.type === 'spline')[1] as SketchSpline;
    expect(closed.closed).toBe(true);
    expect(closed.points.length).toBe(3);
  });
});
