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
