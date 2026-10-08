import { describe, it, expect, beforeAll } from 'vitest';
import { createRoot } from 'solid-js';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { createSketchSession } from '../src/ui/sketch/session';

beforeAll(async () => {
  await initSolver();
}, 30_000);

function session(scope: Record<string, number>) {
  const b = new SketchBuilder({ entities: [], constraints: [] });
  const [bottom] = b.rectangle([0, 0], [10, 5]);
  return { bottom, s: createRoot(() => createSketchSession(b.data, { scope: () => new Map(Object.entries(scope)) })) };
}

describe('sesión del editor de sketch: cotas con expresiones', () => {
  it('una cota escrita como expresión usa el valor del parámetro y guarda la expresión', () => {
    const { s, bottom } = session({ largo: 40 });
    s.select(bottom, false);
    s.applyConstraint('distance');
    expect(s.prompt()?.value).toBeCloseTo(10, 6);
    s.confirmPrompt('largo / 2');
    expect(s.prompt()).toBeNull();
    const k = s.data().constraints.find((c) => c.type === 'distance')!;
    expect(k).toMatchObject({ value: 20 });
    expect(s.documentExprs()).toEqual({ [`constraint:${k.id}`]: 'largo / 2' });

    // Editar la cota con un número quita la expresión; deshacer la recupera.
    s.editDimension(k.id);
    expect(s.prompt()?.text).toBe('largo / 2');
    s.confirmPrompt('25');
    expect(s.documentExprs()).toEqual({});
    s.undo();
    expect(s.documentExprs()).toEqual({ [`constraint:${k.id}`]: 'largo / 2' });
  });

  it('expresiones inválidas o no positivas dan un mensaje y no cambian el sketch', () => {
    const { s, bottom } = session({ cero: 0 });
    s.select(bottom, false);
    s.applyConstraint('distance');
    s.confirmPrompt('ancho * 2');
    expect(s.message()?.text).toMatch(/No existe el parámetro "ancho"/);
    s.confirmPrompt('cero');
    expect(s.message()?.text).toMatch(/mayor que 0/);
    expect(s.data().constraints.some((c) => c.type === 'distance')).toBe(false);
  });

  it('borrar la cota descarta su expresión', () => {
    const { s, bottom } = session({ L: 30 });
    s.select(bottom, false);
    s.applyConstraint('distance');
    s.confirmPrompt('L');
    const k = s.data().constraints.find((c) => c.type === 'distance')!;
    s.select(k.id, false);
    s.deleteSelection();
    expect(s.documentExprs()).toEqual({});
  });
});

describe('sesión del editor de sketch: herramientas de edición', () => {
  const make = () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const lines = b.rectangle([0, 0], [20, 10]);
    return { lines, s: createRoot(() => createSketchSession(b.data)) };
  };

  it('desfase: pide la distancia, crea la copia y la deja elegida; deshacer la quita', () => {
    const { s, lines } = make();
    for (const l of lines) s.select(l, true);
    s.startEdit('offset');
    expect(s.actionPrompt()?.action).toBe('offset');
    s.confirmAction(['3']);
    expect(s.actionPrompt()).toBeNull();
    expect(s.selection().length).toBe(4);
    expect(s.data().entities.filter((e) => e.type === 'line' && !e.construction).length).toBe(8);
    s.undo();
    expect(s.data().entities.filter((e) => e.type === 'line' && !e.construction).length).toBe(4);
  });

  it('redondeo de esquina con un radio que no entra: mensaje y el sketch no cambia', () => {
    const { s, lines } = make();
    s.select(lines[0], false);
    s.select(lines[1], true);
    s.startEdit('fillet');
    const before = s.data();
    s.confirmAction(['50']);
    expect(s.data()).toBe(before);
    expect(s.message()).toMatchObject({ kind: 'error' });
    expect(s.actionPrompt()).not.toBeNull();
    s.confirmAction(['2']);
    expect(s.data().entities.some((e) => e.type === 'arc')).toBe(true);
  });

  it('simetría sin línea al final da una pista; con el eje Y refleja', () => {
    const { s, lines } = make();
    s.select(lines[0], false);
    s.startEdit('mirror');
    expect(s.message()).toMatchObject({ kind: 'hint' });
    for (const l of lines) s.select(l, true);
    s.select('axisY', true);
    s.startEdit('mirror');
    expect(s.data().constraints.filter((c) => c.type === 'symmetric').length).toBeGreaterThan(0);
  });

  it('recortar: con la herramienta, un clic sobre una línea suelta la borra', () => {
    const { s, lines } = make();
    s.setTool('trim');
    s.trimAt(lines[0], [10, 0]);
    // El lado inferior no tiene intersecciones interiores: se borra entero.
    expect(s.data().entities.some((e) => e.id === lines[0])).toBe(false);
  });

  it('patrón circular alrededor del origen con cantidad como expresión', () => {
    const b = new SketchBuilder({ entities: [], constraints: [] });
    const c = b.circle([10, 0], 1);
    const s = createRoot(() => createSketchSession(b.data, { scope: () => new Map([['n', 4]]) }));
    s.select(c, false);
    s.startEdit('circular');
    s.confirmAction(['n * 2', '360']);
    expect(s.data().entities.filter((e) => e.type === 'circle').length).toBe(8);
  });
});
