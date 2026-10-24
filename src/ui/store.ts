// Estado de la aplicación: el documento (fuente de verdad), su historial y los resultados del recálculo.
import { loadFonts } from '../sketch/text';
import { coarsePitch, holeCenters } from '../document/holes';
import { findProfiles } from '../sketch/profiles';
import { batch, createEffect, createMemo, createSignal, on } from 'solid-js';
import solverWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { evaluateDocument, evaluateText, getFieldValue, setFieldValue } from '../document/evaluate';
import { parseExpression, plainNumber } from '../document/expressions';
import { History, type RecordOptions } from '../document/history';
import * as ops from '../document/ops';
import { handlesAfter, type BezierSegment } from '../document/curve3d';
import { parseDocument } from '../document/serialize';
import type {
  BasePlane, CadDocument, Curve3dFeature, ChamferFeature, Feature, FeatureId, FilletFeature, ShellFeature, SketchData, SketchFeature, PlaneFeature, PlaneReference, ThreadFeature, LoftFeature, LoftSection } from '../document/types';
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

/** Campos de caras de las features de modelado directo y de cuerpos. */
export type PickSlot = 'faces' | 'neutral' | 'target' | 'tools' | 'body' | 'plane' | 'bodies' | 'face' | 'loftEdges' | 'loftFaces';

/** Modo "elegir referencias": el historial se retrocede hasta la feature para elegir sobre su entrada. */
export interface Picking {
  featureId: FeatureId;
  kind: 'edges' | 'faces' | 'face';
  /** Campo de la feature que se está eligiendo (cuando tiene más de uno: caras, cara neutra…). */
  slot?: PickSlot;
  /** Documento antes de entrar al modo: el cambio final se deshace de una vez hasta acá. */
  before: CadDocument;
}

export interface StoreCallbacks {
  onMesh: (mesh: MeshPayload | null) => void;
  /** Piezas importadas como referencia (translúcidas). */
  onReferences?: (refs: RecomputeResult['references']) => void;
  onSketches: (sketches: RecomputeResult['sketches']) => void;
}

interface CommitOptions extends RecordOptions {
  /** false: no se registra en el historial (estados transitorios, como el modo elegir). */
  history?: boolean;
  /** Estado a guardar como "anterior" en lugar del actual. */
  base?: CadDocument;
}

