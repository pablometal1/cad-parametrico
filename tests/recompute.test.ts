import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { addFeature, deleteFeature, emptyDocument, makeExtrude, setRollback, setSuppressed, updateFeature } from '../src/document/ops';
import type { CadDocument, ExtrudeFeature, Profile } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/extrude';

beforeAll(async () => {
  await initOCCT();
}, 60_000);

let engine: RecomputeEngine;
afterEach(() => engine?.dispose());

const rect = (width: number, height: number, extra: Partial<Profile> = {}): Profile =>
  ({ kind: 'rectangle', plane: 'XY', offset: 0, center: [0, 0], width, height, ...extra }) as Profile;
const circle = (radius: number, extra: Partial<Profile> = {}): Profile =>
  ({ kind: 'circle', plane: 'XY', offset: 0, center: [0, 0], radius, ...extra }) as Profile;

function build(...specs: Partial<Omit<ExtrudeFeature, 'type'>>[]): CadDocument {
  let doc = emptyDocument();
  for (const s of specs) doc = addFeature(doc, makeExtrude(doc, s));
  return doc;
}

function run(doc: CadDocument) {
  engine ??= new RecomputeEngine();
  const out = engine.run(doc);
  return { ...out, volume: out.shape ? volume(out.shape) : 0, statuses: out.results.map((r) => r.status) };
}

const PI = Math.PI;

describe('extrusión', () => {
  it('nueva: volumen = área × distancia', () => {
    engine = new RecomputeEngine();
    const r = run(build({ profile: rect(40, 30), distance: 20, operation: 'new' }));
    expect(r.statuses).toEqual(['ok']);
    expect(r.volume).toBeCloseTo(24000, 6);
    expect(r.shape!.faces.length).toBe(6);
  });

  it('círculo, sentido invertido y simétrico quedan en la posición correcta', () => {
    engine = new RecomputeEngine();
    const normal = run(build({ profile: circle(5), distance: 10 }));
    expect(normal.volume).toBeCloseTo(PI * 25 * 10, 4);
    expect(normal.shape!.boundingBox.bounds[0][2]).toBeCloseTo(0, 6);
    expect(normal.shape!.boundingBox.bounds[1][2]).toBeCloseTo(10, 6);
    engine.dispose();

    const rev = run(build({ profile: rect(10, 10), distance: 8, direction: 'reversed' }));
    expect(rev.shape!.boundingBox.bounds[0][2]).toBeCloseTo(-8, 6);
    expect(rev.shape!.boundingBox.bounds[1][2]).toBeCloseTo(0, 6);
    engine.dispose();

    const sym = run(build({ profile: rect(10, 10, { offset: 5 }), distance: 8, direction: 'symmetric' }));
    expect(sym.shape!.boundingBox.bounds[0][2]).toBeCloseTo(1, 6);
    expect(sym.shape!.boundingBox.bounds[1][2]).toBeCloseTo(9, 6);
  });

  it('planos XZ e YZ extruyen sobre su normal', () => {
    engine = new RecomputeEngine();
    const xz = run(build({ profile: rect(10, 4, { plane: 'XZ' }), distance: 6 }));
    const [min, max] = xz.shape!.boundingBox.bounds;
    expect(max[0] - min[0]).toBeCloseTo(10, 6);
    expect(Math.abs(max[1] - min[1])).toBeCloseTo(6, 6);
    expect(max[2] - min[2]).toBeCloseTo(4, 6);
    engine.dispose();

    const yz = run(build({ profile: rect(10, 4, { plane: 'YZ' }), distance: 6 }));
    const [a, b] = yz.shape!.boundingBox.bounds;
    expect(b[0] - a[0]).toBeCloseTo(6, 6);
  });

  it('unir: suma volúmenes y unifica caras coplanares', () => {
    engine = new RecomputeEngine();
    // Dos cajas 10×10×10 que se solapan 5 mm en X → 15×10×10.
    const r = run(build(
      { profile: rect(10, 10), distance: 10, operation: 'new' },
      { profile: rect(10, 10, { center: [5, 0] }), distance: 10, operation: 'join' },
    ));
    expect(r.statuses).toEqual(['ok', 'ok']);
    expect(r.volume).toBeCloseTo(1500, 6);
    expect(r.shape!.faces.length).toBe(6); // sin costuras gracias a SimplifyResult
  });

  it('cortar: agujero pasante', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    ));
    expect(r.statuses).toEqual(['ok', 'ok']);
    expect(r.volume).toBeCloseTo(24000 - PI * 25 * 20, 3);
  });

  it('nuevo con sólido previo crea un segundo cuerpo', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(10, 10), distance: 10, operation: 'new' },
      { profile: rect(10, 10, { center: [30, 0] }), distance: 10, operation: 'new' },
    ));
    expect(r.shape!.solids.length).toBe(2);
    expect(r.volume).toBeCloseTo(2000, 6);
  });
});

