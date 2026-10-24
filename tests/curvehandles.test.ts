import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeCurve3d, makePatch, updateFeature } from '../src/document/ops';
import { curveSegments, handlesAfter, isStraight, moveHandle, sampleSegments, type BezierSegment } from '../src/document/curve3d';
import { DocumentFormatError, parseDocument, serializeDocument } from '../src/document/serialize';
import type { Curve3dFeature, ExtrudeFeature, Vec3 } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { KernelService } from '../src/kernel/service';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(...a);
/** ¿Los controles a los dos lados de un vértice están alineados con él (tangente continua)? */
const smoothAt = (incoming: BezierSegment, outgoing: BezierSegment) => {
  const a = sub(incoming[3], incoming[2]);
  const b = sub(outgoing[1], outgoing[0]);
  return norm(cross(a, b)) / (norm(a) * norm(b)) < 1e-9 && a[0] * b[0] + a[1] * b[1] + a[2] * b[2] > 0;
};

const SQUARE: Vec3[] = [[-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10]];

describe('geometría de los tramos', () => {
  it('sin asas y sin suavizar: tramos rectos', () => {
    const segs = curveSegments(SQUARE, true, false);
    expect(segs.length).toBe(4);
    expect(segs.every(isStraight)).toBe(true);
    expect(curveSegments(SQUARE, false, false).length).toBe(3);
  });

  it('suave: pasa por los vértices con tangente continua en cada uno', () => {
    const segs = curveSegments(SQUARE, true, true);
    expect(segs.some(isStraight)).toBe(false);
    for (let i = 0; i < 4; i++) expect(smoothAt(segs[i], segs[(i + 1) % 4])).toBe(true);
    const pts = sampleSegments(segs);
    expect(pts[0]).toEqual(SQUARE[0]);
  });

  it('mover un asa con tangente continua gira la del tramo vecino y conserva su largo', () => {
    const segs = curveSegments(SQUARE, true, true);
    const before = norm(sub(segs[1][1], segs[1][0]));
    const r = moveHandle(segs, true, 0, 1, [12, -14, 16], true);
    expect(r.touched.sort()).toEqual([0, 1]);
    expect(smoothAt(r.segs[0], r.segs[1])).toBe(true);
    expect(norm(sub(r.segs[1][1], r.segs[1][0]))).toBeCloseTo(before, 9);
    // Sin tangente continua solo cambia el tramo movido.
    expect(moveHandle(segs, true, 0, 1, [12, -14, 16], false).touched).toEqual([0]);
  });

  it('las asas guardadas son desplazamientos desde los vértices', () => {
    const segs = curveSegments(SQUARE, false, false);
    const r = moveHandle(segs, false, 1, 0, [10, -6, 18], false);
    const handles = handlesAfter(r.segs, r.touched);
    expect(handles[0]).toBeNull();
    expect(handles[2]).toBeNull();
    expect(handles[1]![0]).toEqual([0, 4, 8]);
    // Volver a armar los tramos con esas asas da lo mismo.
    expect(curveSegments(SQUARE, false, false, handles)[1]).toEqual(r.segs[1]);
  });
});

async function service() {
  const k = new KernelService();
  await k.init();
  return k;
}

function vertexAt(list: Float32Array, pos: Vec3) {
  for (let i = 0; i < list.length / 3; i++) {
    if (Math.hypot(list[3 * i] - pos[0], list[3 * i + 1] - pos[1], list[3 * i + 2] - pos[2]) < 1e-4) return i;
  }
  throw new Error(`No hay vértice en ${pos}`);
}

/** Caja 20 × 20 × 10 con una curva cerrada por las cuatro esquinas de arriba y su parche. */
async function boxPatch(curve: Partial<Curve3dFeature> = {}) {
  const k = await service();
  let doc = build({ profile: rect(20, 20), distance: 10 });
  k.recompute(doc);
  const refs = k.vertexRefs(SQUARE.map((p) => vertexAt(k.vertices(), p)));
  const c = { ...makeCurve3d(doc, refs, true), ...curve };
  doc = addFeature(doc, c);
  doc = addFeature(doc, makePatch(doc, [], { curves: [c.id], thickness: 2, operation: 'new' }));
  return { k, doc, curve: c };
}

