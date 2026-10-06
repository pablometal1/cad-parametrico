import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeChamfer, makeHole, makeSketch, updateFeature } from '../src/document/ops';
import { HOLE_PRESETS, holeCenters, holeProblem } from '../src/document/holes';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, HoleFeature, SketchData, SketchPlaneRef } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { volume } from '../src/kernel/features/measure';
import { edgeRefOf, faceRefOf, type NamedShape } from '../src/kernel/naming';
import { checkPart } from '../src/kernel/features/check';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

const PI = Math.PI;
const BOX = 40 * 30 * 20;
const TOP: SketchPlaneRef = { kind: 'base', plane: 'XY', offset: 20 };

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const r = {
    status: last.status, error: last.error ?? '', statuses: out.results.map((x) => x.status),
    vol: out.shape ? volume(out.shape.shape) : 0, check: out.shape ? checkPart(out.shape.shape) : null,
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

/** Caja 40×30×20 + sketch con los centros + agujero. */
function boxWithHole(draw: (b: SketchBuilder) => void, hole: Partial<HoleFeature> = {}, plane: SketchPlaneRef = TOP) {
  let doc = build({ profile: rect(40, 30), distance: 20 });
  const b = new SketchBuilder({ entities: [], constraints: [] });
  draw(b);
  const sk = makeSketch(doc, { plane, ...(b.data as SketchData) });
  doc = addFeature(doc, sk);
  const h = makeHole(doc, sk.id, hole);
  return { doc: addFeature(doc, h), hole: h, sketch: sk };
}
const at = (x: number, y: number) => (b: SketchBuilder) => b.point([x, y]);

describe('centros de agujero', () => {
  it('puntos sueltos y centros de círculos; no las esquinas ni círculos de construcción', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([0, 0], [10, 10]);
    const p = b.point([3, 4]);
    b.circle([20, 0], 2);
    b.circle([30, 0], 2, true);
    const c = holeCenters(b.data);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ id: p, pos: [3, 4] });
    expect(c[1].pos).toEqual([20, 0]);
  });
});

