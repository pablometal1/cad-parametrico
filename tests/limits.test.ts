import { describe, it, expect, beforeAll } from 'vitest';
import twoBodiesShell from './fixtures/two-bodies-shell.json?raw';
import { parseDocument } from '../src/document/serialize';
import { volume } from '../src/kernel/features/measure';
import { addFeature, makeFillet, makeShell } from '../src/document/ops';
import type { CadDocument, ShellFeature } from '../src/document/types';
import { initOCCT } from '../src/kernel/occt';
import { RecomputeEngine } from '../src/kernel/recompute';
import { largestThatWorks } from '../src/kernel/features/dressup';
import { edgeRefOf, faceRefOf, type NamedShape } from '../src/kernel/naming';
import { initSolver } from '../src/sketch/solver';
import { build, rect } from './helpers';

beforeAll(async () => {
  await Promise.all([initOCCT(), initSolver()]);
}, 60_000);

function edgeIdx(s: NamedShape, p: [number, number, number]) {
  const i = s.shape.edges.findIndex((e) => {
    const m = e.pointAt(0.5).toTuple();
    return Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]) < 1e-6;
  });
  if (i < 0) throw new Error(`No hay arista en ${p}`);
  return i;
}
const topFace = (s: NamedShape) =>
  faceRefOf(s, s.shape.faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.toTuple()[2] - 20) < 1e-6));

function run(doc: CadDocument) {
  const e = new RecomputeEngine();
  const out = e.run(doc);
  const last = out.results[out.results.length - 1];
  const res = { status: last.status, error: last.error ?? '' };
  e.dispose();
  return res;
}

/** Calcula el documento y usa el sólido antes de liberarlo. */
function withShape<T>(doc: CadDocument, fn: (s: NamedShape) => T): T {
  const e = new RecomputeEngine();
  try {
    return fn(e.run(doc).shape!);
  } finally {
    e.dispose();
  }
}

/** El "≈ X mm" que sugiere el mensaje de error. */
function suggested(error: string) {
  const m = error.match(/≈ ([\d.]+) mm/);
  if (!m) throw new Error(`El mensaje no sugiere un máximo: ${error}`);
  return Number(m[1]);
}

describe('límites de redondeo y vaciado', () => {
  it('bisección: encuentra el mayor valor que funciona', () => {
    const v = largestThatWorks(10, (x) => x <= 3.7)!;
    expect(v).toBeLessThanOrEqual(3.7);
    expect(v).toBeGreaterThan(3.65);
    expect(largestThatWorks(10, () => false)).toBeNull();
  });

  it('pared de 0,2 mm: el redondeo exterior dice cuánto entra, y ese valor funciona', () => {
    const base = build({ profile: rect(10, 10), distance: 20 });
    const doc = addFeature(base, makeShell(base, [withShape(base, topFace)], 0.2));

    // Arista vertical exterior: el arco no puede atravesar la esquina interior.
    // Límite geométrico: r·(1 − 1/√2) = 0,2 → r ≈ 0,683.
    const vertical = withShape(doc, (s) => edgeRefOf(s, edgeIdx(s, [5, 5, 10])));
    const failed = run(addFeature(doc, makeFillet(doc, [vertical], 2)));
    expect(failed.status).toBe('error');
    expect(failed.error).toMatch(/pared/);
    const max = suggested(failed.error);
    expect(max).toBeGreaterThan(0.6);
    expect(max).toBeLessThan(0.69);
    expect(run(addFeature(doc, makeFillet(doc, [vertical], max))).status).toBe('ok');

    // Borde superior: la cara del borde mide 0,2 mm de ancho.
    const rim = withShape(doc, (s) => edgeRefOf(s, edgeIdx(s, [0, -5, 20])));
    const rimMax = suggested(run(addFeature(doc, makeFillet(doc, [rim], 2))).error);
    expect(rimMax).toBeLessThan(0.2);
    expect(rimMax).toBeGreaterThan(0.15);
    expect(run(addFeature(doc, makeFillet(doc, [rim], rimMax))).status).toBe('ok');
  });

  it('vaciado después de un redondeo de 1 mm: el espesor tiene que ser menor que el radio', () => {
    const base = build({ profile: rect(10, 10), distance: 20 });
    const verticals = withShape(base, (s) => [[5, 5], [-5, 5], [5, -5], [-5, -5]].map(([x, y]) => edgeRefOf(s, edgeIdx(s, [x, y, 10]))));
    const doc = addFeature(base, makeFillet(base, verticals, 1));
    const top = withShape(doc, topFace);

    const failed = run(addFeature(doc, makeShell(doc, [top], 1.5)));
    expect(failed.status).toBe('error');
    const max = suggested(failed.error);
    expect(max).toBeGreaterThan(0.9);
    expect(max).toBeLessThan(1);
    expect(run(addFeature(doc, makeShell(doc, [top], max))).status).toBe('ok');

    // En el orden inverso (redondeo primero) un radio de 2 con pared de 0,2 sí funciona.
    const doc2 = addFeature(base, makeFillet(base, verticals, 2));
    expect(run(addFeature(doc2, makeShell(doc2, [withShape(doc2, topFace)], 0.2))).status).toBe('ok');
  });
});

