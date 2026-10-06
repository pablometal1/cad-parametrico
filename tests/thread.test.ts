import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeExtrude, makeHole, makeSketch, makeThread, updateFeature } from '../src/document/ops';
import { coarsePitch, HOLE_PRESETS, holeProblem, threadBore } from '../src/document/holes';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, HoleFeature, ThreadFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { checkPart } from '../src/kernel/features/check';
import { cylinderOf, EXTERNAL_DEPTH, INTERNAL_DEPTH } from '../src/kernel/features/thread';
import { faceRefOf, type NamedShape } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, circle, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

const PI = Math.PI;
const TAN30 = Math.tan(PI / 6);

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const c = out.shape ? checkPart(out.shape.shape) : null;
  const r = {
    status: last.status, error: last.error ?? '', vol: out.shape ? volume(out.shape.shape) : 0, solids: out.shape?.shape.solids.length ?? 0,
    printable: !!c && c.valid && c.openEdges === 0 && c.flippedEdges === 0 && c.invertedBodies === 0,
  };
  e.dispose();
  return r;
}
function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}

/**
 * Volumen que quita un surco helicoidal fuera de un radio `r0` (Pappus): la parte del triángulo
 * de 60° más allá de r0, de alto h, gira `turns` vueltas alrededor del eje.
 */
function grooveVolume(r0: number, tip: number, turns: number) {
  const h = Math.abs(tip - r0);
  const area = h * h * TAN30;
  const centroid = tip > r0 ? r0 + h / 3 : r0 - h / 3;
  return area * 2 * PI * centroid * turns;
}

/** Bloque 30×30×20 con un agujero en el centro de la cara superior. */
function blockHole(hole: Partial<HoleFeature>) {
  let doc = build({ profile: rect(30, 30), distance: 20 });
  const b = new SketchBuilder({ entities: [], constraints: [] });
  b.point([0, 0]);
  const sk = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 20 }, ...b.data });
  doc = addFeature(doc, sk);
  const h = makeHole(doc, sk.id, hole);
  return { doc: addFeature(doc, h), hole: h };
}

describe('rosca en el agujero', () => {
  it('M8 ciego: perfora al diámetro menor y talla el hilo (volumen según Pappus)', () => {
    const P = 1.25;
    const clr = 0.2;
    const r = run(blockHole({ diameter: 8, thread: true, threadPitch: P, threadClearance: clr, extent: 'distance', depth: 12 }).doc);
    expect(r.status).toBe('ok');
    expect(r.printable).toBe(true);
    const boreR = threadBore(8, P, clr) / 2;
    const tip = 4 + clr / 2;
    const half = (tip - (boreR - 0.05)) * TAN30;
    const turns = (12 - 2 * half) / P;
    const expected = 30 * 30 * 20 - PI * boreR ** 2 * 12 - grooveVolume(boreR, tip, turns);
    expect(r.vol).toBeCloseTo(expected, 0);
    expect(Math.abs(r.vol - expected) / (30 * 30 * 20 - r.vol)).toBeLessThan(0.005);
    // El hilo llega a la profundidad ISO más la holgura.
    expect(tip - boreR).toBeCloseTo(INTERNAL_DEPTH * P, 6);
  });

  it('M6 pasante y con cajeado: válido, un solo cuerpo', () => {
    const through = run(blockHole({ diameter: 6, thread: true, threadPitch: 1 }).doc);
    expect(through.status).toBe('ok');
    expect(through.solids).toBe(1);
    expect(through.printable).toBe(true);
    const cb = run(blockHole({ kind: 'counterbore', diameter: 6, cbDiameter: 11, cbDepth: 6, thread: true, threadPitch: 1 }).doc);
    expect(cb.status).toBe('ok');
    expect(cb.printable).toBe(true);
    expect(cb.vol).toBeLessThan(through.vol); // el cajeado quita más
  });

  it('presets de rosca: M4 a M24 con paso grueso, todos válidos', () => {
    const threads = HOLE_PRESETS.filter((p) => p.group === 'thread');
    expect(threads.map((p) => p.label)[0]).toBe('M4 × 0.7');
    expect(threads.at(-1)!.label).toBe('M24 × 3');
    const base = makeHole(build({ profile: rect(1, 1) }), 'x');
    for (const p of threads) expect(holeProblem({ ...base, ...p.values }), p.id).toBeNull();
    expect(coarsePitch(8)).toBe(1.25);
    expect(coarsePitch(7.9)).toBe(1.25);
  });
});

