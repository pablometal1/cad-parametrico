import { describe, it, expect, beforeAll } from 'vitest';
import type { SketchData, SketchLine } from '../src/document/types';
import { SketchBuilder } from '../src/sketch/builders';
import { dist, lineEnds, pointLineDistance, signedAngleDeg, arcParams } from '../src/sketch/geometry';
import { removeItems, SketchIndex } from '../src/sketch/model';
import { findProfiles, ProfileError } from '../src/sketch/profiles';
import { initSolver, solveSketch } from '../src/sketch/solver';

beforeAll(async () => {
  await initSolver();
}, 30_000);

const solve = (b: SketchBuilder) => {
  const r = solveSketch(b.data);
  return { ...r, index: new SketchIndex(r.data) };
};
const line = (d: SketchData, id: string) => d.entities.find((e) => e.id === id) as SketchLine;

describe('solver: restricciones', () => {
  it('rectángulo con H/V tiene 4 grados de libertad; con cotas y origen queda definido', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom, right] = b.rectangle([1, 1], [11, 7]);
    expect(solve(b).dof).toBe(4);
    b.constrain({ type: 'distance', a: bottom, value: 40 });
    b.constrain({ type: 'distance', a: right, value: 30 });
    expect(solve(b).dof).toBe(2);
    b.constrain({ type: 'coincident', a: line(b.data, bottom).p1, b: 'origin' });
    const r = solve(b);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    const [p1, p2] = lineEnds(r.index, bottom);
    expect(p1[0]).toBeCloseTo(0, 9);
    expect(p1[1]).toBeCloseTo(0, 9);
    expect(dist(p1, p2)).toBeCloseTo(40, 9);
    expect(dist(...lineEnds(r.index, right))).toBeCloseTo(30, 9);
  });

  it('paralela, perpendicular, igual y ángulo', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l1 = b.line([0, 0], [10, 1]);
    const l2 = b.line([0, 5], [9, 7]);
    const l3 = b.line([20, 0], [21, 8]);
    const l4 = b.line([30, 0], [36, 3]);
    b.constrain({ type: 'parallel', a: l1, b: l2 });
    b.constrain({ type: 'perpendicular', a: l1, b: l3 });
    b.constrain({ type: 'equal', a: l1, b: l3 });
    b.constrain({ type: 'angle', a: l1, b: l4, value: 30 });
    const r = solve(b);
    expect(r.ok).toBe(true);
    expect(Math.abs(signedAngleDeg(r.index, l1, l2)) % 180).toBeCloseTo(0, 6);
    expect(Math.abs(signedAngleDeg(r.index, l1, l3))).toBeCloseTo(90, 6);
    expect(dist(...lineEnds(r.index, l1))).toBeCloseTo(dist(...lineEnds(r.index, l3)), 6);
    expect(signedAngleDeg(r.index, l1, l4)).toBeCloseTo(30, 6);
  });

  it('horizontal/vertical respecto de los ejes implícitos y punto sobre eje', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l = b.line([1, 2], [8, 3]);
    b.constrain({ type: 'parallel', a: l, b: 'axisX' });
    b.constrain({ type: 'coincident', a: line(b.data, l).p1, b: 'axisY' });
    const r = solve(b);
    const [p1, p2] = lineEnds(r.index, l);
    expect(p1[1]).toBeCloseTo(p2[1], 9);
    expect(p1[0]).toBeCloseTo(0, 9);
  });

  it('distancias punto-punto, punto-línea y entre líneas paralelas', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const p = b.point([3, 3]);
    const q = b.point([5, 9]);
    const l = b.line([0, 0], [10, 0]);
    const m = b.line([0, 4], [10, 5]);
    b.constrain({ type: 'horizontal', line: l });
    b.constrain({ type: 'parallel', a: l, b: m });
    b.constrain({ type: 'distance', a: p, b: q, value: 7 });
    b.constrain({ type: 'distance', a: p, b: l, value: 2 });
    b.constrain({ type: 'distance', a: l, b: m, value: 6 });
    const r = solve(b);
    expect(r.ok).toBe(true);
    expect(dist(r.index.point(p), r.index.point(q))).toBeCloseTo(7, 9);
    expect(pointLineDistance(r.index.point(p), ...lineEnds(r.index, l))).toBeCloseTo(2, 9);
    expect(pointLineDistance(lineEnds(r.index, m)[0], ...lineEnds(r.index, l))).toBeCloseTo(6, 9);
  });

  it('radio, igual entre círculos y tangencia línea-círculo y círculo-círculo', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const c1 = b.circle([0, 0], 3);
    const c2 = b.circle([10, 1], 4);
    const l = b.line([-10, 6], [10, 7]);
    b.constrain({ type: 'radius', curve: c1, value: 5 });
    b.constrain({ type: 'equal', a: c1, b: c2 });
    b.constrain({ type: 'tangent', a: l, b: c1 });
    b.constrain({ type: 'tangent', a: c2, b: c1 });
    const r = solve(b);
    expect(r.ok).toBe(true);
    const circ = (id: string) => r.data.entities.find((e) => e.id === id) as { radius: number; center: string };
    expect(circ(c1).radius).toBeCloseTo(5, 9);
    expect(circ(c2).radius).toBeCloseTo(5, 9);
    const center1 = r.index.point(circ(c1).center);
    const center2 = r.index.point(circ(c2).center);
    expect(pointLineDistance(center1, ...lineEnds(r.index, l))).toBeCloseTo(5, 6);
    expect(dist(center1, center2)).toBeCloseTo(10, 6);
  });

  it('arcos: radio, tangencia con línea y puntos coincidentes', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const a = b.arc([0, 0], [4, 0], [0, 4]);
    const l = b.line([0, 6], [-10, 6]);
    b.constrain({ type: 'radius', curve: a, value: 6 });
    b.constrain({ type: 'tangent', a: l, b: a });
    const arc = b.data.entities.find((e) => e.id === a) as { end: string; start: string; center: string };
    b.constrain({ type: 'coincident', a: line(b.data, l).p1, b: arc.end });
    b.constrain({ type: 'coincident', a: arc.center, b: 'origin' });
    const r = solve(b);
    expect(r.ok).toBe(true);
    const ap = arcParams(r.index, r.data.entities.find((e) => e.id === a) as never);
    expect(ap.radius).toBeCloseTo(6, 9);
    expect(dist(r.index.point(arc.end), ap.center)).toBeCloseTo(6, 9);
    expect(pointLineDistance(ap.center, ...lineEnds(r.index, l))).toBeCloseTo(6, 6);
  });

  it('detecta redundancias y conflictos', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom, , top] = b.rectangle([0, 0], [10, 5]);
    const red = b.constrain({ type: 'parallel', a: bottom, b: top });
    expect(solve(b).redundant).toContain(red);

    const c = new SketchBuilder({ entities: [], constraints: [] });
    const l = c.line([0, 0], [10, 0]);
    c.constrain({ type: 'distance', a: l, value: 10 });
    c.constrain({ type: 'distance', a: l, value: 20 });
    const r = solve(c);
    expect(r.ok && r.conflicting.length === 0).toBe(false);
  });

  it('rechaza cotas no positivas y combinaciones inválidas', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l = b.line([0, 0], [1, 0]);
    const c = b.circle([0, 0], 1);
    b.constrain({ type: 'distance', a: l, value: 0 });
    expect(() => solveSketch(b.data)).toThrow(/mayor que 0/);
    const b2 = new SketchBuilder({ entities: [], constraints: [] });
    const l2 = b2.line([0, 0], [1, 0]);
    const c2 = b2.circle([0, 0], 1);
    b2.constrain({ type: 'parallel', a: l2, b: c2 });
    expect(() => solveSketch(b2.data)).toThrow(/incompatibles/);
    void c;
  });

  it('arrastrar mueve el punto sin violar restricciones', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom] = b.rectangle([0, 0], [10, 5]);
    const corner = line(b.data, bottom).p2; // esquina inferior derecha
    const r = solveSketch(b.data, [{ point: corner, to: [20, 2] }]);
    expect(r.ok).toBe(true);
    const idx = new SketchIndex(r.data);
    const p = idx.point(corner);
    expect(p[0]).toBeCloseTo(20, 6);
    expect(p[1]).toBeCloseTo(2, 6);
    // Sigue siendo un rectángulo: la línea inferior horizontal.
    const [a, c] = lineEnds(idx, bottom);
    expect(a[1]).toBeCloseTo(c[1], 9);
  });

  it('el arrastre contra una cota fija respeta la cota', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l = b.line([0, 0], [10, 0]);
    b.constrain({ type: 'distance', a: l, value: 10 });
    b.constrain({ type: 'coincident', a: line(b.data, l).p1, b: 'origin' });
    const r = solveSketch(b.data, [{ point: line(b.data, l).p2, to: [30, 0] }]);
    const idx = new SketchIndex(r.data);
    expect(dist(...lineEnds(idx, l))).toBeCloseTo(10, 6);
  });
});

