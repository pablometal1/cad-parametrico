import { describe, it, expect, beforeAll } from 'vitest';
import type { SketchArc, SketchCircle, SketchData, SketchLine } from '../src/document/types';
import { SketchBuilder } from '../src/sketch/builders';
import { filletCorner, mirrorCurves, offsetCurves, patternCurves, trimCurve, type EditResult } from '../src/sketch/edit';
import { arcParams, dist, lineEnds } from '../src/sketch/geometry';
import { SketchIndex } from '../src/sketch/model';
import { findProfiles } from '../src/sketch/profiles';
import { initSolver, solveSketch } from '../src/sketch/solver';

beforeAll(async () => {
  await initSolver();
}, 30_000);

const empty = (): SketchData => ({ entities: [], constraints: [] });

/** Aplica la edición y resuelve: tiene que dar un sketch sin conflictos ni redundancias. */
function apply(r: EditResult) {
  if (!r.ok) throw new Error(r.error);
  const s = solveSketch(r.data);
  expect(s.ok).toBe(true);
  expect(s.conflicting).toEqual([]);
  expect(s.redundant).toEqual([]);
  return { ...s, created: r.created, index: new SketchIndex(s.data) };
}

/** Área de la única región extruible del sketch. */
function area(d: SketchData) {
  const { regions } = findProfiles(d);
  expect(regions.length).toBe(1);
  const r = regions[0];
  return r.outer.area + r.holes.reduce((acc, h) => acc + h.area, 0);
}

const curves = (d: SketchData, kind: string) => d.entities.filter((e) => e.type === kind && !(e as SketchLine).construction);

/** Rectángulo de 40 × 30 con una esquina en el origen y cotas: totalmente definido. */
function definedRect() {
  const b = new SketchBuilder(empty());
  const lines = b.rectangle([0, 0], [40, 30]);
  const p = (b.data.entities.find((e) => e.id === lines[0]) as SketchLine).p1;
  b.constrain({ type: 'coincident', a: p, b: 'origin' });
  b.constrain({ type: 'distance', a: lines[0], value: 40 });
  b.constrain({ type: 'distance', a: lines[1], value: 30 });
  expect(solveSketch(b.data).dof).toBe(0);
  return { data: b.data, lines };
}

describe('recortar', () => {
  it('dos rectángulos superpuestos: recortando los tramos interiores queda el contorno de la unión', () => {
    const b = new SketchBuilder(empty());
    const [, rightA, topA] = b.rectangle([0, 0], [20, 10]);
    const [bottomB, , , leftB] = b.rectangle([10, 5], [30, 15]);
    let d = b.data;
    // Tramos interiores: derecha de A (x=20, y 5..10), arriba de A (y=10, x 10..20),
    // abajo de B (y=5, x 10..20) e izquierda de B (x=10, y 5..10).
    for (const [id, at] of [[rightA, [20, 7]], [topA, [15, 10]], [bottomB, [15, 5]], [leftB, [10, 7]]] as const) {
      d = apply(trimCurve(d, id, [at[0], at[1]])).data;
    }
    expect(area(d)).toBeCloseTo(20 * 10 + 20 * 10 - 10 * 5, 6);
  });

  it('una línea que no corta nada se borra entera', () => {
    const b = new SketchBuilder(empty());
    const l = b.line([0, 0], [10, 0]);
    const r = apply(trimCurve(b.data, l, [5, 0]));
    expect(r.data.entities).toEqual([]);
  });

  it('cortar un tramo del medio deja dos líneas que conservan la restricción horizontal', () => {
    const b = new SketchBuilder(empty());
    const l = b.line([0, 0], [30, 0]);
    b.constrain({ type: 'horizontal', line: l });
    b.line([10, -5], [10, 5]);
    b.line([20, -5], [20, 5]);
    const r = apply(trimCurve(b.data, l, [15, 0]));
    const pieces = r.data.entities.filter((e): e is SketchLine => e.type === 'line' && Math.abs(r.index.point(e.p1)[1]) < 1e-9 && Math.abs(r.index.point(e.p2)[1]) < 1e-9);
    expect(pieces.length).toBe(2);
    expect(pieces.map((p) => dist(...lineEnds(r.index, p.id))).sort()).toEqual([10, 10].map((x) => expect.closeTo(x, 9)));
    expect(r.data.constraints.filter((c) => c.type === 'horizontal').length).toBe(2);
  });

  it('el extremo recortado sigue a la línea que corta cuando ésta se mueve', () => {
    const b = new SketchBuilder(empty());
    const l = b.line([0, 0], [30, 0]);
    const cutter = b.line([10, -5], [10, 5]);
    const d = apply(trimCurve(b.data, l, [25, 0])).data;
    // Mover la línea que corta: el extremo recortado tiene que acompañarla.
    const cl = d.entities.find((e) => e.id === cutter) as SketchLine;
    const s = solveSketch(d, [{ point: cl.p1, to: [12, -5] }, { point: cl.p2, to: [12, 5] }]);
    const idx = new SketchIndex(s.data);
    const [a, z] = lineEnds(idx, l);
    expect(Math.max(a[0], z[0])).toBeCloseTo(12, 6);
  });

  it('círculo cortado por una línea: queda un arco con el mismo radio', () => {
    const b = new SketchBuilder(empty());
    const c = b.circle([0, 0], 10);
    b.constrain({ type: 'radius', curve: c, value: 10 });
    b.line([-20, 5], [20, 5]);
    const r = apply(trimCurve(b.data, c, [0, 10]));
    const arc = r.data.entities.find((e) => e.id === c) as SketchArc;
    expect(arc.type).toBe('arc');
    const ap = arcParams(r.index, arc);
    expect(ap.radius).toBeCloseTo(10, 9);
    // Se borró el casquete de arriba: el arco va de un corte al otro por abajo.
    expect(ap.endAngle - ap.startAngle).toBeCloseTo(2 * Math.PI - 2 * Math.acos(5 / 10) , 6);
  });
});