describe('rosca sobre una cara cilíndrica', () => {
  /** Cilindro de radio r y alto h, y la referencia a su cara lateral. */
  function rod(r: number, h: number) {
    const doc = build({ profile: circle(r), distance: h });
    const side = withShape(doc, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'CYLINDRE')));
    return { doc, side };
  }

  it('reconoce eje, radio y si es agujero o barra', () => {
    const { doc } = rod(4, 15);
    const c = withShape(doc, (s) => cylinderOf(s.shape.faces.find((f) => f.geomType === 'CYLINDRE')!));
    expect(c.internal).toBe(false);
    expect(c.radius).toBeCloseTo(4, 6);
    expect(Math.abs(c.axis[2])).toBeCloseTo(1, 6);
    expect(c.z1 - c.z0).toBeCloseTo(15, 6);

    const { doc: holed } = blockHole({ diameter: 6 });
    const h = withShape(holed, (s) => cylinderOf(s.shape.faces.find((f) => f.geomType === 'CYLINDRE')!));
    expect(h.internal).toBe(true);
    expect(h.radius).toBeCloseTo(3, 6);
  });

  it('rosca externa M8 en una barra (tornillo impreso)', () => {
    const P = 1.25;
    const { doc, side } = rod(4, 15);
    const t = makeThread(doc, side, P, { clearance: 0.2 });
    const r = run(addFeature(doc, t));
    expect(r.status).toBe('ok');
    expect(r.printable).toBe(true);
    const tip = 4 - EXTERNAL_DEPTH * P - 0.1;
    const half = (4.05 - tip) * TAN30;
    const turns = (15 - 2 * half) / P;
    const expected = PI * 16 * 15 - grooveVolume(4, tip, turns);
    expect(Math.abs(r.vol - expected) / (PI * 16 * 15 - r.vol)).toBeLessThan(0.005);
  });

  it('largo parcial, desde cualquiera de los extremos', () => {
    const { doc, side } = rod(4, 20);
    const full = run(addFeature(doc, makeThread(doc, side, 1.25))).vol;
    const t = makeThread(doc, side, 1.25, { length: 8 });
    const part = run(addFeature(doc, t)).vol;
    const other = run(addFeature(doc, { ...t, fromStart: true })).vol;
    expect(part).toBeGreaterThan(full);
    expect(other).toBeCloseTo(part, 1);
  });

  it('rosca interna sobre un agujero existente y errores claros', () => {
    const { doc } = blockHole({ diameter: threadBore(8, 1.25, 0), extent: 'distance', depth: 12 });
    const wall = withShape(doc, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'CYLINDRE')));
    const r = run(addFeature(doc, makeThread(doc, wall, 1.25)));
    expect(r.status).toBe('ok');
    expect(r.printable).toBe(true);

    const top = withShape(doc, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE')));
    expect(run(addFeature(doc, makeThread(doc, top, 1.25))).error).toMatch(/no es cilíndrica/);
    const thin = rod(0.5, 10);
    expect(run(addFeature(thin.doc, makeThread(thin.doc, thin.side, 1.5))).error).toMatch(/paso es demasiado grande/);
  });

  it('se guarda y se abre; archivos viejos de agujero quedan sin rosca', () => {
    const { doc, side } = rod(4, 15);
    const d = addFeature(doc, makeThread(doc, side, 1.25, { length: 5, fromStart: true }));
    expect(parseDocument(serializeDocument(d))).toEqual(d);
    const { doc: hd } = blockHole({ diameter: 8, thread: true, threadPitch: 1.25 });
    const old = JSON.parse(serializeDocument(hd));
    delete old.features[3].thread;
    delete old.features[3].threadPitch;
    delete old.features[3].threadClearance;
    const back = parseDocument(JSON.stringify(old)).features[3] as HoleFeature;
    expect(back.thread).toBe(false);
  });
});

// Tipos usados solo en firmas.
export type { ThreadFeature };
void updateFeature;
void makeExtrude;

describe('información de caras curvas', () => {
  it('elegir un cilindro completo da su radio (antes fallaba: el centro de masa cae en el eje)', async () => {
    const { KernelService } = await import('../src/kernel/service');
    const k = new KernelService();
    await k.init();
    k.recompute(build({ profile: [rect(30, 30), circle(4, [40, 0])], distance: 20 }));
    const faces = (k as unknown as { current: { shape: { faces: { geomType: string }[] } } }).current.shape.faces;
    const i = faces.findIndex((f) => f.geomType === 'CYLINDRE');
    const info = k.faceInfo(i);
    expect(info.cylinder!.radius).toBeCloseTo(4, 6);
    expect(info.cylinder!.internal).toBe(false);
    expect(Math.hypot(...info.normal)).toBeCloseTo(1, 6);
    expect(Math.abs(info.normal[2])).toBeLessThan(1e-6); // la normal de un cilindro vertical es horizontal
    k.dispose();
  });
});
