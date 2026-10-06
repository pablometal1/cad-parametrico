import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  addFeature, deleteFeature, makeChamfer, makeExtrude, makeFillet, makeRevolve, makeShell, makeSketch, setRollback, updateFeature,
} from '../src/document/ops';
import type { CadDocument, EdgeRef, ExtrudeFeature, FaceRef, FilletFeature, RevolveFeature, SketchFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { edgeNames, edgeRefOf, faceRefOf, type NamedShape } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, circle, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

let engine: RecomputeEngine;
afterEach(() => engine?.dispose());
const run = (doc: CadDocument) => {
  const out = engine.run(doc);
  return { ...out, volume: out.shape ? volume(out.shape.shape) : 0, statuses: out.results.map((r) => r.status) };
};

const PI = Math.PI;

/** Caja 40×30×20 centrada en XY, apoyada en z=0. */
const boxDoc = () => build({ profile: rect(40, 30), distance: 20 });
const extrudeOf = (doc: CadDocument) => doc.features.find((f) => f.type === 'extrude') as ExtrudeFeature;

/** Busca la arista cuyo punto medio está cerca de `p`. */
function edgeAt(shape: NamedShape, p: [number, number, number]): EdgeRef {
  const edges = shape.shape.edges;
  const i = edges.findIndex((e) => {
    const m = e.pointAt(0.5).toTuple();
    return Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]) < 1e-6;
  });
  if (i < 0) throw new Error(`No hay arista en ${p}`);
  return edgeRefOf(shape, i);
}

/** Busca la cara plana cuyo centro está cerca de `p`. */
function faceAt(shape: NamedShape, p: [number, number, number]): FaceRef {
  const i = shape.shape.faces.findIndex((f) => {
    const c = f.center.toTuple();
    return Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 1e-6;
  });
  if (i < 0) throw new Error(`No hay cara en ${p}`);
  return faceRefOf(shape, i);
}

/** Volumen que quita un redondeo de radio r en una arista recta de longitud L. */
const filletLoss = (r: number, L: number) => (r * r - (PI * r * r) / 4) * L;

describe('nombres generados', () => {
  it('las caras de una extrusión se nombran por la curva del sketch y por inicio/fin', () => {
    engine = new RecomputeEngine();
    const doc = boxDoc();
    const out = run(doc);
    const names = out.shape!.names.map((n) => n[0].replace(/f_[0-9a-f]{12}/, 'F'));
    expect(names.sort()).toEqual(['F:end', 'F:side:l1', 'F:side:l2', 'F:side:l3', 'F:side:l4', 'F:start']);
  });

  it('los nombres de aristas son únicos en una caja y estables entre recálculos', () => {
    engine = new RecomputeEngine();
    const doc = boxDoc();
    const a = edgeNames(run(doc).shape!).names;
    expect(new Set(a).size).toBe(12);
    const engine2 = new RecomputeEngine();
    const b = edgeNames(engine2.run(doc).shape!).names;
    engine2.dispose();
    expect(b).toEqual(a);
  });

  it('una unión con caras coplanares conserva los nombres de ambos lados', () => {
    engine = new RecomputeEngine();
    const doc = build(
      { profile: rect(10, 10), distance: 10 },
      { profile: rect(10, 10, [5, 0]), distance: 10, operation: 'join' },
    );
    const out = run(doc);
    expect(out.shape!.shape.faces.length).toBe(6);
    const top = out.shape!.names[out.shape!.shape.faces.findIndex((f) => Math.abs(f.center.z - 10) < 1e-9)];
    expect(top.length).toBe(2); // la cara superior unificada tiene el nombre de las dos extrusiones
  });
});

