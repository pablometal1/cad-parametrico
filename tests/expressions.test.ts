import { describe, it, expect, beforeAll } from 'vitest';
import {
  addFeature, addParameter, deleteParameter, makeSketch, parameterUsage, renameParameter, updateFeature, updateParameter,
} from '../src/document/ops';
import { evaluateDocument, evaluateParameters, setFieldValue } from '../src/document/evaluate';
import { evaluateExpr, ExpressionError, parseExpression, plainNumber, referencedNames, renameInExpression } from '../src/document/expressions';
import { parseDocument, serializeDocument } from '../src/document/serialize';
import type { CadDocument, ExtrudeFeature, Parameter, SketchFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { KernelService } from '../src/kernel/service';
import { volume } from '../src/kernel/features/measure';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

const ev = (text: string, vars: Record<string, number> = {}) =>
  evaluateExpr(parseExpression(text), (n) => {
    if (!(n in vars)) throw new ExpressionError(`No existe "${n}"`);
    return vars[n];
  });

describe('expresiones', () => {
  it('aritmética, precedencia y funciones (ángulos en grados)', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('-2^2')).toBe(-4);
    expect(ev('2^3^2')).toBe(512);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('sin(30)')).toBeCloseTo(0.5, 12);
    expect(ev('atan2(1, 1)')).toBeCloseTo(45, 12);
    expect(ev('max(3, 7, 5) + min(2, 1)')).toBe(8);
    expect(ev('sqrt(16) * pi')).toBeCloseTo(4 * Math.PI, 12);
    expect(ev('1.5e2')).toBe(150);
  });

  it('variables con acentos y referencias', () => {
    expect(ev('largo / 2', { largo: 80 })).toBe(40);
    expect(ev('diámetro_ext - 2 * pared', { diámetro_ext: 20, pared: 1.5 })).toBe(17);
    expect([...referencedNames(parseExpression('a + max(b, pi) * a'))]).toEqual(['a', 'b']);
  });

  it('errores claros', () => {
    expect(() => parseExpression('')).toThrow(/vacía/);
    expect(() => parseExpression('2 +')).toThrow(/incompleta/);
    expect(() => parseExpression('(1 + 2')).toThrow(/Se esperaba "\)"/);
    expect(() => parseExpression('2 $ 3')).toThrow(/Carácter no válido/);
    expect(() => parseExpression('foo(2)')).toThrow(/Función desconocida/);
    expect(() => parseExpression('sin(1, 2)')).toThrow(/argumento/);
    expect(() => ev('1 / 0')).toThrow(/finito/);
  });

  it('números sueltos con coma decimal', () => {
    expect(plainNumber('35,5')).toBe(35.5);
    expect(plainNumber(' -2.25 ')).toBe(-2.25);
    expect(plainNumber('ancho')).toBeNull();
    expect(plainNumber('1+2')).toBeNull();
  });

  it('renombrar respeta el resto del texto y no toca funciones', () => {
    expect(renameInExpression('ancho*2 + max(ancho, 3)', 'ancho', 'w')).toBe('w*2 + max(w, 3)');
    expect(renameInExpression('anchoTotal + ancho', 'ancho', 'w')).toBe('anchoTotal + w');
    expect(renameInExpression('min + min(1, 2)', 'min', 'x')).toBe('x + min(1, 2)');
  });
});