describe('errores por feature', () => {
  it('una feature imposible queda en error y el modelo sigue con el sólido previo', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: rect(10, 10), distance: 0, operation: 'join' }, // distancia inválida
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    ));
    expect(r.statuses).toEqual(['ok', 'error', 'ok']);
    expect(r.results[1].error).toMatch(/distancia/i);
    expect(r.volume).toBeCloseTo(24000 - PI * 25 * 20, 3);
  });

  it('unir/cortar sin sólido previo, corte que no toca y corte total', () => {
    engine = new RecomputeEngine();
    const noBase = run(build({ profile: rect(10, 10), distance: 5, operation: 'cut' }));
    expect(noBase.statuses).toEqual(['error']);
    expect(noBase.results[0].error).toMatch(/No hay un sólido previo/);
    expect(noBase.shape).toBeNull();
    engine.dispose();

    const miss = run(build(
      { profile: rect(10, 10), distance: 5, operation: 'new' },
      { profile: rect(2, 2, { center: [50, 50] }), distance: 5, operation: 'cut' },
    ));
    expect(miss.results[1].error).toMatch(/no intersecta/);
    engine.dispose();

    const all = run(build(
      { profile: rect(10, 10), distance: 5, operation: 'new' },
      { profile: rect(20, 20), distance: 20, operation: 'cut', direction: 'symmetric' },
    ));
    expect(all.results[1].error).toMatch(/elimina todo/);
    expect(all.volume).toBeCloseTo(500, 6);
  });

  it('perfil con dimensiones inválidas', () => {
    engine = new RecomputeEngine();
    const r = run(build({ profile: circle(-1), distance: 5 }));
    expect(r.results[0].error).toMatch(/radio/);
  });
});

describe('suprimir y retroceder', () => {
  const base = () => build(
    { profile: rect(40, 30), distance: 20, operation: 'new' },
    { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    { profile: rect(10, 10, { offset: 20 }), distance: 5, operation: 'join' },
  );

  it('suprimir excluye la feature sin afectar a las demás', () => {
    engine = new RecomputeEngine();
    const doc = base();
    const r = run(setSuppressed(doc, doc.features[1].id, true));
    expect(r.statuses).toEqual(['ok', 'suppressed', 'ok']);
    expect(r.volume).toBeCloseTo(24000 + 500, 4);
  });

  it('retroceder calcula solo hasta el marcador', () => {
    engine = new RecomputeEngine();
    const doc = base();
    const r = run(setRollback(doc, 1));
    expect(r.statuses).toEqual(['ok', 'rolledBack', 'rolledBack']);
    expect(r.volume).toBeCloseTo(24000, 6);
    const r0 = run(setRollback(doc, 0));
    expect(r0.shape).toBeNull();
  });
});

describe('cache de recálculo', () => {
  it('editar una feature recalcula solo ella y las posteriores', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
      { profile: rect(10, 10, { offset: 20 }), distance: 5, operation: 'join' },
    );
    const first = run(doc);
    expect(first.results.map((r) => r.cached)).toEqual([false, false, false]);

    const again = run(doc);
    expect(again.results.map((r) => r.cached)).toEqual([true, true, true]);
    expect(again.volume).toBeCloseTo(first.volume, 9);

    const edited = updateFeature<ExtrudeFeature>(doc, doc.features[1].id, { profile: circle(3) });
    const r = run(edited);
    expect(r.results.map((x) => x.cached)).toEqual([true, false, false]);
    expect(r.volume).toBeCloseTo(24000 - PI * 9 * 20 + 500, 3);
  });

  it('renombrar no recalcula; suprimir y reactivar reutiliza la cache', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    );
    run(doc);
    const renamed = updateFeature(doc, doc.features[1].id, { name: 'Agujero' });
    expect(run(renamed).results.map((r) => r.cached)).toEqual([true, true]);

    const sup = setSuppressed(doc, doc.features[0].id, true);
    const rs = run(sup);
    expect(rs.statuses).toEqual(['suppressed', 'error']); // el corte se queda sin base
    const back = run(doc);
    expect(back.results.map((r) => r.cached)).toEqual([true, false]);
    expect(back.statuses).toEqual(['ok', 'ok']);
  });

  it('borrar una feature libera su entrada de cache', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    );
    run(doc);
    expect(engine.cacheSize).toBe(2);
    const r = run(deleteFeature(doc, doc.features[1].id));
    expect(engine.cacheSize).toBe(1);
    expect(r.volume).toBeCloseTo(24000, 6);
  });

  it('retroceder y avanzar reutiliza la cache', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    );
    run(doc);
    run(setRollback(doc, 1));
    expect(run(doc).results.map((r) => r.cached)).toEqual([true, true]);
  });
});