describe('agujero', () => {
  it('simple pasante: quita un cilindro de toda la altura', () => {
    const r = run(boxWithHole(at(0, 0), { diameter: 6 }).doc);
    expect(r.status).toBe('ok');
    expect(r.vol).toBeCloseTo(BOX - PI * 9 * 20, 3);
    expect(checkProblems(r.check)).toBe(true);
  });

  it('ciego con fondo plano y con punta de mecha de 118°', () => {
    const flat = run(boxWithHole(at(0, 0), { diameter: 6, extent: 'distance', depth: 8 }).doc);
    expect(flat.vol).toBeCloseTo(BOX - PI * 9 * 8, 3);
    const drill = run(boxWithHole(at(0, 0), { diameter: 6, extent: 'distance', depth: 8, tip: 'drill' }).doc);
    const tipH = 3 / Math.tan((59 * PI) / 180);
    expect(drill.vol).toBeCloseTo(BOX - PI * 9 * 8 - (PI * 9 * tipH) / 3, 3);
  });

  it('cajeado (M3 Allen) y avellanado (M3 cabeza plana a 90°)', () => {
    const cb = run(boxWithHole(at(0, 0), { kind: 'counterbore', diameter: 3.4, cbDiameter: 6.5, cbDepth: 3.3 }).doc);
    expect(cb.status).toBe('ok');
    expect(cb.vol).toBeCloseTo(BOX - PI * 3.25 ** 2 * 3.3 - PI * 1.7 ** 2 * (20 - 3.3), 3);

    const cs = run(boxWithHole(at(0, 0), { kind: 'countersink', diameter: 3.4, csDiameter: 6.7, csAngle: 90 }).doc);
    expect(cs.status).toBe('ok');
    const h = 3.35 - 1.7; // a 90°, la profundidad del cono es la diferencia de radios
    const cone = (PI * h / 3) * (3.35 ** 2 + 3.35 * 1.7 + 1.7 ** 2);
    expect(cs.vol).toBeCloseTo(BOX - cone - PI * 1.7 ** 2 * (20 - h), 3);
  });

  it('varios centros en un paso (punto y círculo), y sobre una cara del modelo', () => {
    const two = run(boxWithHole((b) => { b.point([-10, 0]); b.circle([10, 0], 1); }, { diameter: 4 }).doc);
    expect(two.vol).toBeCloseTo(BOX - 2 * PI * 4 * 20, 3);

    const base = build({ profile: rect(40, 30), distance: 20 });
    const top = withShape(base, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[2] - 20) < 1e-6)));
    const onFace = run(boxWithHole(at(0, 0), { diameter: 6 }, { kind: 'face', face: top, offset: 0 }).doc);
    expect(onFace.vol).toBeCloseTo(BOX - PI * 9 * 20, 3);
  });

  it('dirección: desde abajo hace falta invertirla, y si no toca lo dice', () => {
    const bottom: SketchPlaneRef = { kind: 'base', plane: 'XY', offset: 0 };
    const wrong = run(boxWithHole(at(0, 0), { diameter: 6, extent: 'distance', depth: 5 }, bottom).doc);
    expect(wrong.status).toBe('error');
    expect(wrong.error).toMatch(/no toca el sólido.*Invertir dirección/);
    const right = run(boxWithHole(at(0, 0), { diameter: 6, extent: 'distance', depth: 5, reversed: true }, bottom).doc);
    expect(right.vol).toBeCloseTo(BOX - PI * 9 * 5, 3);
  });

  it('con el sketch dentro de la pieza, el agujero arranca justo en el plano (no corta de más)', () => {
    const mid: SketchPlaneRef = { kind: 'base', plane: 'XY', offset: 10 };
    const r = run(boxWithHole(at(0, 0), { diameter: 6, extent: 'distance', depth: 5 }, mid).doc);
    expect(r.vol).toBeCloseTo(BOX - PI * 9 * 5, 3);
  });

  it('un chaflán en el borde del agujero sigue al cambiar el diámetro', () => {
    const { doc, hole } = boxWithHole(at(0, 0), { diameter: 6 });
    const ref = withShape(doc, (s) => edgeRefOf(s, s.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return e.geomType === 'CIRCLE' && Math.abs(m[2] - 20) < 1e-6;
    })));
    expect(ref.name).toContain(`${hole.id}:wall:`);
    const withChamfer = addFeature(doc, makeChamfer(doc, [ref], 1));
    expect(run(withChamfer).status).toBe('ok');
    const wider = run(updateFeature<HoleFeature>(withChamfer, hole.id, { diameter: 10 }));
    expect(wider.statuses.every((s) => s === 'ok')).toBe(true);
    // Chaflán de 1 mm alrededor de un agujero de radio 5: anillo triangular (Pappus).
    const ring = 0.5 * 1 * 1 * 2 * PI * (5 + 1 / 3);
    expect(wider.vol).toBeCloseTo(BOX - PI * 25 * 20 - ring, 2);
  });

  it('errores claros y presets coherentes', () => {
    expect(run(boxWithHole(() => {}, {}).doc).error).toMatch(/no tiene centros de agujero/);
    expect(run(boxWithHole(at(0, 0), { kind: 'counterbore', diameter: 6, cbDiameter: 5 }).doc).error).toMatch(/cajeado tiene que ser mayor/);
    const base = makeHole(build({ profile: rect(1, 1) }), 'x');
    for (const p of HOLE_PRESETS) expect(holeProblem({ ...base, ...p.values }), p.id).toBeNull();
    expect(HOLE_PRESETS.filter((p) => p.group === 'counterbore').length).toBe(7);
  });

  it('se guarda y se abre igual', () => {
    const { doc } = boxWithHole(at(0, 0), { kind: 'countersink', extent: 'distance', depth: 12, tip: 'drill', reversed: false });
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
  });
});

function checkProblems(c: ReturnType<typeof checkPart> | null) {
  return !!c && c.valid && c.openEdges === 0 && c.flippedEdges === 0 && c.invertedBodies === 0;
}