describe('referencias que sobreviven al recálculo', () => {
  it('redondeo: la arista sigue encontrándose al cambiar la altura y el ancho de la caja', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    // Arista superior delantera (y = -15, z = 20), de longitud 40.
    const ref = edgeAt(run(doc).shape!, [0, -15, 20]);
    doc = addFeature(doc, makeFillet(doc, [ref], 3));
    const r1 = run(doc);
    expect(r1.statuses).toEqual(['ok', 'ok', 'ok']);
    expect(r1.volume).toBeCloseTo(24000 - filletLoss(3, 40), 3);

    // Más alta: la arista se movió a z = 30 pero conserva su nombre.
    const ext = extrudeOf(doc);
    const taller = updateFeature<ExtrudeFeature>(doc, ext.id, { distance: 30 });
    const r2 = run(taller);
    expect(r2.statuses).toEqual(['ok', 'ok', 'ok']);
    expect(r2.volume).toBeCloseTo(36000 - filletLoss(3, 40), 3);

    // Más ancha: la arista mide 60 y el redondeo la sigue.
    const sk = doc.features[0] as SketchFeature;
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([-30, -15], [30, 15]);
    const wider = updateFeature<SketchFeature>(taller, sk.id, b.data);
    const r3 = run(wider);
    expect(r3.statuses).toEqual(['ok', 'ok', 'ok']);
    expect(r3.volume).toBeCloseTo(60 * 30 * 30 - filletLoss(3, 60), 3);
  });

  it('insertar una feature antes no rompe la referencia (agujero en la cara superior)', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const ref = edgeAt(run(doc).shape!, [0, -15, 20]);
    doc = addFeature(doc, makeFillet(doc, [ref], 3));
    // Retrocedo antes del redondeo e inserto un agujero pasante.
    doc = setRollback(doc, 2);
    const hole = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, entities: [], constraints: [] });
    const hb = new SketchBuilder({ entities: [], constraints: [] });
    hb.circle([0, 0], 5);
    doc = addFeature(doc, { ...hole, ...hb.data });
    doc = addFeature(doc, makeExtrude(doc, hole.id, { operation: 'cut', distance: 50, direction: 'symmetric' }));
    doc = setRollback(doc, null);
    const r = run(doc);
    expect(r.statuses).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(r.volume).toBeCloseTo(24000 - PI * 25 * 20 - filletLoss(3, 40), 3);
  });

  it('sketch sobre una cara: sigue a la cara cuando la caja cambia de altura', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const top = faceAt(run(doc).shape!, [0, 0, 20]);
    expect(top.normal).toEqual([0, 0, 1]);
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.circle([0, 0], 5);
    const sk = makeSketch(doc, { plane: { kind: 'face', face: top, offset: 0 }, ...b.data });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 10, operation: 'join' }));
    const r1 = run(doc);
    expect(r1.statuses).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r1.shape!.shape.boundingBox.bounds[1][2]).toBeCloseTo(30, 6);
    expect(r1.sketches.get(sk.id)!.reference.length).toBe(4 * 4); // contorno: 4 segmentos (u,v,u,v)

    const r2 = run(updateFeature<ExtrudeFeature>(doc, extrudeOf(doc).id, { distance: 35 }));
    expect(r2.statuses).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r2.shape!.shape.boundingBox.bounds[1][2]).toBeCloseTo(45, 6);
    expect(r2.volume).toBeCloseTo(40 * 30 * 35 + PI * 25 * 10, 3);
  });

  it('referencia perdida: error claro y el modelo sigue', () => {
    engine = new RecomputeEngine();
    let doc = build(
      { profile: rect(40, 30), distance: 20 },
      { profile: rect(10, 10), offset: 20, distance: 10, operation: 'join' },
    );
    // Arista superior del bloque agregado (z = 30).
    const ref = edgeAt(run(doc).shape!, [0, -5, 30]);
    doc = addFeature(doc, makeFillet(doc, [ref], 1));
    expect(run(doc).statuses.at(-1)).toBe('ok');
    // Borro el bloque agregado: la arista ya no existe.
    const blockExtrude = doc.features.filter((f) => f.type === 'extrude')[1];
    const r = run(deleteFeature(doc, blockExtrude.id));
    expect(r.statuses.at(-1)).toBe('error');
    expect(r.results.at(-1)!.error).toMatch(/Referencia perdida/);
    expect(r.volume).toBeCloseTo(24000, 4);
  });
});

