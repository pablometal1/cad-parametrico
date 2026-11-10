import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeVertex, measureDistanceBetween } from 'replicad';
import { evaluateDocument } from '../src/document/evaluate';
import {
  addFeature, emptyDocument, makeChamfer, makeCurve3d, makeDome, makeExtrude, makeFillet, makeLoft, makeShell, makeSketch,
} from '../src/document/ops';
import type { CadDocument, EdgeRef, FaceRef, Vec3 } from '../src/document/types';
import { sweepFilletSingleEdge } from '../src/kernel/features/filletEngine';
import { volume } from '../src/kernel/features/measure';
import { EDGE_NORMAL, EDGE_SEAM, EDGE_TANGENT, edgeNames, edgeRefOf, faceRefOf, resolveEdge, vertexRefOf, type NamedShape } from '../src/kernel/naming';
import { initOCCT } from '../src/kernel/occt';
import { isValidShape } from '../src/kernel/occtUtils';
import { RecomputeEngine } from '../src/kernel/recompute';
import { KernelService } from '../src/kernel/service';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';

let engine: RecomputeEngine | null = null;

beforeAll(async () => {
  await initOCCT();
  await initSolver();
});

afterEach(() => {
  engine?.dispose();
  engine = null;
});

function run(doc: CadDocument) {
  engine ??= new RecomputeEngine();
  const ev = evaluateDocument(doc);
  const out = engine.run(ev.doc, ev.errors);
  return {
    statuses: out.results.map((r) => r.status),
    results: out.results,
    shape: out.shape,
    volume: out.shape ? volume(out.shape.shape) : 0,
  };
}

function boxDoc(w = 40, h = 30, d = 20): CadDocument {
  let doc = emptyDocument();
  const b = new SketchBuilder({ entities: [], constraints: [] });
  b.rectangle([-w / 2, -h / 2], [w / 2, h / 2]);
  const sk = makeSketch(doc, b.data);
  doc = addFeature(doc, sk);
  doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: d }));
  return doc;
}

