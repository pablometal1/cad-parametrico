import { describe, it, expect } from 'vitest';
import { History } from '../src/document/history';

describe('historial de deshacer/rehacer', () => {
  it('deshace y rehace en orden; un cambio nuevo borra lo rehacible', () => {
    const h = new History<string>();
    let s = 'a';
    const change = (next: string) => {
      h.record(s);
      s = next;
    };
    change('b');
    change('c');
    s = h.undo(s)!;
    expect(s).toBe('b');
    s = h.undo(s)!;
    expect(s).toBe('a');
    expect(h.undo(s)).toBeNull();
    s = h.redo(s)!;
    expect(s).toBe('b');
    change('x');
    expect(h.canRedo).toBe(false);
    expect(h.undo(s)).toBe('b');
  });

  it('agrupa cambios seguidos con la misma clave dentro de la ventana de tiempo', () => {
    let t = 0;
    const h = new History<number>(200, 1000, () => t);
    let s = 0;
    const change = (next: number, key?: string, sticky = false) => {
      h.record(s, { coalesce: key, sticky });
      s = next;
    };
    change(1, 'drag');
    t = 100;
    change(2, 'drag');
    t = 200;
    change(3, 'drag');
    expect(h.depth).toBe(1);
    t = 5000; // pasó la ventana: paso nuevo
    change(4, 'drag');
    expect(h.depth).toBe(2);
    change(5, 'otra');
    expect(h.depth).toBe(3);
    expect(h.undo(s)).toBe(4);
  });

  it('agrupación "sticky" sin límite de tiempo, y corte explícito', () => {
    let t = 0;
    const h = new History<number>(200, 10, () => t);
    let s = 0;
    for (let i = 1; i <= 5; i++) {
      t += 1000;
      h.record(s, { coalesce: 'dialog', sticky: true });
      s = i;
    }
    expect(h.depth).toBe(1);
    expect(h.undo(s)).toBe(0);

    h.record(0, { coalesce: 'k', sticky: true });
    h.breakCoalescing();
    h.record(1, { coalesce: 'k', sticky: true });
    expect(h.depth).toBe(2);
  });

  it('limita la cantidad de pasos y descarta lo rehacible a pedido', () => {
    const h = new History<number>(3);
    for (let i = 0; i < 10; i++) h.record(i);
    expect(h.depth).toBe(3);
    h.undo(10);
    expect(h.canRedo).toBe(true);
    h.discardRedo();
    expect(h.canRedo).toBe(false);
  });
});
