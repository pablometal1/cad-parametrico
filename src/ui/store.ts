// Estado de la aplicación: el documento (fuente de verdad) y los resultados del último recálculo.
import { batch, createMemo, createSignal } from 'solid-js';
import solverWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import * as ops from '../document/ops';
import type { BasePlane, CadDocument, Feature, FeatureId, SketchData, SketchFeature } from '../document/types';
import type { KernelClient } from '../kernel/client';
import type { FeatureResult, MeshPayload, RecomputeResult } from '../kernel/protocol';
import { SketchBuilder } from '../sketch/builders';
import { initSolver } from '../sketch/solver';

export interface RecomputeStats {
  totalMs: number;
  computed: number;
  cached: number;
  errors: number;
}

export type KernelState = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

export interface SketchEditing {
  featureId: FeatureId;
  /** Si el sketch se creó al entrar: cancelar lo borra. */
  isNew: boolean;
}

/** Documento de ejemplo: rectángulo 40×30 totalmente definido, extruido 20 mm. */
export function initialDocument(): CadDocument {
  let doc = ops.emptyDocument();
  const b = new SketchBuilder({ entities: [], constraints: [] });
  const [bottom, right] = b.rectangle([0, 0], [40, 30]);
  b.constrain({ type: 'coincident', a: 'p1', b: 'origin' });
  b.constrain({ type: 'distance', a: bottom, value: 40 });
  b.constrain({ type: 'distance', a: right, value: 30 });
  const sketch = ops.makeSketch(doc, b.data);
  doc = ops.addFeature(doc, sketch);
  return ops.addFeature(doc, ops.makeExtrude(doc, sketch.id));
}

export interface StoreCallbacks {
  onMesh: (mesh: MeshPayload | null) => void;
  onSketches: (sketches: RecomputeResult['sketches']) => void;
}

export function createCadStore(kernel: KernelClient, callbacks: StoreCallbacks) {
  const [doc, setDoc] = createSignal<CadDocument>(initialDocument());
  const [results, setResults] = createSignal<ReadonlyMap<FeatureId, FeatureResult>>(new Map());
  const [selectedId, setSelectedId] = createSignal<FeatureId | null>(null);
  const [kernelState, setKernelState] = createSignal<KernelState>({ state: 'loading' });
  const [computing, setComputing] = createSignal(false);
  const [stats, setStats] = createSignal<RecomputeStats | null>(null);
  const [editing, setEditing] = createSignal<SketchEditing | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

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
          callbacks.onMesh(r.mesh);
          callbacks.onSketches(r.sketches);
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
    editing,
    notice,
    setNotice,
    selectFeature: setSelectedId,

    async start() {
      try {
        // El solver de sketch corre también en el hilo principal (edición interactiva).
        await Promise.all([kernel.init(), initSolver(solverWasmUrl)]);
        setKernelState({ state: 'ready' });
        pending = doc();
        await pump();
      } catch (err) {
        setKernelState({ state: 'error', message: (err as Error).message });
      }
    },

    /** Crea un sketch vacío sobre un plano base y entra a editarlo. */
    newSketch(plane: BasePlane) {
      const f = ops.makeSketch(doc(), { plane: { kind: 'base', plane, offset: 0 } });
      apply((d) => ops.addFeature(d, f));
      batch(() => {
        setSelectedId(f.id);
        setEditing({ featureId: f.id, isNew: true });
      });
    },

    editSketch(id: FeatureId) {
      const f = ops.findFeature(doc(), id);
      if (f?.type !== 'sketch') return;
      batch(() => {
        setSelectedId(id);
        setEditing({ featureId: id, isNew: false });
      });
    },

    finishSketch(data: SketchData) {
      const e = editing();
      if (!e) return;
      apply((d) => ops.updateFeature<SketchFeature>(d, e.featureId, { entities: data.entities, constraints: data.constraints }));
      setEditing(null);
    },

    cancelSketch() {
      const e = editing();
      if (!e) return;
      if (e.isNew) {
        apply((d) => ops.deleteFeature(d, e.featureId));
        setSelectedId(null);
      }
      setEditing(null);
    },

    /**
     * Extruye el sketch seleccionado, o si no hay uno seleccionado, el último sketch
     * todavía sin usar. Devuelve un mensaje si no hay ninguno.
     */
    addExtrude(): string | null {
      const sel = selectedFeature();
      const sketch = sel?.type === 'sketch' ? sel : ops.unusedSketches(doc()).at(-1);
      if (!sketch) return 'Primero creá un sketch con un perfil cerrado (o elegí uno en el historial)';
      const f = ops.makeExtrude(doc(), sketch.id);
      apply((d) => ops.addFeature(d, f));
      setSelectedId(f.id);
      return null;
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