describe('vaciado en piezas reales', () => {
  // Documento de un usuario: caja 10×10×20 + cilindro aparte (dos cuerpos), vaciado de la caja,
  // un saliente cilíndrico unido con redondeos de 0,3 y 0,4 mm, y un vaciado del saliente.
  const fixture = () => parseDocument(twoBodiesShell);
  const statuses = (doc: CadDocument) => {
    const e = new RecomputeEngine();
    const out = e.run(doc);
    const res = Object.fromEntries(out.results.map((r, i) => [doc.features[i].name, r.status === 'ok' ? 'ok' : r.error]));
    const vol = out.shape ? volume(out.shape.shape) : 0;
    const solids = out.shape?.shape.solids.length ?? 0;
    e.dispose();
    return { res, vol, solids };
  };

  it('con dos cuerpos se vacía solo el que tiene la cara quitada', () => {
    const doc = fixture();
    const upToShell = { ...doc, rollback: 3 };
    const { res, vol, solids } = statuses(upToShell);
    expect(res.Vaciado1).toBe('ok');
    expect(solids).toBe(2);
    // Cilindro intacto (π·r²·20, r² = 80) + caja con paredes de 0,2 mm.
    const cylinder = Math.PI * 80 * 20;
    const box = 10 * 10 * 20 - 9.6 * 9.6 * 19.8;
    expect(vol).toBeCloseTo(cylinder + box, 2);
  });

  it('vaciado después de redondeos sobre un cilindro (OCCT directo falla, se resuelve por booleanas)', () => {
    const { res } = statuses(fixture());
    expect(res.Vaciado1).toBe('ok');
    expect(res.Vaciado2).toBe('ok');
    // Vaciado3 quita la misma cara que Vaciado2, que ya no existe.
    expect(res.Vaciado3).toMatch(/Referencia perdida/);
  });

  it('un solo vaciado al final quitando la tapa y el extremo del saliente', () => {
    const base = fixture();
    const v1 = base.features.find((f) => f.name === 'Vaciado1') as ShellFeature;
    const v2 = base.features.find((f) => f.name === 'Vaciado2') as ShellFeature;
    const rest = base.features.filter((f) => !f.name.startsWith('Vaciado'));
    const vols: number[] = [];
    for (const t of [0.2, 0.35]) {
      const doc = { ...base, features: [...rest, { ...v2, name: 'Final', faces: [...v1.faces, ...v2.faces], thickness: t }] };
      const { res, vol } = statuses(doc);
      expect(res.Final, `espesor ${t}`).toBe('ok');
      vols.push(vol);
    }
    // Más espesor deja más material, y nunca más que la pieza maciza.
    const solid = statuses({ ...base, features: rest }).vol;
    expect(vols[1]).toBeGreaterThan(vols[0]);
    expect(vols[1]).toBeLessThan(solid);
    // Pared de 0,2 mm: se quita casi todo el interior de la caja (≈ 9,6 × 9,6 × 19,8).
    expect(solid - vols[0]).toBeGreaterThan(9.5 * 9.5 * 19.7);
  });
});

describe('segundo vaciado sobre una pieza ya vaciada', () => {
  // Documento actual del usuario: caja vaciada a 0,2 mm, tubo unido al costado y Vaciado2 en
  // la punta del tubo. Antes solo funcionaba con menos de 0,1 mm (se re-ahuecaban las paredes).
  const doc = (t: number): CadDocument => {
    const base = parseDocument(twoBodiesShell);
    return {
      ...base,
      features: base.features
        .filter((f) => f.type !== 'fillet' && f.name !== 'Vaciado3')
        .map((f) => (f.name === 'Vaciado2' ? { ...(f as ShellFeature), thickness: t } : f)),
    };
  };
  const result = (d: CadDocument) => {
    const e = new RecomputeEngine();
    const out = e.run(d);
    const last = out.results[out.results.length - 1];
    const r = { status: last.status, error: last.error, vol: out.shape ? volume(out.shape.shape) : 0, solids: out.shape?.shape.solids.length ?? 0 };
    e.dispose();
    return r;
  };

  it('el tubo queda hueco, abierto en la punta y conectado con el interior de la caja', () => {
    const r = result(doc(0.2));
    expect(r.status).toBe('ok');
    expect(r.solids).toBe(2);
    const cylinder = Math.PI * 80 * 20; // el otro cuerpo, intacto
    const box = 2000 - 9.6 * 9.6 * 19.8; // paredes de 0,2 que ya tenía
    const r2 = 8; // radio del tubo al cuadrado
    const ri2 = (Math.sqrt(r2) - 0.2) ** 2;
    const tube = Math.PI * (r2 - ri2) * 11.5;
    const hole = Math.PI * ri2 * 0.2; // la pared de la caja se abre donde entra el tubo
    // Donde el tubo entra en la caja el hueco queda con un redondeo interior de 0,2 mm, que quita
    // 2π·r·0,2²·(1 − π/4) ≈ 0,14 mm³ más que la cuenta con aristas vivas.
    const junction = 2 * Math.PI * Math.sqrt(ri2) * 0.04 * (1 - Math.PI / 4);
    expect(r.vol).toBeCloseTo(cylinder + box + tube - hole - junction, 1);
  });

  it('funciona con espesores mayores que la mitad de la pared existente', () => {
    for (const t of [0.1, 0.3, 0.5, 1]) expect(result(doc(t)).status, `espesor ${t}`).toBe('ok');
  });
});
