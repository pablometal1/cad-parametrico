import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { addFeature, deleteFeature, makeExtrude, makeSketch, setRollback, setSuppressed, updateFeature } from '../src/document/ops';
import type { CadDocument, ExtrudeFeature, SketchFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { initSolver } from '../src/sketch/solver';
import { SketchBuilder } from '../src/sketch/builders';
import { build, circle, extrudeIds, profileData, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

let engine: RecomputeEngine;
afterEach(() => engine?.dispose());

function run(doc: CadDocument) {
  engine ??= new RecomputeEngine();
  const named = engine.run(doc);
  const out = { ...named, shape: named.shape?.shape ?? null };
  const ext = new Set(extrudeIds(doc));
  const extrudes = out.results.filter((r) => ext.has(r.id));
  return {
    ...out,
    volume: out.shape ? volume(out.shape) : 0,
    statuses: out.results.map((r) => r.status),
    /** Solo las extrusiones (los sketches quedan intercalados). */
    ext: extrudes,
    extStatuses: extrudes.map((r) => r.status),
  };
}

const PI = Math.PI;

describe('extrusión de sketch', () => {
  it('nueva: volumen = área × distancia', () => {
    engine = new RecomputeEngine();
    const r = run(build({ profile: rect(40, 30), distance: 20, operation: 'new' }));
    expect(r.statuses).toEqual(['ok', 'ok']);
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

    const sym = run(build({ profile: rect(10, 10), offset: 5, distance: 8, direction: 'symmetric' }));
    expect(sym.shape!.boundingBox.bounds[0][2]).toBeCloseTo(1, 6);
    expect(sym.shape!.boundingBox.bounds[1][2]).toBeCloseTo(9, 6);
  });

  it('planos XZ e YZ extruyen sobre su normal y respetan la orientación u/v', () => {
    engine = new RecomputeEngine();
    const xz = run(build({ profile: rect(10, 4, [0, 10]), plane: 'XZ', distance: 6 }));
    const [min, max] = xz.shape!.boundingBox.bounds;
    expect(max[0] - min[0]).toBeCloseTo(10, 6);
    expect(min[1]).toBeCloseTo(-6, 6); // normal de XZ = -Y
    expect(min[2]).toBeCloseTo(8, 6); // v del sketch = +Z
    expect(max[2]).toBeCloseTo(12, 6);
    engine.dispose();

    const yz = run(build({ profile: rect(10, 4), plane: 'YZ', distance: 6 }));
    const [a, b] = yz.shape!.boundingBox.bounds;
    expect(a[0]).toBeCloseTo(0, 6);
    expect(b[0]).toBeCloseTo(6, 6);
    expect(b[1] - a[1]).toBeCloseTo(10, 6);
  });

  it('perfil con agujeros y varias regiones', () => {
    engine = new RecomputeEngine();
    // Placa 40×30 con dos agujeros de r=3, más un cuadrado separado de 5×5.
    const r = run(build({
      profile: [rect(40, 30), circle(3, [-10, 0]), circle(3, [10, 0]), rect(5, 5, [40, 0])],
      distance: 2,
    }));
    expect(r.extStatuses).toEqual(['ok']);
    expect(r.volume).toBeCloseTo((1200 - 2 * PI * 9 + 25) * 2, 3);
    expect(r.shape!.solids.length).toBe(2);
  });

  it('perfil con arcos (ranura)', () => {
    engine = new RecomputeEngine();
    // Ranura: dos semicírculos de r=5 unidos por líneas, centros en x=±10.
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const p1 = b.point([-10, -5]);
    const p2 = b.point([10, -5]);
    const p3 = b.point([10, 5]);
    const p4 = b.point([-10, 5]);
    b.line(p1, p2);
    b.arc([10, 0], p2, p3);
    b.line(p3, p4);
    b.arc([-10, 0], p4, p1);
    let doc = addFeature(build(), makeSketch(build(), { ...b.data }));
    doc = addFeature(doc, makeExtrude(doc, doc.features[0].id, { distance: 3 }));
    const res = run(doc);
    expect(res.statuses).toEqual(['ok', 'ok']);
    expect(res.volume).toBeCloseTo((20 * 10 + PI * 25) * 3, 3);
  });

  it('unir: suma volúmenes y unifica caras coplanares', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(10, 10), distance: 10, operation: 'new' },
      { profile: rect(10, 10, [5, 0]), distance: 10, operation: 'join' },
    ));
    expect(r.extStatuses).toEqual(['ok', 'ok']);
    expect(r.volume).toBeCloseTo(1500, 6);
    expect(r.shape!.faces.length).toBe(6);
  });

  it('cortar: agujero pasante', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    ));
    expect(r.extStatuses).toEqual(['ok', 'ok']);
    expect(r.volume).toBeCloseTo(24000 - PI * 25 * 20, 3);
  });

  it('nuevo con sólido previo crea un segundo cuerpo', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(10, 10), distance: 10, operation: 'new' },
      { profile: rect(10, 10, [30, 0]), distance: 10, operation: 'new' },
    ));
    expect(r.shape!.solids.length).toBe(2);
    expect(r.volume).toBeCloseTo(2000, 6);
  });
});

