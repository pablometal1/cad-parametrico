import { describe, it, expect, beforeAll } from 'vitest';
import { createRoot } from 'solid-js';
import { makeVertex, measureDistanceBetween } from 'replicad';
import { addFeature, emptyDocument, makeExtrude, makeSketch } from '../src/document/ops';
import { basePlaneFrame } from '../src/document/planes';
import { DocumentFormatError, parseDocument, serializeDocument } from '../src/document/serialize';
import type { SketchData, SketchSpline } from '../src/document/types';
import { volume } from '../src/kernel/features/measure';
import { makeBSplineEdge } from '../src/kernel/features/sketch';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { SketchBuilder } from '../src/sketch/builders';
import { mirrorCurves } from '../src/sketch/edit';
import { SketchIndex, type Vec2 } from '../src/sketch/model';
import { findProfiles } from '../src/sketch/profiles';
import { constraintFromSelection } from '../src/sketch/rules';
import { initSolver, solveSketch } from '../src/sketch/solver';
import { bsplineData, curvatureComb, sampleNurbs } from '../src/sketch/spline';
import { createSketchSession } from '../src/ui/sketch/session';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

const empty = (): SketchData => ({ entities: [], constraints: [] });
const near = (a: Vec2, b: Vec2, digits = 9) => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];

