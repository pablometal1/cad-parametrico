import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeExtrude, makeSketch } from '../src/document/ops';
import { holeCenters } from '../src/document/holes';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, SketchData, SketchPlaneRef, SketchText } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { checkPart } from '../src/kernel/features/check';
import { flattenContour, loadFonts, signedArea, textContours, textRegions } from '../src/sketch/text';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver(), loadFonts()]);
}, 60_000);

const T = (text: string, height = 10, extra: Partial<SketchText> = {}): Pick<SketchText, 'text' | 'height' | 'angle' | 'bold'> =>
  ({ text, height, angle: 0, bold: true, ...extra });

/** Área encerrada por las letras (exteriores menos agujeros), con las curvas bien divididas. */
function textArea(text: string, height: number) {
  return textRegions(textContours(T(text, height), [0, 0])).reduce((acc, r) => {
    const a = (c: typeof r.outer) => Math.abs(signedArea(flattenContour(c, 64)));
    return acc + a(r.outer) - r.holes.reduce((h, c) => h + a(c), 0);
  }, 0);
}

/** Sketch con un texto anclado en (x, y). */
function textSketch(text: string, height: number, at: [number, number], plane: SketchPlaneRef): SketchData {
  return {
    entities: [
      { id: 'p1', type: 'point', x: at[0], y: at[1] },
      { id: 't1', type: 'text', point: 'p1', text, height, angle: 0, bold: true },
    ],
    constraints: [],
  } satisfies SketchData & { entities: unknown[] };
  void plane;
}

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const c = out.shape ? checkPart(out.shape.shape) : null;
  const r = {
    status: last.status, error: last.error ?? '', vol: out.shape ? volume(out.shape.shape) : 0, solids: out.shape?.shape.solids.length ?? 0,
    printable: !!c && c.valid && c.openEdges === 0 && c.flippedEdges === 0 && c.invertedBodies === 0,
    bounds: out.shape?.shape.boundingBox.bounds,
  };
  e.dispose();
  return r;
}

describe('contornos de texto', () => {
  it('la altura es la de las mayúsculas, y el texto empieza en el ancla', () => {
    const pts = textContours(T('H', 12), [5, 7]).flatMap((c) => flattenContour(c));
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(7, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12, 6);
    expect(Math.min(...pts.map((p) => p[0]))).toBeGreaterThanOrEqual(5);
  });

  it('agujeros de las letras: O tiene uno, 8 dos, la i son dos piezas; también ñ y acentos', () => {
    const holes = (s: string) => textRegions(textContours(T(s), [0, 0])).map((r) => r.holes.length);
    expect(holes('O')).toEqual([1]);
    expect(holes('8')).toEqual([2]);
    expect(holes('i')).toEqual([0, 0]);
    expect(holes('A')).toEqual([1]);
    expect(textRegions(textContours(T('ñ'), [0, 0]))).toHaveLength(2);
    expect(textRegions(textContours(T('é'), [0, 0]))).toHaveLength(2);
  });

  it('girar el texto 90° lo pone vertical', () => {
    const pts = textContours(T('IIII', 10, { angle: 90 }), [0, 0]).flatMap((c) => flattenContour(c));
    const w = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const h = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    expect(w).toBeCloseTo(10, 6);
    expect(h).toBeGreaterThan(w); // cuatro letras en fila, ahora a lo alto
  });
});

describe('texto en el modelo', () => {
  it('extruir "IL" (solo rectas) da exactamente área × altura', () => {
    let doc: CadDocument = { format: 'cad-parametrico', version: 1, units: 'mm', parameters: [], features: [], rollback: null };
    const sk = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, ...textSketch('IL', 10, [0, 0], { kind: 'base', plane: 'XY', offset: 0 }) });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 2 }));
    const r = run(doc);
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(textArea('IL', 10) * 2, 6);
    expect(r.solids).toBe(2);
  });

  it('letras con curvas y agujeros ("O8Añ"): sólidos válidos y el volumen de su área', () => {
    let doc: CadDocument = { format: 'cad-parametrico', version: 1, units: 'mm', parameters: [], features: [], rollback: null };
    const sk = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, ...textSketch('O8Añ', 10, [0, 0], { kind: 'base', plane: 'XY', offset: 0 }) });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 3 }));
    const r = run(doc);
    expect(r.status).toBe('ok');
    expect(r.printable).toBe(true);
    expect(Math.abs(r.vol - textArea('O8Añ', 10) * 3) / r.vol).toBeLessThan(0.001);
  });

  it('grabado (cortar) y relieve (unir) sobre la cara superior de una caja', () => {
    const box = build({ profile: rect(60, 30), distance: 10 });
    const top: SketchPlaneRef = { kind: 'base', plane: 'XY', offset: 10 };
    const area = textArea('CAD 3D', 8);
    for (const [op, sign] of [['cut', -1], ['join', 1]] as const) {
      let doc = box;
      const sk = makeSketch(doc, { plane: top, ...textSketch('CAD 3D', 8, [-25, -4], top) });
      doc = addFeature(doc, sk);
      // Cortar hacia adentro (dirección invertida); unir hacia afuera.
      doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 1, operation: op, direction: op === 'cut' ? 'reversed' : 'normal' }));
      const r = run(doc);
      expect(r.status, op).toBe('ok');
      expect(r.printable, op).toBe(true);
      expect(r.solids, op).toBe(1);
      expect(Math.abs(r.vol - (60 * 30 * 10 + sign * area)) / area, op).toBeLessThan(0.002);
    }
  });

  it('el texto se mueve con su punto (cotas) y se guarda en el archivo', () => {
    const data: SketchData = {
      entities: [
        { id: 'p1', type: 'point', x: 3, y: 3 },
        { id: 't1', type: 'text', point: 'p1', text: 'Hola', height: 5, angle: 0, bold: false },
      ],
      constraints: [
        { id: 'k1', type: 'distance', a: 'p1', b: 'origin', value: 20 },
        { id: 'k2', type: 'horizontal', line: 'axisX' },
      ].slice(0, 1) as SketchData['constraints'],
    };
    let doc: CadDocument = { format: 'cad-parametrico', version: 1, units: 'mm', parameters: [], features: [], rollback: null };
    const sk = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, ...data });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 1 }));
    const r = run(doc);
    expect(r.status).toBe('ok');
    // El ancla quedó a 20 mm del origen: el texto se alejó.
    const [min] = r.bounds!;
    expect(Math.hypot(min[0], min[1])).toBeGreaterThan(10);
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    // El ancla de un texto no es un centro de agujero.
    expect(holeCenters(data)).toEqual([]);
  });
});
