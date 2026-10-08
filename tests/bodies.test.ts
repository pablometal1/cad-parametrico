import { describe, it, expect, beforeAll } from 'vitest';
import { addFeature, makeCombine, makeDraft, makeFillet, makeMove, makePushPull, makeSplit } from '../src/document/ops';
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

/** Recalcula y usa el sólido final (o el error de la última feature) antes de liberarlo. */
function run<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    const out = e.run(doc);
    const last = out.results[out.results.length - 1];
    if (last.status !== 'ok') throw new Error(`${last.status}: ${last.error}`);
    return fn(out.shape!);
  } finally {
    e.dispose();
  }
}
function lastError(doc: CadDocument): string {
  const e = new RecomputeEngine();
  try {
    const out = e.run(doc);
    return out.results[out.results.length - 1].error ?? '';
  } finally {
    e.dispose();
  }
}
const vol = (doc: CadDocument) => run(doc, (s) => volume(s.shape));
const solids = (doc: CadDocument) => run(doc, (s) => s.shape.solids.length);

/** Cara plana cuyo centro está en `p` (y opcionalmente con esa normal). */
function faceAt(doc: CadDocument, p: [number, number, number]) {
  return run(doc, (s) => {
    const i = s.shape.faces.findIndex((f) => {
      const c = f.center.toTuple();
      return Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 1e-6;
    });
    if (i < 0) throw new Error(`No hay cara en ${p}`);
    return faceRefOf(s, i);
  });
}

/** Caja de 10 × 10 × 20 centrada en XY, de z = 0 a 20. */
const box = () => build({ profile: rect(10, 10), distance: 20 });

describe('empujar / tirar', () => {
  it('tirar de la tapa agrega material y la tapa conserva su nombre', () => {
    const base = box();
    const top = faceAt(base, [0, 0, 20]);
    const doc = addFeature(base, makePushPull(base, [top], 5));
    expect(vol(doc)).toBeCloseTo(2500, 6);
    // Lo que se apoyaba en la tapa la sigue encontrando, ahora a z = 25.
    expect(faceAt(doc, [0, 0, 25]).name).toBe(top.name);
  });

  it('empujar quita material; empujar de más da un mensaje', () => {
    const base = box();
    const top = faceAt(base, [0, 0, 20]);
    expect(vol(addFeature(base, makePushPull(base, [top], -3)))).toBeCloseTo(1700, 6);
    expect(lastError(addFeature(base, makePushPull(base, [top], -25)))).toMatch(/sin material/);
  });

  it('un redondeo de una arista de la tapa sobrevive a cambiar la distancia', () => {
    const base = box();
    const top = faceAt(base, [0, 0, 20]);
    let doc = addFeature(base, makePushPull(base, [top], 5));
    const edge = run(doc, (s) => {
      const i = s.shape.edges.findIndex((e) => {
        const m = e.pointAt(0.5).toTuple();
        return Math.abs(m[2] - 25) < 1e-6 && Math.abs(m[1] + 5) < 1e-6;
      });
      return edgeRefOf(s, i);
    });
    doc = addFeature(doc, makeFillet(doc, [edge], 1));
    const pp = doc.features.find((f) => f.type === 'pushpull')!;
    const moved = { ...doc, features: doc.features.map((f) => (f.id === pp.id ? { ...f, distance: 8 } : f)) };
    expect(vol(moved)).toBeCloseTo(10 * 10 * 28 - 10 * (1 - Math.PI / 4), 4);
  });

  it('varias caras a la vez: tapa hacia afuera y base hacia afuera', () => {
    const base = box();
    const doc = addFeature(base, makePushPull(base, [faceAt(base, [0, 0, 20]), faceAt(base, [0, 0, 0])], 2));
    expect(vol(doc)).toBeCloseTo(2400, 6);
    expect(solids(doc)).toBe(1);
  });

  it('una cara curva no se puede empujar', () => {
    const base = build({ profile: circle(5), distance: 10 });
    const side = run(base, (s) => faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType !== 'PLANE')));
    expect(lastError(addFeature(base, makePushPull(base, [side], 1)))).toMatch(/planas/);
  });
});

describe('ángulo de desmoldeo', () => {
  it('las 4 paredes con 5° respecto de la base: la pieza se angosta hacia arriba', () => {
    const base = box();
    const bottom = faceAt(base, [0, 0, 0]);
    const sides = [[5, 0, 10], [-5, 0, 10], [0, 5, 10], [0, -5, 10]].map((p) => faceAt(base, p as [number, number, number]));
    const doc = addFeature(base, makeDraft(base, sides, bottom, 5));
    // Tronco de pirámide: lado 10 abajo y 10 − 2·20·tan 5° arriba.
    const a = 10;
    const b = 10 - 2 * 20 * Math.tan((5 * Math.PI) / 180);
    expect(vol(doc)).toBeCloseTo((20 / 3) * (a * a + a * b + b * b), 3);
  });

  it('con la tapa como cara neutra, se angosta hacia abajo (mismo volumen)', () => {
    const base = box();
    const top = faceAt(base, [0, 0, 20]);
    const sides = [[5, 0, 10], [-5, 0, 10], [0, 5, 10], [0, -5, 10]].map((p) => faceAt(base, p as [number, number, number]));
    const doc = addFeature(base, makeDraft(base, sides, top, 5));
    const b = 10 - 2 * 20 * Math.tan((5 * Math.PI) / 180);
    expect(vol(doc)).toBeCloseTo((20 / 3) * (100 + 10 * b + b * b), 3);
    expect(run(doc, (s) => s.shape.boundingBox.bounds[1][0])).toBeCloseTo(5, 6);
  });
});

