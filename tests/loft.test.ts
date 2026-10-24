import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeExtrude, makeLoft, makeSketch, makeSweep, sketchesUsedBy } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { BasePlane, CadDocument, LoftFeature, SketchData, SketchFeature } from '../src/document/types';
import { area, volume } from '../src/kernel/features/measure';
import { edgeRefOf, faceRefOf, type NamedShape } from '../src/kernel/naming';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
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
  try {
    const out = e.run(doc);
    const last = out.results[out.results.length - 1];
    const shape = out.shape?.shape;
    return {
      status: last.status,
      error: last.error,
      vol: shape ? volume(shape) : 0,
      solids: shape?.solids.length ?? 0,
      faceTypes: shape?.faces.map((f) => f.geomType) ?? [],
    };
  } finally {
    e.dispose();
  }
}

function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}

const square = (s: number) => (b: SketchBuilder) => b.rectangle([-s / 2, -s / 2], [s / 2, s / 2]);

describe('solevación hasta un punto', () => {
  it('cuadrado → punto, reglada: pirámide exacta', () => {
    let [doc, base] = sketch(emptyDocument(), 'XY', 0, square(10));
    let tip: SketchFeature;
    [doc, tip] = sketch(doc, 'XY', 12, (b) => b.point([0, 0]));
    const r = run(addFeature(doc, makeLoft(doc, [base.id, tip.id], { ruled: true })));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo((100 * 12) / 3, 6);
  });

  it('punto → círculo → punto: una lente cerrada', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', -6, (b) => b.point([0, 0]));
    let mid: SketchFeature;
    let c: SketchFeature;
    [doc, mid] = sketch(doc, 'XY', 0, (b) => b.circle([0, 0], 5));
    [doc, c] = sketch(doc, 'XY', 6, (b) => b.point([0, 0]));
    const r = run(addFeature(doc, makeLoft(doc, [a.id, mid.id, c.id])));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(1);
    expect(r.vol).toBeGreaterThan(100);
    expect(r.vol).toBeLessThan(Math.PI * 25 * 12);
  });

  it('un punto en el medio no sirve', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, square(10));
    let p: SketchFeature;
    let c: SketchFeature;
    [doc, p] = sketch(doc, 'XY', 5, (b) => b.point([0, 0]));
    [doc, c] = sketch(doc, 'XY', 10, square(10));
    expect(run(addFeature(doc, makeLoft(doc, [a.id, p.id, c.id]))).error).toMatch(/primera o la última/);
  });
});

describe('solevación cerrada en anillo', () => {
  it('cuatro círculos alrededor del eje Z forman un anillo suave, sin tapas', () => {
    // Secciones en los planos verticales que contienen al eje Z, a 20 mm de él: XZ en x = ±20 y
    // YZ en y = ±20. Las normales de los planos no siguen el recorrido (dos quedan al revés).
    let [doc, s1] = sketch(emptyDocument(), 'XZ', 0, (b) => b.circle([20, 0], 3));
    let s2: SketchFeature;
    let s3: SketchFeature;
    let s4: SketchFeature;
    [doc, s2] = sketch(doc, 'YZ', 0, (b) => b.circle([20, 0], 3));
    [doc, s3] = sketch(doc, 'XZ', 0, (b) => b.circle([-20, 0], 3));
    [doc, s4] = sketch(doc, 'YZ', 0, (b) => b.circle([-20, 0], 3));
    const r = run(addFeature(doc, makeLoft(doc, [s1.id, s2.id, s3.id, s4.id], { closed: true })));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(1);
    expect(r.faceTypes.every((t) => t === 'BSPLINE_SURFACE')).toBe(true);
    // Toro de radios 20 y 3 = 3553 mm³; con solo cuatro secciones la curva central se abomba un poco.
    expect(r.vol).toBeGreaterThan(3400);
    expect(r.vol).toBeLessThan(4000);
  });

  it('con dos secciones no se puede cerrar', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, square(10));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, square(6));
    expect(run(addFeature(doc, makeLoft(doc, [a.id, b.id], { closed: true }))).error).toMatch(/al menos tres/);
  });
});

