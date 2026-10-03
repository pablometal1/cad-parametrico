import { describe, it, expect, beforeAll } from 'vitest';
import { makeBaseBox } from 'replicad';
import { initOCCT } from '../src/kernel/occt';
import { KernelService } from '../src/kernel/service';

type OC = Awaited<ReturnType<typeof initOCCT>>;
let oc: OC;

beforeAll(async () => {
  oc = await initOCCT();
}, 60_000);

describe('KernelService', () => {
  it('genera una caja con 6 caras planas y malla asociada a cada cara', async () => {
    const k = new KernelService();
    await k.init();
    const m = k.buildBox(40, 30, 20);

    expect(m.faceRanges.length).toBe(12);
    expect(m.edgeRanges.length).toBe(24);
    // Cada cara rectangular se tesela en 2 triángulos (6 índices) y los rangos cubren todos los índices sin solaparse.
    let total = 0;
    for (let i = 0; i < 6; i++) {
      expect(m.faceRanges[2 * i + 1]).toBe(6);
      total += m.faceRanges[2 * i + 1];
    }
    expect(total).toBe(m.indices.length);
    expect(new Set(Array.from({ length: 6 }, (_, i) => m.faceRanges[2 * i])).size).toBe(6);

    expect(m.bbox.min.map((v) => Math.round(v))).toEqual([-20, -15, 0]);
    expect(m.bbox.max.map((v) => Math.round(v))).toEqual([20, 15, 20]);
  });

  it('los triángulos de cada rango pertenecen geométricamente a esa cara', async () => {
    const k = new KernelService();
    await k.init();
    const m = k.buildBox(40, 30, 20);
    for (let f = 0; f < 6; f++) {
      const info = k.faceInfo(f);
      const [start, count] = [m.faceRanges[2 * f], m.faceRanges[2 * f + 1]];
      for (let j = start; j < start + count; j++) {
        const v = m.indices[j];
        const p = [m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]];
        // Todos los vértices están en el plano de la cara: (p - c) · n = 0
        const d = p.reduce((acc, pi, a) => acc + (pi - info.center[a]) * info.normal[a], 0);
        expect(Math.abs(d)).toBeLessThan(1e-4);
      }
    }
  });

  it('faceInfo da área, normal exterior y tipo de superficie', async () => {
    const k = new KernelService();
    await k.init();
    k.buildBox(40, 30, 20);
    const infos = Array.from({ length: 6 }, (_, i) => k.faceInfo(i));
    const top = infos.find((f) => Math.abs(f.center[2] - 20) < 1e-6)!;
    const bottom = infos.find((f) => Math.abs(f.center[2]) < 1e-6)!;
    expect(top.surfaceType).toBe('PLANE');
    expect(top.area).toBeCloseTo(1200, 6);
    expect(top.normal[2]).toBeCloseTo(1, 6);
    expect(bottom.normal[2]).toBeCloseTo(-1, 6);
    const side = infos.find((f) => Math.abs(f.center[0] - 20) < 1e-6)!;
    expect(side.area).toBeCloseTo(600, 6);
    expect(side.normal[0]).toBeCloseTo(1, 6);
  });

  it('rechaza dimensiones inválidas y caras fuera de rango', async () => {
    const k = new KernelService();
    await k.init();
    expect(() => k.faceInfo(0)).toThrow(/No hay sólido/);
    expect(() => k.buildBox(0, 10, 10)).toThrow(/> 0/);
    expect(() => k.buildBox(10, Number.NaN, 10)).toThrow(/> 0/);
    k.buildBox(10, 10, 10);
    expect(() => k.faceInfo(6)).toThrow(/fuera de rango/);
  });
});

// Riesgo R1 del plan: la compilación de OCCT debe exponer la historia de las operaciones,
// base de la estrategia de nombrado topológico (fase 4).
describe('historia de OCCT (R1)', () => {
  const size = (l: { Size(): number }) => l.Size();

  it('MakePrism.Generated(arista) devuelve la cara lateral', () => {
    const base = makeBaseBox(10, 10, 10).faces.find((f) => Math.abs(f.center.z) < 1e-9)!;
    const vec = new oc.gp_Vec(0, 0, 5);
    const prism = new oc.BRepPrimAPI_MakePrism(base.wrapped, vec, false, true);
    expect(prism.IsDone()).toBe(true);
    for (const e of base.edges) {
      const gen = prism.Generated(e.wrapped);
      expect(size(gen)).toBe(1);
      expect(gen.First().ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_FACE);
      gen.delete();
    }
    prism.delete();
    vec.delete();
  });

  it('BRepAlgoAPI_Fuse.Modified / IsDeleted rastrean las caras', () => {
    const a = makeBaseBox(10, 10, 10);
    const b = makeBaseBox(10, 10, 10).translate(5, 0, 0);
    const fuse = new oc.BRepAlgoAPI_Fuse(a.wrapped, b.wrapped, new oc.Message_ProgressRange());
    expect(fuse.IsDone()).toBe(true);
    expect(fuse.HasHistory()).toBe(true);
    // La cara +X de "a" queda dentro de "b": debe figurar como borrada.
    const inner = a.faces.find((f) => Math.abs(f.center.x - 5) < 1e-9)!;
    expect(fuse.IsDeleted(inner.wrapped)).toBe(true);
    // La cara superior de "a" se une con la de "b": tiene al menos un sucesor.
    const top = a.faces.find((f) => Math.abs(f.center.z - 10) < 1e-9)!;
    expect(fuse.IsDeleted(top.wrapped)).toBe(false);
    const mod = fuse.Modified(top.wrapped);
    expect(size(mod)).toBeGreaterThanOrEqual(1);
    mod.delete();
    fuse.delete();
  });

  it('BRepFilletAPI_MakeFillet.Generated(arista) devuelve la cara del redondeo', () => {
    const box = makeBaseBox(10, 10, 10);
    const fillet = new oc.BRepFilletAPI_MakeFillet(box.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    const edge = box.edges[0];
    fillet.Add(2, edge.wrapped);
    fillet.Build(new oc.Message_ProgressRange());
    expect(fillet.IsDone()).toBe(true);
    const gen = fillet.Generated(edge.wrapped);
    expect(size(gen)).toBe(1);
    gen.delete();
    fillet.delete();
  });
});
