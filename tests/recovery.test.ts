import { describe, it, expect, beforeAll } from 'vitest';
import { createRoot } from 'solid-js';
import { addFeature, makeHole, makeSketch, makeThread } from '../src/document/ops';
import type { CadDocument } from '../src/document/types';
import type { KernelClient } from '../src/kernel/client';
import type { RecomputeResult } from '../src/kernel/protocol';
import { KernelService } from '../src/kernel/service';
import { RecomputeEngine } from '../src/kernel/recompute';
import { faceRefOf } from '../src/kernel/naming';
import { SketchBuilder } from '../src/sketch/builders';
import { initSolver } from '../src/sketch/solver';
import { createCadStore } from '../src/ui/store';
import { build, circle, rect } from './helpers';

beforeAll(async () => {
  await initSolver();
}, 60_000);

const EMPTY: RecomputeResult = { features: [], mesh: null, sketches: [], parameters: [], planes: [], curves: [], references: [], totalMs: 0 };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Kernel simulado: `fails` dice si cada llamada a recompute falla. */
function fakeKernel(fails: (call: number) => boolean) {
  const calls = { recompute: 0, restart: 0 };
  const kernel = {
    init: async () => ({ occtLoadMs: 0 }),
    recompute: async () => {
      calls.recompute++;
      if (fails(calls.recompute)) throw new Error('error interno de OpenCascade');
      return EMPTY;
    },
    restart: async () => {
      calls.restart++;
    },
  } as unknown as KernelClient;
  return { kernel, calls };
}

function store(kernel: KernelClient) {
  return createRoot(() => createCadStore(kernel, { onMesh: () => {}, onSketches: () => {} }));
}

describe('el kernel se recupera solo', () => {
  it('si un recálculo falla, reinicia el kernel y reintenta; la app sigue lista', async () => {
    const { kernel, calls } = fakeKernel((n) => n === 1);
    const s = store(kernel);
    await s.start();
    await tick();
    expect(calls.restart).toBe(1);
    expect(calls.recompute).toBe(2);
    expect(s.kernelState().state).toBe('ready');
    expect(s.recomputeError()).toBeNull();
  });

  it('si sigue fallando avisa, pero el próximo cambio se vuelve a calcular', async () => {
    let broken = true;
    const { kernel, calls } = fakeKernel(() => broken);
    const s = store(kernel);
    await s.start();
    await tick();
    expect(s.kernelState().state).toBe('ready');
    expect(s.recomputeError()).toMatch(/error interno/);
    // El usuario deshace o cambia algo: se recalcula y, si anda, el aviso desaparece.
    broken = false;
    const before = calls.recompute;
    s.newDocument();
    await tick();
    await tick();
    expect(calls.recompute).toBeGreaterThan(before);
    expect(s.recomputeError()).toBeNull();
  });
});

describe('malla para mostrar', () => {
  it('las roscas se muestran con una cantidad razonable de triángulos', () => {
    const k = new KernelService();
    return k.init().then(() => {
      // Rosca externa M8 en una barra y agujero M8 roscado.
      let rod = build({ profile: circle(4), distance: 15 });
      const e = new RecomputeEngine();
      const s = e.run(rod).shape!;
      const side = faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'CYLINDRE'));
      e.dispose();
      rod = addFeature(rod, makeThread(rod, side, 1.25));
      const r1 = k.recompute(rod);
      expect(r1.features.every((f) => f.status === 'ok')).toBe(true);
      expect(r1.mesh!.indices.length / 3).toBeLessThan(50_000);

      let block: CadDocument = build({ profile: rect(40, 40), distance: 30 });
      const b = new SketchBuilder({ entities: [], constraints: [] });
      b.point([0, 0]);
      const sk = makeSketch(block, { plane: { kind: 'base', plane: 'XY', offset: 30 }, ...b.data });
      block = addFeature(block, sk);
      block = addFeature(block, makeHole(block, sk.id, { diameter: 8, thread: true, threadPitch: 1.25 }));
      const r2 = k.recompute(block);
      expect(r2.features.every((f) => f.status === 'ok')).toBe(true);
      expect(r2.mesh!.indices.length / 3).toBeLessThan(50_000);
      k.dispose();
    });
  }, 120_000);
});