/** Dos cajas separadas como cuerpos distintos: A de 10×10×10 en el origen y B corrida 5 en X. */
function twoBodies() {
  return build(
    { profile: rect(10, 10), distance: 10 },
    { profile: rect(10, 10, [5, 0]), distance: 10, operation: 'new' },
  );
}

describe('combinar cuerpos', () => {
  const refs = (doc: CadDocument) => ({ a: faceAt(doc, [-5, 0, 5]), b: faceAt(doc, [10, 0, 5]) });

  it('unir, cortar e intersectar', () => {
    const doc = twoBodies();
    expect(solids(doc)).toBe(2);
    const { a, b } = refs(doc);
    const join = addFeature(doc, makeCombine(doc, a, [b], 'join'));
    expect(solids(join)).toBe(1);
    expect(vol(join)).toBeCloseTo(1500, 6);
    const cut = addFeature(doc, makeCombine(doc, a, [b], 'cut'));
    expect(solids(cut)).toBe(1);
    expect(vol(cut)).toBeCloseTo(500, 6);
    const inter = addFeature(doc, makeCombine(doc, a, [b], 'intersect'));
    expect(vol(inter)).toBeCloseTo(500, 6);
  });

  it('cortar conservando la herramienta deja los dos cuerpos', () => {
    const doc = twoBodies();
    const { a, b } = refs(doc);
    const f = { ...makeCombine(doc, a, [b], 'cut'), keepTools: true };
    const out = addFeature(doc, f);
    expect(solids(out)).toBe(2);
    expect(vol(out)).toBeCloseTo(500 + 1000, 6);
  });

  it('el mismo cuerpo como destino y herramienta da un mensaje', () => {
    const doc = twoBodies();
    const { a } = refs(doc);
    expect(lastError(addFeature(doc, makeCombine(doc, a, [a])))).toMatch(/distinto/);
  });
});

describe('extrusión con intersección', () => {
  it('caja ∩ cilindro: queda lo común', () => {
    const doc = build({ profile: rect(10, 10), distance: 10 }, { profile: circle(4), distance: 30, operation: 'intersect' });
    expect(vol(doc)).toBeCloseTo(Math.PI * 16 * 10, 4);
  });
});

describe('dividir', () => {
  it('una caja partida por el plano XY a 8 mm: dos cuerpos con el mismo volumen total', () => {
    const base = box();
    const doc = addFeature(base, makeSplit(base, { kind: 'base', plane: 'XY' }, { offset: 8 }));
    expect(solids(doc)).toBe(2);
    expect(vol(doc)).toBeCloseTo(2000, 6);
    const vols = run(doc, (s) => s.shape.solids.map((x) => volume(x)).sort((p, q) => p - q));
    expect(vols[0]).toBeCloseTo(800, 6);
  });

  it('un plano que no toca la pieza da un mensaje', () => {
    const base = box();
    expect(lastError(addFeature(base, makeSplit(base, { kind: 'base', plane: 'XY' }, { offset: 50 })))).toMatch(/no corta/);
  });

  it('dividir solo un cuerpo con una cara de otro', () => {
    const doc = twoBodies();
    // Separar B a mitad de altura; A queda entero.
    const b = faceAt(doc, [10, 0, 5]);
    const out = addFeature(doc, makeSplit(doc, { kind: 'base', plane: 'XY' }, { offset: 5, body: b }));
    expect(solids(out)).toBe(3);
  });
});

describe('mover y copiar cuerpos', () => {
  it('mover todo 10 mm en X y girar 90° en Z', () => {
    const base = box();
    const moved = addFeature(base, makeMove(base, [], { dx: 10 }));
    expect(run(moved, (s) => s.shape.boundingBox.bounds[0][0])).toBeCloseTo(5, 6);
    expect(vol(moved)).toBeCloseTo(2000, 6);
    const thin = build({ profile: rect(20, 4), distance: 2 });
    const rotated = addFeature(thin, makeMove(thin, [], { dx: 0, angle: 90 }));
    const [lo, hi] = run(rotated, (s) => s.shape.boundingBox.bounds);
    expect(hi[1] - lo[1]).toBeCloseTo(20, 6);
  });

  it('copiar un cuerpo deja el original y la copia, que se puede referenciar aparte', () => {
    const base = box();
    const top = faceAt(base, [0, 0, 20]);
    const doc = addFeature(base, makeMove(base, [top], { dx: 30, copy: true }));
    expect(solids(doc)).toBe(2);
    expect(vol(doc)).toBeCloseTo(4000, 6);
    // La tapa original sigue en su lugar con su nombre; la de la copia tiene otro.
    expect(faceAt(doc, [0, 0, 20]).name).toBe(top.name);
    expect(faceAt(doc, [30, 0, 20]).name).not.toBe(top.name);
  });

  it('sin traslación ni giro da un mensaje', () => {
    const base = box();
    expect(lastError(addFeature(base, makeMove(base, [], { dx: 0 })))).toMatch(/distinto de 0/);
  });
});

describe('archivo', () => {
  it('las features nuevas se guardan y se vuelven a abrir', () => {
    const doc = twoBodies();
    const a = faceAt(doc, [-5, 0, 5]);
    const b = faceAt(doc, [10, 0, 5]);
    let d = addFeature(doc, makeCombine(doc, a, [b], 'intersect'));
    d = addFeature(d, makeSplit(d, { kind: 'face', face: a }, { offset: -2 }));
    d = addFeature(d, makeMove(d, [a], { dz: 3, copy: true }));
    d = addFeature(d, makePushPull(d, [a], 1));
    d = addFeature(d, makeDraft(d, [a], b, 2));
    expect(parseDocument(serializeDocument(d))).toEqual(d);
  });
});
