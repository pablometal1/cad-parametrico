// Estado de la aplicación: el documento (fuente de verdad), su historial y los resultados del recálculo.
import { batch, createEffect, createMemo, createSignal, on } from 'solid-js';
import solverWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { evaluateDocument, evaluateText, getFieldValue, setFieldValue } from '../document/evaluate';
import { parseExpression, plainNumber } from '../document/expressions';
import { History, type RecordOptions } from '../document/history';
import * as ops from '../document/ops';
import { parseDocument } from '../document/serialize';
import type {
  BasePlane, CadDocument, ChamferFeature, Feature, FeatureId, FilletFeature, ShellFeature, SketchData, SketchFeature,
} from '../document/types';
import type { KernelClient } from '../kernel/client';
import type { FeatureResult, MeshPayload, RecomputeResult } from '../kernel/protocol';
import { SketchBuilder } from '../sketch/builders';
import { initSolver } from '../sketch/solver';
import { baseName, downloadDocument, loadDraft, saveDraft } from './files';

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
  /** Profundidad del historial al abrir (para saber si hubo cambios). */
  depth: number;
}

/** Modo "elegir referencias": el historial se retrocede hasta la feature para elegir sobre su entrada. */
export interface Picking {
  featureId: FeatureId;
  kind: 'edges' | 'faces' | 'face';
  /** Documento antes de entrar al modo: el cambio final se deshace de una vez hasta acá. */
  before: CadDocument;
}

export interface StoreCallbacks {
  onMesh: (mesh: MeshPayload | null) => void;
  onSketches: (sketches: RecomputeResult['sketches']) => void;
}

interface CommitOptions extends RecordOptions {
  /** false: no se registra en el historial (estados transitorios, como el modo elegir). */
  history?: boolean;
  /** Estado a guardar como "anterior" en lugar del actual. */
  base?: CadDocument;
}