describe('solevación de curvas abiertas (superficie engrosada)', () => {
  it('dos rectas paralelas: una pared plana del espesor pedido', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (b) => b.line([0, 0], [20, 0]));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, (bb) => bb.line([0, 0], [20, 0]));
    const r = run(addFeature(doc, makeLoft(doc, [a.id, b.id], { thickness: 2 })));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(20 * 10 * 2, 4);
  });

  it('curvas NURBS en tres alturas: una chapa curva', () => {
    const wave = (dy: number) => (b: SketchBuilder) => b.spline([[0, 0], [10, 8 + dy], [20, -6], [30, 0]], false, false, { kind: 'control' });
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, wave(0));
    let b: SketchFeature;
    let c: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, wave(6));
    [doc, c] = sketch(doc, 'XY', 20, wave(-4));
    const r = run(addFeature(doc, makeLoft(doc, [a.id, b.id, c.id], { thickness: 1.5 })));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(1);
    // Más que una pared recta de 30 × 20 × 1,5 (la curva es más larga que su cuerda).
    expect(r.vol).toBeGreaterThan(30 * 20 * 1.5);
  });

  it('sin espesor: una superficie (como en Plasticity); mezclando abiertas y cerradas, error claro', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (b) => b.line([0, 0], [20, 0]));
    let b: SketchFeature;
    let sq: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, (bb) => bb.line([0, 0], [20, 0]));
    [doc, sq] = sketch(doc, 'XY', 20, square(10));
    const sheet = run(addFeature(doc, makeLoft(doc, [a.id, b.id])));
    expect(sheet.status).toBe('ok');
    expect(sheet.solids).toBe(0);
    expect(sheet.faceTypes.length).toBe(1);
    expect(run(addFeature(doc, makeLoft(doc, [a.id, sq.id], { thickness: 1 }))).error).toMatch(/todas contornos cerrados/);
  });

  it('«solo superficie» con contornos cerrados: un tubo sin tapas', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (b) => b.circle([0, 0], 5));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, (bb) => bb.circle([0, 0], 3));
    const r = run(addFeature(doc, makeLoft(doc, [a.id, b.id], { surface: true })));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(0);
    expect(r.faceTypes.every((t) => t !== 'PLANE')).toBe(true);
  });
});

describe('solevación desde una cara del modelo', () => {
  it('de la cara de arriba de un bloque a un círculo, unida al bloque', () => {
    let [doc, base] = sketch(emptyDocument(), 'XY', 0, square(20));
    doc = addFeature(doc, makeExtrude(doc, base.id, { distance: 5 }));
    let top: SketchFeature;
    [doc, top] = sketch(doc, 'XY', 20, (b) => b.circle([0, 0], 4));
    const face = withShape(doc, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[2] - 5) < 1e-6)));
    const r = run(addFeature(doc, makeLoft(doc, [{ face }, top.id], { ruled: true, operation: 'join' })));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(1);
    // Bloque (2000) más una transición entre un cuadrado de 400 mm² y un círculo de 50 mm² en 15 mm.
    expect(r.vol).toBeGreaterThan(2000 + 15 * 50);
    expect(r.vol).toBeLessThan(2000 + 15 * 400);
  });
});

