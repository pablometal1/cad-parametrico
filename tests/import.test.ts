import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeImport, updateFeature } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, ImportFeature } from '../src/document/types';
import { KernelService } from '../src/kernel/service';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { checkPart } from '../src/kernel/features/check';
import { addSketchExtrude, build, circle, rect } from './helpers';

let k: KernelService;
let stepB64 = '';
let stlB64 = '';

const toB64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

beforeAll(async () => {
  k = new KernelService();
  await k.init();
  // Archivos reales: una caja de 40 × 30 × 20 (centrada en XY, de z = 0 a 20) exportada por el programa.
  k.recompute(build({ profile: rect(40, 30), distance: 20 }));
  stepB64 = toB64((await k.exportModel('step', 'medium')).data);
  stlB64 = toB64((await k.exportModel('stl', 'medium')).data);
}, 120_000);

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const c = out.shape ? checkPart(out.shape.shape) : null;
  const r = {
    status: last.status, error: last.error ?? '', vol: out.shape ? volume(out.shape.shape) : 0,
    bounds: out.shape?.shape.boundingBox.bounds, references: out.references.length,
    printable: !!c && c.valid && c.openEdges === 0 && c.invertedBodies === 0,
  };
  e.dispose();
  return r;
}

function withImport(doc: CadDocument, format: 'stl' | 'step', patch: Partial<ImportFeature> = {}) {
  const f = { ...makeImport(doc, `caja.${format}`, format, format === 'stl' ? stlB64 : stepB64), ...patch };
  return addFeature(doc, f);
}