describe('desfasar', () => {
  it('rectángulo definido: el desfase hacia afuera queda totalmente definido y 2 mm más grande', () => {
    const { data, lines } = definedRect();
    const r = apply(offsetCurves(data, lines, 2));
    expect(r.dof).toBe(0);
    expect(r.created.length).toBe(4);
    // Área del rectángulo nuevo: (40 + 4) × (30 + 4).
    const xs = r.created.flatMap((id) => lineEnds(r.index, id).map((p) => p[0]));
    const ys = r.created.flatMap((id) => lineEnds(r.index, id).map((p) => p[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(44, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(34, 9);
    // Al cambiar el largo del original, el desfase lo sigue.
    const d2 = { ...r.data, constraints: r.data.constraints.map((c) => (c.type === 'distance' && c.b === undefined && c.a === lines[0] ? { ...c, value: 50 } : c)) };
    const s2 = solveSketch(d2);
    const idx2 = new SketchIndex(s2.data);
    const xs2 = r.created.flatMap((id) => lineEnds(idx2, id).map((p) => p[0]));
    expect(Math.max(...xs2) - Math.min(...xs2)).toBeCloseTo(54, 6);
  });

  it('hacia adentro con distancia negativa', () => {
    const { data, lines } = definedRect();
    const r = apply(offsetCurves(data, lines, -5));
    const xs = r.created.flatMap((id) => lineEnds(r.index, id).map((p) => p[0]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 9);
  });

  it('ranura: líneas y arcos, el desfase queda cerrado y concéntrico', () => {
    const b = new SketchBuilder(empty());
    const slot = b.slot([0, 0], [20, 0], 5);
    const r = apply(offsetCurves(b.data, slot, 2));
    const arcs = r.created.map((id) => r.index.get(id)).filter((e): e is SketchArc => e?.type === 'arc');
    expect(arcs.length).toBe(2);
    for (const a of arcs) expect(arcParams(r.index, a).radius).toBeCloseTo(7, 9);
    // Ranura nueva: 2·7 de ancho y 20 + 14 de largo, con extremos redondos.
    const outer = { ...r.data, entities: r.data.entities.filter((e) => e.type === 'point' || r.created.includes(e.id)) };
    expect(area(outer)).toBeCloseTo(20 * 14 + Math.PI * 49, 0);
  });

  it('rectángulo con las 4 esquinas redondeadas: el desfase queda definido y sigue a las cotas', () => {
    const { data } = definedRect();
    let d = data;
    for (const corner of [[0, 0], [40, 0], [40, 30], [0, 30]]) {
      const idx = new SketchIndex(d);
      const p = idx.points().find((q) => Math.abs(q.x - corner[0]) < 1e-9 && Math.abs(q.y - corner[1]) < 1e-9)!;
      d = apply(filletCorner(d, [p.id], 4)).data;
    }
    const contour = d.entities.filter((e) => (e.type === 'line' || e.type === 'arc') && !e.construction).map((e) => e.id);
    expect(contour.length).toBe(8);
    const r = apply(offsetCurves(d, contour, 3));
    expect(r.dof).toBe(0);
    const arcs = r.created.map((id) => r.index.get(id)).filter((e): e is SketchArc => e?.type === 'arc');
    for (const a of arcs) expect(arcParams(r.index, a).radius).toBeCloseTo(7, 9);
    // Cambiar el ancho del original (la cota pasó a la esquina virtual): el desfase lo sigue, afuera.
    const width = r.data.constraints.filter((c) => c.type === 'distance' && c.value === 40);
    expect(width.length).toBe(1);
    const d2 = { ...r.data, constraints: r.data.constraints.map((c) => (c === width[0] ? { ...c, value: 60 } : c)) };
    const s2 = solveSketch(d2);
    expect(s2.ok).toBe(true);
    const idx2 = new SketchIndex(s2.data);
    const xs = r.created.filter((id) => idx2.get(id)?.type === 'line').flatMap((id) => lineEnds(idx2, id).map((p) => p[0]));
    expect(Math.max(...xs)).toBeCloseTo(63, 6);
    expect(Math.min(...xs)).toBeCloseTo(-3, 6);
  });

  it('rectángulo con una sola esquina redondeada, desfase hacia adentro: definido y sin redundancias', () => {
    const { data, lines } = definedRect();
    const right = data.entities.find((e) => e.id === lines[1]) as SketchLine;
    const d = apply(filletCorner(data, [right.p2], 6)).data;
    const contour = d.entities.filter((e) => (e.type === 'line' || e.type === 'arc') && !e.construction).map((e) => e.id);
    const r = apply(offsetCurves(d, contour, -3));
    expect(r.dof).toBe(0);
    const arc = r.created.map((id) => r.index.get(id)).find((e): e is SketchArc => e?.type === 'arc')!;
    expect(arcParams(r.index, arc).radius).toBeCloseTo(3, 9);
  });

  it('cualquier combinación de esquinas redondeadas, hacia afuera y hacia adentro: definido y sin redundancias', () => {
    const corners = [[0, 0], [40, 0], [40, 30], [0, 30]];
    for (let mask = 1; mask < 16; mask++) {
      let d = definedRect().data;
      for (const [k, corner] of corners.entries()) {
        if (!(mask & (1 << k))) continue;
        const p = new SketchIndex(d).points().find((q) => Math.abs(q.x - corner[0]) < 1e-9 && Math.abs(q.y - corner[1]) < 1e-9)!;
        d = apply(filletCorner(d, [p.id], 5)).data;
      }
      const contour = d.entities.filter((e) => (e.type === 'line' || e.type === 'arc') && !e.construction).map((e) => e.id);
      for (const dist of [2, -2]) {
        const r = apply(offsetCurves(d, contour, dist));
        expect(r.dof, `esquinas ${mask.toString(2)}, desfase ${dist}`).toBe(0);
      }
    }
  });

  it('ranura y hexágono, hacia afuera y hacia adentro: el desfase no agrega grados de libertad', () => {
    const shapes = [
      (b: SketchBuilder) => b.slot([0, 0], [20, 0], 5),
      (b: SketchBuilder) => b.polygon([0, 0], [10, 0], 6).slice(0, 6),
    ];
    for (const [k, make] of shapes.entries()) {
      for (const dist of [1.5, -1.5]) {
        const b = new SketchBuilder(empty());
        const ids = make(b);
        const before = solveSketch(b.data).dof;
        const r = apply(offsetCurves(b.data, ids, dist));
        expect(r.dof, `figura ${k}, desfase ${dist}`).toBe(before);
      }
    }
  });

  it('cadena abierta línea + arco tangente', () => {
    const b = new SketchBuilder(empty());
    const p = b.point([10, 0]);
    const l = b.line([0, 0], p);
    const a = b.arc([10, 5], p, [15, 5]);
    const r = apply(offsetCurves(b.data, [l, a], 1));
    expect(r.created.length).toBe(2);
    const arc = r.index.get(r.created[1]) as SketchArc;
    const ap = arcParams(r.index, arc);
    expect([4, 6].some((x) => Math.abs(ap.radius - x) < 1e-9)).toBe(true);
  });

  it('círculo: mismo centro y radio más grande', () => {
    const b = new SketchBuilder(empty());
    const c = b.circle([3, 4], 10);
    const r = apply(offsetCurves(b.data, [c], 1.5));
    const n = r.index.get(r.created[0]) as SketchCircle;
    expect(n.center).toBe((r.index.get(c) as SketchCircle).center);
    expect(n.radius).toBeCloseTo(11.5, 9);
  });

  it('un contorno ramificado no se puede desfasar', () => {
    const b = new SketchBuilder(empty());
    const p = b.point([0, 0]);
    const ids = [b.line(p, [10, 0]), b.line(p, [0, 10]), b.line(p, [-10, 0])];
    const r = offsetCurves(b.data, ids, 1);
    expect(r.ok).toBe(false);
  });
});

describe('redondear esquina', () => {
  it('rectángulo definido: redondear una esquina lo deja definido y conserva sus cotas', () => {
    const { data, lines } = definedRect();
    // Esquina (40, 30) entre la derecha y la de arriba.
    const right = data.entities.find((e) => e.id === lines[1]) as SketchLine;
    const r = apply(filletCorner(data, [right.p2], 5));
    expect(r.dof).toBe(0);
    const arc = r.index.get(r.created[0]) as SketchArc;
    const ap = arcParams(r.index, arc);
    expect(ap.radius).toBeCloseTo(5, 9);
    expect(ap.center[0]).toBeCloseTo(35, 9);
    expect(ap.center[1]).toBeCloseTo(25, 9);
    expect(ap.endAngle - ap.startAngle).toBeCloseTo(Math.PI / 2, 9);
    // El área sale de la polilínea que aproxima el arco: alcanza con 1 decimal.
    expect(area(r.data)).toBeCloseTo(40 * 30 - (25 - (Math.PI * 25) / 4), 1);
  });

  it('las cotas de largo pasan a la esquina virtual y siguen mandando', () => {
    const { data, lines } = definedRect();
    const right = data.entities.find((e) => e.id === lines[1]) as SketchLine;
    let d = apply(filletCorner(data, [right.p2], 5)).data;
    d = { ...d, constraints: d.constraints.map((c) => (c.type === 'distance' && c.value === 30 ? { ...c, value: 35 } : c)) };
    const s = solveSketch(d);
    expect(s.ok).toBe(true);
    const idx = new SketchIndex(s.data);
    const ys = curves(s.data, 'line').flatMap((l) => lineEnds(idx, l.id).map((p) => p[1]));
    expect(Math.max(...ys)).toBeCloseTo(35, 6);
  });

  it('esquina sin cotas, elegida por sus dos líneas: el vértice desaparece', () => {
    const b = new SketchBuilder(empty());
    const p = b.point([0, 0]);
    const l1 = b.line(p, [10, 0]);
    const l2 = b.line(p, [0, 10]);
    const r = apply(filletCorner(b.data, [l1, l2], 2));
    expect(r.data.entities.some((e) => e.id === p)).toBe(false);
    const ap = arcParams(r.index, r.index.get(r.created[0]) as SketchArc);
    expect(ap.center[0]).toBeCloseTo(2, 9);
    expect(ap.center[1]).toBeCloseTo(2, 9);
  });

  it('polígono regular (lados iguales): el redondeo mantiene la igualdad con una línea completa', () => {
    const b = new SketchBuilder(empty());
    const sides = b.polygon('origin', [10, 0], 6);
    const p = (b.data.entities.find((e) => e.id === sides[0]) as SketchLine).p1;
    const r = apply(filletCorner(b.data, [p], 1));
    const eq = r.data.constraints.filter((c) => c.type === 'equal');
    expect(eq.length).toBe(5);
    // Los lados (medidos hasta las esquinas virtuales) siguen siendo iguales: no se deforma.
    const lens = eq.flatMap((k) => [(k as { a: string }).a, (k as { b: string }).b]).map((id) => dist(...lineEnds(r.index, id)));
    for (const l of lens) expect(l).toBeCloseTo(lens[0], 6);
  });

  it('un radio que no entra da el máximo posible', () => {
    const { data, lines } = definedRect();
    const right = data.entities.find((e) => e.id === lines[1]) as SketchLine;
    const r = filletCorner(data, [right.p2], 40);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hasta ≈ 30/);
  });
});

describe('simetría y patrones', () => {
  it('reflejar un triángulo respecto del eje Y: la copia sigue a la original', () => {
    const b = new SketchBuilder(empty());
    const a = b.point([0, 0]);
    const l1 = b.line(a, [10, 0]);
    // El lado sobre el eje es de construcción: los dos triángulos forman un solo contorno.
    const l2 = b.line(a, [0, 10], true);
    const tri = [l1, l2, b.line((b.data.entities.find((e) => e.id === l1) as SketchLine).p2, (b.data.entities.find((e) => e.id === l2) as SketchLine).p2)];
    const r = apply(mirrorCurves(b.data, tri, 'axisY'));
    // El lado que está sobre el eje no se copia.
    expect(r.created.length).toBe(2);
    const xs = r.created.flatMap((id) => lineEnds(r.index, id).map((p) => p[0]));
    expect(Math.min(...xs)).toBeCloseTo(-10, 9);
    // Los puntos sobre el eje se comparten: el contorno completo es un solo perfil.
    expect(area(r.data)).toBeCloseTo(100, 6);
    // Mover un vértice original mueve su reflejo.
    const p2 = (r.data.entities.find((e) => e.id === l1) as SketchLine).p2;
    const s = solveSketch(r.data, [{ point: p2, to: [14, 0] }]);
    const idx = new SketchIndex(s.data);
    const xs2 = r.created.flatMap((id) => lineEnds(idx, id).map((p) => p[0]));
    expect(Math.min(...xs2)).toBeCloseTo(-14, 6);
  });

  it('reflejar un arco y un círculo respecto de una línea inclinada', () => {
    const b = new SketchBuilder(empty());
    const axis = b.line([0, 0], [10, 10], true);
    const c = b.circle([10, 0], 2);
    const arc = b.arc([5, -5], [8, -5], [5, -2]);
    const r = apply(mirrorCurves(b.data, [c, arc, axis], axis));
    const circle = r.index.get(r.created[0]) as SketchCircle;
    const cc = r.index.point(circle.center);
    expect(cc[0]).toBeCloseTo(0, 9);
    expect(cc[1]).toBeCloseTo(10, 9);
    const ap = arcParams(r.index, r.index.get(r.created[1]) as SketchArc);
    expect(ap.center[0]).toBeCloseTo(-5, 9);
    expect(ap.center[1]).toBeCloseTo(5, 9);
    expect(ap.endAngle - ap.startAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('patrón circular de 6 agujeros alrededor del origen', () => {
    const b = new SketchBuilder(empty());
    const c = b.circle([20, 0], 3);
    const r = apply(patternCurves(b.data, [c], { kind: 'circular', center: 'origin', count: 6, angle: 360 }));
    expect(r.created.length).toBe(5);
    const centers = curves(r.data, 'circle').map((e) => r.index.point((e as SketchCircle).center));
    expect(centers.length).toBe(6);
    for (const p of centers) expect(Math.hypot(p[0], p[1])).toBeCloseTo(20, 9);
    expect(centers.some((p) => Math.abs(p[0] - 10) < 1e-9 && Math.abs(p[1] - 20 * Math.sin(Math.PI / 3)) < 1e-9)).toBe(true);
    // Radios iguales: cambiar el original cambia todos.
    const d2 = { ...r.data, constraints: [...r.data.constraints, { id: 'kr', type: 'radius' as const, curve: c, value: 4 }] };
    const s = solveSketch(d2);
    expect(curves(s.data, 'circle').every((e) => Math.abs((e as SketchCircle).radius - 4) < 1e-6)).toBe(true);
  });

  it('patrón lineal de un rectángulo a lo largo del eje X', () => {
    const b = new SketchBuilder(empty());
    const rect = b.rectangle([0, 0], [5, 5]);
    const r = apply(patternCurves(b.data, rect, { kind: 'linear', direction: 'axisX', count: 3, spacing: 10 }));
    expect(r.created.length).toBe(8);
    expect(findProfiles(r.data).regions.length).toBe(3);
    const xs = r.created.flatMap((id) => lineEnds(r.index, id).map((p) => p[0]));
    expect(Math.max(...xs)).toBeCloseTo(25, 9);
  });
});