describe('sketch en el recálculo', () => {
  it('el solver corre en el recálculo: cambiar una cota cambia el sólido', () => {
    engine = new RecomputeEngine();
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom, right] = b.rectangle([0, 0], [10, 10]);
    b.constrain({ type: 'distance', a: bottom, value: 40 });
    b.constrain({ type: 'distance', a: right, value: 30 });
    let doc = addFeature(build(), makeSketch(build(), b.data));
    doc = addFeature(doc, makeExtrude(doc, doc.features[0].id, { distance: 10 }));
    const r1 = run(doc);
    expect(r1.volume).toBeCloseTo(12000, 4);
    expect(r1.results[0].info).toMatch(/grados de libertad/);

    const sk = doc.features[0] as SketchFeature;
    const k = sk.constraints.find((c) => c.type === 'distance' && c.a === bottom)!;
    const doc2 = updateFeature<SketchFeature>(doc, sk.id, {
      constraints: sk.constraints.map((c) => (c.id === k.id ? { ...c, value: 50 } : c)),
    });
    expect(run(doc2).volume).toBeCloseTo(15000, 4);
  });

  it('informa si el sketch está totalmente definido', () => {
    engine = new RecomputeEngine();
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom, right] = b.rectangle([0, 0], [40, 30]);
    b.constrain({ type: 'distance', a: bottom, value: 40 });
    b.constrain({ type: 'distance', a: right, value: 30 });
    const corner = b.data.entities.find((e) => e.type === 'line' && e.id === bottom)!;
    b.constrain({ type: 'coincident', a: (corner as { p1: string }).p1, b: 'origin' });
    const doc = addFeature(build(), makeSketch(build(), b.data));
    expect(run(doc).results[0].info).toMatch(/^Totalmente definido · 1 perfil/);
  });

  it('restricciones en conflicto: el sketch y su extrusión quedan en error', () => {
    engine = new RecomputeEngine();
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom] = b.rectangle([0, 0], [40, 30]);
    b.constrain({ type: 'distance', a: bottom, value: 40 });
    b.constrain({ type: 'distance', a: bottom, value: 50 });
    let doc = addFeature(build(), makeSketch(build(), b.data));
    doc = addFeature(doc, makeExtrude(doc, doc.features[0].id, { distance: 10 }));
    const r = run(doc);
    expect(r.statuses).toEqual(['error', 'error']);
    expect(r.results[0].error).toMatch(/conflicto|solución/);
    expect(r.results[1].error).toMatch(/tiene errores/);
  });

  it('sketch sin perfiles cerrados, borrado o suprimido', () => {
    engine = new RecomputeEngine();
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.line([0, 0], [10, 0]);
    let doc = addFeature(build(), makeSketch(build(), b.data));
    doc = addFeature(doc, makeExtrude(doc, doc.features[0].id, { distance: 10 }));
    const open = run(doc);
    expect(open.results[0].info).toMatch(/1 abierto/);
    expect(open.results[1].error).toMatch(/no tiene perfiles cerrados/);

    const ok = build({ profile: rect(10, 10), distance: 5 });
    const sketchId = ok.features[0].id;
    expect(run(setSuppressed(ok, sketchId, true)).results[1].error).toMatch(/suprimido/);
    expect(run(deleteFeature(ok, sketchId)).results[0].error).toMatch(/borrado/);
  });

  it('más de dos curvas en un vértice da un error claro', () => {
    engine = new RecomputeEngine();
    const b = new SketchBuilder(profileData(rect(10, 10)));
    const corner = b.data.entities.find((e) => e.type === 'point')!.id;
    b.line(corner, [-10, -10]);
    const doc = addFeature(build(), makeSketch(build(), b.data));
    expect(run(doc).results[0].error).toMatch(/se unen 3 curvas/);
  });

  it('la geometría de construcción no forma perfiles', () => {
    engine = new RecomputeEngine();
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([0, 0], [10, 10], true);
    b.circle([5, 5], 2);
    let doc = addFeature(build(), makeSketch(build(), b.data));
    doc = addFeature(doc, makeExtrude(doc, doc.features[0].id, { distance: 1 }));
    expect(run(doc).volume).toBeCloseTo(PI * 4, 4);
  });
});

