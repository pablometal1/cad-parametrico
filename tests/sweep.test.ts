import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeExtrude, makeFillet, makeLoft, makeSketch, makeSweep, updateFeature } from '../src/document/ops';
import type { BasePlane, CadDocument, SketchData, SketchFeature, SweepFeature, LoftFeature } from '../src/document/types';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { edgeRefOf, type NamedShape } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function sketch(doc: CadDocument, plane: BasePlane, offset: number, draw: (b: SketchBuilder) => void): [CadDocument, SketchFeature] {
  const b = new SketchBuilder({ entities: [], constraints: [] });
  draw(b);
  const sk = makeSketch(doc, { plane: { kind: 'base', plane, offset }, ...(b.data as SketchData) });
  return [addFeature(doc, sk), sk];
}

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const res = { status: last.status, error: last.error, statuses: out.results.map((r) => r.status), vol: out.shape ? volume(out.shape.shape) : 0, solids: out.shape?.shape.solids.length ?? 0 };
  e.dispose();
  return res;
}

function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}

/** Perfil circular de radio r en el plano YZ (perpendicular al eje X, donde empieza la trayectoria). */
function circleProfile(doc: CadDocument, r: number) {
  return sketch(doc, 'YZ', 0, (b) => b.circle([0, 0], r));
}