function polygonArea(poly: Vec2[]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function run(data: SketchData, distance = 5) {
  let doc = emptyDocument();
  const sk = makeSketch(doc, data);
  doc = addFeature(doc, sk);
  doc = addFeature(doc, makeExtrude(doc, sk.id, { distance }));
  const e = new RecomputeEngine();
  const out = e.run(doc);
  return { out, dispose: () => e.dispose() };
}

const CV: Vec2[] = [[0, 0], [10, 15], [25, -5], [40, 12], [50, 0]];

describe('geometría NURBS', () => {
  it('abierta: empieza y termina en los extremos, tangente al polígono de control', () => {
    const pts = sampleNurbs(CV, false, 3, 20000);
    near(pts[0], CV[0]);
    near(pts[pts.length - 1], CV[CV.length - 1]);
    const sin = (a: Vec2, b: Vec2) => cross(a, b) / Math.hypot(...a) / Math.hypot(...b);
    expect(sin(sub(pts[1], pts[0]), sub(CV[1], CV[0]))).toBeCloseTo(0, 3);
    expect(sin(sub(pts.at(-1)!, pts.at(-2)!), sub(CV[4], CV[3]))).toBeCloseTo(0, 3);
    // No pasa por los puntos interiores (se acerca a ellos).
    expect(Math.min(...pts.map((p) => Math.hypot(p[0] - 10, p[1] - 15)))).toBeGreaterThan(1);
  });

  it('queda dentro de la envolvente convexa (acá, de la caja) de sus puntos de control', () => {
    for (const p of sampleNurbs(CV, false, 3, 100)) {
      expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(p[0]).toBeLessThanOrEqual(50 + 1e-9);
      expect(p[1]).toBeGreaterThanOrEqual(-5 - 1e-9);
      expect(p[1]).toBeLessThanOrEqual(15 + 1e-9);
    }
  });

  it('grado 1 es el polígono de control; el grado se limita por la cantidad de puntos', () => {
    const lin = sampleNurbs(CV, false, 1, 4);
    near(lin[4], CV[1]);
    near(lin[2], [5, 7.5]);
    expect(bsplineData([[0, 0], [5, 5], [10, 0]], false, 5).degree).toBe(2);
    // Con dos puntos es un segmento recto.
    for (const p of sampleNurbs([[0, 0], [8, 4]], false)) expect(p[1]).toBeCloseTo(p[0] / 2, 12);
  });

  it('cerrada: periódica y cúbica uniforme (cada punto de nudo es (P₋₁ + 4P₀ + P₁)/6)', () => {
    const sq: Vec2[] = [[0, 0], [12, 0], [12, 12], [0, 12]];
    const pts = sampleNurbs(sq, true, 3, 10);
    near(pts[0], pts[pts.length - 1]);
    const knotPoints = [0, 10, 20, 30].map((i) => pts[i]);
    const expected = sq.map((_, i) => {
      const [a, b, c] = [sq[i], sq[(i + 1) % 4], sq[(i + 2) % 4]];
      return [(a[0] + 4 * b[0] + c[0]) / 6, (a[1] + 4 * b[1] + c[1]) / 6] as Vec2;
    });
    knotPoints.forEach((p, i) => near(p, expected[i]));
  });

  it('la curva de OpenCascade es la misma que dibuja el editor', () => {
    for (const closed of [false, true]) {
      const frame = basePlaneFrame({ kind: 'base', plane: 'XY', offset: 0 });
      const edge = makeBSplineEdge(bsplineData(CV, closed, 3), frame);
      try {
        for (const [u, v] of sampleNurbs(CV, closed, 3, 12)) {
          const vx = makeVertex([u, v, 0]);
          expect(measureDistanceBetween(edge, vx)).toBeLessThan(1e-7);
          vx.delete();
        }
      } finally {
        edge.delete();
      }
    }
  });

  it('peine de curvatura: en un círculo, curvatura constante 1/r hacia el centro', () => {
    const r = 7;
    const circle: Vec2[] = Array.from({ length: 361 }, (_, i) => [r * Math.cos((i * Math.PI) / 180), r * Math.sin((i * Math.PI) / 180)]);
    const teeth = curvatureComb(circle, true);
    for (const t of teeth) {
      expect(t.k).toBeCloseTo(1 / r, 4);
      // La normal (izquierda del recorrido antihorario) apunta al centro.
      expect(t.normal[0] * -t.at[0] + t.normal[1] * -t.at[1]).toBeGreaterThan(0);
    }
  });
});

describe('NURBS en el sketch', () => {
  it('cerrada: un perfil; extrudida da un sólido de una sola cara lateral', () => {
    const b = new SketchBuilder(empty());
    const pts: Vec2[] = [[0, 0], [30, -4], [34, 18], [12, 26], [-6, 12]];
    b.spline(pts, true, false, { kind: 'control' });
    expect(findProfiles(b.data).regions.length).toBe(1);
    const { out, dispose } = run(b.data, 4);
    try {
      expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok']);
      const shape = out.shape!.shape;
      // Arriba, abajo y una sola cara B-spline alrededor.
      expect(shape.faces.length).toBe(3);
      const area = polygonArea(sampleNurbs(pts, true, 3, 400).slice(0, -1));
      expect(volume(shape)).toBeCloseTo(area * 4, 1);
    } finally {
      dispose();
    }
  });

  it('abierta + línea que la cierra: extruye con una cara curva y una plana', () => {
    const b = new SketchBuilder(empty());
    const s = b.spline(CV, false, false, { kind: 'control', degree: 4 });
    const sp = b.data.entities.find((e) => e.id === s) as SketchSpline;
    b.line(sp.points[4], sp.points[0]);
    const { out, dispose } = run(b.data);
    try {
      expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok']);
      expect(out.shape!.shape.faces.length).toBe(4);
    } finally {
      dispose();
    }
  });

  it('tangencia con una línea en el extremo compartido', () => {
    for (const kind of ['control', 'fit'] as const) {
      const b = new SketchBuilder(empty());
      const l = b.line([-20, -10], [0, 0]);
      const line = b.data.entities.find((e) => e.id === l)!;
      if (line.type !== 'line') throw new Error();
      const s = b.spline([line.p2, [10, 15], [25, 5]], false, false, { kind });
      const rule = constraintFromSelection('tangent', b.data, [l, s]);
      if (!rule.ok) throw new Error(rule.hint);
      for (const c of rule.constraints) b.constrain(c);
      const r = solveSketch(b.data);
      expect(r.ok).toBe(true);
      expect(r.conflicting).toEqual([]);
      const idx = new SketchIndex(r.data);
      const sp = idx.get(s) as SketchSpline;
      const [p1, p2] = [idx.point(line.p1), idx.point(line.p2)];
      const curve = kind === 'control' ? sampleNurbs(sp.points.map((id) => idx.point(id)), false, 3, 20000) : null;
      // La recta pasa por el segundo punto de la spline, y la curva sale en esa dirección.
      expect(cross(sub(p2, p1), sub(idx.point(sp.points[1]), p2))).toBeCloseTo(0, 6);
      if (curve) expect(cross(sub(p2, p1), sub(curve[1], curve[0])) / Math.hypot(...sub(curve[1], curve[0])) / Math.hypot(...sub(p2, p1))).toBeCloseTo(0, 3);
    }
  });

  it('tangencia con un arco y entre dos splines', () => {
    const b = new SketchBuilder(empty());
    const a = b.arc([0, 0], [10, 0], [0, 10]);
    const arc = b.data.entities.find((e) => e.id === a)!;
    if (arc.type !== 'arc') throw new Error();
    const s1 = b.spline([arc.start, [15, -8], [25, -2]], false, false, { kind: 'control' });
    const sp1 = b.data.entities.find((e) => e.id === s1) as SketchSpline;
    const s2 = b.spline([sp1.points[2], [30, 6], [40, 0]], false, false, { kind: 'control' });
    for (const pair of [[a, s1], [s1, s2]]) {
      const rule = constraintFromSelection('tangent', b.data, pair);
      if (!rule.ok) throw new Error(rule.hint);
      for (const c of rule.constraints) b.constrain(c);
    }
    const r = solveSketch(b.data);
    expect(r.ok).toBe(true);
    const idx = new SketchIndex(r.data);
    const [c, st] = [idx.point(arc.center), idx.point(arc.start)];
    const q1 = idx.point(sp1.points[1]);
    // Radio ⟂ primer tramo del polígono.
    const rad = sub(st, c);
    const tan = sub(q1, st);
    expect((rad[0] * tan[0] + rad[1] * tan[1]) / Math.hypot(...tan)).toBeCloseTo(0, 6);
    const sp2 = idx.get(s2) as SketchSpline;
    const j = idx.point(sp1.points[2]);
    expect(cross(sub(j, idx.point(sp1.points[1])), sub(idx.point(sp2.points[1]), j))).toBeCloseTo(0, 6);
  });

  it('tangencia sin extremo compartido: pide unirlos primero', () => {
    const b = new SketchBuilder(empty());
    const l = b.line([-20, 0], [-5, 0]);
    const s = b.spline([[0, 0], [10, 10], [20, 0]], false, false, { kind: 'control' });
    const rule = constraintFromSelection('tangent', b.data, [l, s]);
    expect(rule.ok).toBe(false);
  });

  it('simetría: la copia sigue siendo NURBS del mismo grado', () => {
    const b = new SketchBuilder(empty());
    const s = b.spline([[2, 0], [8, 5], [3, 10], [6, 14]], false, false, { kind: 'control', degree: 2 });
    const r = mirrorCurves(b.data, [s], 'axisY');
    if (!r.ok) throw new Error(r.error);
    const copies = r.data.entities.filter((e): e is SketchSpline => e.type === 'spline');
    expect(copies.length).toBe(2);
    expect(copies.every((c) => c.kind === 'control' && c.degree === 2)).toBe(true);
  });

  it('se guarda y se vuelve a abrir; un grado inválido se rechaza', () => {
    const b = new SketchBuilder(empty());
    b.spline(CV, false, false, { kind: 'control', degree: 4 });
    let doc = emptyDocument();
    doc = addFeature(doc, makeSketch(doc, b.data));
    const text = serializeDocument(doc);
    expect(parseDocument(text)).toEqual(doc);
    expect(() => parseDocument(text.replace('"degree": 4', '"degree": 9'))).toThrow(DocumentFormatError);
    expect(() => parseDocument(text.replace('"kind": "control"', '"kind": "bezier"'))).toThrow(DocumentFormatError);
  });
});

describe('herramienta Curva NURBS del editor', () => {
  it('clics en los puntos de control; después se cambia el grado o se pasa a spline por puntos', () => {
    const s = createRoot(() => createSketchSession(empty()));
    s.setTool('nurbs');
    for (const p of CV) s.click({ pos: p });
    s.finishPending();
    const made = s.data().entities.find((e) => e.type === 'spline') as SketchSpline;
    expect(made.kind).toBe('control');
    expect(made.points.length).toBe(5);

    s.setSplineShape(made.id, { degree: 2 });
    expect((s.data().entities.find((e) => e.id === made.id) as SketchSpline).degree).toBe(2);
    s.setSplineShape(made.id, { kind: 'fit' });
    const fit = s.data().entities.find((e) => e.id === made.id) as SketchSpline;
    expect(fit.kind).toBeUndefined();
    expect(fit.degree).toBeUndefined();
  });
});