describe('redondeo, chaflán, vaciado y revolución', () => {
  it('redondeo imposible: error en el timeline, el sólido previo sigue', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const ref = edgeAt(run(doc).shape!, [0, -15, 20]);
    doc = addFeature(doc, makeFillet(doc, [ref], 50));
    const r = run(doc);
    expect(r.statuses).toEqual(['ok', 'ok', 'error']);
    expect(r.results[2].error).toMatch(/entra hasta ≈ 19\.9\d? mm/);
    expect(r.volume).toBeCloseTo(24000, 4);
  });

  it('chaflán: quita un prisma triangular', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const ref = edgeAt(run(doc).shape!, [0, -15, 20]);
    doc = addFeature(doc, makeChamfer(doc, [ref], 2));
    const r = run(doc);
    expect(r.statuses.at(-1)).toBe('ok');
    expect(r.volume).toBeCloseTo(24000 - 2 * 40, 4); // (2·2/2)·40
  });

  it('las caras del redondeo se pueden referenciar después (redondeo sobre redondeo)', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const ref = edgeAt(run(doc).shape!, [0, -15, 20]);
    const fillet = makeFillet(doc, [ref], 3);
    doc = addFeature(doc, fillet);
    const out = run(doc).shape!;
    const filletFaces = out.names.filter((n) => n.some((x) => x.includes(':fillet:')));
    expect(filletFaces).toHaveLength(1);
    // Cambiar el radio del primero no rompe un chaflán en una arista lateral vertical.
    const side = edgeAt(out, [20, 15, 10]);
    doc = addFeature(doc, makeChamfer(doc, [side], 1));
    expect(run(doc).statuses.at(-1)).toBe('ok');
    expect(run(updateFeature<FilletFeature>(doc, fillet.id, { radius: 5 })).statuses.at(-1)).toBe('ok');
  });

  it('vaciado quitando la cara superior', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const top = faceAt(run(doc).shape!, [0, 0, 20]);
    doc = addFeature(doc, makeShell(doc, [top], 2));
    const r = run(doc);
    expect(r.statuses.at(-1)).toBe('ok');
    expect(r.volume).toBeCloseTo(24000 - 36 * 26 * 18, 3);
    // El vaciado sobrevive a un cambio de altura.
    const r2 = run(updateFeature<ExtrudeFeature>(doc, extrudeOf(doc).id, { distance: 30 }));
    expect(r2.statuses.at(-1)).toBe('ok');
    expect(r2.volume).toBeCloseTo(36000 - 36 * 26 * 28, 3);
  });

  it('vaciado con espesor imposible da error', () => {
    engine = new RecomputeEngine();
    let doc = boxDoc();
    const top = faceAt(run(doc).shape!, [0, 0, 20]);
    doc = addFeature(doc, makeShell(doc, [top], 40));
    const r = run(doc);
    expect(r.statuses.at(-1)).toBe('error');
    expect(r.volume).toBeCloseTo(24000, 4);
  });

  it('revolución alrededor de un eje del sketch y de una línea de construcción', () => {
    engine = new RecomputeEngine();
    // Arandela: rectángulo de x∈[5,10], y∈[0,4] girado alrededor del eje v (Y) del sketch XY.
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([5, 0], [10, 4]);
    let doc = build();
    const sk = makeSketch(doc, b.data);
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeRevolve(doc, sk));
    const full = run(doc);
    expect(full.statuses).toEqual(['ok', 'ok']);
    expect(full.volume).toBeCloseTo(PI * (100 - 25) * 4, 3);

    const rev = doc.features[1];
    const half = run(updateFeature<RevolveFeature>(doc, rev.id, { angle: 180 }));
    expect(half.volume).toBeCloseTo((PI * (100 - 25) * 4) / 2, 3);

    // Con una línea de construcción como eje (x = 2): radios 3..8.
    const b2 = new SketchBuilder(b.data);
    const axis = b2.line([2, -5], [2, 5], true);
    engine.dispose();
    const doc2 = updateFeature<SketchFeature>(doc, sk.id, b2.data);
    const withLine = run(updateFeature<RevolveFeature>(doc2, rev.id, { axis: { kind: 'sketchLine', line: axis } }));
    expect(withLine.volume).toBeCloseTo(PI * (64 - 9) * 4, 3);
  });

  it('revolución con el perfil cruzando el eje da error', () => {
    engine = new RecomputeEngine();
    let doc = build();
    const sk = makeSketch(doc, { ...new SketchBuilder({ entities: [], constraints: [] }).data });
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([-5, 0], [5, 4]);
    doc = addFeature(doc, { ...sk, ...b.data });
    doc = addFeature(doc, makeRevolve(doc, { ...sk, ...b.data }));
    const r = run(doc);
    expect(r.statuses).toEqual(['ok', 'error']);
    expect(r.results[1].error).toMatch(/eje/);
  });

  it('extrusión de un círculo sobre una cara lateral (plano no base)', () => {
    engine = new RecomputeEngine();
    let doc = build({ profile: circle(10), distance: 20 }, { profile: rect(40, 30), distance: 5, operation: 'join' });
    const front = faceAt(run(doc).shape!, [0, -15, 2.5]);
    expect(front.normal).toEqual([0, -1, 0]);
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([-5, 0], [5, 4]);
    const sk = makeSketch(doc, { plane: { kind: 'face', face: front, offset: 0 }, ...b.data });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 3 }));
    const r = run(doc);
    expect(r.statuses.every((s) => s === 'ok')).toBe(true);
    // El bloque crece 3 mm hacia -Y.
    expect(r.shape!.shape.boundingBox.bounds[0][1]).toBeCloseTo(-18, 6);
  });
});

