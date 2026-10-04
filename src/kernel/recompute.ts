// Motor de recálculo: recorre el documento y regenera el sólido, reutilizando resultados en cache.
import { activeCount } from '../document/ops';
import type { CadDocument, Feature, FeatureId, ProfileFeature } from '../document/types';
import { describeError, FeatureError, hashString } from './occtUtils';
import type { NamedShape } from './naming';
import { runExtrude } from './features/extrude';
import { runRevolve } from './features/revolve';
import { runEdgeFeature, runShell } from './features/dressup';
import { describeSketch, evaluateSketch, type EvaluatedSketch } from './features/sketch';
import type { FeatureResult, FeatureStatus } from './protocol';

interface CacheEntry {
  /** Hash de (clave de la entrada + parámetros de la feature + estado de dependencias). */
  key: string;
  /** Sólido nombrado después de la feature. Si `owned` es false, es el mismo objeto que la entrada. */
  output: NamedShape | null;
  owned: boolean;
  /** Para features de sketch: el sketch resuelto, que consumen las features posteriores. */
  sketch?: EvaluatedSketch;
  status: Extract<FeatureStatus, 'ok' | 'error'>;
  error?: string;
  info?: string;
  timeMs: number;
}

export interface RecomputeOutput {
  results: FeatureResult[];
  /** Sólido final con nombres (propiedad del motor: válido hasta la próxima llamada a run o dispose). */
  shape: NamedShape | null;
  /** Sketches evaluados en este recálculo. */
  sketches: Map<FeatureId, EvaluatedSketch>;
}

const ROOT_KEY = 'root';

interface Context {
  input: NamedShape | null;
  sketches: Map<FeatureId, EvaluatedSketch>;
  doc: CadDocument;
  index: number;
}

export class RecomputeEngine {
  private cache = new Map<FeatureId, CacheEntry>();
  /** Sólido de entrada de cada feature evaluada en el último recálculo (propiedad de la cache). */
  private lastInputs = new Map<FeatureId, NamedShape | null>();
  private lastSketches = new Map<FeatureId, EvaluatedSketch>();
  private lastDoc: CadDocument | null = null;

  /** Contexto de la feature en el último recálculo, o null si no se evaluó (retrocedida/suprimida). */
  contextOf(id: FeatureId): { input: NamedShape | null; sketches: Map<FeatureId, EvaluatedSketch>; doc: CadDocument } | null {
    if (!this.lastDoc || !this.lastInputs.has(id)) return null;
    return { input: this.lastInputs.get(id)!, sketches: this.lastSketches, doc: this.lastDoc };
  }

  run(doc: CadDocument): RecomputeOutput {
    const active = activeCount(doc);
    const results: FeatureResult[] = [];
    const sketches = new Map<FeatureId, EvaluatedSketch>();
    let current: NamedShape | null = null;
    let currentKey = ROOT_KEY;
    this.lastInputs = new Map();
    this.lastSketches = sketches;
    this.lastDoc = doc;

    doc.features.forEach((feature, index) => {
      if (index >= active) {
        results.push({ id: feature.id, status: 'rolledBack', timeMs: 0, cached: false });
        return;
      }
      if (feature.suppressed) {
        // Una feature suprimida es transparente: no cambia ni el sólido ni la clave.
        results.push({ id: feature.id, status: 'suppressed', timeMs: 0, cached: false });
        return;
      }

      const ctx: Context = { input: current, sketches, doc, index };
      this.lastInputs.set(feature.id, current);
      // La clave incluye el estado de las dependencias (p. ej. un sketch borrado vs. suprimido).
      const key = hashString(currentKey + '\u0000' + featureFingerprint(feature) + '\u0000' + dependencyState(feature, ctx));
      let entry = this.cache.get(feature.id);
      const cached = entry?.key === key;
      if (!cached) {
        if (entry) this.release(entry);
        entry = this.compute(feature, ctx, key);
        this.cache.set(feature.id, entry);
      }
      const e = entry!;
      if (e.sketch) sketches.set(feature.id, e.sketch);
      results.push({ id: feature.id, status: e.status, error: e.error, info: e.info, timeMs: e.timeMs, cached });
      current = e.output;
      // Si la feature falló, el sólido sigue siendo el de la entrada y la clave también.
      currentKey = e.status === 'ok' ? key : currentKey;
    });

    this.evictMissing(doc);
    return { results, shape: current, sketches };
  }

