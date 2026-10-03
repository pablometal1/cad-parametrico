// Estado de la aplicación: el documento (fuente de verdad) y los resultados del último recálculo.
import { createMemo, createSignal } from 'solid-js';
import * as ops from '../document/ops';
import type { CadDocument, Feature, FeatureId } from '../document/types';
import type { KernelClient } from '../kernel/client';
import type { FeatureResult, MeshPayload } from '../kernel/protocol';

export interface RecomputeStats {
  totalMs: number;
  computed: number;
  cached: number;
  errors: number;
}

export type KernelState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

export function initialDocument(): CadDocument {
  const doc = ops.emptyDocument();
  return ops.addFeature(doc, ops.makeExtrude(doc));
}

export function createCadStore(kernel: KernelClient, onMesh: (mesh: MeshPayload | null) => void) {
  const [doc, setDoc] = createSignal<CadDocument>(initialDocument());
  const [results, setResults] = createSignal<ReadonlyMap<FeatureId, FeatureResult>>(new Map());
  const [selectedId, setSelectedId] = createSignal<FeatureId | null>(null);
  const [kernelState, setKernelState] = createSignal<KernelState>({ state: 'loading' });
  const [computing, setComputing] = createSignal(false);
  const [stats, setStats] = createSignal<RecomputeStats | null>(null);

  const selectedFeature = createMemo(() => {
    const id = selectedId();
    return id ? ops.findFeature(doc(), id) ?? null : null;
  });

  // Recálculo en cola: si llegan cambios mientras el worker trabaja, solo se envía el último documento.
  let pending: CadDocument | null = null;
  let running = false;

  async function pump() {
    if (running || kernelState().state !== 'ready') return;
    running = true;
    setComputing(true);
    try {
      while (pending) {
        const d = pending;
        pending = null;
        try {
          const r = await kernel.recompute(d);
          setResults(new Map(r.features.map((f) => [f.id, f])));
          const evaluated = r.features.filter((f) => f.status === 'ok' || f.status === 'error');
          setStats({
            totalMs: r.totalMs,
            computed: evaluated.filter((f) => !f.cached).length,
            cached: evaluated.filter((f) => f.cached).length,
            errors: r.features.filter((f) => f.status === 'error').length,
          });
          onMesh(r.mesh);
        } catch (err) {
          setKernelState({ state: 'error', message: (err as Error).message });
          return;
        }
      }
    } finally {
      running = false;
      setComputing(false);
    }
  }

  function commit(next: CadDocument) {
    setDoc(next);
    pending = next;
    void pump();
  }

  /** Aplica una operación pura; si falla, no cambia nada y devuelve el error. */
  function apply(op: (d: CadDocument) => CadDocument): Error | null {
    try {
      const next = op(doc());
      if (next !== doc()) commit(next);
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  return {
    doc,
    results,
    selectedId,
    selectedFeature,
    kernelState,
    computing,
    stats,
    selectFeature: setSelectedId,

    async start() {
      try {
        await kernel.init();
        setKernelState({ state: 'ready' });
        pending = doc();
        await pump();
      } catch (err) {
        setKernelState({ state: 'error', message: (err as Error).message });
      }
    },

    addExtrude() {
      const f = ops.makeExtrude(doc());
      apply((d) => ops.addFeature(d, f));
      setSelectedId(f.id);
    },

    updateFeature<F extends Feature>(id: FeatureId, patch: Partial<Omit<F, 'id' | 'type'>>) {
      return apply((d) => ops.updateFeature<F>(d, id, patch));
    },

    deleteFeature(id: FeatureId) {
      if (selectedId() === id) setSelectedId(null);
      return apply((d) => ops.deleteFeature(d, id));
    },

    toggleSuppressed(id: FeatureId) {
      const f = ops.findFeature(doc(), id);
      if (f) apply((d) => ops.setSuppressed(d, id, !f.suppressed));
    },

    rollbackAfter(id: FeatureId) {
      return apply((d) => ops.rollbackAfter(d, id));
    },

    setRollback(count: number | null) {
      return apply((d) => ops.setRollback(d, count));
    },
  };
}

export type CadStore = ReturnType<typeof createCadStore>;