function edgeNear(named: NamedShape, pt: Vec3): EdgeRef {
  let best = 0;
  let bestD = Infinity;
  named.shape.edges.forEach((e, i) => {
    const p = e.pointAt(0.5).toTuple();
    const d = Math.hypot(p[0] - pt[0], p[1] - pt[1], p[2] - pt[2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return edgeRefOf(named, best);
}

function faceNear(named: NamedShape, pt: Vec3): FaceRef {
  let best = 0;
  let bestD = Infinity;
  named.shape.faces.forEach((f, i) => {
    const p = f.center.toTuple();
    const d = Math.hypot(p[0] - pt[0], p[1] - pt[1], p[2] - pt[2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return faceRefOf(named, best);
}

describe('Motor de redondeos (Fillet Engine)', () => {
  it('Etapa 2 (cadenas G1): propaga automáticamente a lo largo de aristas tangentes conectadas', () => {
    let doc = boxDoc(40, 30, 20);
    // Primero redondeamos una arista vertical (x=20, y=-15) con radio 6 para que el borde superior
    // tenga un tramo en arco tangente G1 a los dos lados rectos.
    const vertEdge = edgeNear(run(doc).shape!, [20, -15, 10]);
    doc = addFeature(doc, makeFillet(doc, [vertEdge], 6));
    const afterVert = run(doc).shape!;

    // Ahora elegimos SOLO UNA arista recta superior (y = -15, z = 20) que termina en el arco tangente.
    // Sin propagación G1, ChFi3d falla al intentar cortar en seco sobre un vértice tangente.
    const singleTopEdge = edgeNear(afterVert, [-3, -15, 20]);
    doc = addFeature(doc, makeFillet(doc, [singleTopEdge], 2));
    const res = run(doc);
    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
    expect(res.volume).toBeLessThan(volume(afterVert.shape));
  });

  it('Etapa 3 (UnifySameDomain): redondea aristas sobre caras partidas por una curva impresa', () => {
    let doc = boxDoc(40, 30, 20);
    const s0 = run(doc).shape!;
    // Imprimimos una curva 3D recta sobre la cara superior entre (-20, 0, 20) y (20, 0, 20),
    // partiendo la cara superior en dos caras coplanares y dividiendo las aristas laterales.
    const eLeft = s0.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[0] + 20) < 1e-3 && Math.abs(m[1]) < 1e-3 && Math.abs(m[2] - 20) < 1e-3;
    });
    const eRight = s0.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.abs(m[0] - 20) < 1e-3 && Math.abs(m[1]) < 1e-3 && Math.abs(m[2] - 20) < 1e-3;
    });
    const v1 = vertexRefOf(s0, [eLeft], [-20, 0, 20]);
    const v2 = vertexRefOf(s0, [eRight], [20, 0, 20]);
    const curve = { ...makeCurve3d(doc, [v1, v2], false), imprint: true };
    doc = addFeature(doc, curve);
    const afterSplit = run(doc).shape!;
    expect(afterSplit.shape.faces.length).toBeGreaterThan(6);

    // Redondeamos uno de los tramos de la arista superior partida y una arista que cruza la partición.
    const splitEdge = edgeNear(afterSplit, [20, 7.5, 20]);
    doc = addFeature(doc, makeFillet(doc, [splitEdge], 3));
    const res = run(doc);
    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
  });

  it('Etapa 4 (descomposición secuencial): resuelve combinaciones de aristas convexas y cóncavas en escalón', () => {
    // Pieza en L: base 40x30x10 + bloque superior 20x30x15 en x ∈ [0, 20].
    let doc = boxDoc(40, 30, 10);
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([0, -15], [20, 15]);
    const sk2 = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 10 }, ...b.data });
    doc = addFeature(doc, sk2);
    doc = addFeature(doc, makeExtrude(doc, sk2.id, { distance: 15, operation: 'join' }));
    const stepShape = run(doc).shape!;

    // Seleccionamos simultáneamente la arista cóncava interior (x=0, z=10) y aristas convexas que convergen en ella.
    const concaveEdge = edgeNear(stepShape, [0, 0, 10]);
    const convexTop = edgeNear(stepShape, [0, 0, 25]);
    const convexFront = edgeNear(stepShape, [10, -15, 25]);
    doc = addFeature(doc, makeFillet(doc, [concaveEdge, convexTop, convexFront], 3));
    const res = run(doc);
    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
  });

  it('Etapa 5 (superficies complejas y cuña geométrica barrida): redondea abombados, solevaciones y cuña directa', () => {
    // Caja con cara superior abombada (superficie BSpline de relleno) y redondeo de sus bordes.
    let doc = boxDoc(30, 30, 15);
    const top = faceNear(run(doc).shape!, [0, 0, 15]);
    doc = addFeature(doc, makeDome(doc, top, 4));
    const domed = run(doc).shape!;

    const domeEdge = edgeNear(domed, [0, -15, 15]);
    doc = addFeature(doc, makeFillet(doc, [domeEdge], 1.5));
    const resDome = run(doc);
    expect(resDome.statuses.at(-1)).toBe('ok');
    expect(isValidShape(resDome.shape!.shape)).toBe(true);

    // Prueba directa del motor geométrico de cuña barrida (sweepFilletSingleEdge) en arista convexa y cóncava.
    let stepDoc = boxDoc(40, 30, 10);
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([0, -15], [20, 15]);
    const sk2 = makeSketch(stepDoc, { plane: { kind: 'base', plane: 'XY', offset: 10 }, ...b.data });
    stepDoc = addFeature(stepDoc, sk2);
    stepDoc = addFeature(stepDoc, makeExtrude(stepDoc, sk2.id, { distance: 15, operation: 'join' }));
    const lShape = run(stepDoc).shape!;
    const v0 = volume(lShape.shape);
    const { names } = edgeNames(lShape);

    // 1. Cuña barrida en arista convexa (longitud 30, radio 2 -> quita (1 - pi/4) * 4 * 30).
    const convexIdx = resolveEdge(lShape, edgeNear(lShape, [-20, 0, 10]));
    const convexSwept = sweepFilletSingleEdge(
      lShape,
      convexIdx,
      2,
      { featureId: 'f_test', isFillet: true, size: 2, variable: false },
      names[convexIdx],
    );
    expect(convexSwept).not.toBeNull();
    try {
      expect(isValidShape(convexSwept!.shape)).toBe(true);
      expect(volume(convexSwept!.shape)).toBeCloseTo(v0 - (1 - Math.PI / 4) * 4 * 30, 1);
      expect(convexSwept!.names.some((ns) => ns.includes(`f_test:fillet:${names[convexIdx]}`))).toBe(true);
    } finally {
      convexSwept?.shape.delete();
    }

    // 2. Cuña barrida en arista cóncava (longitud 30, radio 2 -> agrega (1 - pi/4) * 4 * 30).
    const concaveIdx = resolveEdge(lShape, edgeNear(lShape, [0, 0, 10]));
    const concaveSwept = sweepFilletSingleEdge(
      lShape,
      concaveIdx,
      2,
      { featureId: 'f_test2', isFillet: true, size: 2, variable: false },
      names[concaveIdx],
    );
    expect(concaveSwept).not.toBeNull();
    try {
      expect(isValidShape(concaveSwept!.shape)).toBe(true);
      expect(volume(concaveSwept!.shape)).toBeCloseTo(v0 + (1 - Math.PI / 4) * 4 * 30, 1);
      expect(concaveSwept!.names.some((ns) => ns.includes(`f_test2:fillet:${names[concaveIdx]}`))).toBe(true);
    } finally {
      concaveSwept?.shape.delete();
    }

    // 3. Rechaza radios que exceden el ancho de la cara adyacente (p. ej. radio 25 en cara de 10 mm).
    const impossible = sweepFilletSingleEdge(
      lShape,
      convexIdx,
      25,
      { featureId: 'f_bad', isFillet: true, size: 25, variable: false },
      names[convexIdx],
    );
    expect(impossible).toBeNull();

    // Solevación entre dos rectángulos de distinto tamaño y redondeo de una arista.
    engine?.dispose();
    engine = new RecomputeEngine();
    let loftDoc = emptyDocument();
    const sb1 = new SketchBuilder({ entities: [], constraints: [] });
    sb1.rectangle([-15, -15], [15, 15]);
    const s1 = makeSketch(loftDoc, sb1.data);
    loftDoc = addFeature(loftDoc, s1);

    const sb2 = new SketchBuilder({ entities: [], constraints: [] });
    sb2.rectangle([-10, -8], [10, 8]);
    const s2 = makeSketch(loftDoc, { plane: { kind: 'base', plane: 'XY', offset: 20 }, ...sb2.data });
    loftDoc = addFeature(loftDoc, s2);
    loftDoc = addFeature(loftDoc, makeLoft(loftDoc, [s1.id, s2.id]));
    const loftShape = run(loftDoc).shape!;

    const loftEdge = edgeNear(loftShape, [0, -8, 20]);
    loftDoc = addFeature(loftDoc, makeFillet(loftDoc, [loftEdge], 1.5));
    const resLoft = run(loftDoc);
    expect(resLoft.statuses.at(-1)).toBe('ok');
    expect(isValidShape(resLoft.shape!.shape)).toBe(true);
  });

  it('Etapa 6 (radio adaptativo por arista): adapta el radio cuando una arista del grupo toca una cara más angosta', () => {
    // Base 40x30x20 con un escalón bajo de 1.2 mm de alto sobre un borde.
    let doc = boxDoc(40, 30, 20);
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([10, -15], [20, 15]);
    const sk2 = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 20 }, ...b.data });
    doc = addFeature(doc, sk2);
    doc = addFeature(doc, makeExtrude(doc, sk2.id, { distance: 1.2, operation: 'join' }));
    const stepped = run(doc).shape!;

    // Elegimos una arista amplia de la base (que admite radio 5 mm) junto con la arista del escalón de 1.2 mm
    // (donde 5 mm supera la altura de 1.2 mm). El motor debe redondear ambas adaptando el radio de la angosta.
    const wideEdge = edgeNear(stepped, [-20, 0, 20]);
    const narrowEdge = edgeNear(stepped, [20, 0, 21.2]);
    doc = addFeature(doc, makeFillet(doc, [wideEdge, narrowEdge], 5));
    const res = run(doc);
    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
    const filletFaces = res.shape!.names.filter((ns) => ns.some((n) => n.includes(':fillet:')));
    expect(filletFaces.length).toBeGreaterThanOrEqual(2);
  });

  it('desborde / adaptación: radio 8.9 mm en arista con cara de 4 mm se resuelve con éxito sin bloquearse en error', () => {
    // Sólido con un escalón de 4 mm de ancho o altura (base 40x30x20 con escalón de 4 mm).
    let doc = boxDoc(40, 30, 20);
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([10, -15], [20, 15]);
    const sk2 = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 20 }, ...b.data });
    doc = addFeature(doc, sk2);
    doc = addFeature(doc, makeExtrude(doc, sk2.id, { distance: 4, operation: 'join' }));
    const shape = run(doc).shape!;

    // Seleccionamos la arista del escalón de 4 mm (donde antes el usuario recibía:
    // "No se pudo redondear con radio 8.9 mm: en estas aristas entra hasta ≈ 3.99 mm...")
    const stepEdge = edgeNear(shape, [20, 0, 24]);
    doc = addFeature(doc, makeFillet(doc, [stepEdge], 8.9));
    const res = run(doc);

    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
    expect(res.volume).toBeLessThan(volume(shape.shape));
    const filletFace = res.shape!.names.find((ns) => ns.some((n) => n.includes(':fillet:')));
    expect(filletFace).toBeDefined();
  });

  it('desborde / adaptación en placa delgada de 4 mm con radio 8.9 mm', () => {
    // Placa de 40x30x4: la altura completa es 4 mm. Radio pedido = 8.9 mm.
    let doc = boxDoc(40, 30, 4);
    const shape0 = run(doc).shape!;
    const edge = edgeNear(shape0, [0, -15, 4]);
    doc = addFeature(doc, makeFillet(doc, [edge], 8.9));
    const res = run(doc);

    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
    expect(res.volume).toBeLessThan(volume(shape0.shape));
  });

  it('desborde / adaptación en múltiples aristas con caras angostas (radio 8.9 mm)', () => {
    let doc = boxDoc(40, 30, 4);
    const shape0 = run(doc).shape!;
    const edge1 = edgeNear(shape0, [0, -15, 4]);
    const edge2 = edgeNear(shape0, [0, 15, 4]);
    doc = addFeature(doc, makeFillet(doc, [edge1, edge2], 8.9));
    const res = run(doc);

    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
    expect(res.volume).toBeLessThan(volume(shape0.shape));
  });

  it('KernelService: filtra costuras/tangentes en selecciones mixtas y sugiere un radio válido inicial', async () => {
    const k = new KernelService();
    await k.init();
    try {
      // Caja con redondeo previo (genera aristas tangentes) y vaciado de 0.2 mm.
      let doc = boxDoc(20, 20, 20);
      k.recompute(doc);
      const e0 = k.edgeRefs([0])[0];
      doc = addFeature(doc, makeFillet(doc, [e0], 3));
      const r1 = k.recompute(doc);
      const kinds = Array.from(r1.mesh!.edgeKinds);
      const tangentIdx = kinds.indexOf(EDGE_TANGENT);
      const normalIdx = kinds.indexOf(EDGE_NORMAL);
      expect(tangentIdx).toBeGreaterThanOrEqual(0);
      expect(normalIdx).toBeGreaterThanOrEqual(0);

      // Si el usuario selecciona varias aristas incluyendo una tangente junto a una normal, se filtra a la normal.
      const mixedRefs = k.edgeRefs([tangentIdx, normalIdx]);
      expect(mixedRefs).toHaveLength(1);

      // Si solo selecciona la tangente, sigue dando el mensaje explicativo.
      expect(() => k.edgeRefs([tangentIdx])).toThrow(/tangentes/);

      // En una pieza con pared de 0.2 mm, suggestEdgeSize devuelve un radio menor que 2 mm que sí funciona.
      let thinDoc = boxDoc(10, 10, 20);
      const top = faceNear(run(thinDoc).shape!, [0, 0, 20]);
      thinDoc = addFeature(thinDoc, makeShell(thinDoc, [top], 0.2));
      const rThin = k.recompute(thinDoc);
      const rimIdx = Array.from(rThin.mesh!.edgeKinds).findIndex((kind, i) => {
        if (kind !== EDGE_NORMAL) return false;
        const info = k.edgeInfo(i);
        return Math.abs(info.midpoint[2] - 20) < 1e-3;
      });
      expect(rimIdx).toBeGreaterThanOrEqual(0);
      const suggested = k.suggestEdgeSize([rimIdx], true, 2);
      expect(suggested).toBeGreaterThan(0);
      expect(suggested).toBeLessThan(0.2);

      const refs = k.edgeRefs([rimIdx]);
      thinDoc = addFeature(thinDoc, makeFillet(thinDoc, refs, suggested));
      const rFilleted = k.recompute(thinDoc);
      expect(rFilleted.features.at(-1)?.status).toBe('ok');
      void EDGE_SEAM;
      void makeChamfer;
    } finally {
      k.dispose();
    }
  });

  /** Volumen que quita un redondeo de radio r a lo largo de L mm de una arista a 90°. */
  const filletCut = (r: number, L: number) => (1 - Math.PI / 4) * r * r * L;

  it('caras coplanares partidas no cuentan como angostas: tapa partida en diagonal, radio completo y sin aviso', () => {
    let doc = boxDoc(40, 30, 20);
    const s0 = run(doc).shape!;
    const edgeIdxAt = (pt: Vec3) => s0.shape.edges.findIndex((e) => {
      const m = e.pointAt(0.5).toTuple();
      return Math.hypot(m[0] - pt[0], m[1] - pt[1], m[2] - pt[2]) < 1e-3;
    });
    // Línea impresa de esquina a esquina de la tapa: la parte en dos triángulos coplanares. Junto a la
    // arista x = 20 la cara vecina mide de 0 a 40 mm de ancho, pero es la misma superficie que sigue:
    // el motor no tiene que reducir el radio cerca de la esquina (OCCT pasa por encima de la partición,
    // y si no pudiera, la unificación de caras va antes que cualquier reducción).
    const v1 = vertexRefOf(s0, [edgeIdxAt([0, -15, 20]), edgeIdxAt([20, 0, 20])], [20, -15, 20]);
    const v2 = vertexRefOf(s0, [edgeIdxAt([0, 15, 20]), edgeIdxAt([-20, 0, 20])], [-20, 15, 20]);
    doc = addFeature(doc, makeCurve3d(doc, [v1, v2], false));
    const split = run(doc);
    expect(split.shape!.shape.faces.length).toBe(7);
    const before = split.volume;

    doc = addFeature(doc, makeFillet(doc, [edgeNear(split.shape!, [20, 0, 20])], 3));
    const res = run(doc);
    expect(res.statuses.at(-1)).toBe('ok');
    // Radio completo en todo el largo y sin aviso.
    expect(res.results.at(-1)!.warning).toBeUndefined();
    expect(before - res.volume).toBeCloseTo(filletCut(3, 30), 0);
  });

  it('radio adaptado por tramo: un bolsillo a 0,5 mm del borde reduce el radio solo ahí, y lo avisa', () => {
    let doc = boxDoc(40, 30, 20);
    // Bolsillo de 2,5 × 6 mm en la tapa, a 0,5 mm del borde x = 20, en el centro de la arista.
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([17, -3], [19.5, 3]);
    const sk = makeSketch(doc, { plane: { kind: 'base', plane: 'XY', offset: 20 }, ...b.data });
    doc = addFeature(doc, sk);
    doc = addFeature(doc, makeExtrude(doc, sk.id, { distance: 5, direction: 'reversed', operation: 'cut' }));
    const pocket = run(doc);
    expect(pocket.statuses.at(-1)).toBe('ok');
    const before = pocket.volume;

    doc = addFeature(doc, makeFillet(doc, [edgeNear(pocket.shape!, [20, 0, 20])], 3));
    const res = run(doc);
    expect(res.statuses.at(-1)).toBe('ok');
    expect(isValidShape(res.shape!.shape)).toBe(true);
    const warning = res.results.at(-1)!.warning ?? '';
    expect(warning).toMatch(/solo en los tramos/);
    expect(warning).toMatch(/3 mm no entra/);
    // Con el radio reducido en toda la arista (≈ 0,45 mm) se quitarían ≈ 1,3 mm³; con 3 mm en todo
    // el largo, 57,9. Reduciendo solo junto al bolsillo queda claramente más cerca de lo pedido.
    const removed = before - res.volume;
    expect(removed).toBeGreaterThan(0.5 * filletCut(3, 30));
    expect(removed).toBeLessThan(filletCut(3, 30));
    // Lejos del bolsillo el radio es el pedido: el punto medio del arco de 3 mm está en la superficie.
    const k = 3 * (1 - Math.SQRT1_2);
    const far: Vec3 = [20 - k, 13, 20 - k];
    const d = Math.min(...res.shape!.shape.faces.map((f) => {
      try {
        const c = f.center.toTuple();
        void c;
        return f.geomType === 'PLANE' ? Infinity : distanceToFace(f, far);
      } catch {
        return Infinity;
      }
    }));
    expect(d).toBeLessThan(0.05);
  });

  it('arrastre más allá del máximo: adapta también apenas pasado el límite, con el mismo radio en cada paso', () => {
    let doc = boxDoc(40, 30, 20);
    const s0 = run(doc).shape!;
    const fillet = makeFillet(doc, [edgeNear(s0, [20, 0, 20])], 5);
    doc = addFeature(doc, fillet);
    const applied = (radius: number) => {
      const res = run({ ...doc, features: doc.features.map((f) => (f.id === fillet.id ? { ...f, radius } : f)) });
      expect(res.statuses.at(-1), `radio ${radius}`).toBe('ok');
      const m = (res.results.at(-1)!.warning ?? '').match(/reducido (?:a|hasta) ([\d.]+) mm/);
      return m ? Number(m[1]) : null;
    };
    // Entra hasta casi 20 mm (la cara lateral mide 20): hasta ahí, sin aviso.
    expect(applied(18)).toBeNull();
    // Apenas pasado el máximo antes daba error; ahora adapta y avisa.
    const justOver = applied(20)!;
    expect(justOver).toBeGreaterThan(19);
    expect(justOver).toBeLessThan(20);
    // Los pasos siguientes del arrastre reutilizan lo ya medido y dan el mismo radio (± 0,05).
    for (const r of [22, 25, 30, 21]) expect(Math.abs(applied(r)! - justOver)).toBeLessThan(0.06);
    // Volver a un radio que entra lo restablece exacto.
    expect(applied(10)).toBeNull();
  });
});

/** Distancia de un punto a una cara (vértice de prueba contra la cara, con OCCT). */
function distanceToFace(face: import('replicad').Face, pt: Vec3): number {
  const v = makeVertex(pt);
  try {
    return measureDistanceBetween(face, v);
  } finally {
    v.delete();
  }
}
