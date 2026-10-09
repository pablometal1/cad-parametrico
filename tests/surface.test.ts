import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeDome, makeFillet, makePatch } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument } from '../src/document/types';
import { volume } from '../src/kernel/features/measure';
import { edgeRefOf, faceRefOf, type NamedShape } from '../src/kernel/naming';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { initSolver } from '../src/sketch/solver';
import { build, circle, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function result(doc: CadDocument) {
  const e = new RecomputeEngine();
  try {
    const out = e.run(doc);
    const last = out.results[out.results.length - 1];
    const s = out.shape;
    return {
      error: last.error ?? '', vol: s ? volume(s.shape) : 0, solids: s?.shape.solids.length ?? 0,
      top: s ? s.shape.boundingBox.bounds[1][2] : 0, low: s ? s.shape.boundingBox.bounds[0][2] : 0,
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
/** Caja 20 × 20 × 10 centrada en XY. */
const box = () => build({ profile: rect(20, 20), distance: 10 });
const topFace = (doc: CadDocument) =>
  withShape(doc, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[2] - 10) < 1e-6)));
const topEdges = (doc: CadDocument) =>
  withShape(doc, (s) => s.shape.edges.flatMap((e, i) => (Math.abs(e.pointAt(0.5).toTuple()[2] - 10) < 1e-6 ? [edgeRefOf(s, i)] : [])));

describe('abombar cara', () => {
  it('hacia afuera: la tapa sube 4 mm en el centro y el borde queda en su lugar', () => {
    const base = box();
    const r = result(addFeature(base, makeDome(base, topFace(base), 4)));
    expect(r.error).toBe('');
    expect(r.solids).toBe(1);
    expect(r.top).toBeCloseTo(14, 2);
    // Volumen agregado: menos que un prisma de 4 mm sobre la tapa, más que una pirámide.
    expect(r.vol - 4000).toBeGreaterThan((400 * 4) / 3);
    expect(r.vol - 4000).toBeLessThan(400 * 4);
  });

  it('hacia adentro: un hundimiento de 3 mm', () => {
    const base = box();
    const r = result(addFeature(base, makeDome(base, topFace(base), -3)));
    expect(r.error).toBe('');
    expect(r.top).toBeCloseTo(10, 6);
    expect(4000 - r.vol).toBeGreaterThan(400);
    expect(4000 - r.vol).toBeLessThan(1200);
  });

  it('una cara redonda (tapa de un cilindro) también', () => {
    const base = build({ profile: circle(8), distance: 10 });
    const r = result(addFeature(base, makeDome(base, topFace(base), 3)));
    expect(r.error).toBe('');
    expect(r.top).toBeCloseTo(13, 2);
  });

  it('una cara curva da un mensaje', () => {
    const base = build({ profile: circle(8), distance: 10 });
    const side = withShape(base, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType !== 'PLANE')));
    expect(result(addFeature(base, makeDome(base, side, 2))).error).toMatch(/planas/);
  });

  it('se puede redondear después el borde del abombado', () => {
    const base = box();
    const doc = addFeature(base, makeDome(base, topFace(base), 4));
    const edge = withShape(doc, (s) => edgeRefOf(s, s.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[2] - 10) < 1e-6 && Math.abs(m[1] + 10) < 1e-6;
    })));
    expect(result(addFeature(doc, makeFillet(doc, [edge], 1))).error).toBe('');
  });
});

describe('parche', () => {
  it('rellena el contorno de la tapa con una superficie abombada y engrosada', () => {
    const base = box();
    const r = result(addFeature(base, makePatch(base, topEdges(base), { height: 5, thickness: 1.5 })));
    expect(r.error).toBe('');
    expect(r.solids).toBe(1);
    expect(r.vol).toBeGreaterThan(4000 + 400 * 1.5 * 0.9);
  });

  it('como cuerpo nuevo', () => {
    const base = box();
    const r = result(addFeature(base, makePatch(base, topEdges(base), { height: 3, thickness: 1, operation: 'new' })));
    expect(r.error).toBe('');
    expect(r.solids).toBe(2);
  });

  it('pocas aristas o espesor 0 dan un mensaje', () => {
    const base = box();
    const edges = topEdges(base);
    expect(result(addFeature(base, makePatch(base, edges.slice(0, 1)))).error).toMatch(/contorno/);
    expect(result(addFeature(base, makePatch(base, edges, { thickness: 0 }))).error).toMatch(/espesor/);
  });

  it('se guardan y se vuelven a abrir', () => {
    const base = box();
    let doc = addFeature(base, makePatch(base, topEdges(base), { height: 2 }));
    doc = addFeature(doc, makeDome(doc, topFace(base), -1));
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });
});