  dispose() {
    for (const entry of this.cache.values()) this.release(entry);
    this.cache.clear();
    this.lastInputs.clear();
    this.lastDoc = null;
  }

  /** Cantidad de entradas en cache (para tests y diagnóstico). */
  get cacheSize() {
    return this.cache.size;
  }

  private compute(feature: Feature, ctx: Context, key: string): CacheEntry {
    const t0 = performance.now();
    const ok = (output: NamedShape): CacheEntry => ({ key, output, owned: true, status: 'ok', timeMs: elapsed(t0) });
    try {
      switch (feature.type) {
        case 'sketch': {
          const sketch = evaluateSketch(feature, ctx.input);
          // Un sketch no modifica el sólido.
          return { key, output: ctx.input, owned: false, sketch, status: 'ok', info: describeSketch(sketch), timeMs: elapsed(t0) };
        }
        case 'extrude':
          return ok(runExtrude(feature, resolveSketch(feature, ctx), ctx.input));
        case 'revolve':
          return ok(runRevolve(feature, resolveSketch(feature, ctx), ctx.input));
        case 'fillet':
        case 'chamfer':
          return ok(runEdgeFeature(feature, ctx.input));
        case 'shell':
          return ok(runShell(feature, ctx.input));
      }
    } catch (err) {
      return { key, output: ctx.input, owned: false, status: 'error', error: describeError(err), timeMs: elapsed(t0) };
    }
  }

  private evictMissing(doc: CadDocument) {
    const ids = new Set(doc.features.map((f) => f.id));
    for (const [id, entry] of this.cache) {
      if (!ids.has(id)) {
        this.release(entry);
        this.cache.delete(id);
      }
    }
  }

  private release(entry: CacheEntry) {
    if (entry.owned && entry.output) entry.output.shape.delete();
    entry.output = null;
    entry.owned = false;
  }
}

function dependencyState(feature: Feature, ctx: Context): string {
  if (feature.type !== 'extrude' && feature.type !== 'revolve') return '';
  try {
    resolveSketch(feature, ctx);
    return 'ok';
  } catch (err) {
    return (err as Error).message;
  }
}

/** Busca el sketch que usa una feature y explica por qué no está disponible si falta. */
function resolveSketch(feature: ProfileFeature, ctx: Context): EvaluatedSketch {
  const evaluated = ctx.sketches.get(feature.sketch);
  if (evaluated) return evaluated;
  const what = feature.type === 'extrude' ? 'esta extrusión' : 'esta revolución';
  const i = ctx.doc.features.findIndex((f) => f.id === feature.sketch);
  if (i < 0) throw new FeatureError(`El sketch de ${what} fue borrado`);
  const target = ctx.doc.features[i];
  if (target.type !== 'sketch') throw new FeatureError(`"${target.name}" no es un sketch`);
  if (i > ctx.index) throw new FeatureError(`El sketch "${target.name}" está después en el historial`);
  if (target.suppressed) throw new FeatureError(`El sketch "${target.name}" está suprimido`);
  throw new FeatureError(`El sketch "${target.name}" tiene errores`);
}

/** Parámetros que afectan la geometría (excluye nombre y supresión). */
function featureFingerprint(feature: Feature): string {
  const { name: _name, suppressed: _suppressed, ...geometric } = feature;
  return stableStringify(geometric);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function elapsed(t0: number) {
  return Math.round((performance.now() - t0) * 10) / 10;
}