export function createCadStore(kernel: KernelClient, callbacks: StoreCallbacks) {
  const draft = loadDraft();
  const [doc, setDoc] = createSignal<CadDocument>(draft?.doc ?? initialDocument());
  const [results, setResults] = createSignal<ReadonlyMap<FeatureId, FeatureResult>>(new Map());
  const [selectedId, setSelectedId] = createSignal<FeatureId | null>(null);
  const [kernelState, setKernelState] = createSignal<KernelState>({ state: 'loading' });
  const [computing, setComputing] = createSignal(false);
  const [stats, setStats] = createSignal<RecomputeStats | null>(null);
  const [editing, setEditing] = createSignal<SketchEditing | null>(null);
  const [notice, setNotice] = createSignal<string | null>(
    draft ? 'Se recuperó el último trabajo de este navegador (Archivo → Nuevo para empezar de cero)' : null,
  );
  const [picking, setPicking] = createSignal<Picking | null>(null);
  const [dialog, setDialog] = createSignal<ToolDialog | null>(null);
  /** Dibujo directo en 3D activo (sobre un plano o cara, sin abrir el editor de sketch). */
  const [drawing, setDrawing] = createSignal(false);
  const [fileName, setFileName] = createSignal(draft?.fileName ?? 'pieza');
  /** Documento tal como está en el último archivo guardado/abierto (para saber si hay cambios). */
  const [savedDoc, setSavedDoc] = createSignal<CadDocument | null>(draft && !draft.dirty ? draft.doc : draft ? null : doc());

  const history = new History<CadDocument>();
  const [historyVersion, setHistoryVersion] = createSignal(0);
  const bumpHistory = () => setHistoryVersion((v) => v + 1);

  /** Documento con parámetros y expresiones evaluados (lo que ve el kernel). */
  const evaluated = createMemo(() => evaluateDocument(doc()));

  const selectedFeature = createMemo(() => {
    const id = selectedId();
    return id ? ops.findFeature(doc(), id) ?? null : null;
  });

  const dirty = () => doc() !== savedDoc();

  // Borrador automático en el navegador (para no perder trabajo al recargar).
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on([doc, fileName], () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft({ doc: doc(), fileName: fileName(), dirty: dirty() }), 600);
  }, { defer: true }));

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
          const evaluatedFeatures = r.features.filter((f) => f.status === 'ok' || f.status === 'error');
          setStats({
            totalMs: r.totalMs,
            computed: evaluatedFeatures.filter((f) => !f.cached).length,
            cached: evaluatedFeatures.filter((f) => f.cached).length,
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

  function setDocument(next: CadDocument) {
    setDoc(next);
    pending = next;
    void pump();
  }

  function commit(next: CadDocument, opts: CommitOptions = {}) {
    if (opts.history !== false) {
      // Mientras hay un panel de herramienta abierto, sus cambios forman un solo paso.
      const d = dialog();
      const grouping = d && !opts.coalesce ? { coalesce: `dialog:${d.featureId}`, sticky: true } : opts;
      history.record(opts.base ?? doc(), grouping);
      bumpHistory();
    }
    setDocument(next);
  }

  /** Aplica una operación pura; si falla, no cambia nada y devuelve el error. */
  function apply(op: (d: CadDocument) => CadDocument, opts: CommitOptions = {}): Error | null {
    try {
      const next = op(doc());
      if (next !== doc()) commit(next, opts);
      return null;
    } catch (err) {
      return err as Error;
    }
  }

  /** Vuelve al estado anterior sin dejar nada para rehacer (cancelar una creación o una edición). */
  function revertLastStep() {
    const prev = history.undo(doc());
    history.discardRedo();
    bumpHistory();
    if (prev) setDocument(prev);
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

  /** Abre el panel flotante de una feature. */
  function openDialog(id: FeatureId, isNew: boolean) {
    const f = ops.findFeature(doc(), id);
    if (!f || f.type === 'sketch') return;
    batch(() => {
      setSelectedId(id);
      setDialog({ featureId: id, isNew, depth: history.depth });
    });
  }

  /** Agrega una feature nueva y abre su panel; la creación y los ajustes del panel son un solo paso. */
  function addWithDialog(f: Feature) {
    apply((d) => ops.addFeature(d, f), { coalesce: `dialog:${f.id}`, sticky: true });
    openDialog(f.id, true);
  }

  /** Reemplaza el documento entero (abrir/nuevo): limpia historial y estados de edición. */
  function replaceDocument(next: CadDocument, name: string) {
    batch(() => {
      history.clear();
      bumpHistory();
      setDialog(null);
      setPicking(null);
      setEditing(null);
      setSelectedId(null);
      setFileName(name);
      setSavedDoc(next);
      setDocument(next);
    });
  }

  return {
    doc,
    evaluated,
    results,
    picking,
    dialog,
    openDialog,
    selectedId,
    selectedFeature,
    kernelState,
    computing,
    stats,
    editing,
    notice,
    setNotice,
    selectFeature: setSelectedId,
    fileName,
    dirty,

    drawing,
    setDrawing,

    /**
     * Guarda lo dibujado directamente en 3D: crea el sketch la primera vez y después lo actualiza.
     * Cada figura terminada es un paso del historial. Devuelve el id del sketch.
     */
    commitDirectDraw(featureId: FeatureId | null, plane: SketchFeature['plane'], data: SketchData): FeatureId {
      if (featureId && ops.findFeature(doc(), featureId)) {
        apply((d) => ops.updateFeature<SketchFeature>(d, featureId, { entities: data.entities, constraints: data.constraints }));
        return featureId;
      }
      const f = ops.makeSketch(doc(), { plane, entities: data.entities, constraints: data.constraints });
      apply((d) => ops.addFeature(d, f));
      setSelectedId(f.id);
      return f.id;
    },

    canUndo: () => (historyVersion(), history.canUndo),
    canRedo: () => (historyVersion(), history.canRedo),

    undo() {
      if (dialog() || picking() || editing() || drawing()) return;
      const prev = history.undo(doc());
      bumpHistory();
      if (prev) setDocument(prev);
    },

    redo() {
      if (dialog() || picking() || editing() || drawing()) return;
      const next = history.redo(doc());
      bumpHistory();
      if (next) setDocument(next);
    },

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

    // ------------------------------------------------------------ archivos

    newDocument() {
      replaceDocument(ops.emptyDocument(), 'pieza');
      setNotice(null);
    },

    save() {
      downloadDocument(doc(), fileName());
      setSavedDoc(doc());
    },

    /** Abre un proyecto desde el texto de un archivo. Devuelve un mensaje de error o null. */
    open(text: string, name: string): string | null {
      try {
        replaceDocument(parseDocument(text), baseName(name));
        setNotice(null);
        return null;
      } catch (err) {
        return `No se pudo abrir "${name}": ${(err as Error).message}`;
      }
    },

    setFileName,

    // ------------------------------------------------------------ panel de herramienta

    /** Acepta los cambios del panel flotante. */
    acceptDialog() {
      setDialog(null);
      history.breakCoalescing();
    },

    /** Cancela: una feature nueva se borra; una existente vuelve a como estaba al abrir. */
    cancelDialog() {
      const d = dialog();
      if (!d) return;
      setDialog(null);
      if (d.isNew) {
        if (selectedId() === d.featureId) setSelectedId(null);
        revertLastStep();
      } else if (history.depth > d.depth) {
        revertLastStep();
      }
    },

    // ------------------------------------------------------------ sketches

    /** Crea un sketch vacío sobre un plano base y entra a editarlo. */
    newSketch(plane: BasePlane) {
      const f = ops.makeSketch(doc(), { plane: { kind: 'base', plane, offset: 0 } });
      apply((d) => ops.addFeature(d, f), { coalesce: `sketch:${f.id}`, sticky: true });
      batch(() => {
        setSelectedId(f.id);
        setEditing({ featureId: f.id, isNew: true });
      });
    },

    editSketch(id: FeatureId) {
      const f = ops.findFeature(doc(), id);
      if (f?.type !== 'sketch') return;
      history.breakCoalescing();
      batch(() => {
        setSelectedId(id);
        setEditing({ featureId: id, isNew: false });
      });
    },

    finishSketch(data: SketchData, exprs: Record<string, string>) {
      const e = editing();
      if (!e) return;
      const f = ops.findFeature(doc(), e.featureId);
      // Expresiones que no son de cotas (p. ej. el desplazamiento) se conservan.
      const kept = Object.fromEntries(Object.entries(f?.exprs ?? {}).filter(([k]) => !k.startsWith('constraint:')));
      const all = { ...kept, ...exprs };
      apply(
        (d) => ops.updateFeature<SketchFeature>(d, e.featureId, {
          entities: data.entities,
          constraints: data.constraints,
          exprs: Object.keys(all).length ? all : undefined,
        }),
        { coalesce: `sketch:${e.featureId}`, sticky: true },
      );
      history.breakCoalescing();
      setEditing(null);
    },

    cancelSketch() {
      const e = editing();
      if (!e) return;
      if (e.isNew) {
        revertLastStep();
        setSelectedId(null);
      }
      setEditing(null);
    },

    // ------------------------------------------------------------ creación de features

    /**
     * Extruye el sketch seleccionado, o si no hay uno seleccionado, el último sketch
     * todavía sin usar. Devuelve un mensaje si no hay ninguno.
     */
    addExtrude(): string | null {
      const sketch = sketchForProfile();
      if (!sketch) return 'Primero creá un sketch con un perfil cerrado (o elegí uno en el historial)';
      addWithDialog(ops.makeExtrude(doc(), sketch.id));
      return null;
    },

    addRevolve(): string | null {
      const sketch = sketchForProfile();
      if (!sketch) return 'Primero creá un sketch con un perfil cerrado (o elegí uno en el historial)';
      addWithDialog(ops.makeRevolve(doc(), sketch));
      return null;
    },

    /**
     * Patrón o simetría de la extrusión/revolución seleccionada en el historial (o de la última).
     * Devuelve un mensaje si no hay ninguna.
     */
    addCopy(kind: 'pattern' | 'mirror'): string | null {
      const sel = selectedFeature();
      const active = doc().features.slice(0, ops.activeCount(doc()));
      const source = ops.isCopyable(sel ?? undefined) ? sel : [...active].reverse().find((f) => ops.isCopyable(f));
      if (!source) return 'Primero creá una extrusión o revolución (o elegila en el historial) para repetirla';
      addWithDialog(kind === 'pattern' ? ops.makePattern(doc(), source.id) : ops.makeMirror(doc(), source.id));
      return null;
    },

    /** Redondeo o chaflán de las aristas elegidas en el viewport (índices del sólido mostrado). */
    async addEdgeFeature(type: 'fillet' | 'chamfer', edges: number[]) {
      if (edges.length === 0) return setNotice('Seleccioná una o más aristas en el modelo (Shift + clic para varias)');
      const refs = await withRefs(() => kernel.edgeRefs(edges));
      if (!refs) return;
      addWithDialog(type === 'fillet' ? ops.makeFillet(doc(), refs) : ops.makeChamfer(doc(), refs));
    },

    async addShell(faces: number[]) {
      if (faces.length === 0) return setNotice('Seleccioná las caras a quitar (p. ej. la superior) y volvé a tocar Vaciado');
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      addWithDialog(ops.makeShell(doc(), refs));
    },

    /** Crea un sketch sobre una cara plana del sólido mostrado y entra a editarlo. */
    async newSketchOnFace(face: number) {
      const refs = await withRefs(() => kernel.faceRefs([face]));
      if (!refs) return;
      if (refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
      const f = ops.makeSketch(doc(), { plane: { kind: 'face', face: refs[0], offset: 0 } });
      apply((d) => ops.addFeature(d, f), { coalesce: `sketch:${f.id}`, sticky: true });
      batch(() => {
        setSelectedId(f.id);
        setEditing({ featureId: f.id, isNew: true });
      });
    },

    // ------------------------------------------------------------ modo elegir referencias

    /** Entra al modo elegir referencias para una feature existente (retrocede el historial hasta ella). */
    beginPick(featureId: FeatureId) {
      const d = doc();
      const i = d.features.findIndex((f) => f.id === featureId);
      const f = d.features[i];
      if (!f) return;
      const kind = f.type === 'fillet' || f.type === 'chamfer' ? 'edges' : f.type === 'shell' ? 'faces' : 'face';
      setPicking({ featureId, kind, before: d });
      apply((x) => ops.setRollback(x, i), { history: false });
    },

    /** Aplica la selección del viewport a la feature en edición y restaura el marcador. */
    async finishPick(sel: { faces: number[]; edges: number[] }) {
      const p = picking();
      if (!p) return;
      const restore = (d: CadDocument) => ops.setRollback(d, p.before.rollback);
      const opts: CommitOptions = { base: p.before };
      if (p.kind === 'edges') {
        if (!sel.edges.length) return setNotice('Seleccioná al menos una arista');
        const refs = await withRefs(() => kernel.edgeRefs(sel.edges));
        if (!refs) return;
        apply((d) => restore(ops.updateFeature<FilletFeature | ChamferFeature>(d, p.featureId, { edges: refs })), opts);
      } else if (p.kind === 'faces') {
        const refs = await withRefs(() => kernel.faceRefs(sel.faces));
        if (!refs) return;
        apply((d) => restore(ops.updateFeature<ShellFeature>(d, p.featureId, { faces: refs })), opts);
      } else {
        if (sel.faces.length !== 1) return setNotice('Seleccioná una cara plana');
        const refs = await withRefs(() => kernel.faceRefs(sel.faces));
        if (!refs) return;
        if (refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
        const sk = ops.findFeature(doc(), p.featureId) as SketchFeature;
        apply(
          (d) => restore(ops.updateFeature<SketchFeature>(d, p.featureId, { plane: { kind: 'face', face: refs[0], offset: sk.plane.offset } })),
          opts,
        );
      }
      batch(() => {
        setPicking(null);
        setNotice(null);
      });
    },

    cancelPick() {
      const p = picking();
      if (!p) return;
      setPicking(null);
      setDocument(p.before);
    },

    // ------------------------------------------------------------ edición de features

    updateFeature<F extends Feature>(id: FeatureId, patch: Partial<Omit<F, 'id' | 'type'>>) {
      return apply((d) => ops.updateFeature<F>(d, id, patch));
    },

    /**
     * Valor que se ve en un campo: el evaluado (si tiene expresión, el resultado).
     * Para cotas de ángulo devuelve el valor guardado (el panel no edita cotas).
     */
    fieldValue(id: FeatureId, path: string): number | undefined {
      const f = evaluated().doc.features.find((x) => x.id === id);
      return f ? getFieldValue(f, path) : undefined;
    },

    fieldExpression(id: FeatureId, path: string): string | undefined {
      return ops.findFeature(doc(), id)?.exprs?.[path];
    },

    /**
     * Escribe un campo desde texto: un número fija el valor; cualquier otra cosa es una
     * expresión (`ancho / 2`). Devuelve el mensaje de error, o null si se aplicó.
     */
    setFieldText(id: FeatureId, path: string, text: string): string | null {
      const f = ops.findFeature(doc(), id);
      if (!f) return 'La feature ya no existe';
      const n = plainNumber(text);
      let value: number;
      let expr: string | undefined;
      try {
        if (n !== null) {
          value = n;
        } else {
          parseExpression(text);
          value = evaluateText(text, evaluated().scope);
          expr = text.trim();
        }
      } catch (err) {
        return (err as Error).message;
      }
      const exprs = { ...(f.exprs ?? {}) };
      if (expr) exprs[path] = expr;
      else delete exprs[path];
      const clean = Number(value.toPrecision(12)); // sin ruido de coma flotante en el documento
      const next = { ...setFieldValue(f, path, clean), exprs: Object.keys(exprs).length ? exprs : undefined };
      const { id: _id, type: _type, ...patch } = next;
      apply((d) => ops.updateFeature(d, id, patch));
      return null;
    },

    /** Valor fijado desde un manipulador 3D: reemplaza la expresión del campo, si la había. */
    setFieldFromManipulator(id: FeatureId, path: string, value: number) {
      const f = ops.findFeature(doc(), id);
      if (!f) return;
      const exprs = { ...(f.exprs ?? {}) };
      const hadExpr = path in exprs;
      delete exprs[path];
      const clean = Number(value.toPrecision(12)); // sin ruido de coma flotante en el documento
      const next = { ...setFieldValue(f, path, clean), exprs: Object.keys(exprs).length ? exprs : undefined };
      const { id: _id, type: _type, ...patch } = next;
      apply((d) => ops.updateFeature(d, id, patch), { coalesce: `drag:${id}:${path}` });
      if (hadExpr) setNotice(`Se reemplazó la expresión de ${f.name} por el valor arrastrado (Ctrl+Z para volver)`);
    },

    deleteFeature(id: FeatureId) {
      if (selectedId() === id) setSelectedId(null);
      const f = ops.findFeature(doc(), id);
      const err = apply((d) => ops.deleteFeature(d, id));
      if (!err && f) setNotice(`Se borró "${f.name}" (Ctrl+Z para deshacer)`);
      return err;
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

    // ------------------------------------------------------------ parámetros

    /** Agrega un parámetro con un nombre libre. Devuelve su id. */
    addParameter(): string {
      const name = ops.nextParameterName(doc(), 'param');
      apply((d) => ops.addParameter(d, name, '10'));
      return doc().parameters.at(-1)!.id;
    },

    /** Cambia la expresión (se valida la sintaxis; los errores de valor se muestran en la tabla). */
    setParameterExpression(id: string, text: string): string | null {
      const t = text.trim();
      if (plainNumber(t) === null) {
        try {
          parseExpression(t);
        } catch (err) {
          return (err as Error).message;
        }
      }
      apply((d) => ops.updateParameter(d, id, { expression: plainNumber(t) !== null ? String(plainNumber(t)) : t }));
      return null;
    },

    renameParameter(id: string, name: string): string | null {
      const err = apply((d) => ops.renameParameter(d, id, name.trim()));
      return err ? err.message : null;
    },

    setParameterComment(id: string, comment: string) {
      apply((d) => ops.updateParameter(d, id, { comment: comment.trim() || undefined }));
    },

    parameterUsage(name: string) {
      return ops.parameterUsage(doc(), name);
    },

    deleteParameter(id: string) {
      apply((d) => ops.deleteParameter(d, id));
    },
  };
}

export type CadStore = ReturnType<typeof createCadStore>;