describe('superficie por vértices con asas', () => {
  it('sin asas, el parche es una tapa plana; al levantar las asas se abomba', async () => {
    const flat = await boxPatch();
    const r0 = flat.k.recompute(flat.doc);
    expect(r0.features.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const v0 = flat.k.massProperties().volume;

    // Las dos asas de cada tramo suben 8 mm: los bordes se curvan hacia arriba.
    const up: [Vec3, Vec3] = [[0, 0, 8], [0, 0, 8]];
    const curved = await boxPatch({ handles: [up, up, up, up] });
    const r1 = curved.k.recompute(curved.doc);
    expect(r1.features.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const m1 = curved.k.massProperties();
    expect(m1.check.valid).toBe(true);
    expect(m1.volume).toBeGreaterThan(v0 + 1);
    expect(m1.bboxMax[2]).toBeGreaterThan(10 + 2 + 4);
    // El visor recibe los tramos con los controles en su lugar.
    const geo = r1.curves.find((c) => c.id === curved.curve.id)!;
    expect(geo.segments[0][1]).toEqual([-10, -10, 18]);
  });

  it('curva suave: el parche sale redondeado y válido', async () => {
    const { k, doc } = await boxPatch({ smooth: true });
    const r = k.recompute(doc);
    expect(r.features.at(-1)!.status).toBe('ok');
    expect(k.massProperties().check.valid).toBe(true);
  });

  it('las asas siguen al modelo cuando cambia su altura', async () => {
    const up: [Vec3, Vec3] = [[0, 0, 5], [0, 0, 5]];
    const { k, doc, curve } = await boxPatch({ handles: [up, null, null, null] });
    const ext = doc.features.find((f) => f.type === 'extrude') as ExtrudeFeature;
    const r = k.recompute(updateFeature<ExtrudeFeature>(doc, ext.id, { distance: 20 }));
    expect(r.features.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    const geo = r.curves.find((c) => c.id === curve.id)!;
    expect(geo.segments[0][1]).toEqual([-10, -10, 25]);
  });

  it('asas guardadas para otra cantidad de tramos: error claro', async () => {
    const { k, doc } = await boxPatch({ handles: [null, null] });
    const r = k.recompute(doc);
    expect(r.features[2].error).toMatch(/4 tramos/);
  });

  it('se guarda y se vuelve a abrir; asas mal formadas se rechazan', async () => {
    const up: [Vec3, Vec3] = [[0, 0, 5], [1, 2, 3]];
    const { doc } = await boxPatch({ smooth: true, handles: [up, null, null, null] });
    const text = serializeDocument(doc);
    expect(parseDocument(text)).toEqual(doc);
    const bad = JSON.parse(text);
    bad.features[2].handles[0] = [[0, 0, 5]];
    expect(() => parseDocument(JSON.stringify(bad))).toThrow(DocumentFormatError);
  });

  it('el parche se engrosa hacia afuera de la pieza (queda a la vista, no adentro)', async () => {
    const { k, doc } = await boxPatch();
    k.recompute(doc);
    const m = k.massProperties();
    expect(m.bodies).toBe(2);
    // La tapa de 2 mm queda arriba de la caja (z de 10 a 12), no dentro de ella.
    expect(m.bboxMax[2]).toBeCloseTo(12, 6);
  });

  it('una unión incoherente se rechaza con un mensaje claro en lugar de dejar un sólido roto', async () => {
    // Superficie alabeada por cuatro vértices alternados arriba y abajo: atraviesa la caja y
    // OCCT devuelve una unión más chica que la caja sola.
    const k = await service();
    let doc = build({ profile: rect(20, 20), distance: 10 });
    k.recompute(doc);
    const twisted: Vec3[] = [[-10, -10, 0], [10, -10, 10], [10, 10, 0], [-10, 10, 10]];
    const c = makeCurve3d(doc, k.vertexRefs(twisted.map((p) => vertexAt(k.vertices(), p))), true);
    doc = addFeature(doc, c);
    const joined = addFeature(doc, makePatch(doc, [], { curves: [c.id], operation: 'join' }));
    const r = k.recompute(joined);
    expect(r.features.at(-1)!.error ?? '').toMatch(/incoherente/);
    // Como cuerpo aparte sí sale.
    const apart = addFeature(doc, makePatch(doc, [], { curves: [c.id], operation: 'new' }));
    expect(k.recompute(apart).features.at(-1)!.status).toBe('ok');
  });
});