describe('solevación con trayectoria central', () => {
  it('dos círculos a lo largo de una recta: tronco de cono', () => {
    let [doc, a] = sketch(emptyDocument(), 'YZ', 0, (b) => b.circle([0, 0], 3));
    let b: SketchFeature;
    let spine: SketchFeature;
    [doc, b] = sketch(doc, 'YZ', 30, (bb) => bb.circle([0, 0], 1.5));
    [doc, spine] = sketch(doc, 'XY', 0, (bb) => bb.line([0, 0], [30, 0]));
    const loft = makeLoft(doc, [a.id, b.id], { spine: spine.id });
    const r = run(addFeature(doc, loft));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo((Math.PI / 3) * 30 * (9 + 4.5 + 2.25), 0);
    // La trayectoria es una dependencia: no se puede mover antes que la solevación sin avisar.
    expect(sketchesUsedBy(loft)).toEqual([a.id, b.id, spine.id]);
  });

  it('por un arco: sigue la curva', () => {
    let [doc, a] = sketch(emptyDocument(), 'YZ', 0, (b) => b.circle([0, 0], 2));
    let b: SketchFeature;
    let spine: SketchFeature;
    // Arco de radio 20 con centro (0, 20) del origen a (20, 20): termina mirando hacia +Y.
    [doc, b] = sketch(doc, 'XZ', -20, (bb) => bb.rectangle([18.5, -1.5], [21.5, 1.5]));
    [doc, spine] = sketch(doc, 'XY', 0, (bb) => bb.arc([0, 20], [0, 0], [20, 20]));
    const r = run(addFeature(doc, makeLoft(doc, [a.id, b.id], { spine: spine.id })));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(1);
    // Entre un círculo (12,6 mm²) y un cuadrado (9 mm²) a lo largo de 31,4 mm.
    expect(r.vol).toBeGreaterThan(9 * 31.4 * 0.9);
    expect(r.vol).toBeLessThan(12.6 * 31.4 * 1.1);
  });

  it('una solevación con trayectoria no se cierra en anillo', () => {
    let [doc, a] = sketch(emptyDocument(), 'YZ', 0, (b) => b.circle([0, 0], 3));
    let b: SketchFeature;
    let c: SketchFeature;
    let spine: SketchFeature;
    [doc, b] = sketch(doc, 'YZ', 10, (bb) => bb.circle([0, 0], 2));
    [doc, c] = sketch(doc, 'YZ', 20, (bb) => bb.circle([0, 0], 3));
    [doc, spine] = sketch(doc, 'XY', 0, (bb) => bb.line([0, 0], [20, 0]));
    expect(run(addFeature(doc, makeLoft(doc, [a.id, b.id, c.id], { spine: spine.id, closed: true }))).error).toMatch(/no se puede cerrar/);
  });
});

describe('splines como trayectoria de barrido', () => {
  it('un círculo barrido por una NURBS y por una spline por puntos', () => {
    for (const kind of ['control', 'fit'] as const) {
      let [doc, profile] = sketch(emptyDocument(), 'YZ', 0, (b) => b.circle([0, 0], 1));
      let path: SketchFeature;
      [doc, path] = sketch(doc, 'XY', 0, (b) => b.spline([[0, 0], [10, 0], [20, 8], [30, 0]], false, false, { kind }));
      const r = run(addFeature(doc, makeSweep(doc, profile.id, path.id)));
      expect(r.status, kind).toBe('ok');
      // Sale tangente al eje X (perpendicular al perfil). Pappus: área del círculo por el largo
      // de la curva, que es más que la cuerda de 30 mm.
      expect(r.vol, kind).toBeGreaterThan(Math.PI * 30);
      expect(r.vol, kind).toBeLessThan(Math.PI * 45);
    }
  });

  it('línea + NURBS unidas en una sola cadena', () => {
    let [doc, profile] = sketch(emptyDocument(), 'YZ', 0, (b) => b.circle([0, 0], 1));
    let path: SketchFeature;
    [doc, path] = sketch(doc, 'XY', 0, (b) => {
      const l = b.line([0, 0], [10, 0]);
      const line = b.data.entities.find((e) => e.id === l);
      if (line?.type !== 'line') throw new Error();
      b.spline([line.p2, [20, 0], [25, 10], [30, 10]], false, false, { kind: 'control' });
    });
    expect(run(addFeature(doc, makeSweep(doc, profile.id, path.id))).status).toBe('ok');
  });
});

describe('guardar y abrir', () => {
  it('secciones de cara, anillo, trayectoria y espesor sobreviven al archivo', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, square(10));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 10, square(6));
    const face = { name: 'f1:end', type: 'PLANE', center: [0, 0, 5] as [number, number, number], area: 100, normal: [0, 0, 1] as [number, number, number] };
    doc = addFeature(doc, makeLoft(doc, [{ face }, a.id, b.id], { closed: true, spine: b.id, thickness: 2 }));
    const back = parseDocument(serializeDocument(doc));
    expect(back).toEqual(doc);
    const loft = back.features.at(-1) as LoftFeature;
    expect(loft.sections[0]).toEqual({ face });
  });
});

