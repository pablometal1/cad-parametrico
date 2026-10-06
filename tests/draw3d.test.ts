import { describe, it, expect, beforeAll } from 'vitest';
import { createRoot } from 'solid-js';
import { basePlaneFrame, toWorld, type PlaneFrame } from '../src/document/planes';
import type { SketchData } from '../src/document/types';
import { initSolver } from '../src/sketch/solver';
import { createDirectDraw } from '../src/ui/draw3d/controller';
import { gridStep, previewLabel, previewSegments2D, snapToGrid, toWorldSegments } from '../src/ui/draw3d/preview';

beforeAll(async () => {
  await initSolver();
}, 30_000);

describe('vista previa del dibujo directo', () => {
  it('rectángulo: 4 lados y medidas', () => {
    const pending = { tool: 'rectangle' as const, corner: { pos: [0, 0] as [number, number] } };
    expect(previewSegments2D(pending, [10, 5])).toHaveLength(8);
    expect(previewLabel(pending, [10, -5])).toBe('10 × 5 mm');
  });

  it('círculo y arco', () => {
    const c = { tool: 'circle' as const, center: { pos: [0, 0] as [number, number] } };
    expect(previewLabel(c, [3, 4])).toBe('R 5 mm');
    expect(previewSegments2D(c, [3, 4]).length).toBeGreaterThan(16);
    const a = { tool: 'arc' as const, center: { pos: [0, 0] as [number, number] }, start: { pos: [5, 0] as [number, number] } };
    expect(previewLabel(a, [0, 5])).toBe('90°');
  });

  it('a 3D sobre el plano, grilla y paso redondo', () => {
    const xz = basePlaneFrame({ kind: 'base', plane: 'XZ', offset: 0 });
    expect(toWorldSegments(xz, [[1, 2]])).toEqual([1, 0, 2]);
    expect(snapToGrid([1.4, -2.6], 1)).toEqual([1, -3]);
    expect(gridStep(0.1)).toBe(2); // 0.1 mm/px × 18 px = 1.8 → 2
    expect(gridStep(1)).toBe(20);
  });
});

/** Viewport de prueba: proyección ortográfica simple (1 px = 1 mm) del plano XY. */
function fakeViewport() {
  const calls: { mode: PlaneFrame | null } = { mode: null };
  const vp = {
    handlers: null as unknown,
    setDrawMode: (frame: PlaneFrame | null, handlers: unknown) => {
      calls.mode = frame;
      vp.handlers = handlers;
    },
    setDrawOverlay: () => {},
    project: (p: readonly number[]) => [p[0], -p[1]] as [number, number],
    mmPerPixelAt: () => 0.05, // grilla de 1 mm
  };
  return { calls, vp };
}

/** Store de prueba: registra lo que el dibujo guarda en el documento. */
function fakeStore() {
  const commits: { featureId: string | null; data: SketchData }[] = [];
  let drawing = false;
  let selected: string | null = null;
  return {
    commits,
    isDrawing: () => drawing,
    selected: () => selected,
    store: {
      evaluated: () => ({ scope: new Map<string, number>() }),
      setDrawing: (v: boolean) => { drawing = v; },
      selectFeature: (id: string | null) => { selected = id; },
      commitDirectDraw: (featureId: string | null, _plane: unknown, data: SketchData) => {
        commits.push({ featureId, data });
        return featureId ?? 'sk1';
      },
    },
  };
}

const frameXY = basePlaneFrame({ kind: 'base', plane: 'XY', offset: 0 });
const target = (data: SketchData = { entities: [], constraints: [] }) => ({
  plane: { kind: 'base' as const, plane: 'XY' as const, offset: 0 }, frame: frameXY, featureId: null, data,
  label: 'plano XY', center: [0, 0] as [number, number], extent: 50,
});
const ev = (alt = false) => ({ altKey: alt }) as PointerEvent;
const screen = (u: number, v: number) => {
  const p = toWorld(frameXY, u, v);
  return [p[0], -p[1]] as [number, number];
};