describe('tabla de parámetros', () => {
  const P = (name: string, expression: string): Parameter => ({ id: name, name, expression });

  it('evalúa en orden de dependencias', () => {
    const { values } = evaluateParameters([P('ancho', 'largo / 2'), P('largo', '80'), P('alto', 'ancho + 5')]);
    expect(values.map((v) => v.value)).toEqual([40, 80, 45]);
  });

  it('detecta ciclos, nombres desconocidos y errores en cadena', () => {
    const { values } = evaluateParameters([P('a', 'b + 1'), P('b', 'a * 2'), P('c', 'x'), P('d', 'c + 1'), P('e', '3 +')]);
    expect(values[0].error).toMatch(/circular/);
    expect(values[1].error).toMatch(/circular/);
    expect(values[2].error).toMatch(/No existe el parámetro "x"/);
    expect(values[3].error).toMatch(/"c" tiene un error/);
    expect(values[4].error).toMatch(/incompleta/);
  });

  it('operaciones: agregar, validar nombres, renombrar con referencias y uso', () => {
    let doc = build({ profile: rect(40, 30), distance: 20 });
    doc = addParameter(doc, 'largo', '80');
    doc = addParameter(doc, 'ancho', 'largo / 2');
    expect(() => addParameter(doc, 'largo', '1')).toThrow(/Ya existe/);
    expect(() => addParameter(doc, '2x', '1')).toThrow(/no es un nombre válido/);
    expect(() => addParameter(doc, 'sin', '1')).toThrow(/no es un nombre válido/);

    const ext = doc.features[1] as ExtrudeFeature;
    doc = updateFeature<ExtrudeFeature>(doc, ext.id, { exprs: { distance: 'ancho / 4' } });
    expect(parameterUsage(doc, 'ancho')).toEqual([ext.name]);
    expect(parameterUsage(doc, 'largo')).toEqual(['ancho']);

    const largoId = doc.parameters[0].id;
    doc = renameParameter(doc, largoId, 'L');
    expect(doc.parameters.map((p) => `${p.name}=${p.expression}`)).toEqual(['L=80', 'ancho=L / 2']);
    doc = renameParameter(doc, doc.parameters[1].id, 'w');
    expect((doc.features[1] as ExtrudeFeature).exprs).toEqual({ distance: 'w / 4' });

    doc = updateParameter(doc, largoId, { expression: '100', comment: 'largo total' });
    expect(doc.parameters[0]).toMatchObject({ expression: '100', comment: 'largo total' });
    expect(deleteParameter(doc, largoId).parameters).toHaveLength(1);
  });

  it('serializa parámetros y expresiones (y acepta archivos sin parámetros)', () => {
    let doc = build({ profile: rect(40, 30), distance: 20 });
    doc = addParameter(doc, 'alto', '20', 'altura de la caja');
    doc = updateFeature<ExtrudeFeature>(doc, doc.features[1].id, { exprs: { distance: 'alto' } });
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);

    const raw = JSON.parse(serializeDocument(doc));
    delete raw.parameters;
    expect(parseDocument(JSON.stringify(raw)).parameters).toEqual([]);
    const bad = JSON.parse(serializeDocument(doc));
    bad.parameters[0].name = 'pi';
    expect(() => parseDocument(JSON.stringify(bad))).toThrow(/nombre de parámetro inválido/);
  });
});

describe('evaluación del documento', () => {
  it('reemplaza los campos con expresión y reporta errores por feature', () => {
    let doc = build({ profile: rect(40, 30), distance: 20 }, { profile: rect(10, 10), distance: 5, operation: 'join' });
    doc = addParameter(doc, 'alto', '35');
    const [e1, e2] = doc.features.filter((f) => f.type === 'extrude');
    doc = updateFeature<ExtrudeFeature>(doc, e1.id, { exprs: { distance: 'alto' } });
    doc = updateFeature<ExtrudeFeature>(doc, e2.id, { exprs: { distance: 'altura + 1' } });
    const r = evaluateDocument(doc);
    expect((r.doc.features.find((f) => f.id === e1.id) as ExtrudeFeature).distance).toBe(35);
    expect(r.errors.get(e2.id)).toMatch(/la distancia.*No existe el parámetro "altura"/);
    expect(r.errors.has(e1.id)).toBe(false);
  });

  it('cotas de sketch con expresiones, incluido el ángulo visible', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const A = b.point([0, 0]);
    const B = b.point([10, 0]);
    const C = b.point([0, 10]);
    const ab = b.line(A, B);
    const bc = b.line(B, C);
    b.line(C, A);
    const len = b.constrain({ type: 'distance', a: ab, value: 10 });
    // Ángulo con signo del solver entre ab y bc (exterior = 135°).
    const ang = b.constrain({ type: 'angle', a: ab, b: bc, value: 135 });
    let doc = build();
    const sk = makeSketch(doc, b.data);
    doc = addFeature(doc, sk);
    doc = addParameter(doc, 'lado', '25');
    doc = updateFeature<SketchFeature>(doc, sk.id, { exprs: { [`constraint:${len}`]: 'lado * 2', [`constraint:${ang}`]: '60' } });
    const out = evaluateDocument(doc).doc.features[0] as SketchFeature;
    expect(out.constraints.find((c) => c.id === len)).toMatchObject({ value: 50 });
    // 60° interiores → valor del solver 180 - 60 = 120 (mismo sentido que el guardado).
    expect((out.constraints.find((c) => c.id === ang) as { value: number }).value).toBeCloseTo(120, 9);
  });

  it('setFieldValue en el desplazamiento del plano', () => {
    const doc = addFeature(build(), makeSketch(build()));
    const sk = setFieldValue(doc.features[0] as SketchFeature, 'plane.offset', 7);
    expect(sk.plane.offset).toBe(7);
  });
});

