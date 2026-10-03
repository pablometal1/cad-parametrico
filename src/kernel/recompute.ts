// Motor de recálculo: recorre el documento y regenera el sólido, reutilizando resultados en cache.
import type { AnyShape } from 'replicad';
import { activeCount } from '../document/ops';
import type { CadDocument, Feature, FeatureId } from '../document/types';
import { describeError, hashString } from './occtUtils';
import { runExtrude } from './features/extrude';
import type { FeatureResult, FeatureStatus } from './protocol';

interface CacheEntry {
  /** Hash de (clave de la entrada + parámetros de la feature). */
  key: string;
  /** Sólido después de la feature. Si `owned` es false, es el mismo objeto que la entrada. */
  output: AnyShape | null;
  owned: boolean;
  status: Extract<FeatureStatus, 'ok' | 'error'>;
  error?: string;
  timeMs: number;
}

export interface RecomputeOutput {
  results: FeatureResult[];
  /** Sólido final (propiedad del motor: válido hasta la próxima llamada a run o dispose). */
  shape: AnyShape | null;
}

const ROOT_KEY = 'root';

export class RecomputeEngine {
  private cache = new Map<FeatureId, CacheEntry>();

  run(doc: CadDocument): RecomputeOutput {
    const active = activeCount(doc);
    const results: FeatureResult[] = [];
    let current: AnyShape | null = null;
    let currentKey = ROOT_KEY;

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

      const key = hashString(currentKey + '\u0000' + featureFingerprint(feature));
      let entry = this.cache.get(feature.id);
      const cached = entry?.key === key;
      if (!cached) {
        if (entry) this.release(entry);
        entry = this.compute(feature, current, key);
        this.cache.set(feature.id, entry);
      }
      results.push({ id: feature.id, status: entry!.status, error: entry!.error, timeMs: entry!.timeMs, cached });
      current = entry!.output;
      // Si la feature falló, el sólido sigue siendo el de la entrada y la clave también.
      currentKey = entry!.status === 'ok' ? key : currentKey;
    });

    this.evictMissing(doc);
    return { results, shape: current };
  }

  dispose() {
    for (const entry of this.cache.values()) this.release(entry);
    this.cache.clear();
  }

  /** Cantidad de entradas en cache (para tests y diagnóstico). */
  get cacheSize() {
    return this.cache.size;
  }

  private compute(feature: Feature, input: AnyShape | null, key: string): CacheEntry {
    const t0 = performance.now();
    try {
      const output = runFeature(feature, input);
      return { key, output, owned: true, status: 'ok', timeMs: elapsed(t0) };
    } catch (err) {
      return { key, output: input, owned: false, status: 'error', error: describeError(err), timeMs: elapsed(t0) };
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
    if (entry.owned && entry.output) entry.output.delete();
    entry.output = null;
    entry.owned = false;
  }
}

function runFeature(feature: Feature, input: AnyShape | null): AnyShape {
  switch (feature.type) {
    case 'extrude':
      return runExtrude(feature, input);
  }
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
