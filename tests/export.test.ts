import { describe, it, expect, beforeAll } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { checkWatertight, meshVolume, to3MF, toBinarySTL, weldMesh } from '../src/kernel/export/meshExport';
import { KernelService } from '../src/kernel/service';
import { build, circle, rect } from './helpers';

let k: KernelService;
beforeAll(async () => {
  k = new KernelService();
  await k.init();
}, 60_000);

const PI = Math.PI;

describe('soldado de mallas', () => {
  it('un cubo teselado por cara queda con 8 vértices, cerrado y con el volumen correcto', () => {
    k.recompute(build({ profile: rect(40, 30), distance: 20 }));
    // Se usa el teselado crudo de replicad (vértices duplicados por cara).
    const raw = (k as unknown as { current: { shape: { mesh(o: object): { vertices: number[]; triangles: number[] } } } }).current.shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
    expect(raw.vertices.length / 3).toBe(24);
    const m = weldMesh(raw.vertices, raw.triangles);
    expect(m.positions.length / 3).toBe(8);
    expect(m.triangles.length / 3).toBe(12);
    expect(checkWatertight(m)).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 });
    expect(meshVolume(m)).toBeCloseTo(24000, 6);
  });

  it('quita triángulos degenerados', () => {
    const m = weldMesh([0, 0, 0, 1, 0, 0, 1e-9, 0, 0], [0, 1, 2]);
    expect(m.triangles.length).toBe(0);
  });
});

describe('exportación', () => {
  it('STL binario: cabecera, cantidad de triángulos y tamaño', async () => {
    k.recompute(build({ profile: rect(40, 30), distance: 20 }));
    const r = await k.exportModel('stl', 'medium');
    expect(r.extension).toBe('stl');
    expect(r.triangles).toBe(12);
    expect(r.openEdges).toBe(0);
    const view = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    expect(view.getUint32(80, true)).toBe(12);
    expect(r.data.byteLength).toBe(84 + 12 * 50);
  });

  it('3MF: zip con el modelo en mm, un objeto por cuerpo y malla cerrada', async () => {
    k.recompute(build(
      { profile: rect(10, 10), distance: 10 },
      { profile: rect(10, 10, [30, 0]), distance: 10, operation: 'new' },
    ));
    const r = await k.exportModel('3mf', 'medium');
    expect(r.bodies).toBe(2);
    expect(r.openEdges).toBe(0);
    const files = unzipSync(r.data);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const model = strFromU8(files['3D/3dmodel.model']);
    expect(model).toContain('unit="millimeter"');
    expect(model.match(/<object /g)).toHaveLength(2);
    expect(model.match(/<vertex /g)).toHaveLength(16);
    expect(model.match(/<triangle /g)).toHaveLength(24);
  });

  it('la calidad cambia la cantidad de triángulos de superficies curvas y el volumen converge', async () => {
    k.recompute(build({ profile: circle(10), distance: 20 }));
    const low = await k.exportModel('stl', 'low');
    const high = await k.exportModel('stl', 'high');
    expect(high.triangles!).toBeGreaterThan(low.triangles!);
    expect(high.openEdges).toBe(0);
    // Volumen de la malla de alta calidad cercano al cilindro exacto (< 0,1 %).
    const k2 = k as unknown as { current: { shape: { solids: { mesh(o: object): { vertices: number[]; triangles: number[] } }[] } } };
    const m = weldMesh(...((s) => [s.vertices, s.triangles] as const)(k2.current.shape.solids[0].mesh({ tolerance: 0.005, angularTolerance: 0.1 })));
    expect(Math.abs(meshVolume(m) - PI * 100 * 20) / (PI * 100 * 20)).toBeLessThan(1e-3);
  });

  it('STEP: archivo ISO-10303-21', async () => {
    k.recompute(build({ profile: rect(40, 30), distance: 20 }));
    const r = await k.exportModel('step', 'medium');
    const text = strFromU8(r.data);
    expect(text.startsWith('ISO-10303-21')).toBe(true);
    expect(text).toContain('MANIFOLD_SOLID_BREP');
  });

  it('sin sólido no se puede exportar', async () => {
    k.recompute(build());
    await expect(k.exportModel('stl', 'medium')).rejects.toThrow(/No hay/);
  });

  it('funciones puras: STL y 3MF de una malla mínima', () => {
    const tri = { positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangles: Uint32Array.from([0, 1, 2]) };
    expect(toBinarySTL([tri]).byteLength).toBe(134);
    const model = strFromU8(unzipSync(to3MF([tri], ['Pieza & "uno"']))['3D/3dmodel.model']);
    expect(model).toContain('name="Pieza &amp; &quot;uno&quot;"');
  });
});