describe('aristas que no admiten redondeo', () => {
  it('clasifica costuras y aristas tangentes', async () => {
    const { edgeKinds, EDGE_NORMAL, EDGE_SEAM, EDGE_TANGENT } = await import('../src/kernel/naming');
    engine = new RecomputeEngine();
    // Agujero cilíndrico: su superficie tiene una costura.
    const hole = run(build({ profile: rect(40, 30), distance: 20 }, { profile: circle(5), distance: 50, operation: 'cut', direction: 'symmetric' }));
    const k1 = Array.from(edgeKinds(hole.shape!));
    expect(k1.filter((k) => k === EDGE_SEAM)).toHaveLength(1);
    expect(k1.filter((k) => k === EDGE_NORMAL)).toHaveLength(14);
    engine.dispose();

    // Redondeo: sus dos bordes con las caras vecinas son tangentes.
    let doc = boxDoc();
    const ref = edgeAt(run(doc).shape!, [0, -15, 20]);
    doc = addFeature(doc, makeFillet(doc, [ref], 3));
    const k2 = Array.from(edgeKinds(run(doc).shape!));
    expect(k2.filter((k) => k === EDGE_TANGENT)).toHaveLength(2);
    expect(k2.filter((k) => k === EDGE_SEAM)).toHaveLength(0);
  });

  it('el kernel rechaza elegir costuras o aristas tangentes con un mensaje claro', async () => {
    const { KernelService } = await import('../src/kernel/service');
    const { edgeKinds, EDGE_SEAM } = await import('../src/kernel/naming');
    const k = new KernelService();
    await k.init();
    const doc = build({ profile: rect(40, 30), distance: 20 }, { profile: circle(5), distance: 50, operation: 'cut', direction: 'symmetric' });
    const r = k.recompute(doc);
    const seam = Array.from(r.mesh!.edgeKinds).indexOf(EDGE_SEAM);
    expect(seam).toBeGreaterThanOrEqual(0);
    expect(() => k.edgeRefs([seam])).toThrow(/costura/);
    const normal = Array.from(r.mesh!.edgeKinds).indexOf(0);
    expect(k.edgeRefs([normal])).toHaveLength(1);
    void edgeKinds;
    k.dispose();
  });
});