describe('importar', () => {
  it('STEP como cuerpo nuevo: mismo volumen y lugar', () => {
    const r = run(withImport(emptyDocument(), 'step', { operation: 'new' }));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(24000, 4);
    expect(r.bounds![0]).toEqual([expect.closeTo(-20, 4), expect.closeTo(-15, 4), expect.closeTo(0, 4)]);
    expect(r.printable).toBe(true);
  });

  it('STL como cuerpo nuevo: la malla cerrada se vuelve sólido', () => {
    const r = run(withImport(emptyDocument(), 'stl', { operation: 'new' }));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(24000, 2);
  });

  it('ubicar: escala, giro y traslado', () => {
    const r = run(withImport(emptyDocument(), 'step', { operation: 'new', scale: 2, rotation: [0, 0, 90], position: [100, 0, 5] }));
    expect(r.vol).toBeCloseTo(24000 * 8, 2);
    const [min, max] = r.bounds!;
    // 80 × 60 girado 90° en Z → 60 de ancho en X y 80 en Y; trasladado 100 en X y 5 en Z.
    expect(max[0] - min[0]).toBeCloseTo(60, 4);
    expect(max[1] - min[1]).toBeCloseTo(80, 4);
    expect((max[0] + min[0]) / 2).toBeCloseTo(100, 4);
    expect(min[2]).toBeCloseTo(5, 4);
  });

  it('encastre: cortar la pieza importada de un bloque', () => {
    // Bloque 60 × 60 × 30; la caja importada entra 10 mm desde arriba (de z = 20 a 40).
    const block = build({ profile: rect(60, 60), distance: 30 });
    const r = run(withImport(block, 'step', { operation: 'cut', position: [0, 0, 20] }));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(60 * 60 * 30 - 40 * 30 * 10, 3);
    expect(r.printable).toBe(true);
  });

  it('solo referencia: no cambia el sólido y se devuelve aparte', () => {
    const block = build({ profile: rect(60, 60), distance: 30 });
    const r = run(withImport(block, 'step', { operation: 'reference' }));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(60 * 60 * 30, 4);
    expect(r.references).toBe(1);
  });

  /** STL binario modificado: `edit` recibe los triángulos (9 floats cada uno) y devuelve los nuevos. */
  const editSTL = (edit: (tris: number[][]) => number[][]) => {
    const bytes = Uint8Array.from(atob(stlB64), (c) => c.charCodeAt(0));
    const dv = new DataView(bytes.buffer);
    const n = dv.getUint32(80, true);
    const tris: number[][] = [];
    for (let t = 0; t < n; t++) tris.push(Array.from({ length: 9 }, (_, k) => dv.getFloat32(84 + 50 * t + 12 + 4 * k, true)));
    const out = edit(tris);
    const res = new Uint8Array(84 + 50 * out.length);
    const w = new DataView(res.buffer);
    w.setUint32(80, out.length, true);
    out.forEach((tri, t) => tri.forEach((v, k) => w.setFloat32(84 + 50 * t + 12 + 4 * k, v, true)));
    return toB64(res);
  };
  const stlBody = (data: string, op: ImportFeature['operation'] = 'new') =>
    run(addFeature(emptyDocument(), { ...makeImport(emptyDocument(), 'malla.stl', 'stl', data), operation: op }));

  it('un STL con un agujero se repara y queda sólido', () => {
    const r = stlBody(editSTL((t) => t.slice(0, -2)));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(24000, 0);
    expect(r.printable).toBe(true);
  });

  it('caras dadas vuelta, triángulos repetidos y vértices apenas distintos', () => {
    const flipped = stlBody(editSTL((t) => t.map((tri, i) => (i % 3 === 0 ? [...tri.slice(0, 3), ...tri.slice(6, 9), ...tri.slice(3, 6)] : tri))));
    expect(flipped.error).toBe('');
    expect(flipped.vol).toBeCloseTo(24000, 0);
    const dup = stlBody(editSTL((t) => [...t, t[0], t[5]]));
    expect(dup.error).toBe('');
    expect(dup.vol).toBeCloseTo(24000, 0);
    const jitter = stlBody(editSTL((t) => t.map((tri, i) => tri.map((v, k) => v + (((i + k) % 2) ? 2e-5 : 0)))));
    expect(jitter.error).toBe('');
    expect(jitter.vol).toBeCloseTo(24000, 0);
  });

  it('la feature cuenta qué se reparó; lo que no cierra queda de referencia', () => {
    const doc = addFeature(emptyDocument(), makeImport(emptyDocument(), 'malla.stl', 'stl', editSTL((t) => t.slice(0, -2))));
    expect(doc.features[0].type === 'import' && doc.features[0].operation).toBe('new');
    const info = k.recompute(doc).features[0].info;
    expect(info).toMatch(/sólido, reparado: 1 agujero cerrado/);
    // Un solo triángulo no encierra volumen.
    const flat = editSTL((t) => [t[0]]);
    expect(stlBody(flat, 'reference').status).toBe('ok');
    expect(stlBody(flat).error).toMatch(/no forma un sólido cerrado/);

    const garbage = run(addFeature(emptyDocument(), { ...makeImport(emptyDocument(), 'x.step', 'step', btoa('no es un step')) }));
    expect(garbage.error).toMatch(/STEP/);

    const d = withImport(emptyDocument(), 'step', { position: [1, 2, 3] });
    expect(parseDocument(serializeDocument(d))).toEqual(d);
    void updateFeature;
  });

  it('booleanas sobre una malla de otro programa (caras casi coplanares, esfera facetada)', () => {
    const tri = (pts: number[][]) => pts.flat();
    // Caja de 40 subdividida 4×4 por cara, con ruido de 1e-5 por vértice (redondeo de otro programa).
    const P = new Map<string, number[]>();
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 1e-5;
    const pt = (x: number, y: number, z: number) => {
      const key = `${x},${y},${z}`;
      if (!P.has(key)) P.set(key, [x + rnd(), y + rnd(), z + rnd()]);
      return P.get(key)!;
    };
    const box: number[][] = [];
    const g = (i: number) => -20 + i * 10;
    const face = (f: (u: number, v: number) => [number, number, number], flip: boolean) => {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const a = pt(...f(i, j)), b = pt(...f(i + 1, j)), c = pt(...f(i + 1, j + 1)), d = pt(...f(i, j + 1));
        box.push(...(flip ? [tri([a, c, b]), tri([a, d, c])] : [tri([a, b, c]), tri([a, c, d])]));
      }
    };
    face((i, j) => [g(i), g(j), -20], true); face((i, j) => [g(i), g(j), 20], false);
    face((i, j) => [g(i), -20, g(j)], false); face((i, j) => [g(i), 20, g(j)], true);
    face((i, j) => [-20, g(i), g(j)], true); face((i, j) => [20, g(i), g(j)], false);
    // Esfera UV de radio 20.
    const sphere: number[][] = [];
    const S = (i: number, j: number) => {
      const th = (Math.PI * i) / 12, ph = (2 * Math.PI * (j % 24)) / 24;
      return [20 * Math.sin(th) * Math.cos(ph), 20 * Math.sin(th) * Math.sin(ph), 20 * Math.cos(th)];
    };
    for (let i = 0; i < 12; i++) for (let j = 0; j < 24; j++) sphere.push(tri([S(i, j), S(i + 1, j), S(i + 1, j + 1)]), tri([S(i, j), S(i + 1, j + 1), S(i, j + 1)]));
    const encode = (tris: number[][]) => {
      const res = new Uint8Array(84 + 50 * tris.length);
      const w = new DataView(res.buffer);
      w.setUint32(80, tris.length, true);
      tris.forEach((t, i) => t.forEach((v, kk) => w.setFloat32(84 + 50 * i + 12 + 4 * kk, v, true)));
      return toB64(res);
    };
    for (const mesh of [box, sphere]) {
      const d = addFeature(emptyDocument(), makeImport(emptyDocument(), 'malla.stl', 'stl', encode(mesh)));
      const cut = run(addSketchExtrude(d, { profile: circle(4, [5, 0]), distance: 60, direction: 'symmetric', operation: 'cut' }));
      expect(cut.error).toBe('');
      expect(cut.printable).toBe(true);
      const join = run(addSketchExtrude(d, { profile: rect(10, 10, [10, 10]), distance: 40, operation: 'join' }));
      expect(join.error).toBe('');
    }
  }, 120_000);
});