describe('barrido', () => {
  it('círculo a lo largo de una recta: cilindro', () => {
    let [doc, profile] = circleProfile(emptyDocument(), 2);
    let path: SketchFeature;
    [doc, path] = sketch(doc, 'XY', 0, (b) => b.line([0, 0], [30, 0]));
    doc = addFeature(doc, makeSweep(doc, profile.id, path.id));
    const r = run(doc);
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(Math.PI * 4 * 30, 3);
  });

  it('recta + arco + recta: el volumen sigue el teorema de Pappus (área × largo del recorrido)', () => {
    let [doc, profile] = circleProfile(emptyDocument(), 2);
    let path: SketchFeature;
    [doc, path] = sketch(doc, 'XY', 0, (b) => {
      // Las curvas se dan desordenadas a propósito: la trayectoria se arma por los extremos.
      b.line([30, 10], [30, 30]);
      b.line([0, 0], [20, 0]);
      b.arc([20, 10], [20, 0], [30, 10]);
    });
    doc = addFeature(doc, makeSweep(doc, profile.id, path.id));
    const r = run(doc);
    expect(r.status).toBe('ok');
    const length = 20 + (Math.PI * 10) / 2 + 20;
    expect(r.vol).toBeCloseTo(Math.PI * 4 * length, 1);
  });

  it('cortar: un canal barrido sobre una caja', () => {
    let [doc, box] = sketch(emptyDocument(), 'XY', 0, (b) => b.rectangle([0, -10], [30, 10]));
    doc = addFeature(doc, makeExtrude(doc, box.id, { distance: 10 }));
    let profile: SketchFeature;
    let path: SketchFeature;
    // Círculo r=2 centrado en la cara superior (z=10), barrido a lo largo de X.
    [doc, profile] = sketch(doc, 'YZ', 0, (b) => b.circle([0, 10], 2));
    [doc, path] = sketch(doc, 'XZ', 0, (b) => b.line([0, 10], [30, 10]));
    doc = addFeature(doc, makeSweep(doc, profile.id, path.id, { operation: 'cut' }));
    const r = run(doc);
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(30 * 20 * 10 - (Math.PI * 4 * 30) / 2, 2);
  });

  it('errores claros: trayectoria ramificada, perfil abierto, mismo sketch', () => {
    let [doc, profile] = circleProfile(emptyDocument(), 2);
    let path: SketchFeature;
    [doc, path] = sketch(doc, 'XY', 0, (b) => {
      b.line([0, 0], [10, 0]);
      b.line([10, 0], [20, 0]);
      b.line([10, 0], [10, 10]);
    });
    // El sketch ramificado ya queda en error con su propio mensaje; el barrido lo señala.
    const branched = addFeature(doc, makeSweep(doc, profile.id, path.id));
    const rb = run(branched);
    expect(rb.statuses).toEqual(['ok', 'error', 'error']);
    expect(rb.error).toMatch(/Sketch2" tiene errores/);

    const same = addFeature(doc, makeSweep(doc, profile.id, profile.id));
    expect(run(same).error).toMatch(/distintos/);

    let open: SketchFeature;
    [doc, open] = sketch(doc, 'YZ', 0, (b) => b.line([0, 0], [5, 5]));
    const straight = sketch(doc, 'XY', 0, (b) => b.line([0, 0], [30, 0]));
    const noProfile = addFeature(straight[0], makeSweep(straight[0], open.id, straight[1].id));
    expect(run(noProfile).error).toMatch(/perfil no tiene contornos cerrados/);
  });

  it('el redondeo del extremo sigue funcionando al alargar la trayectoria', () => {
    let [doc, profile] = sketch(emptyDocument(), 'YZ', 0, (b) => b.rectangle([-3, -3], [3, 3]));
    let path: SketchFeature;
    [doc, path] = sketch(doc, 'XY', 0, (b) => b.line([0, 0], [30, 0]));
    const sw = makeSweep(doc, profile.id, path.id);
    doc = addFeature(doc, sw);
    // Arista del extremo final (x = 30), y = 3.
    const ref = withShape(doc, (s) => {
      const i = s.shape.edges.findIndex((e) => {
        const m = e.pointAt(0.5).toTuple();
        return Math.abs(m[0] - 30) < 1e-6 && Math.abs(m[1] - 3) < 1e-6;
      });
      return edgeRefOf(s, i);
    });
    expect(ref.name).toContain(`${sw.id}:end`);
    doc = addFeature(doc, makeFillet(doc, [ref], 1));
    expect(run(doc).status).toBe('ok');
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.line([0, 0], [45, 0]);
    const longer = updateFeature<SketchFeature>(doc, path.id, b.data);
    const r = run(longer);
    expect(r.statuses.every((s) => s === 'ok')).toBe(true);
    // Prisma de 6×6×45 menos el redondeo de radio 1 sobre una arista de 6.
    expect(r.vol).toBeCloseTo(36 * 45 - (1 - Math.PI / 4) * 6, 3);
  });
});

describe('solevación', () => {
  const square = (side: number) => (b: SketchBuilder) => b.rectangle([-side / 2, -side / 2], [side / 2, side / 2]);

  it('cuadrado 10 → cuadrado 4 a 10 mm: tronco de pirámide', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, square(10));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, square(4));
    for (const ruled of [true, false]) {
      const r = run(addFeature(doc, makeLoft(doc, [a.id, b.id], { ruled })));
      expect(r.status, `ruled ${ruled}`).toBe('ok');
      expect(r.vol).toBeCloseTo((10 / 3) * (100 + 16 + Math.sqrt(100 * 16)), 3);
    }
  });

  it('círculo → círculo igual: cilindro; cuadrado → círculo: sólido válido entre ambos', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (b) => b.circle([0, 0], 5));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, (bb) => bb.circle([0, 0], 5));
    expect(run(addFeature(doc, makeLoft(doc, [a.id, b.id]))).vol).toBeCloseTo(Math.PI * 25 * 10, 2);

    let sq: SketchFeature;
    [doc, sq] = sketch(doc, 'XY', 20, square(10));
    const r = run(addFeature(doc, makeLoft(doc, [b.id, sq.id])));
    expect(r.status).toBe('ok');
    // Entre el cilindro inscripto y el prisma circunscripto.
    expect(r.vol).toBeGreaterThan(Math.PI * 25 * 10);
    expect(r.vol).toBeLessThan(100 * 10);
  });

  it('tres secciones suaves y unión con un cuerpo existente', () => {
    let [doc, base] = sketch(emptyDocument(), 'XY', 0, square(20));
    doc = addFeature(doc, makeExtrude(doc, base.id, { distance: 5 }));
    let s1: SketchFeature;
    let s2: SketchFeature;
    let s3: SketchFeature;
    [doc, s1] = sketch(doc, 'XY', 5, square(10));
    [doc, s2] = sketch(doc, 'XY', 15, (b) => b.circle([0, 0], 3));
    [doc, s3] = sketch(doc, 'XY', 25, square(8));
    const loft = makeLoft(doc, [s1.id, s2.id, s3.id]);
    expect(loft.operation).toBe('join');
    const r = run(addFeature(doc, loft));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(1);
    expect(r.vol).toBeGreaterThan(20 * 20 * 5);
  });

  it('errores claros: una sola sección, sección con dos contornos', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, square(10));
    expect(run(addFeature(doc, makeLoft(doc, [a.id]))).error).toMatch(/al menos dos/);
    let two: SketchFeature;
    [doc, two] = sketch(doc, 'XY', 10, (b) => {
      b.circle([-10, 0], 2);
      b.circle([10, 0], 2);
    });
    expect(run(addFeature(doc, makeLoft(doc, [a.id, two.id]))).error).toMatch(/exactamente un contorno/);
  });

  it('se puede editar: cambiar a reglada recalcula', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, square(10));
    let b: SketchFeature;
    let c: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, square(4));
    [doc, c] = sketch(doc, 'XY', 20, square(10));
    const loft = makeLoft(doc, [a.id, b.id, c.id]);
    doc = addFeature(doc, loft);
    const smooth = run(doc).vol;
    const ruled = run(updateFeature<LoftFeature>(doc, loft.id, { ruled: true })).vol;
    // Reglada: dos troncos de pirámide exactos.
    expect(ruled).toBeCloseTo(2 * (10 / 3) * (100 + 16 + 40), 3);
    // Suave: el semiancho sigue la parábola por (0,5), (10,2), (20,5): h = 2 + 0,03·t², con
    // t = z − 10. Volumen = ∫(2h)² dz = 4·∫(4 + 0,12t² + 0,0009t⁴) dt de −10 a 10 = 784.
    expect(smooth).toBeCloseTo(784, 1);
  });
});

describe('guardar y abrir', () => {
  it('barrido y solevación sobreviven al archivo; datos inválidos se rechazan', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (b) => b.circle([0, 0], 5));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, (bb) => bb.circle([0, 0], 3));
    doc = addFeature(doc, makeSweep(doc, a.id, b.id, { operation: 'cut' }));
    doc = addFeature(doc, makeLoft(doc, [a.id, b.id], { ruled: true }));
    const back = parseDocument(serializeDocument(doc));
    expect(back).toEqual(doc);
    const sw = back.features[2] as SweepFeature;
    expect([sw.type, sw.profile, sw.path, sw.operation]).toEqual(['sweep', a.id, b.id, 'cut']);

    const bad = JSON.parse(serializeDocument(doc));
    bad.features[3].sections = 'nada';
    expect(() => parseDocument(JSON.stringify(bad))).toThrow(/sections: debe ser una lista/);
  });
});
