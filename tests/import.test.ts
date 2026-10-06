import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, emptyDocument, makeImport, updateFeature } from '../src/document/ops';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, ImportFeature } from '../src/document/types';
import { KernelService } from '../src/kernel/service';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { checkPart } from '../src/kernel/features/check';
import { build, rect } from './helpers';

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
    const r = run(withImport(block, 'step'));
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(60 * 60 * 30, 4);
    expect(r.references).toBe(1);
  });

  it('un STL abierto solo sirve de referencia; errores y archivo', () => {
    // Se le quitan triángulos a la malla binaria (cabecera de 80 + cantidad de 4 + 50 por triángulo).
    const bytes = Uint8Array.from(atob(stlB64), (c) => c.charCodeAt(0));
    const n = new DataView(bytes.buffer).getUint32(80, true);
    const cut = bytes.slice(0, 84 + 50 * (n - 2));
    new DataView(cut.buffer).setUint32(80, n - 2, true);
    const open = { ...makeImport(emptyDocument(), 'abierto.stl', 'stl', toB64(cut)) };
    const asRef = run(addFeature(emptyDocument(), open));
    expect(asRef.status).toBe('ok');
    const asBody = run(addFeature(emptyDocument(), { ...open, operation: 'new' }));
    expect(asBody.error).toMatch(/no forma un sólido cerrado/);

    const garbage = run(addFeature(emptyDocument(), { ...open, format: 'step', data: btoa('no es un step') }));
    expect(garbage.error).toMatch(/STEP/);

    const doc = withImport(emptyDocument(), 'step', { position: [1, 2, 3] });
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    void updateFeature;
  });
});