describe('controlador del dibujo directo', () => {
  it('un rectángulo con dos clics crea el sketch con 4 líneas y restricciones H/V', () => {
    const { vp, calls } = fakeViewport();
    const fs = fakeStore();
    const d = createRoot(() => createDirectDraw(fs.store as never, () => vp as never));
    d.start(target(), 'rectangle');
    expect(calls.mode).toBe(frameXY);
    expect(fs.isDrawing()).toBe(true);
    // Los clics llegan por los handlers que el controlador le pasa al viewport.
    const handlers = captureHandlers(d, vp);
    handlers.click([10.3, 5.2], screen(10.3, 5.2), ev());
    expect(fs.commits).toHaveLength(0); // primer clic: solo la primera esquina
    handlers.click([40.2, 30.4], screen(40.2, 30.4), ev());
    expect(fs.commits).toHaveLength(1);
    const data = fs.commits[0].data;
    expect(data.entities.filter((e) => e.type === 'line')).toHaveLength(4);
    expect(data.constraints.filter((c) => c.type === 'horizontal' || c.type === 'vertical')).toHaveLength(4);
    // Ajuste a la grilla de 1 mm.
    const xs = data.entities.filter((e) => e.type === 'point').map((p) => (p as { x: number }).x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(10, 6);
    expect(xs[3]).toBeCloseTo(40, 6);
    d.stop();
    expect(fs.isDrawing()).toBe(false);
    expect(calls.mode).toBeNull();
    // Al terminar no queda nada elegido (sin plano ni sketch resaltados en 3D).
    expect(fs.selected()).toBeNull();
  });

  it('las líneas encadenadas se enganchan al punto inicial y cierran el contorno', () => {
    const { vp } = fakeViewport();
    const fs = fakeStore();
    const d = createRoot(() => createDirectDraw(fs.store as never, () => vp as never));
    d.start(target(), 'line');
    const h = captureHandlers(d, vp);
    h.click([0.2, 0.1], screen(0.2, 0.1), ev()); // se engancha al origen
    h.click([20, 0], screen(20, 0), ev());
    h.click([20, 15], screen(20, 15), ev());
    h.click([0.3, 0.2], screen(0.3, 0.2), ev()); // vuelve al origen: cierra
    const last = fs.commits.at(-1)!.data;
    expect(last.entities.filter((e) => e.type === 'line')).toHaveLength(3);
    // El primer y último tramo comparten el origen implícito: contorno cerrado de 3 lados.
    const lines = last.entities.filter((e) => e.type === 'line') as { p1: string; p2: string }[];
    expect(lines[0].p1).toBe('origin');
    expect(lines[2].p2).toBe('origin');
    // Todos los tramos van al mismo sketch.
    expect(new Set(fs.commits.slice(1).map((c) => c.featureId))).toEqual(new Set(['sk1']));
  });

  it('Alt al hacer clic ignora la grilla', () => {
    const { vp } = fakeViewport();
    const fs = fakeStore();
    const d = createRoot(() => createDirectDraw(fs.store as never, () => vp as never));
    d.start(target(), 'circle');
    const h = captureHandlers(d, vp);
    h.click([25.37, 25.37], screen(25.37, 25.37), ev(true));
    h.click([28.37, 25.37], screen(28.37, 25.37), ev(true));
    expect(d.message()).toBeNull();
    expect(fs.commits).toHaveLength(1);
    const circle = fs.commits[0].data.entities.find((e) => e.type === 'circle') as { radius: number };
    expect(circle.radius).toBeCloseTo(3, 6);
  });
});

/** Recupera los handlers que el controlador registró en el viewport de prueba. */
function captureHandlers(d: ReturnType<typeof createDirectDraw>, vp: { setDrawMode: unknown }) {
  void d;
  return (vp as unknown as { handlers: { click: (uv: [number, number], s: [number, number], e: PointerEvent) => void } }).handlers;
}

describe('herramienta Punto', () => {
  it('cada clic agrega un centro de agujero; sobre un punto existente (el origen) no agrega nada', async () => {
    const { holeCenters } = await import('../src/document/holes');
    const { vp } = fakeViewport();
    const fs = fakeStore();
    const d = createRoot(() => createDirectDraw(fs.store as never, () => vp as never));
    d.start(target(), 'point');
    const h = captureHandlers(d, vp);
    // Lejos entre sí y del origen: en este viewport de prueba 1 px = 1 mm (enganche a ~10 px).
    h.click([15, 15], screen(15, 15), ev());
    h.click([30, 20], screen(30, 20), ev());
    h.click([0.1, 0.1], screen(0.1, 0.1), ev()); // se engancha al origen: no es un punto nuevo
    h.click([30.5, 20.5], screen(30.5, 20.5), ev()); // se engancha al punto anterior
    const data = fs.commits.at(-1)!.data;
    expect(holeCenters(data).map((c) => c.pos)).toEqual([[15, 15], [30, 20]]);
    d.stop();
  });
});