describe('modelo: borrado en cascada', () => {
  it('borrar una línea elimina sus puntos huérfanos y restricciones', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom] = b.rectangle([0, 0], [10, 5]);
    const d = removeItems(b.data, [bottom]);
    expect(d.entities.filter((e) => e.type === 'line')).toHaveLength(3);
    expect(d.entities.filter((e) => e.type === 'point')).toHaveLength(4); // los puntos siguen en uso
    expect(d.constraints).toHaveLength(3);
  });

  it('borrar un punto elimina las curvas que lo usan', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const l1 = b.line([0, 0], [10, 0]);
    const shared = line(b.data, l1).p2;
    b.line(shared, [10, 10]);
    b.constrain({ type: 'distance', a: l1, value: 10 });
    const d = removeItems(b.data, [shared]);
    expect(d.entities).toHaveLength(0);
    expect(d.constraints).toHaveLength(0);
  });

  it('las entidades implícitas no se borran', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const p = b.point([1, 1]);
    b.constrain({ type: 'coincident', a: p, b: 'origin' });
    const d = removeItems(b.data, ['origin']);
    expect(d.constraints).toHaveLength(1);
  });
});

describe('perfiles', () => {
  it('encuentra lazos de líneas aunque estén dibujados en cualquier orden y sentido', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const p = [b.point([0, 0]), b.point([10, 0]), b.point([10, 10]), b.point([0, 10])];
    b.line(p[1], p[0]);
    b.line(p[2], p[3]);
    b.line(p[1], p[2]);
    b.line(p[0], p[3]);
    const { regions, openChains } = findProfiles(b.data);
    expect(regions).toHaveLength(1);
    expect(openChains).toBe(0);
    expect(regions[0].outer.area).toBeCloseTo(100, 9); // orientado antihorario
  });

  it('une extremos coincidentes que son puntos distintos', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.line([0, 0], [10, 0]);
    b.line([10, 0], [5, 8]);
    b.line([5, 8], [0, 0]);
    expect(findProfiles(b.data).regions).toHaveLength(1);
  });

  it('anida agujeros y separa islas dentro de agujeros', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.rectangle([-20, -20], [20, 20]);
    b.circle([0, 0], 10);
    b.circle([0, 0], 4); // isla dentro del agujero
    const { regions } = findProfiles(b.data);
    expect(regions).toHaveLength(2);
    const big = regions.find((r) => r.outer.area > 1000)!;
    expect(big.holes).toHaveLength(1);
    expect(big.holes[0].area).toBeLessThan(0); // agujero horario
    expect(regions.find((r) => r !== big)!.holes).toHaveLength(0);
  });

  it('cuenta cadenas abiertas y rechaza vértices con más de dos curvas', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    b.line([0, 0], [10, 0]);
    b.line([10, 0], [10, 10]);
    expect(findProfiles(b.data)).toMatchObject({ regions: [], openChains: 1 });

    const c = new SketchBuilder({ entities: [], constraints: [] });
    const center = c.point([0, 0]);
    c.line(center, [10, 0]);
    c.line(center, [0, 10]);
    c.line(center, [-10, 0]);
    expect(() => findProfiles(c.data)).toThrow(ProfileError);
  });

  it('lazo de dos curvas: línea y arco (semicírculo)', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const s = b.point([5, 0]);
    const e = b.point([-5, 0]);
    b.arc([0, 0], s, e);
    b.line(e, s);
    const { regions } = findProfiles(b.data);
    expect(regions).toHaveLength(1);
    expect(Math.abs(regions[0].outer.area)).toBeCloseTo((Math.PI * 25) / 2, 1);
  });
});