export function createCadStore(kernel: KernelClient, callbacks: StoreCallbacks) {
  let draftWarned = false;
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
  /** Herramienta Línea 3D activa: vértices del modelo (xyz) y los elegidos en orden. */
  const [lining, setLining] = createSignal<{ vertices: Float32Array; chain: number[] } | null>(null);
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
    draftTimer = setTimeout(() => {
      const ok = saveDraft({ doc: doc(), fileName: fileName(), dirty: dirty() });
      if (!ok && !draftWarned) {
        draftWarned = true;
        setNotice('El borrador automático ya no entra en el navegador (¿un archivo importado grande?): guardá con Ctrl+S para no perder cambios');
      }
      if (ok) draftWarned = false;
    }, 600);
  }, { defer: true }));

  // Recálculo en cola: si llegan cambios mientras el worker trabaja, solo se envía el último documento.
  let pending: CadDocument | null = null;
  let running = false;

  /** Planos de construcción del último recálculo. */
  const [planeFrames, setPlaneFrames] = createSignal<Map<FeatureId, RecomputeResult['planes'][number]['frame']>>(new Map());
  /** Curvas 3D evaluadas (vértices y tramos), para mostrar y arrastrar sus asas. */
  const [curveGeometry, setCurveGeometry] = createSignal<Map<FeatureId, RecomputeResult['curves'][number]>>(new Map());

  /** Error del último recálculo que no es de una feature (malla, memoria…); null si anduvo. */
  const [recomputeError, setRecomputeError] = createSignal<string | null>(null);
  let retried = false;

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
          callbacks.onReferences?.(r.references);
          setPlaneFrames(new Map(r.planes.map((p) => [p.id, p.frame])));
          setCurveGeometry(new Map(r.curves.map((c) => [c.id, c])));
        } catch (err) {
          // Un error inesperado (no de una feature) puede dejar a OpenCascade en mal estado:
          // se reinicia el kernel y se reintenta una vez. Si vuelve a fallar se avisa, pero la app
          // sigue: el próximo cambio (por ejemplo, deshacer) se vuelve a calcular.
          if (!retried) {
            retried = true;
            setRecomputeError('Reiniciando el kernel…');
            try {
              await kernel.restart();
              pending = pending ?? d;
              continue;
            } catch {
              // sigue abajo con el error original
            }
          }
          setRecomputeError((err as Error).message);
          continue;
        }
        retried = false;
        setRecomputeError(null);
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

  /** Sketches sin usar (más el seleccionado), en orden del historial, con su análisis de perfiles. */
  function sketchCandidates() {
    const sel = selectedFeature();
    const unused = ops.unusedSketches(doc());
    const list = sel?.type === 'sketch' && !unused.some((s) => s.id === sel.id) ? [...unused, sel] : unused;
    const order = new Map(doc().features.map((f, i) => [f.id, i]));
    return list
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .map((s) => {
        try {
          const p = findProfiles(s);
          return { sketch: s, regions: p.regions.length, open: p.openChains };
        } catch {
          return { sketch: s, regions: 0, open: 0 };
        }
      });
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

  /**
   * Termina la Línea 3D y la guarda como curva (necesita al menos 2 vértices). Con `surface`, la
   * cierra y la rellena con un parche en el mismo paso (superficie por vértices).
   */
  async function finishLine3d(closed = false, surface = false) {
    const l = lining();
    if (!l) return;
    if (l.chain.length < 2) {
      setLining(null);
      return;
    }
    setLining(null);
    const refs = await withRefs(() => kernel.vertexRefs(l.chain));
    if (!refs) return;
    if (!surface) return addWithDialog(ops.makeCurve3d(doc(), refs, closed && l.chain.length >= 3));
    if (l.chain.length < 3) return setNotice('Para una superficie hacen falta al menos 3 vértices');
    const curve = ops.makeCurve3d(doc(), refs, true);
    apply((d) => ops.addFeature(d, curve), { coalesce: `dialog:${curve.id}`, sticky: true });
    // Cuerpo aparte (como en Plasticity): unida, una superficie por vértices de la pieza queda
    // sobre ella o adentro y no se ve.
    addWithDialog(ops.makePatch(doc(), [], { curves: [curve.id], operation: 'new', thickness: 0 }));
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
    planeFrames,
    curveGeometry,
    recomputeError,
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
    lining,

    /** Empieza a unir vértices del modelo con líneas 3D. */
    async startLine3d() {
      const vertices = await withRefs(() => kernel.vertices());
      if (!vertices) return;
      if (vertices.length === 0) return setNotice('No hay vértices en el modelo para unir: creá primero un sólido');
      batch(() => {
        setSelectedId(null);
        setNotice(null);
        setLining({ vertices, chain: [] });
      });
    },

    /** Clic en un vértice: lo suma a la cadena; el primero la cierra y repetir el último la termina. */
    pickVertex(index: number) {
      const l = lining();
      if (!l) return;
      const chain = l.chain;
      if (chain.length >= 3 && index === chain[0]) return void finishLine3d(true);
      if (index === chain.at(-1)) return void finishLine3d(false);
      setLining({ ...l, chain: [...chain, index] });
    },

    finishLine3d,

    /** Quita el último vértice elegido. */
    undoVertex() {
      const l = lining();
      if (l?.chain.length) setLining({ ...l, chain: l.chain.slice(0, -1) });
    },

    cancelLine3d() {
      setLining(null);
    },

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
        await Promise.all([kernel.init(), initSolver(solverWasmUrl), loadFonts()]);
        setKernelState({ state: 'ready' });
        pending = doc();
        await pump();
      } catch (err) {
        setKernelState({ state: 'error', message: (err as Error).message });
      }
    },

    // ------------------------------------------------------------ archivos

    /** Abre una plantilla de la biblioteca como proyecto nuevo. Devuelve un mensaje de error o null. */
    async openTemplate(id: string, name: string): Promise<string | null> {
      try {
        const d = await kernel.buildTemplate(id);
        replaceDocument(d, name);
        setNotice('Modelo de la biblioteca listo: cambiá sus medidas en la tabla de parámetros (fx, Shift+X)');
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },

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
      // Al terminar una herramienta no queda nada elegido (sin asas ni resaltados en 3D).
      batch(() => {
        setDialog(null);
        setSelectedId(null);
      });
      history.breakCoalescing();
    },

    /** Cancela: una feature nueva se borra; una existente vuelve a como estaba al abrir. */
    cancelDialog() {
      const d = dialog();
      if (!d) return;
      setDialog(null);
      setSelectedId(null);
      if (d.isNew) {
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
      setSelectedId(null);
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
      // Solo curvas abiertas (un nervio, una pared): extrusión delgada de entrada.
      let onlyOpen = false;
      try {
        const p = findProfiles(sketch);
        onlyOpen = p.regions.length === 0 && p.openChains > 0;
      } catch {
        // Topología no soportada: el error lo muestra la extrusión.
      }
      const f = ops.makeExtrude(doc(), sketch.id);
      addWithDialog(onlyOpen ? { ...f, thin: 2 } : f);
      return null;
    },

    addRevolve(): string | null {
      const sketch = sketchForProfile();
      if (!sketch) return 'Primero creá un sketch con un perfil cerrado (o elegí uno en el historial)';
      addWithDialog(ops.makeRevolve(doc(), sketch));
      return null;
    },

    /** Barrido: el último sketch sin usar con contorno cerrado recorre el último con una cadena abierta. */
    addSweep(): string | null {
      const c = sketchCandidates();
      const path = [...c].reverse().find((x) => x.regions === 0 && x.open > 0)
        ?? [...c].reverse().find((x) => x.regions === 1 && x.sketch.entities.filter((e) => e.type !== 'point').length === 1);
      const profile = [...c].reverse().find((x) => x.regions > 0 && x.sketch.id !== path?.sketch.id);
      if (!profile || !path) {
        return 'Para un barrido hacen falta dos sketches sin usar: uno con el perfil cerrado y otro con la trayectoria (líneas y arcos unidos)';
      }
      addWithDialog(ops.makeSweep(doc(), profile.sketch.id, path.sketch.id));
      return null;
    },

    /**
     * Solevación. Con una cara elegida en el modelo, empieza en ella y sigue por los sketches sin
     * usar (contornos cerrados o puntos). Si no, une los sketches sin usar paralelos con un contorno
     * cerrado o un punto; y si no hay, los que tienen una curva abierta (superficie engrosada).
     */
    async addLoft(faces: number[] = [], edges: number[] = []): Promise<string | null> {
      // Aristas elegidas (como en Plasticity): cada cadena conectada es una sección; sale una
      // superficie que continúa tangente a las caras vecinas.
      if (edges.length > 0) {
        const chains = await withRefs(() => kernel.edgeChains(edges));
        if (!chains) return null;
        if (chains.length < 2) return 'Elegí aristas de al menos dos bordes separados (Shift + clic): cada grupo conectado es una sección';
        const refs = await withRefs(() => Promise.all(chains.map((c) => kernel.edgeRefs(c))));
        if (!refs) return null;
        addWithDialog(ops.makeLoft(doc(), refs.map((r) => ({ edges: r })), { continuity: true, operation: 'new' }));
        return null;
      }
      // Dos o más caras: un sólido de cara a cara que continúa las paredes, unido a la pieza.
      if (faces.length >= 2) {
        const refs = await withRefs(() => kernel.faceRefs(faces));
        if (!refs) return null;
        addWithDialog(ops.makeLoft(doc(), refs.map((face) => ({ face })), { continuity: true, operation: 'join' }));
        return null;
      }
      const isPoint = (sk: SketchFeature) =>
        sk.entities.filter((e) => e.type === 'point').length === 1 && !sk.entities.some((e) => e.type !== 'point');
      const candidates = sketchCandidates();
      const solidish = candidates.filter((x) => x.regions === 1 || isPoint(x.sketch));
      if (faces.length > 0) {
        if (faces.length > 1) return 'Para empezar la solevación en una cara, elegí una sola';
        const rest = solidish.map((x) => x.sketch.id);
        if (!rest.length) return 'Para una solevación desde una cara hace falta al menos un sketch sin usar, con un contorno cerrado o un punto';
        const refs = await withRefs(() => kernel.faceRefs(faces));
        if (!refs) return null;
        addWithDialog(ops.makeLoft(doc(), [{ face: refs[0] }, ...rest], { operation: 'join' }));
        return null;
      }
      const dir = (sk: SketchFeature): number[] =>
        sk.plane.kind === 'base'
          ? { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] }[sk.plane.plane]
          : sk.plane.kind === 'face'
            ? sk.plane.face.normal ?? [0, 0, 1]
            : planeFrames().get(sk.plane.plane)?.normal ?? [0, 0, 1];
      // Solo secciones paralelas a la última (un perfil para barrido en otro plano no entra).
      const parallelTo = (list: typeof candidates) => {
        const ref = list.at(-1) ? dir(list.at(-1)!.sketch) : null;
        return list.filter((x) => {
          const n = dir(x.sketch);
          return !!ref && Math.abs(Math.abs(n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2]) - 1) < 1e-6;
        });
      };
      const closed = parallelTo(solidish);
      if (closed.filter((x) => x.regions === 1).length >= 1 && closed.length >= 2) {
        addWithDialog(ops.makeLoft(doc(), closed.map((x) => x.sketch.id)));
        return null;
      }
      const open = parallelTo(candidates.filter((x) => x.regions === 0 && x.open === 1));
      if (open.length >= 2) {
        addWithDialog(ops.makeLoft(doc(), open.map((x) => x.sketch.id), { thickness: 2 }));
        return null;
      }
      return 'Para una solevación hacen falta al menos dos sketches sin usar (en planos desplazados), cada uno con un contorno cerrado, un punto o una curva abierta; o elegí primero una cara del modelo';
    },

    /**
     * Plano de construcción. Referencia: la cara plana seleccionada en el modelo, o el plano
     * de la feature elegida en el historial (plano o sketch), o XY.
     */
    async addPlane(faces: number[]) {
      let reference: PlaneReference = { kind: 'base', plane: 'XY' };
      if (faces.length === 1) {
        const refs = await withRefs(() => kernel.faceRefs(faces));
        if (!refs) return;
        if (refs[0].type !== 'PLANE') return setNotice('La cara seleccionada no es plana: elegí una cara plana o deseleccioná para partir de XY');
        reference = { kind: 'face', face: refs[0] };
      } else {
        const sel = selectedFeature();
        if (sel?.type === 'plane') reference = { kind: 'plane', plane: sel.id };
        else if (sel?.type === 'sketch') {
          const pl = sel.plane;
          reference = pl.kind === 'base' ? { kind: 'base', plane: pl.plane } : pl.kind === 'plane' ? { kind: 'plane', plane: pl.plane } : { kind: 'face', face: pl.face };
        }
      }
      addWithDialog(ops.makePlane(doc(), reference));
    },

    /** Abre un sketch nuevo apoyado en un plano de construcción (al final del historial). */
    newSketchOnPlane(planeId: FeatureId) {
      if (dialog()) {
        setDialog(null);
        history.breakCoalescing();
      }
      const f = ops.makeSketch(doc(), { plane: { kind: 'plane', plane: planeId, offset: 0 } });
      apply((d) => ops.addFeature(d, f), { coalesce: `sketch:${f.id}`, sticky: true });
      batch(() => {
        setSelectedId(f.id);
        setEditing({ featureId: f.id, isNew: true });
      });
    },

    /**
     * Agujero en los centros del sketch elegido (o del último sin usar que tenga puntos o círculos).
     * Devuelve un mensaje si no hay ninguno.
     */
    addHole(): string | null {
      const sel = selectedFeature();
      const withCenters = (s: SketchFeature) => holeCenters(s).length > 0;
      const sketch = sel?.type === 'sketch' && withCenters(sel) ? sel : [...ops.unusedSketches(doc())].reverse().find(withCenters);
      if (!sketch) return 'Para un agujero: elegí una cara plana y marcá los centros con la herramienta Punto (O), o dibujá círculos donde van';
      addWithDialog(ops.makeHole(doc(), sketch.id));
      return null;
    },

    /** Rosca sobre la cara cilíndrica seleccionada, con el paso grueso ISO de su diámetro. */
    async addThread(faces: number[]) {
      if (faces.length !== 1) return setNotice('Seleccioná una cara cilíndrica: la pared de un agujero (rosca interna) o una barra (externa)');
      const info = await withRefs(() => kernel.faceInfo(faces[0]));
      if (!info) return;
      if (!info.cylinder) return setNotice('La cara seleccionada no es cilíndrica');
      const d = 2 * info.cylinder.radius;
      // En un agujero, su diámetro es el menor: el nominal es más grande en ~1,08 pasos.
      const pitch = coarsePitch(info.cylinder.internal ? d + 1.0825 * coarsePitch(d) : d);
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      addWithDialog(ops.makeThread(doc(), refs[0], pitch));
    },

    /** Pieza importada (STL/STEP en base64): entra como referencia; el panel permite ubicarla y operar. */
    addImport(fileName: string, format: 'stl' | 'step', data: string) {
      addWithDialog(ops.makeImport(doc(), fileName, format, data));
    },

    /** Mueve una feature en el historial. Devuelve el motivo si no se puede. */
    moveFeature(id: FeatureId, toIndex: number): string | null {
      const reason = ops.moveBlocker(doc(), id, toIndex);
      if (reason) return reason;
      apply((d) => ops.moveFeature(d, id, toIndex));
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

    /** Empujar/tirar las caras planas elegidas. */
    async addPushPull(faces: number[]) {
      if (faces.length === 0) return setNotice('Seleccioná las caras planas a empujar o tirar y volvé a tocar Empujar/tirar');
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      if (refs.some((r) => r.type !== 'PLANE')) return setNotice('Empujar/tirar solo funciona con caras planas');
      addWithDialog(ops.makePushPull(doc(), refs));
    },

    /** Desmoldeo: las caras a inclinar y, al final, la cara neutra (plana). */
    async addDraft(faces: number[]) {
      if (faces.length < 2) return setNotice('Seleccioná las caras a inclinar y, al final, la cara plana neutra (la que no cambia, p. ej. la base)');
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      const neutral = refs[refs.length - 1];
      if (neutral.type !== 'PLANE') return setNotice('La última cara elegida (la neutra) tiene que ser plana');
      addWithDialog(ops.makeDraft(doc(), refs.slice(0, -1), neutral));
    },

    /** Combinar: el cuerpo de la primera cara elegida es el destino; los demás, herramientas. */
    async addCombine(faces: number[]) {
      if (faces.length < 2) return setNotice('Seleccioná una cara del cuerpo de destino y después una de cada cuerpo herramienta');
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      addWithDialog(ops.makeCombine(doc(), refs[0], refs.slice(1)));
    },

    /** Dividir: con una cara plana elegida, por su plano; si no, por XY. */
    async addSplit(faces: number[]) {
      if (faces.length > 1) return setNotice('Seleccioná una sola cara plana como plano de corte (o ninguna para cortar por XY)');
      if (faces.length === 1) {
        const refs = await withRefs(() => kernel.faceRefs(faces));
        if (!refs) return;
        if (refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
        addWithDialog(ops.makeSplit(doc(), { kind: 'face', face: refs[0] }));
        return;
      }
      const sel = selectedFeature();
      addWithDialog(ops.makeSplit(doc(), sel?.type === 'plane' ? { kind: 'plane', plane: sel.id } : { kind: 'base', plane: 'XY' }));
    },

    /** Abombar la cara plana elegida. */
    async addDome(faces: number[]) {
      if (faces.length !== 1) return setNotice('Seleccioná una cara plana para abombar');
      const refs = await withRefs(() => kernel.faceRefs(faces));
      if (!refs) return;
      if (refs[0].type !== 'PLANE') return setNotice('Abombar funciona con caras planas');
      addWithDialog(ops.makeDome(doc(), refs[0]));
    },

    /** Guarda las asas arrastradas en el visor (los tramos tocados quedan fijos). */
    moveCurveHandles(id: FeatureId, segments: BezierSegment[], touched: number[]) {
      const f = ops.findFeature(doc(), id);
      if (f?.type !== 'curve3d') return;
      apply((d) => ops.updateFeature<Curve3dFeature>(d, id, { handles: handlesAfter(segments, touched, f.handles) }));
    },

    /** Parche sobre las aristas elegidas (un contorno cerrado). */
    async addPatch(edges: number[]) {
      // Sin aristas elegidas: la curva 3D seleccionada o, si no, la última cerrada que no usa ningún parche.
      const used = new Set(doc().features.flatMap((f) => (f.type === 'patch' ? f.curves ?? [] : [])));
      const selected = selectedFeature();
      const sel = selected?.type === 'curve3d' ? selected
        : doc().features.filter((f): f is Curve3dFeature => f.type === 'curve3d' && f.closed && !used.has(f.id)).at(-1);
      if (sel && edges.length === 0) {
        if (!sel.closed) return setNotice('La curva 3D tiene que estar cerrada para hacer un parche (activá «Cerrada» en su panel)');
        return addWithDialog(ops.makePatch(doc(), [], { curves: [sel.id], operation: 'new', thickness: 0 }));
      }
      if (edges.length < 2) return setNotice('Seleccioná las aristas de un contorno cerrado (Shift + clic) y volvé a tocar Parche');
      const refs = await withRefs(() => kernel.edgeRefs(edges));
      if (!refs) return;
      // Como en Plasticity: superficie sin espesor y tangente a las caras vecinas.
      addWithDialog(ops.makePatch(doc(), refs, { operation: 'new', thickness: 0, tangent: true }));
    },

    /** Mover o copiar: los cuerpos de las caras elegidas (ninguna: todos). */
    async addMove(faces: number[]) {
      const refs = faces.length ? await withRefs(() => kernel.faceRefs(faces)) : [];
      if (!refs) return;
      addWithDialog(ops.makeMove(doc(), refs));
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
    /** `edgeAxis`: para un plano, elegir la arista que hace de eje de giro (en vez de la cara). */
    beginPick(featureId: FeatureId, edgeAxis = false, slot?: PickSlot) {
      const d = doc();
      const i = d.features.findIndex((f) => f.id === featureId);
      const f = d.features[i];
      if (!f) return;
      const multi = slot === 'faces' || slot === 'tools' || slot === 'bodies' || slot === 'loftFaces';
      const kind = slot === 'loftEdges' ? 'edges' : slot ? (multi ? 'faces' : 'face') : f.type === 'fillet' || f.type === 'chamfer' || f.type === 'patch' || edgeAxis ? 'edges' : f.type === 'shell' ? 'faces' : 'face';
      // Para un sketch o un plano: el modelo hasta antes de la feature (la cara tiene que existir antes).
      setPicking({ featureId, kind, slot, before: d });
      apply((x) => ops.setRollback(x, i), { history: false });
    },

    /** Aplica la selección del viewport a la feature en edición y restaura el marcador. */
    async finishPick(sel: { faces: number[]; edges: number[] }) {
      const p = picking();
      if (!p) return;
      const restore = (d: CadDocument) => ops.setRollback(d, p.before.rollback);
      const opts: CommitOptions = { base: p.before };
      if (p.slot === 'loftEdges' || p.slot === 'loftFaces') {
        // Solevación: agrega secciones del modelo (sin límite). Cada grupo de aristas conectadas es una.
        const loft = ops.findFeature(p.before, p.featureId);
        if (loft?.type !== 'loft') return;
        let added: LoftSection[];
        if (p.slot === 'loftEdges') {
          if (!sel.edges.length) return setNotice('Seleccioná aristas (Shift + clic para varias)');
          const chains = await withRefs(() => kernel.edgeChains(sel.edges));
          if (!chains) return;
          const refs = await withRefs(() => Promise.all(chains.map((c) => kernel.edgeRefs(c))));
          if (!refs) return;
          added = refs.map((r) => ({ edges: r }));
        } else {
          if (!sel.faces.length) return setNotice('Seleccioná al menos una cara');
          const refs = await withRefs(() => kernel.faceRefs(sel.faces));
          if (!refs) return;
          added = refs.map((face) => ({ face }));
        }
        apply((d) => restore(ops.updateFeature<LoftFeature>(d, p.featureId, { sections: [...loft.sections, ...added], continuity: loft.continuity ?? true })), opts);
        batch(() => {
          setPicking(null);
          setNotice(null);
        });
        return;
      }
      if (p.slot) {
        // Campos de caras de las features de modelado directo y de cuerpos.
        const optional = p.slot === 'bodies' || p.slot === 'body';
        if (!optional && sel.faces.length === 0) return setNotice('Seleccioná al menos una cara');
        if (!p.slot.endsWith('s') && sel.faces.length > 1) return setNotice('Seleccioná una sola cara');
        const refs = sel.faces.length ? await withRefs(() => kernel.faceRefs(sel.faces)) : [];
        if (!refs) return;
        if ((p.slot === 'neutral' || p.slot === 'plane' || p.slot === 'face') && refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
        const patch: Record<string, unknown> = {
          face: { face: refs[0] },
          faces: { faces: refs }, tools: { tools: refs }, bodies: { bodies: refs },
          neutral: { neutral: refs[0] }, target: { target: refs[0] },
          body: { body: refs[0] }, plane: { plane: { kind: 'face', face: refs[0] } },
        }[p.slot];
        apply((d) => restore(ops.updateFeature(d, p.featureId, patch as never)), opts);
        batch(() => {
          setPicking(null);
          setNotice(null);
        });
        return;
      }
      if (p.kind === 'edges' && ops.findFeature(doc(), p.featureId)?.type === 'plane') {
        if (sel.edges.length !== 1) return setNotice('Seleccioná una arista recta como eje');
        const info = await withRefs(() => kernel.edgeInfo(sel.edges[0]));
        if (!info) return;
        if (info.curveType !== 'LINE') return setNotice('La arista del eje tiene que ser recta');
        const refs = await withRefs(() => kernel.edgeRefs(sel.edges));
        if (!refs) return;
        apply((d) => restore(ops.updateFeature<PlaneFeature>(d, p.featureId, { axis: 'edge', axisEdge: refs[0] })), opts);
      } else if (p.kind === 'edges') {
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
        const target = ops.findFeature(doc(), p.featureId);
        if (target?.type === 'thread') {
          if (refs[0].type !== 'CYLINDRE') return setNotice('La cara elegida no es cilíndrica');
          apply((d) => restore(ops.updateFeature<ThreadFeature>(d, p.featureId, { face: refs[0] })), opts);
          batch(() => {
            setPicking(null);
            setNotice(null);
          });
          return;
        }
        if (refs[0].type !== 'PLANE') return setNotice('La cara elegida no es plana');
        if (target?.type === 'plane') {
          apply((d) => restore(ops.updateFeature<PlaneFeature>(d, p.featureId, { reference: { kind: 'face', face: refs[0] } })), opts);
        } else {
          const sk = target as SketchFeature;
          apply(
            (d) => restore(ops.updateFeature<SketchFeature>(d, p.featureId, { plane: { kind: 'face', face: refs[0], offset: sk.plane.offset } })),
            opts,
          );
        }
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