describe('recálculo con parámetros', () => {
  beforeAll(async () => {
    await Promise.all([initOCCT(), initSolver()]);
  }, 60_000);

  const withParams = (): CadDocument => {
    // Caja de largo × ancho × alto con ancho = largo / 2 y la cota del sketch ligada a parámetros.
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const [bottom, right] = b.rectangle([0, 0], [10, 10]);
    const kL = b.constrain({ type: 'distance', a: bottom, value: 10 });
    const kW = b.constrain({ type: 'distance', a: right, value: 10 });
    let doc = build();
    const sk = makeSketch(doc, b.data);
    doc = addFeature(doc, { ...sk, exprs: { [`constraint:${kL}`]: 'largo', [`constraint:${kW}`]: 'ancho' } });
    doc = addParameter(doc, 'largo', '80');
    doc = addParameter(doc, 'ancho', 'largo / 2');
    doc = addParameter(doc, 'alto', '10');
    const built = build({ profile: rect(1, 1), distance: 1 });
    const ext = { ...(built.features[1] as ExtrudeFeature), id: 'ext', sketch: sk.id, exprs: { distance: 'alto' } };
    return addFeature(doc, ext);
  };

  it('cambiar un parámetro cambia el sólido; un error de expresión no rompe el modelo', () => {
    const engine = new RecomputeEngine();
    let doc = withParams();
    let r = evaluateDocument(doc);
    let out = engine.run(r.doc, r.errors);
    expect(out.results.map((x) => x.status)).toEqual(['ok', 'ok']);
    expect(volume(out.shape!.shape)).toBeCloseTo(80 * 40 * 10, 3);

    doc = updateParameter(doc, doc.parameters[0].id, { expression: '100' });
    r = evaluateDocument(doc);
    out = engine.run(r.doc, r.errors);
    expect(volume(out.shape!.shape)).toBeCloseTo(100 * 50 * 10, 3);

    // Expresión rota en la extrusión: queda en error y no hay sólido, pero el sketch sigue bien.
    doc = updateFeature<ExtrudeFeature>(doc, 'ext', { exprs: { distance: 'alto +' } });
    r = evaluateDocument(doc);
    out = engine.run(r.doc, r.errors);
    expect(out.results.map((x) => x.status)).toEqual(['ok', 'error']);
    expect(out.results[1].error).toMatch(/Expresión de la distancia/);
    engine.dispose();
  });

  it('el servicio devuelve los valores de los parámetros', async () => {
    const k = new KernelService();
    await k.init();
    const res = k.recompute(withParams());
    expect(res.parameters.map((p) => [p.name, p.value])).toEqual([['largo', 80], ['ancho', 40], ['alto', 10]]);
    k.dispose();
  });

  it('cambiar solo el texto de la expresión (mismo valor) no recalcula', () => {
    const engine = new RecomputeEngine();
    let doc = withParams();
    let r = evaluateDocument(doc);
    engine.run(r.doc, r.errors);
    doc = updateFeature<ExtrudeFeature>(doc, 'ext', { exprs: { distance: 'alto * 1' } });
    r = evaluateDocument(doc);
    expect(engine.run(r.doc, r.errors).results.every((x) => x.cached)).toBe(true);
    engine.dispose();
  });
});