describe('propiedades físicas', () => {
  it('volumen, área, caja y centro de masa de una caja', () => {
    k.recompute(build({ profile: rect(40, 30, [10, 0]), distance: 20 }));
    const p = k.massProperties();
    expect(p.volume).toBeCloseTo(24000, 6);
    expect(p.area).toBeCloseTo(2 * (40 * 30 + 40 * 20 + 30 * 20), 6);
    expect(p.bodies).toBe(1);
    p.center.forEach((v, i) => expect(v).toBeCloseTo([10, 0, 10][i], 6));
    expect(p.bboxMax[0] - p.bboxMin[0]).toBeCloseTo(40, 6);
  });
});

describe('masa y filamento', () => {
  it('20 cm³ de PLA ≈ 24,8 g y ≈ 8,3 m de filamento de 1,75 mm', async () => {
    const { massGrams, filamentMeters } = await import('../src/ui/PartInfo');
    expect(massGrams(20000, 1.24)).toBeCloseTo(24.8, 6);
    expect(filamentMeters(20000)).toBeCloseTo(20000 / (Math.PI * 0.875 ** 2) / 1000, 9);
    expect(filamentMeters(20000)).toBeCloseTo(8.315, 2);
  });
});

describe('medición', () => {
  const faceAt = (z: number | null, x: number | null = null) =>
    (k as unknown as { current: { shape: { faces: { center: { x: number; y: number; z: number } }[] } } }).current.shape.faces.findIndex((f) =>
      (z === null || Math.abs(f.center.z - z) < 1e-6) && (x === null || Math.abs(f.center.x - x) < 1e-6));

  it('caras opuestas, vecinas y aristas de una caja 40×30×20', () => {
    k.recompute(build({ profile: rect(40, 30), distance: 20 }));
    const top = faceAt(20);
    const bottom = faceAt(0);
    const side = faceAt(10, 20);
    const opposite = k.measure([top, bottom], []);
    expect(opposite.distance).toBeCloseTo(20, 6);
    expect(opposite.angle).toBeCloseTo(0, 6);
    expect(opposite.planeDistance).toBeCloseTo(20, 6);

    const adjacent = k.measure([top, side], []);
    expect(adjacent.distance).toBeCloseTo(0, 6);
    expect(adjacent.angle).toBeCloseTo(90, 6);
    expect(adjacent.planeDistance).toBeUndefined();

    // Dos aristas verticales opuestas en diagonal: distancia = diagonal de la base (50).
    const edges = (k as unknown as { current: { shape: { edges: { pointAt(t: number): { toTuple(): number[] } }[] } } }).current.shape.edges;
    const vertical = edges.map((e, i) => ({ i, a: e.pointAt(0).toTuple(), b: e.pointAt(1).toTuple() }))
      .filter((e) => Math.abs(e.a[0] - e.b[0]) < 1e-9 && Math.abs(e.a[1] - e.b[1]) < 1e-9);
    const e1 = vertical.find((e) => e.a[0] > 0 && e.a[1] > 0)!;
    const e2 = vertical.find((e) => e.a[0] < 0 && e.a[1] < 0)!;
    const diag = k.measure([], [e1.i, e2.i]);
    expect(diag.distance).toBeCloseTo(50, 6);
    expect(diag.angle).toBeCloseTo(0, 6);

    // Arista vertical contra la cara superior: ángulo 90° entre recta y plano.
    expect(k.measure([top], [e1.i]).angle).toBeCloseTo(90, 6);
    expect(() => k.measure([top], [])).toThrow(/dos elementos/);
  });
});
