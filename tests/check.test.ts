import { describe, it, expect, beforeAll } from 'vitest';
import { cast } from 'replicad';
import { addFeature, makeExtrude, makeFillet, makeSketch } from '../src/document/ops';
import type { CadDocument } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { checkPart } from '../src/kernel/features/check';
import { edgeRefOf, type NamedShape } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, circle, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}

const OK = { valid: true, openEdges: 0, flippedEdges: 0, invertedBodies: 0, overlappingPairs: 0, checkedOverlap: true, sheetFaces: 0 };

describe('comprobación para imprimir', () => {
  it('caja, redondeo y agujero pasante: todo bien', () => {
    let doc = build({ profile: rect(40, 30), distance: 20 });
    expect(withShape(doc, (s) => checkPart(s.shape))).toEqual(OK);
    const ref = withShape(doc, (s) => edgeRefOf(s, s.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[1] + 15) < 1e-6 && Math.abs(m[2] - 20) < 1e-6;
    })));
    doc = addFeature(doc, makeFillet(doc, [ref], 4));
    const hb = new SketchBuilder({ entities: [], constraints: [] });
    hb.circle([0, 0], 5);
    const hole = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 0 }, ...hb.data });
    doc = addFeature(doc, hole);
    doc = addFeature(doc, makeExtrude(doc, hole.id, { operation: 'cut', distance: 50, direction: 'symmetric' }));
    expect(withShape(doc, (s) => checkPart(s.shape))).toEqual(OK);
  });

  it('un sólido dado vuelta (normales hacia adentro) se detecta', () => {
    const doc = build({ profile: rect(10, 10), distance: 10 });
    const r = withShape(doc, (s) => {
      const flipped = cast(s.shape.wrapped.Reversed());
      try {
        return checkPart(flipped);
      } finally {
        flipped.delete();
      }
    });
    expect(r.invertedBodies).toBe(1);
  });

  it('cuerpos nuevos que se pisan se avisan; separados no', () => {
    const overlapping = build(
      { profile: rect(10, 10), distance: 10 },
      { profile: circle(4, [5, 5]), distance: 10, operation: 'new' },
    );
    const r = withShape(overlapping, (s) => checkPart(s.shape));
    expect(r.overlappingPairs).toBe(1);
    expect(r.invertedBodies).toBe(0);

    const apart = build(
      { profile: rect(10, 10), distance: 10 },
      { profile: circle(4, [30, 0]), distance: 10, operation: 'new' },
    );
    expect(withShape(apart, (s) => checkPart(s.shape))).toEqual(OK);
  });
});

describe('mensajes de la comprobación', () => {
  it('todo bien no da mensajes; cada problema da uno claro', async () => {
    const { checkProblems } = await import('../src/ui/PartInfo');
    expect(checkProblems(OK)).toEqual([]);
    const msgs = checkProblems({ ...OK, invertedBodies: 1, openEdges: 3, overlappingPairs: 2 });
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatch(/1 cuerpo tiene las normales hacia adentro/);
    expect(msgs[1]).toMatch(/3 aristas sin cerrar/);
    expect(msgs[2]).toMatch(/2 pares de cuerpos se superponen/);
  });
});
