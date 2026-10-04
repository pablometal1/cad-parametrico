// Estado de la aplicación: el documento (fuente de verdad) y los resultados del último recálculo.
import { batch, createMemo, createSignal } from 'solid-js';
import solverWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import * as ops from '../document/ops';
import type {
  BasePlane, CadDocument, ChamferFeature, Feature, FeatureId, FilletFeature, ShellFeature, SketchData, SketchFeature,
} from '../document/types';
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

/** Panel flotante de edición de una feature (con vista previa en vivo y Aceptar/Cancelar). */
export interface ToolDialog {
  featureId: FeatureId;
  /** Creada al abrir el panel: cancelar la borra. */
  isNew: boolean;
  /** Valores al abrir, para restaurarlos al cancelar. */
  original: Feature;
}

/** Modo "elegir referencias": el historial se retrocede hasta la feature para elegir sobre su entrada. */
export interface Picking {
  featureId: FeatureId;
  kind: 'edges' | 'faces' | 'face';
  /** Marcador de retroceso a restaurar al terminar. */
  previousRollback: number | null;
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
  const [picking, setPicking] = createSignal<Picking | null>(null);
  const [dialog, setDialog] = createSignal<ToolDialog | null>(null);

  /** Abre el panel flotante de una feature; guarda una copia para poder cancelar. */
  function openDialog(id: FeatureId, isNew: boolean) {
    const f = ops.findFeature(doc(), id);
    if (!f || f.type === 'sketch') return;
    batch(() => {
      setSelectedId(id);
      setDialog({ featureId: id, isNew, original: f });
    });
  }

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

  /** Toma la última feature de perfil posible: el sketch seleccionado o el último sin usar. */
  function sketchForProfile(): SketchFeature | null {
    const sel = selectedFeature();
    return sel?.type === 'sketch' ? sel : ops.unusedSketches(doc()).at(-1) ?? null;
  }

  async function withRefs<T>(fetch: () => Promise<T>): Promise<T | null> {
    try {
      return await fetch();
    } catch (err) {
      setNotice((err as Error).message);
      return null;
    }
  }

  return {
    doc,
    results,
    picking,
    dialog,
    openDialog,

    /** Acepta los cambios del panel flotante. */
    acceptDialog() {
      setDialog(null);
    },

    /** Cancela: una feature nueva se borra; una existente vuelve a sus valores originales. */
    cancelDialog() {
      const d = dialog();
      if (!d) return;
      setDialog(null);
      if (!ops.findFeature(doc(), d.featureId)) return;
      if (d.isNew) {
        if (selectedId() === d.featureId) setSelectedId(null);
        apply((x) => ops.deleteFeature(x, d.featureId));
      } else {
        const { id: _id, type: _type, ...original } = d.original;
        apply((x) => ops.updateFeature(x, d.featureId, original));
      }
    },
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
      const sketch = sketchForProfile();
      if (!sketch) return 'Primero creá un sketch con un perfil cerrado (o elegí uno en el historial)';
      const f = ops.makeExtrude(doc(), sketch.id);
      apply((d) => ops.addFeature(d, f));
      openDialog(f.id, true);
      return null;
    },

    addRevolve(): string | null {
      const sketch = sketchForProfile();
      if (!sketch) return 'Primero creá un sketch con un perfil cerrado (o elegí uno en el historial)';
      const f = ops.makeRevolve(doc(), sketch);
      apply((d) => ops.addFeature(d, f));
      openDialog(f.id, true);
      return null;
    },

    /** Redondeo o chaflán de las aristas elegidas en el viewport (índices del sólido mostrado). */
    async addEdgeFeature(type: 'fillet' | 'chamfer', edges: number[]) {
      if (edges.length === 0) return setNotice('Seleccioná una o más aristas en el modelo (Shift + clic para varias)');
      const refs = await withRefs(() => kernel.edgeRefs(edges));
      if (!refs) return;
      const f = type === 'fillet' ? ops.makeFillet(doc(), refs) : ops.makeChamfer(doc(), refs);
      apply((d) => ops.addFeature(d, f));
      openDialog(f.id, true);
    },

    async addShell(faces: number[]) {
      if (faces.length === 0) return setNotice('Seleccioná las caras a quitar (p. ej. la superior) y volvé a tocar Vaciado');
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      const f = ops.makeShell(doc(), refs);
      apply((d) => ops.addFeature(d, f));
      openDialog(f.id, true);
    },

    /** Crea un sketch sobre una cara plana del sólido mostrado y entra a editarlo. */
    async newSketchOnFace(face: number) {
      const refs = await withRefs(() => kernel.faceRefs([face]));
      if (!refs) return;
      if (refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
      const f = ops.makeSketch(doc(), { plane: { kind: 'face', face: refs[0], offset: 0 } });
      apply((d) => ops.addFeature(d, f));
      batch(() => {
        setSelectedId(f.id);
        setEditing({ featureId: f.id, isNew: true });
      });
    },

    /** Entra al modo elegir referencias para una feature existente (retrocede el historial hasta ella). */
    beginPick(featureId: FeatureId) {
      const d = doc();
      const i = d.features.findIndex((f) => f.id === featureId);
      const f = d.features[i];
      if (!f) return;
      const kind = f.type === 'fillet' || f.type === 'chamfer' ? 'edges' : f.type === 'shell' ? 'faces' : 'face';
      setPicking({ featureId, kind, previousRollback: d.rollback });
      apply((x) => ops.setRollback(x, i));
    },

    /** Aplica la selección del viewport a la feature en edición y restaura el marcador. */
    async finishPick(sel: { faces: number[]; edges: number[] }) {
      const p = picking();
      if (!p) return;
      if (p.kind === 'edges') {
        if (!sel.edges.length) return setNotice('Seleccioná al menos una arista');
        const refs = await withRefs(() => kernel.edgeRefs(sel.edges));
        if (!refs) return;
        apply((d) => ops.setRollback(ops.updateFeature<FilletFeature | ChamferFeature>(d, p.featureId, { edges: refs }), p.previousRollback));
      } else if (p.kind === 'faces') {
        const refs = await withRefs(() => kernel.faceRefs(sel.faces));
        if (!refs) return;
        apply((d) => ops.setRollback(ops.updateFeature<ShellFeature>(d, p.featureId, { faces: refs }), p.previousRollback));
      } else {
        if (sel.faces.length !== 1) return setNotice('Seleccioná una cara plana');
        const refs = await withRefs(() => kernel.faceRefs(sel.faces));
        if (!refs) return;
        if (refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
        const sk = ops.findFeature(doc(), p.featureId) as SketchFeature;
        apply((d) => ops.setRollback(
          ops.updateFeature<SketchFeature>(d, p.featureId, { plane: { kind: 'face', face: refs[0], offset: sk.plane.offset } }),
          p.previousRollback,
        ));
      }
      batch(() => {
        setPicking(null);
        setNotice(null);
      });
    },

    cancelPick() {
      const p = picking();
      if (!p) return;
      apply((d) => ops.setRollback(d, p.previousRollback));
      setPicking(null);
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