describe('solevación entre aristas y caras del modelo (con continuidad)', () => {
  /** Dos bloques de 20 × 20 × 10 separados: x de −30 a −10 y de 10 a 30. */
  function twoBlocks() {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (b) => b.rectangle([-30, -10], [-10, 10]));
    doc = addFeature(doc, makeExtrude(doc, a.id, { distance: 10 }));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 0, (bb) => bb.rectangle([10, -10], [30, 10]));
    return addFeature(doc, makeExtrude(doc, b.id, { distance: 10, operation: 'new' }));
  }
  const edgeAt = (s: NamedShape, x: number, z: number) =>
    edgeRefOf(s, s.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[0] - x) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2] - z) < 1e-6;
    }));
  const faceAt = (s: NamedShape, x: number) =>
    faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[0] - x) < 1e-6));

  it('aristas de dos cuerpos: una superficie puente; con continuidad sale tangente a la tapa', () => {
    const doc = twoBlocks();
    const [ea, eb] = withShape(doc, (s) => [edgeAt(s, -10, 10), edgeAt(s, 10, 10)]);
    const plain = run(addFeature(doc, makeLoft(doc, [{ edges: [ea] }, { edges: [eb] }])));
    expect(plain.error ?? plain.status).toBe('ok');
    expect(plain.solids).toBe(2);
    const smooth = addFeature(doc, makeLoft(doc, [{ edges: [ea] }, { edges: [eb] }], { continuity: true }));
    const r = run(smooth);
    expect(r.status).toBe('ok');
    expect(r.faceTypes.filter((t) => t === 'BSPLINE_SURFACE').length).toBe(1);
    // La tangente continúa una cara del bloque (la tapa: horizontal hacia el otro bloque), así que
    // cerca de la arista la superficie es casi horizontal.
    withShape(smooth, (s) => {
      const sheet = s.shape.faces.find((f) => f.geomType === 'BSPLINE_SURFACE')!;
      const p = sheet.pointOnSurface(0.5, 0.02);
      const n = sheet.normalAt(p).toTuple();
      expect(Math.abs(n[2])).toBeGreaterThan(0.9);
    });
  });

  it('cara a cara con continuidad: un sólido que sigue las paredes y se une a los dos bloques', () => {
    const doc = twoBlocks();
    const [fa, fb] = withShape(doc, (s) => [faceAt(s, -10), faceAt(s, 10)]);
    const r = run(addFeature(doc, makeLoft(doc, [{ face: fa }, { face: fb }], { continuity: true, operation: 'join' })));
    expect(r.error ?? r.status).toBe('ok');
    expect(r.solids).toBe(1);
    // Bloques alineados: continuar sus paredes da un puente recto de 20 × 10 × 20 entre ellos.
    expect(r.vol).toBeCloseTo(2 * 4000 + 4000, 3);
  });

  it('se guarda y se vuelve a abrir con secciones de aristas', () => {
    const doc = twoBlocks();
    const [ea, eb] = withShape(doc, (s) => [edgeAt(s, -10, 10), edgeAt(s, 10, 10)]);
    const d = addFeature(doc, makeLoft(doc, [{ edges: [ea] }, { edges: [eb] }], { continuity: true, surface: true }));
    expect(parseDocument(serializeDocument(d))).toEqual(d);
  });

  it('más de dos secciones de aristas: la superficie pasa por todas', () => {
    let doc = twoBlocks();
    // Un tercer bloque más alto, más lejos en X.
    let c: SketchFeature;
    [doc, c] = sketch(doc, 'XY', 0, (bb) => bb.rectangle([50, -10], [70, 10]));
    doc = addFeature(doc, makeExtrude(doc, c.id, { distance: 20, operation: 'new' }));
    const [e1, e2, e3] = withShape(doc, (s) => [edgeAt(s, -10, 10), edgeAt(s, 10, 10), edgeAt(s, 50, 20)]);
    const r = run(addFeature(doc, makeLoft(doc, [{ edges: [e1] }, { edges: [e2] }, { edges: [e3] }], { continuity: true })));
    expect(r.error ?? r.status).toBe('ok');
    expect(r.solids).toBe(3);
    expect(r.faceTypes.filter((t) => t === 'BSPLINE_SURFACE').length).toBeGreaterThanOrEqual(1);
  });

  it('tensión: más tensión sigue más a la cara antes de curvarse; el visor recibe una flecha por extremo', async () => {
    // Segundo bloque más alto: el puente tiene que hacer una S.
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (bb) => bb.rectangle([-30, -10], [-10, 10]));
    doc = addFeature(doc, makeExtrude(doc, a.id, { distance: 10 }));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 15, (bb) => bb.rectangle([10, -10], [30, 10]));
    doc = addFeature(doc, makeExtrude(doc, b.id, { distance: 10, operation: 'new' }));
    const [fa, fb] = withShape(doc, (s) => [faceAt(s, -10), faceAt(s, 10)]);
    // El volumen no cambia (cada corte es el mismo rectángulo corrido); el área de la S sí.
    const areaOf = (t: number) => withShape(addFeature(doc, makeLoft(doc, [{ face: fa }, { face: fb }], { continuity: true, operation: 'new', tensionStart: t, tensionEnd: t })), (s) => area(s.shape));
    const [soft, hard] = [areaOf(0.5), areaOf(2)];
    expect(soft).toBeGreaterThan(0);
    expect(Math.abs(hard - soft)).toBeGreaterThan(20);

    const { KernelService } = await import('../src/kernel/service');
    const k = new KernelService();
    await k.init();
    const loft = makeLoft(doc, [{ face: fa }, { face: fb }], { continuity: true, operation: 'new' });
    k.recompute(addFeature(doc, loft));
    const handles = k.manipulator(loft.id);
    expect(handles.map((h) => (h.kind === 'linear' ? h.param : ''))).toEqual(['tensionStart', 'tensionEnd']);
    const start = handles[0];
    if (start.kind !== 'linear') throw new Error();
    // Sale de la cara del primer bloque hacia +X (continuando sus paredes).
    expect(start.dir[0]).toBeGreaterThan(0.99);
    expect(start.value).toBe(1);
  });

  it('puente entre aristas a distinta altura: sin sobrepaso (no baja de la tapa baja ni sube de la alta)', () => {
    let [doc, a] = sketch(emptyDocument(), 'XY', 0, (bb) => bb.rectangle([-30, -10], [-10, 10]));
    doc = addFeature(doc, makeExtrude(doc, a.id, { distance: 10 }));
    let b: SketchFeature;
    [doc, b] = sketch(doc, 'XY', 15, (bb) => bb.rectangle([10, -10], [30, 10]));
    doc = addFeature(doc, makeExtrude(doc, b.id, { distance: 10, operation: 'new' }));
    const [ea, eb] = withShape(doc, (s) => [edgeAt(s, -10, 10), edgeAt(s, 10, 25)]);
    const d = addFeature(doc, makeLoft(doc, [{ edges: [ea] }, { edges: [eb] }], { continuity: true }));
    expect(run(d).error ?? 'ok').toBe('ok');
    withShape(d, (s) => {
      const sheet = s.shape.faces.find((f) => f.geomType === 'BSPLINE_SURFACE')!;
      const [lo, hi] = sheet.boundingBox.bounds;
      expect(lo[2]).toBeGreaterThan(10 - 0.05);
      expect(hi[2]).toBeLessThan(25 + 0.05);
    });
  });

  it('la tensión se puede fijar aunque la solevación todavía no la tenga (arrastrando la flecha)', async () => {
    const { setFieldValue } = await import('../src/document/evaluate');
    const loft = makeLoft(emptyDocument(), ['a', 'b']);
    expect(setFieldValue(loft, 'tensionStart', 2).tensionStart).toBe(2);
    expect(() => setFieldValue(loft, 'inventado', 2)).toThrow();
  });
});
