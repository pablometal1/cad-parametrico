import { describe, it, expect, beforeAll } from 'vitest';
import { updateParameter } from '../src/document/ops';
import { initOCCT } from '../src/kernel/occt';
import { KernelService } from '../src/kernel/service';
import { initSolver } from '../src/sketch/solver';
import { buildTemplate, TEMPLATE_LIST } from '../src/templates';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

describe('biblioteca de modelos', () => {
  for (const info of TEMPLATE_LIST) {
    it(`${info.name}: se arma sin errores y responde a los parámetros`, async () => {
      const k = new KernelService();
      await k.init();
      const doc = buildTemplate(info.id, k);
      const r = k.recompute(doc);
      const errors = r.features.filter((f) => f.status === 'error').map((f) => `${doc.features.find((x) => x.id === f.id)?.name}: ${f.error}`);
      expect(errors).toEqual([]);
      const m = k.massProperties();
      expect(m.volume).toBeGreaterThan(0);
      // Cambiar las medidas principales regenera todo sin errores.
      let d = doc;
      for (const [name, expr] of [['largo', '750'], ['ancho', '280'], ['alto', '340']] as const) {
        const p = d.parameters.find((x) => x.name === name);
        if (p) d = updateParameter(d, p.id, { expression: expr });
      }
      const r2 = k.recompute(d);
      const errors2 = r2.features.filter((f) => f.status === 'error').map((f) => `${d.features.find((x) => x.id === f.id)?.name}: ${f.error}`);
      expect(errors2).toEqual([]);
      expect(k.massProperties().volume).not.toBeCloseTo(m.volume, 0);
    }, 120_000);
  }
});
