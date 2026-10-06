import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, deleteFeature, emptyDocument, makeExtrude, makePlane, makeSketch, moveBlocker, updateFeature } from '../src/document/ops';
import { constructionFrame, basePlaneFrame } from '../src/document/planes';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, PlaneFeature, PlaneReference, SketchFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { faceRefOf, type NamedShape } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const bounds = out.shape?.shape.boundingBox.bounds;
  const r = {
    statuses: out.results.map((x) => x.status),
    errors: out.results.map((x) => x.error ?? ''),
    vol: out.shape ? volume(out.shape.shape) : 0,
    min: bounds?.[0] as number[] | undefined,
    max: bounds?.[1] as number[] | undefined,
    planes: out.planes,
  };
  e.dispose();
  return r;
}

/** Plano + sketch con un cuadrado de 10 centrado sobre ese plano + extrusión de 4 mm. */
function onPlane(doc: CadDocument, plane: PlaneFeature) {
  doc = addFeature(doc, plane);
  const b = new SketchBuilder({ entities: [], constraints: [] });
  b.rectangle([-5, -5], [5, 5]);
  const sk: SketchFeature = makeSketch(doc, { plane: { kind: 'plane', plane: plane.id, offset: 0 }, ...b.data });
  doc = addFeature(doc, sk);
  return { doc: addFeature(doc, makeExtrude(doc, sk.id, { distance: 4 })), sketch: sk };
}

describe('geometría del plano de construcción', () => {
  it('girar XY 90° en X da la orientación de XZ; la distancia va sobre la nueva normal', () => {
    const xy = basePlaneFrame({ kind: 'base', plane: 'XY', offset: 0 });
    const f = constructionFrame(xy, 'X', 90, 10);
    close(f.normal, [0, -1, 0]);
    close(f.xDir, [1, 0, 0]);
    close(f.yDir, [0, 0, 1]);
    close(f.origin, [0, -10, 0]);
    // Girar alrededor de la normal no la cambia; sin eje, el ángulo se ignora.
    close(constructionFrame(xy, 'Z', 45, 0).normal, [0, 0, 1]);
    close(constructionFrame(xy, 'none', 45, 3).origin, [0, 0, 3]);
  });
});

describe('sketches sobre planos de construcción', () => {
  it('XY desplazado 15 mm: la extrusión arranca en z = 15', () => {
    const { doc } = onPlane(emptyDoc(), makePlane(emptyDoc(), { kind: 'base', plane: 'XY' }, { distance: 15 }));
    const r = run(doc);
    expect(r.statuses).toEqual(['ok', 'ok', 'ok']);
    close(r.min!, [-5, -5, 15]);
    close(r.max!, [5, 5, 19]);
  });

  it('plano girado 30° en X: el cuerpo sale inclinado y con el mismo volumen', () => {
    const plane = makePlane(emptyDoc(), { kind: 'base', plane: 'XY' }, { axis: 'X', angle: 30, distance: 0 });
    const r = run(onPlane(emptyDoc(), plane).doc);
    expect(r.statuses).toEqual(['ok', 'ok', 'ok']);
    expect(r.vol).toBeCloseTo(400, 6);
    expect(r.planes.get(plane.id)!.normal[1]).toBeCloseTo(-0.5, 9);
    // Caja girada: en Y ocupa 10·cos30 + 4·sin30 de alto.
    expect(r.max![1] - r.min![1]).toBeCloseTo(10 * Math.cos(Math.PI / 6) + 4 * Math.sin(Math.PI / 6), 6);
  });

  it('planos encadenados y planos sobre una cara del modelo', () => {
    let doc = emptyDoc();
    const p1 = makePlane(doc, { kind: 'base', plane: 'XY' }, { distance: 10 });
    doc = addFeature(doc, p1);
    const p2 = makePlane(doc, { kind: 'plane', plane: p1.id }, { distance: 5 });
    const chained = run(onPlane(doc, p2).doc);
    expect(chained.statuses.every((s) => s === 'ok')).toBe(true);
    expect(chained.min![2]).toBeCloseTo(15, 9);

    // Caja de 20 de alto: plano sobre la cara superior, a 5 mm.
    const box = build({ profile: rect(40, 30), distance: 20 });
    const top = withShape(box, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[2] - 20) < 1e-6)));
    const onFace = run(onPlane(box, makePlane(box, { kind: 'face', face: top } as PlaneReference, { distance: 5 })).doc);
    expect(onFace.statuses.every((s) => s === 'ok')).toBe(true);
    expect(onFace.max![2]).toBeCloseTo(29, 6);
    expect(onFace.vol).toBeCloseTo(40 * 30 * 20 + 400, 4);
  });

  it('cambiar la distancia mueve el sketch; borrar o suprimir el plano deja el sketch con un error claro', () => {
    const plane = makePlane(emptyDoc(), { kind: 'base', plane: 'XY' }, { distance: 15 });
    const { doc, sketch } = onPlane(emptyDoc(), plane);
    const moved = run(updateFeature<PlaneFeature>(doc, plane.id, { distance: -8 }));
    expect(moved.min![2]).toBeCloseTo(-8, 9);

    const suppressed = run(updateFeature<PlaneFeature>(doc, plane.id, { suppressed: true }));
    expect(suppressed.statuses).toEqual(['suppressed', 'error', 'error']);
    expect(suppressed.errors[1]).toMatch(/plano de construcción del sketch no está disponible/);

    const r = run(deleteFeature(doc, plane.id));
    expect(r.statuses).toEqual(['error', 'error']);
    expect(r.errors[0]).toMatch(/plano de construcción del sketch no está disponible/);
    expect(sketch.plane.kind).toBe('plane');
  });
});

describe('historial y archivo', () => {
  it('un sketch no puede subir antes de su plano, ni un plano antes de la cara que usa', () => {
    const plane = makePlane(emptyDoc(), { kind: 'base', plane: 'XY' }, { distance: 15 });
    const { doc, sketch } = onPlane(emptyDoc(), plane);
    expect(moveBlocker(doc, sketch.id, 0)).toMatch(/usa "Plano1"/);

    const box = build({ profile: rect(10, 10), distance: 10 });
    const ext = box.features[1];
    const p = makePlane(box, { kind: 'face', face: { name: `${ext.id}:end`, type: 'PLANE', center: [0, 0, 10], area: 100, normal: [0, 0, 1] } });
    const withPlane = addFeature(box, p);
    expect(moveBlocker(withPlane, p.id, 0)).toMatch(/usa "Extrusión1"/);
    expect(moveBlocker(withPlane, p.id, 1)).toMatch(/usa "Extrusión1"/);
  });

  it('se guarda y se abre igual; referencias inválidas se rechazan', () => {
    const plane = makePlane(emptyDoc(), { kind: 'base', plane: 'YZ' }, { axis: 'Z', angle: 45, distance: 3 });
    const { doc } = onPlane(emptyDoc(), plane);
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    const bad = JSON.parse(serializeDocument(doc));
    bad.features[0].reference = { kind: 'eje' };
    expect(() => parseDocument(JSON.stringify(bad))).toThrow(/reference.kind/);
    bad.features[0].reference = { kind: 'base', plane: 'XY' };
    bad.features[0].axis = 'W';
    expect(() => parseDocument(JSON.stringify(bad))).toThrow(/axis/);
  });
});

const emptyDoc = emptyDocument;

function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}