describe('errores por feature', () => {
  it('una feature imposible queda en error y el modelo sigue con el sólido previo', () => {
    engine = new RecomputeEngine();
    const r = run(build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: rect(10, 10), distance: 0, operation: 'join' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    ));
    expect(r.extStatuses).toEqual(['ok', 'error', 'ok']);
    expect(r.ext[1].error).toMatch(/distancia/i);
    expect(r.volume).toBeCloseTo(24000 - PI * 25 * 20, 3);
  });

  it('unir/cortar sin sólido previo, corte que no toca y corte total', () => {
    engine = new RecomputeEngine();
    const noBase = run(build({ profile: rect(10, 10), distance: 5, operation: 'cut' }));
    expect(noBase.extStatuses).toEqual(['error']);
    expect(noBase.ext[0].error).toMatch(/No hay un sólido previo/);
    expect(noBase.shape).toBeNull();
    engine.dispose();

    const miss = run(build(
      { profile: rect(10, 10), distance: 5, operation: 'new' },
      { profile: rect(2, 2, [50, 50]), distance: 5, operation: 'cut' },
    ));
    expect(miss.ext[1].error).toMatch(/no intersecta/);
    engine.dispose();

    const all = run(build(
      { profile: rect(10, 10), distance: 5, operation: 'new' },
      { profile: rect(20, 20), distance: 20, operation: 'cut', direction: 'symmetric' },
    ));
    expect(all.ext[1].error).toMatch(/elimina todo/);
    expect(all.volume).toBeCloseTo(500, 6);
  });
});

describe('suprimir y retroceder', () => {
  const base = () => build(
    { profile: rect(40, 30), distance: 20, operation: 'new' },
    { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    { profile: rect(10, 10), offset: 20, distance: 5, operation: 'join' },
  );

  it('suprimir excluye la feature sin afectar a las demás', () => {
    engine = new RecomputeEngine();
    const doc = base();
    const r = run(setSuppressed(doc, extrudeIds(doc)[1], true));
    expect(r.extStatuses).toEqual(['ok', 'suppressed', 'ok']);
    expect(r.volume).toBeCloseTo(24000 + 500, 4);
  });

  it('retroceder calcula solo hasta el marcador', () => {
    engine = new RecomputeEngine();
    const doc = base();
    const r = run(setRollback(doc, 2));
    expect(r.statuses).toEqual(['ok', 'ok', 'rolledBack', 'rolledBack', 'rolledBack', 'rolledBack']);
    expect(r.volume).toBeCloseTo(24000, 6);
    expect(run(setRollback(doc, 0)).shape).toBeNull();
  });
});

describe('cache de recálculo', () => {
  it('editar una feature recalcula solo ella y las posteriores', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
      { profile: rect(10, 10), offset: 20, distance: 5, operation: 'join' },
    );
    const first = run(doc);
    expect(first.results.every((r) => !r.cached)).toBe(true);
    expect(run(doc).results.every((r) => r.cached)).toBe(true);

    const cutId = extrudeIds(doc)[1];
    const r = run(updateFeature<ExtrudeFeature>(doc, cutId, { distance: 10 }));
    expect(r.results.map((x) => x.cached)).toEqual([true, true, true, false, false, false]);
    expect(r.volume).toBeCloseTo(24000 - PI * 25 * 5 + 500, 3);
  });

  it('renombrar no recalcula; suprimir y reactivar reutiliza la cache', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    );
    run(doc);
    const [first, cut] = extrudeIds(doc);
    expect(run(updateFeature(doc, cut, { name: 'Agujero' })).results.every((r) => r.cached)).toBe(true);

    const sup = run(setSuppressed(doc, first, true));
    expect(sup.extStatuses).toEqual(['suppressed', 'error']); // el corte se queda sin base
    const back = run(doc);
    expect(back.extStatuses).toEqual(['ok', 'ok']);
    expect(back.ext.map((x) => x.cached)).toEqual([true, false]);
  });

  it('borrar una feature libera su entrada de cache', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    );
    run(doc);
    expect(engine.cacheSize).toBe(4);
    const r = run(deleteFeature(doc, extrudeIds(doc)[1]));
    expect(engine.cacheSize).toBe(3);
    expect(r.volume).toBeCloseTo(24000, 6);
  });

  it('retroceder y avanzar reutiliza la cache', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(40, 30), distance: 20, operation: 'new' },
      { profile: circle(5), distance: 40, operation: 'cut', direction: 'symmetric' },
    );
    run(doc);
    run(setRollback(doc, 2));
    expect(run(doc).results.every((r) => r.cached)).toBe(true);
  });
});
