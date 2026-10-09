import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { activeCount, findFeature, isProfileFeature, TYPE_LABELS, unusedSketches } from '../document/ops';
import type { BasePlane, SketchFeature } from '../document/types';
import { createKernelClient } from '../kernel/client';
import type { EdgeInfo, FaceInfo, MeshPayload, RecomputeResult } from '../kernel/protocol';
import { Viewport, type PickItem, type ViewportSelection } from '../viewport/Viewport';
import { FeatureEditor } from './FeatureEditor';
import { createSketchSession } from './sketch/session';
import { SketchEditor } from './sketch/SketchEditor';
import { createCadStore, type PickSlot } from './store';
import { Timeline } from './Timeline';
import { FEATURE_ICONS, Icon, tip } from './icons';
import { DRAW_KEYS, DRAW_TOOLS, FEATURE_KEYS, FEATURE_TOOLS, PLANE_TOOL, type FeatureTool } from './tools';
import { TooltipLayer } from './Tooltip';
import { ShortcutHelp } from './ShortcutHelp';
import { ParameterTable } from './ParameterTable';
import { ExportDialog } from './ExportDialog';
import { PartInfo } from './PartInfo';
import type { MassProperties, Measurement } from '../kernel/protocol';
import { createDirectDraw, type DrawTool } from './draw3d/controller';
import { basePlaneFrame, faceFrame } from '../document/planes';

const PLANE_MENU: { plane: BasePlane; label: string }[] = [
  { plane: 'XY', label: 'Plano XY (planta)' },
  { plane: 'XZ', label: 'Plano XZ (frente)' },
  { plane: 'YZ', label: 'Plano YZ (lateral)' },
];


const SLOT_TEXT: Record<PickSlot, string> = {
  faces: 'Elegí las caras (Shift + clic para varias)',
  neutral: 'Elegí la cara plana neutra (la que no cambia)',
  target: 'Elegí una cara del cuerpo de destino',
  tools: 'Elegí una cara de cada cuerpo herramienta (Shift + clic para varios)',
  body: 'Elegí una cara del cuerpo a dividir (ninguna: todos)',
  plane: 'Elegí la cara plana que hace de plano de corte',
  face: 'Elegí la cara plana a abombar',
  bodies: 'Elegí una cara de cada cuerpo (ninguna: todos)',
};

function pickText(kind: keyof typeof PICK_TEXT, type: string | undefined, slot?: PickSlot) {
  if (slot) return SLOT_TEXT[slot];
  if (type === 'thread') return 'Elegí la cara cilíndrica a roscar (pared de un agujero o una barra)';
  if (type === 'plane') return kind === 'edges' ? 'Elegí la arista recta que hace de eje de giro' : 'Elegí una cara plana como referencia del plano';
  return PICK_TEXT[kind];
}

const PICK_TEXT = {
  edges: 'Elegí las aristas (Shift + clic para varias)',
  faces: 'Elegí las caras a quitar (Shift + clic para varias)',
  face: 'Elegí una cara plana como apoyo del sketch',
};

export function App() {
  let viewportEl!: HTMLDivElement;
  let viewport: Viewport | undefined;
  let framed = false;
  const kernel = createKernelClient();

  const [viewSel, setViewSel] = createSignal<ViewportSelection>({ faces: [], edges: [] });
  const [faceInfos, setFaceInfos] = createSignal<FaceInfo[]>([]);
  const [edgeInfos, setEdgeInfos] = createSignal<EdgeInfo[]>([]);
  const [hovered, setHovered] = createSignal<PickItem | null>(null);
  const [planeMenu, setPlaneMenu] = createSignal(false);
  const [fileMenu, setFileMenu] = createSignal(false);
  const [paramsOpen, setParamsOpen] = createSignal(false);
  const [exportOpen, setExportOpen] = createSignal(false);
  const [mass, setMass] = createSignal<MassProperties | null>(null);
  const [measurement, setMeasurement] = createSignal<Measurement | null>(null);
  const [helpOpen, setHelpOpen] = createSignal(false);
  let fileInput!: HTMLInputElement;
  let importInput!: HTMLInputElement;

  /** Lee un STL/STEP y lo agrega como pieza importada (el archivo queda dentro del documento). */
  const importFile = async (file: File) => {
    const ext = file.name.toLowerCase().split('.').pop();
    const format = ext === 'stl' ? 'stl' : ext === 'step' || ext === 'stp' ? 'step' : null;
    if (!format) return store.setNotice('Solo se pueden importar archivos .stl, .step o .stp');
    const MAX_MB = 15;
    if (file.size > MAX_MB * 1024 * 1024) return store.setNotice(`El archivo pesa más de ${MAX_MB} MB: simplificalo antes de importarlo`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    store.addImport(file.name, format, btoa(bin));
    if (file.size > 2 * 1024 * 1024) store.setNotice('Archivo grande: la importación puede tardar unos segundos');
  };

  const openFile = async (file: File) => {
    if (store.dirty() && !window.confirm('Hay cambios sin guardar. ¿Abrir otro proyecto igual?')) return;
    const err = store.open(await file.text(), file.name);
    store.setNotice(err ?? `Se abrió "${file.name}"`);
    framed = false; // encuadrar el proyecto nuevo
  };
  const saveAs = () => {
    const name = window.prompt('Nombre del archivo', store.fileName());
    if (name?.trim()) {
      store.setFileName(name.trim());
      store.save();
    }
  };
  const runFeatureTool = (id: FeatureTool) => {
    const sel = viewSel();
    if (id === 'extrude') store.setNotice(store.addExtrude());
    else if (id === 'revolve') store.setNotice(store.addRevolve());
    else if (id === 'sweep') store.setNotice(store.addSweep());
    else if (id === 'loft') store.setNotice(store.addLoft());
    else if (id === 'thread') void store.addThread(sel.faces);
    else if (id === 'hole') {
      const msg = store.addHole();
      // Sin centros pero con una cara elegida: se marcan ahí con la herramienta Punto.
      if (msg && sel.faces.length === 1) {
        void startDrawing('point').then(() => store.setNotice('Marcá los centros de los agujeros y apretá Enter; después tocá Agujero (Shift+H)'));
      } else store.setNotice(msg);
    }
    else if (id === 'pattern' || id === 'mirror') store.setNotice(store.addCopy(id));
    else if (id === 'fillet' || id === 'chamfer') store.addEdgeFeature(id, sel.edges);
    else if (id === 'pushpull') void store.addPushPull(sel.faces);
    else if (id === 'draft') void store.addDraft(sel.faces);
    else if (id === 'combine') void store.addCombine(sel.faces);
    else if (id === 'split') void store.addSplit(sel.faces);
    else if (id === 'move') void store.addMove(sel.faces);
    else if (id === 'dome') void store.addDome(sel.faces);
    else if (id === 'patch') void store.addPatch(sel.edges);
    else if (id === 'line3d') void store.startLine3d();
    else store.addShell(sel.faces);
  };
  const newProject = () => {
    if (store.dirty() && !window.confirm('Hay cambios sin guardar. ¿Empezar un proyecto nuevo igual?')) return;
    store.newDocument();
  };

  // Atajos globales (no mientras se escribe en un campo ni dentro del editor de sketch, que tiene los suyos).
  const onGlobalKey = (e: KeyboardEvent) => {
    if (store.editing()) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (!(e.ctrlKey || e.metaKey)) {
      onPlainKey(e, tag);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      store.save();
    } else if (k === 'o') {
      e.preventDefault();
      fileInput.click();
    } else if (k === 'e') {
      e.preventDefault();
      if (mass()) setExportOpen(true);
    } else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return;
    } else if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      store.undo();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      store.redo();
    }
  };
  // Atajos de una tecla: herramientas, features, encuadrar, ayuda.
  const onPlainKey = (e: KeyboardEvent, tag: string | undefined) => {
    if (e.altKey || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || draw.active()) return;
    const k = e.key.toLowerCase();
    if (e.key === '?') {
      e.preventDefault();
      setHelpOpen(!helpOpen());
      return;
    }
    if (e.key === 'Escape') {
      if (helpOpen()) setHelpOpen(false);
      else if (fileMenu() || planeMenu()) {
        setFileMenu(false);
        setPlaneMenu(false);
      } else if (store.lining()) store.cancelLine3d();
      else if (store.picking()) store.cancelPick();
      else if (!store.dialog()) viewport?.setSelection({ faces: [], edges: [] });
      return;
    }
    if (k === 'f' && !e.shiftKey) {
      if (ready()) viewport?.fitView();
      return;
    }
    if (store.lining()) {
      if (e.key === 'Enter') {
        e.preventDefault();
        void store.finishLine3d();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        store.undoVertex();
      }
      return;
    }
    if (busy()) return;
    if (e.shiftKey) {
      if (FEATURE_KEYS[k]) {
        e.preventDefault();
        runFeatureTool(FEATURE_KEYS[k]);
      } else if (k === 'x') {
        e.preventDefault();
        setParamsOpen(!paramsOpen());
      } else if (k === PLANE_TOOL.key.slice(-1).toLowerCase()) {
        e.preventDefault();
        void store.addPlane(viewSel().faces);
      }
    } else if (DRAW_KEYS[k]) {
      e.preventDefault();
      void startDrawing(DRAW_KEYS[k]);
    } else if (k === 'k') {
      e.preventDefault();
      setPlaneMenu(!planeMenu());
    } else if (k === 'z' && ready()) {
      e.preventDefault();
      viewport?.cycleShading();
    }
  };
  // Aviso al cerrar con cambios sin guardar en archivo (en desarrollo no, para no trabar las recargas).
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!import.meta.env.DEV && store.dirty()) e.preventDefault();
  };
  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('beforeunload', onBeforeUnload);
  onCleanup(() => {
    window.removeEventListener('keydown', onGlobalKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
  });
  const [sketchLines, setSketchLines] = createSignal<RecomputeResult['sketches']>([]);
  let selectionRequest = 0;

  const showMesh = (mesh: MeshPayload | null) => {
    if (!viewport) return;
    if (!mesh) {
      viewport.clear();
      return;
    }
    viewport.setMesh(mesh);
    // Solo se encuadra la primera vez; después se respeta la cámara del usuario.
    if (!framed) {
      viewport.fitView();
      framed = true;
    }
  };

  const store = createCadStore(kernel, {
    onMesh: showMesh,
    onSketches: setSketchLines,
    onReferences: (refs) => viewport?.setReferences(refs.map((r) => r.mesh)),
  });
  const draw = createDirectDraw(store, () => viewport);

  /**
   * Empieza a dibujar en 3D. Plano: la cara plana seleccionada; si no, el sketch seleccionado
   * (se sigue dibujando en él); si no, el plano base elegido (XY por defecto).
   */
  const startDrawing = async (tool: DrawTool, base?: BasePlane) => {
    store.setNotice(null);
    const size = Math.max(50, (viewport?.modelRadius ?? 0) * 1.5);
    const sel = viewSel();
    if (!base && sel.faces.length === 1) {
      try {
        const [info] = await Promise.all([kernel.faceInfo(sel.faces[0])]);
        if (info.surfaceType !== 'PLANE') {
          store.setNotice('La cara seleccionada no es plana: elegí una cara plana o deseleccioná para dibujar en un plano base');
          return;
        }
        const [ref] = await kernel.faceRefs([sel.faces[0]]);
        const frame = faceFrame(info.center, info.normal);
        const c = info.center;
        const r = [c[0] - frame.origin[0], c[1] - frame.origin[1], c[2] - frame.origin[2]];
        const center: [number, number] = [
          r[0] * frame.xDir[0] + r[1] * frame.xDir[1] + r[2] * frame.xDir[2],
          r[0] * frame.yDir[0] + r[1] * frame.yDir[1] + r[2] * frame.yDir[2],
        ];
        draw.start({
          plane: { kind: 'face', face: ref, offset: 0 }, frame, featureId: null, data: { entities: [], constraints: [] },
          label: `cara #${info.index}`, center, extent: Math.max(30, Math.sqrt(info.area)),
        }, tool);
      } catch (err) {
        store.setNotice((err as Error).message);
      }
      return;
    }
    const selected = store.selectedFeature();
    if (!base && selected?.type === 'plane') {
      const frame = store.planeFrames().get(selected.id);
      if (!frame) {
        store.setNotice(`"${selected.name}" tiene un error: corregilo antes de dibujar en él`);
        return;
      }
      draw.start({
        plane: { kind: 'plane', plane: selected.id, offset: 0 }, frame, featureId: null,
        data: { entities: [], constraints: [] }, label: selected.name, center: [0, 0], extent: size,
      }, tool);
      return;
    }
    if (!base && selected?.type === 'sketch') {
      const lines = sketchLines().find((l) => l.id === selected.id);
      const evaluatedSketch = store.evaluated().doc.features.find((f) => f.id === selected.id) as SketchFeature;
      if (lines) {
        const [u0, v0, u1, v1] = lines.bounds;
        draw.start({
          plane: selected.plane, frame: lines.plane, featureId: selected.id,
          data: { entities: evaluatedSketch.entities, constraints: evaluatedSketch.constraints },
          label: selected.name, center: [(u0 + u1) / 2, (v0 + v1) / 2], extent: Math.max(size, (u1 - u0), (v1 - v0)),
        }, tool);
        return;
      }
    }
    const plane = base ?? 'XY';
    draw.start({
      plane: { kind: 'base', plane, offset: 0 }, frame: basePlaneFrame({ kind: 'base', plane, offset: 0 }), featureId: null,
      data: { entities: [], constraints: [] }, label: `plano ${plane}`, center: [0, 0], extent: size,
    }, tool);
  };

  // Planos de construcción: como los sketches, se ven mientras no los usa nada (o si están
  // elegidos o en edición). El elegido se resalta.
  createEffect(() => {
    const frames = store.planeFrames();
    const sel = store.selectedId();
    const editingPlane = store.dialog()?.featureId;
    const d = store.doc();
    const active = d.features.slice(0, activeCount(d)).filter((f) => !f.suppressed);
    const used = new Set(active.flatMap((f) =>
      f.type === 'sketch' && f.plane.kind === 'plane' ? [f.plane.plane] : f.type === 'plane' && f.reference.kind === 'plane' ? [f.reference.plane] : []));
    const list = store.editing()
      ? []
      : [...frames].filter(([id]) => !used.has(id) || id === sel || id === editingPlane).map(([id, frame]) => ({ id, frame, selected: id === sel }));
    viewport?.setConstructionPlanes(list);
  });

  // Al cerrar una herramienta, terminar un sketch o dejar de dibujar se limpia la selección 3D
  // (las aristas de un redondeo, la cara de un vaciado…).
  let wasBusy = false;
  createEffect(() => {
    const busyNow = !!store.dialog() || !!store.editing() || store.drawing() || !!store.lining();
    if (wasBusy && !busyNow && !store.picking()) viewport?.setSelection({ faces: [], edges: [] });
    wasBusy = busyNow;
  });

  // Sketches visibles en 3D: los que todavía no usa ninguna feature, más el seleccionado y el
  // de la extrusión/revolución seleccionada (vista previa del perfil y de su plano de trabajo).
  createEffect(() => {
    const visible = new Set(unusedSketches(store.doc()).map((s) => s.id));
    const planes = new Set<string>();
    const sel = store.selectedFeature();
    // Curvas 3D: siempre a la vista salvo las que ya usa un parche (como los sketches).
    const usedCurves = new Set(store.doc().features.flatMap((f) => (f.type === 'patch' ? f.curves ?? [] : [])));
    for (const f of store.doc().features) if (f.type === 'curve3d' && !usedCurves.has(f.id)) visible.add(f.id);
    if (sel?.type === 'curve3d') visible.add(sel.id);
    if (sel?.type === 'sketch') {
      visible.add(sel.id);
      planes.add(sel.id);
    }
    if (sel && isProfileFeature(sel)) {
      visible.add(sel.sketch);
      planes.add(sel.sketch);
    }
    viewport?.setSketches(sketchLines(), visible);
    viewport?.setSketchPlanes(sketchLines(), store.editing() ? new Set() : planes);
  });

  // Propiedades de la pieza (volumen, masa…) tras cada recálculo.
  let massRequest = 0;
  createEffect(() => {
    store.results();
    if (!ready()) return;
    const req = ++massRequest;
    kernel.massProperties().then(
      (m) => req === massRequest && setMass(m),
      () => req === massRequest && setMass(null),
    );
  });

  // Manipulador 3D de la feature seleccionada: se pide al kernel después de cada recálculo.
  let manipulatorRequest = 0;
  createEffect(() => {
    const id = store.selectedId();
    store.results(); // re-evaluar tras cada recálculo
    const feature = id ? findFeature(store.doc(), id) : undefined;
    const req = ++manipulatorRequest;
    if (!feature || feature.type === 'sketch' || store.editing() || store.picking() || store.drawing() || store.lining() || !ready()) {
      viewport?.setManipulator([], null);
      return;
    }
    kernel.manipulator(feature.id).then(
      (ms) => {
        if (req !== manipulatorRequest) return;
        viewport?.setManipulator(ms, (m) => ({
          // El nombre del parámetro coincide con el campo de la feature (distance, radius, angle, dx…).
          onDrag: (value) => store.setFieldFromManipulator(m.featureId, m.param, value),
          onCommit: (value) => store.setFieldFromManipulator(m.featureId, m.param, value),
        }));
      },
      () => req === manipulatorRequest && viewport?.setManipulator([], null),
    );
  });

  // En modo elegir, solo se puede seleccionar el tipo de entidad que se pide.
  createEffect(() => {
    const p = store.picking();
    viewport?.setPickable(p ? { face: p.kind !== 'edges', edge: p.kind === 'edges' } : { face: true, edge: true });
  });

  // Sesión de edición del sketch activo: se crea una sola vez al entrar al modo sketch
  // (cambios del documento mientras tanto no la reinician).
  const session = createMemo(() => {
    const e = store.editing();
    if (!e) return null;
    const f = untrack(() => store.evaluated().doc.features.find((x) => x.id === e.featureId)) as SketchFeature | undefined;
    if (!f) return null;
    // Cotas con su valor evaluado; las expresiones se editan por id de restricción.
    const exprs = Object.fromEntries(
      Object.entries(f.exprs ?? {}).filter(([k]) => k.startsWith('constraint:')).map(([k, v]) => [k.slice(11), v]),
    );
    const session = createSketchSession(
      { entities: f.entities, constraints: f.constraints },
      { exprs, scope: () => store.evaluated().scope },
    );
    return { feature: f, session };
  });

  onMount(() => {
    viewport = new Viewport(viewportEl, {
      // Elegir sketches y planos haciendo clic en 3D; clic en el vacío deselecciona.
      onFeaturePick: (id) => {
        if (store.dialog() || store.picking() || store.editing() || store.drawing() || store.lining()) return;
        store.selectFeature(id);
      },
      onEmptyClick: () => {
        if (store.dialog() || store.picking() || store.editing() || store.drawing() || store.lining()) return;
        store.selectFeature(null);
      },
      onHoverChange: setHovered,
      onSelectionChange: async (sel) => {
        setViewSel(sel);
        const req = ++selectionRequest;
        try {
          const [faces, edges] = await Promise.all([
            Promise.all(sel.faces.map((f) => kernel.faceInfo(f))),
            Promise.all(sel.edges.map((e) => kernel.edgeInfo(e))),
          ]);
          // Con dos elementos seleccionados se mide entre ellos.
          let m: Measurement | null = null;
          if (sel.faces.length + sel.edges.length === 2) {
            try {
              m = await kernel.measure(sel.faces, sel.edges);
            } catch {
              m = null;
            }
          }
          if (req === selectionRequest) {
            setFaceInfos(faces);
            setEdgeInfos(edges);
            setMeasurement(m);
            viewport?.setMeasure(m && m.distance > 1e-9 ? { p1: m.p1, p2: m.p2, text: `${fmtNum(m.distance)} mm` } : null);
          }
        } catch {
          if (req === selectionRequest) {
            setFaceInfos([]);
            setEdgeInfos([]);
            setMeasurement(null);
            viewport?.setMeasure(null);
          }
        }
      },
    });
    void store.start();
  });

  onCleanup(() => viewport?.dispose());

  const ready = () => store.kernelState().state === 'ready';
  const busy = () => !ready() || !!store.editing() || !!store.picking() || store.drawing() || !!store.lining();

  // Línea 3D: el visor muestra los vértices y la cadena elegida.
  createEffect(() => {
    const l = store.lining();
    viewport?.setVertexMode(l?.vertices ?? null, l ? { onPick: (i) => store.pickVertex(i) } : null);
  });
  createEffect(() => {
    const l = store.lining();
    if (l) viewport?.setVertexChain(l.chain);
  });
  const singleFace = () => viewSel().faces.length === 1 && viewSel().edges.length === 0;

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand" {...tip('CAD paramétrico', undefined, 'Pieza en milímetros')}>CAD</span>
        <div class="menu-anchor">
          <button class="tb has-caret" classList={{ active: fileMenu() }} onClick={() => setFileMenu(!fileMenu())} disabled={!!store.editing()}
            {...tip('Archivo', undefined, 'Nuevo, abrir, guardar y exportar')}>
            <Icon name="file" /><Icon name="caret" size={12} class="caret" />
          </button>
          <Show when={fileMenu()}>
            <div class="menu" onMouseLeave={() => setFileMenu(false)}>
              <button onClick={() => { setFileMenu(false); newProject(); }}><Icon name="new" size={16} />Nuevo</button>
              <button onClick={() => { setFileMenu(false); fileInput.click(); }}><Icon name="open" size={16} />Abrir… <span class="kbd">Ctrl+O</span></button>
              <button onClick={() => { setFileMenu(false); store.save(); }}><Icon name="save" size={16} />Guardar <span class="kbd">Ctrl+S</span></button>
              <button onClick={() => { setFileMenu(false); saveAs(); }}><Icon name="saveAs" size={16} />Guardar como…</button>
              <button onClick={() => { setFileMenu(false); importInput.click(); }}><Icon name="import" size={16} />Importar STL / STEP…</button>
              <button disabled={!mass()} onClick={() => { setFileMenu(false); setExportOpen(true); }}>
                <Icon name="export" size={16} />Exportar STL / 3MF / STEP… <span class="kbd">Ctrl+E</span>
              </button>
            </div>
          </Show>
          <input
            ref={importInput}
            type="file"
            accept=".stl,.step,.stp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void importFile(file);
            }}
          />
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (file) void openFile(file);
            }}
          />
        </div>
        <button class="tb" onClick={() => store.save()} disabled={!!store.editing()} {...tip('Guardar', 'Ctrl+S')}><Icon name="save" /></button>
        <button class="tb" onClick={() => setExportOpen(true)} disabled={!mass() || !!store.editing()} {...tip('Exportar', 'Ctrl+E', 'STL, 3MF o STEP para imprimir')}>
          <Icon name="export" />
        </button>
        <span class="file-name" {...tip(store.fileName(), undefined, store.dirty() ? 'Hay cambios sin guardar en el archivo' : 'Guardado')}>
          {store.fileName()}{store.dirty() ? ' •' : ''}
        </span>
        <span class="sep" />
        <button class="tb" onClick={() => store.undo()} {...tip('Deshacer', 'Ctrl+Z')}
          disabled={!store.canUndo() || !!store.editing() || !!store.dialog() || !!store.picking()}><Icon name="undo" /></button>
        <button class="tb" onClick={() => store.redo()} {...tip('Rehacer', 'Ctrl+Y')}
          disabled={!store.canRedo() || !!store.editing() || !!store.dialog() || !!store.picking()}><Icon name="redo" /></button>
        <span class="sep" />
        <div class="menu-anchor">
          <button class="tb primary has-caret" classList={{ active: planeMenu() }} onClick={() => setPlaneMenu(!planeMenu())} disabled={busy()}
            {...tip('Nuevo sketch', 'K', 'Abrir el editor 2D con restricciones sobre un plano o una cara')}>
            <Icon name="sketch" /><Icon name="caret" size={12} class="caret" />
          </button>
          <Show when={planeMenu()}>
            <div class="menu" onMouseLeave={() => setPlaneMenu(false)}>
              <For each={PLANE_MENU}>
                {(p) => (
                  <button onClick={() => { setPlaneMenu(false); store.setNotice(null); store.newSketch(p.plane); }}>{p.label}</button>
                )}
              </For>
              <For each={store.doc().features.filter((f) => f.type === 'plane' && store.planeFrames().has(f.id))}>
                {(p) => (
                  <button onClick={() => { setPlaneMenu(false); store.setNotice(null); store.newSketchOnPlane(p.id); }}>
                    <Icon name="plane" size={16} />{p.name}
                  </button>
                )}
              </For>
              <button
                disabled={!singleFace()}
                title={singleFace() ? '' : 'Primero seleccioná una cara plana en el modelo'}
                onClick={() => { setPlaneMenu(false); store.setNotice(null); void store.newSketchOnFace(viewSel().faces[0]); }}
              >
                En la cara seleccionada
              </button>
            </div>
          </Show>
        </div>
        <button class="tb" onClick={() => void store.addPlane(viewSel().faces)} disabled={busy()}
          {...tip(PLANE_TOOL.label, PLANE_TOOL.key, PLANE_TOOL.desc)}><Icon name="plane" /></button>
        <div class="tb-group">
          <For each={DRAW_TOOLS}>
            {(t) => (
              <button class="tb" disabled={busy()} onClick={() => void startDrawing(t.id)}
                {...tip(t.label, t.key, 'Dibujar en 3D sobre la cara o el sketch seleccionado (si no, en el plano XY)')}>
                <Icon name={t.icon} />
              </button>
            )}
          </For>
        </div>
        <span class="sep" />
        <For each={FEATURE_TOOLS}>
          {(t) => (
            <>
              <Show when={t.sepBefore}><span class="sep" /></Show>
              <button class="tb" onClick={() => runFeatureTool(t.id)} disabled={busy()} {...tip(t.label, t.key, t.desc)}>
                <Icon name={t.icon} />
              </button>
            </>
          )}
        </For>
        <span class="sep" />
        <button class="tb" classList={{ active: paramsOpen() }} onClick={() => setParamsOpen(!paramsOpen())} disabled={!!store.editing()}
          {...tip('Parámetros', 'Shift+X', 'Tabla de valores con nombre, usables en cualquier campo numérico')}><Icon name="params" /></button>
        <span class="spacer" />
        <button class="tb" onClick={() => viewport?.fitView()} disabled={!ready() || !!store.editing()} {...tip('Encuadrar', 'F')}><Icon name="fit" /></button>
        <button class="tb" classList={{ active: helpOpen() }} onClick={() => setHelpOpen(!helpOpen())} {...tip('Atajos de teclado', '?')}><Icon name="help" /></button>
      </header>

      <aside class="left">
        <Timeline store={store} />
      </aside>

      <main class="viewport" tabIndex={0}>
        {/* Contenedor propio para el canvas: Solid no debe reconciliar sus hijos. */}
        <div class="viewport-canvas" ref={viewportEl} />
        <Show when={store.kernelState().state === 'loading'}>
          <div class="overlay">Cargando OpenCascade…</div>
        </Show>
        <Show when={ready() && store.doc().features.length === 0 && !store.editing() && !draw.active()}>
          <div class="empty-hint">
            <h3>Empezá una pieza</h3>
            <ol>
              <li>Dibujá en el plano XY con <Icon name="rectangle" size={16} /> <kbd>R</kbd> o <Icon name="circle" size={16} /> <kbd>C</kbd>, o abrí un <Icon name="sketch" size={16} /> sketch <kbd>K</kbd></li>
              <li>Dale volumen con <Icon name="extrude" size={16} /> Extrusión <kbd>Shift+E</kbd></li>
              <li>Exportá para imprimir con <Icon name="export" size={16} /> <kbd>Ctrl+E</kbd></li>
            </ol>
            <p>Todos los atajos: <kbd>?</kbd></p>
          </div>
        </Show>
        <Show when={store.dialog() && !store.picking() && store.selectedFeature()}>
          {(f) => (
            <div class="tool-dialog" onKeyDown={(e) => {
              if (e.key === 'Escape' && (e.target as HTMLElement).tagName !== 'INPUT') store.cancelDialog();
            }}>
              <div class="tool-dialog-title">
                <span class="with-icon"><Icon name={FEATURE_ICONS[f().type]} size={16} /> {store.dialog()!.isNew ? newFeatureTitle(f().type) : `Editar ${f().name}`}</span>
              </div>
              <div class="tool-dialog-body">
                <FeatureEditor store={store} />
                <Show when={['extrude', 'revolve', 'fillet', 'chamfer', 'shell', 'plane', 'hole', 'pushpull', 'dome', 'move'].includes(f().type)}>
                  <p class="hint">Arrastrá el asa naranja en el modelo o hacé clic en su valor para escribirlo.</p>
                </Show>
              </div>
              <div class="tool-dialog-actions">
                <button onClick={() => store.cancelDialog()}>Cancelar</button>
                <button class="primary with-icon" onClick={() => store.acceptDialog()}><Icon name="check" size={15} />Aceptar</button>
              </div>
            </div>
          )}
        </Show>
        {/* Avisos como cartel flotante (no ocupan lugar en la barra). */}
        <Show when={store.notice()}>
          <div class="toast" onClick={() => store.setNotice(null)} title="Clic para ocultar">
            {store.notice()} <span class="toast-close">✕</span>
          </div>
        </Show>
        <Show when={draw.active()}>
          {(a) => (
            <div class="draw-bar">
              <span class="draw-title with-icon"><Icon name="sketch" size={16} /> {a().label}</span>
              <div class="tool-group">
                <For each={DRAW_TOOLS}>
                  {(t) => (
                    <button class="tb" classList={{ active: draw.tool() === t.id }} {...tip(t.label, t.key)} onClick={() => draw.setTool(t.id)}>
                      <Icon name={t.icon} />
                    </button>
                  )}
                </For>
              </div>
              <Show when={draw.tool() === 'text'}>
                <span class="text-opts">
                  <input class="text-input" value={draw.textOptions().text} placeholder="Texto"
                    onInput={(e) => draw.setTextOptions({ ...draw.textOptions(), text: e.currentTarget.value })} />
                  <label class="sides" title="Altura de las mayúsculas (mm)">
                    <input type="number" min="0.5" step="0.5" value={draw.textOptions().height}
                      onChange={(e) => draw.setTextOptions({ ...draw.textOptions(), height: Math.max(0.5, Number(e.currentTarget.value) || 10) })} /> mm
                  </label>
                  <label class="sides">
                    <input type="checkbox" checked={draw.textOptions().bold}
                      onChange={(e) => draw.setTextOptions({ ...draw.textOptions(), bold: e.currentTarget.checked })} /> negrita
                  </label>
                </span>
              </Show>
              <Show when={draw.tool() === 'polygon'}>
                <label class="sides" title="Cantidad de lados del polígono">
                  <input type="number" min="3" max="64" value={draw.sides()} onChange={(e) => draw.setSides(Number(e.currentTarget.value))} /> lados
                </label>
              </Show>
              <Show when={a().plane.kind === 'base' && !draw.currentSketch()}>
                <select title="Plano de dibujo" value={(a().plane as { plane: BasePlane }).plane}
                  onChange={(e) => void startDrawing(draw.tool(), e.currentTarget.value as BasePlane)}>
                  <For each={PLANE_MENU}>{(p) => <option value={p.plane}>{p.plane}</option>}</For>
                </select>
              </Show>
              <button class="tb" classList={{ active: draw.gridSnap() }} onClick={() => draw.setGridSnap(!draw.gridSnap())}
                {...tip('Ajustar a la grilla', 'G', 'Alt al hacer clic: posición libre')}><Icon name="grid" /></button>
              <Show when={draw.currentSketch()}>
                <button class="tb" {...tip('Cotas y restricciones', undefined, 'Abrir este sketch en el editor 2D')} onClick={() => {
                  const id = draw.currentSketch()!;
                  draw.stop();
                  store.editSketch(id);
                }}><Icon name="dims" /></button>
              </Show>
              <button class="primary with-icon" onClick={() => draw.stop()} {...tip('Terminar', 'Enter')}><Icon name="check" size={16} />Terminar</button>
              <Show when={draw.message()}><span class="error">{draw.message()}</span></Show>
              <span class="muted draw-hint">Clic para ubicar puntos · arrastrar: orbitar · Esc cancela · Ctrl+Z deshace</span>
            </div>
          )}
        </Show>
        <Show when={store.lining()}>
          {(l) => (
            <div class="draw-bar">
              <span class="draw-title with-icon"><Icon name="curve3d" size={16} /> Línea 3D · {l().chain.length} vértices</span>
              <button class="primary with-icon" disabled={l().chain.length < 2} onClick={() => void store.finishLine3d()} {...tip('Terminar', 'Enter')}><Icon name="check" size={16} />Terminar</button>
              <button disabled={l().chain.length < 3} onClick={() => void store.finishLine3d(true)} {...tip('Cerrar', undefined, 'Une el último vértice con el primero (o hacé clic en el primero)')}>Cerrar</button>
              <button onClick={() => store.cancelLine3d()} {...tip('Cancelar', 'Esc')}>Cancelar</button>
              <span class="muted draw-hint">Clic en los vértices del modelo · clic en el primero cierra · Backspace quita el último · arrastrar: orbitar</span>
            </div>
          )}
        </Show>
        <Show when={helpOpen()}>
          <ShortcutHelp onClose={() => setHelpOpen(false)} />
        </Show>
        <Show when={exportOpen()}>
          <ExportDialog kernel={kernel} fileName={store.fileName()} onClose={() => setExportOpen(false)} onDone={(m) => store.setNotice(m)} />
        </Show>
        <Show when={paramsOpen() && !store.editing()}>
          <ParameterTable store={store} onClose={() => setParamsOpen(false)} />
        </Show>
        <Show when={store.picking()}>
          {(p) => (
            <div class="pick-banner">
              <span>
                <b>{findFeature(store.doc(), p().featureId)?.name}:</b> {pickText(p().kind, findFeature(store.doc(), p().featureId)?.type, p().slot)}
                {' · '}{p().kind === 'edges' ? `${viewSel().edges.length} elegidas` : `${viewSel().faces.length} elegidas`}
              </span>
              <button class="primary" onClick={() => void store.finishPick(viewport?.getSelection() ?? { faces: [], edges: [] })}>Aplicar</button>
              <button onClick={() => store.cancelPick()}>Cancelar</button>
            </div>
          )}
        </Show>
        <Show when={session()} keyed>
          {(s) => (
            <SketchEditor
              session={s.session}
              title={`${s.feature.name} · ${sketchPlaneLabel(s.feature)}`}
              reference={() => sketchLines().find((l) => l.id === s.feature.id)?.reference}
              onFinish={() => store.finishSketch(s.session.data(), s.session.documentExprs())}
              onCancel={() => {
                if (s.session.dirty() && !window.confirm('¿Descartar los cambios del sketch?')) return;
                store.cancelSketch();
              }}
            />
          )}
        </Show>
      </main>

      <aside class="panel">
        <h2>Parámetros</h2>
        <Show when={!store.dialog()} fallback={<p class="muted">Editando en el cuadro de la herramienta (en el área 3D).</p>}>
          <FeatureEditor store={store} />
        </Show>

        <h2 class="section-gap">Pieza</h2>
        <PartInfo props={mass()} />

        <h2 class="section-gap">Selección</h2>
        <Show
          when={faceInfos().length + edgeInfos().length > 0}
          fallback={<p class="muted">Clic en una cara o arista para seleccionarla. Shift/Ctrl + clic para agregar o quitar.</p>}
        >
          <For each={faceInfos()}>
            {(f) => (
              <dl class="face-info">
                <dt>Cara</dt><dd>#{f.index}</dd>
                <dt>Superficie</dt><dd>{surfaceLabel(f.surfaceType)}</dd>
                <dt>Área</dt><dd>{f.area.toFixed(2)} mm²</dd>
                <dt>Centro</dt><dd>{fmtVec(f.center)}</dd>
                <dt>Normal</dt><dd>{fmtVec(f.normal)}</dd>
              </dl>
            )}
          </For>
          <Show when={measurement()}>
            {(m) => (
              <dl class="face-info measure-info">
                <dt class="with-icon"><Icon name="measure" size={14} />Distancia</dt><dd>{fmtNum(m().distance)} mm</dd>
                <Show when={m().planeDistance !== undefined}>
                  <dt>Entre planos</dt><dd>{fmtNum(m().planeDistance!)} mm</dd>
                </Show>
                <Show when={m().angle !== undefined}>
                  <dt>Ángulo</dt><dd>{fmtNum(m().angle!)}°</dd>
                </Show>
              </dl>
            )}
          </Show>
          <For each={edgeInfos()}>
            {(e) => (
              <dl class="face-info">
                <dt>Arista</dt><dd>#{e.index}</dd>
                <dt>Tipo</dt><dd>{curveLabel(e.curveType)}</dd>
                <dt>Longitud</dt><dd>{e.length.toFixed(3)} mm</dd>
                <dt>Punto medio</dt><dd>{fmtVec(e.midpoint)}</dd>
              </dl>
            )}
          </For>
        </Show>
      </aside>

      <TooltipLayer />
      <footer class="statusbar">
        {(() => {
          const k = store.kernelState();
          if (k.state === 'loading') return <span>Kernel: cargando…</span>;
          if (k.state === 'error') return <span class="error">Error del kernel: {k.message}</span>;
          if (store.computing()) return <span>Recalculando…</span>;
          const re = store.recomputeError();
          if (re) return <span class="error">No se pudo recalcular: {re}. Deshacé el último cambio (Ctrl+Z) o probá otros valores.</span>;
          const s = store.stats();
          if (!s) return <span>Kernel listo</span>;
          return (
            <span>
              Recalculado en {s.totalMs} ms · {s.computed} calculadas, {s.cached} desde cache
              <Show when={s.errors > 0}> · <span class="error">{s.errors} con error</span></Show>
            </span>
          );
        })()}
        <span class="spacer" />
        <span>{hovered() ? `${hovered()!.kind === 'face' ? 'Cara' : 'Arista'} #${hovered()!.index}` : ''}</span>
        <span>mm</span>
      </footer>
    </div>
  );
}

/** Dónde está apoyado un sketch, para el título del editor. */
function sketchPlaneLabel(f: SketchFeature) {
  const p = f.plane;
  if (p.kind === 'base') return `plano ${p.plane}`;
  if (p.kind === 'face') return 'sobre cara';
  return 'sobre plano de construcción';
}

/** "Nueva extrusión", "Nuevo redondeo"… */
function newFeatureTitle(type: keyof typeof TYPE_LABELS) {
  if (type === 'curve3d') return 'Nueva curva 3D';
  const feminine = type === 'extrude' || type === 'revolve' || type === 'loft' || type === 'thread' || type === 'split';
  return `${feminine ? 'Nueva' : 'Nuevo'} ${TYPE_LABELS[type].toLowerCase()}`;
}

function fmtNum(v: number) {
  return String(Math.round(v * 1000) / 1000);
}

function fmtVec(v: [number, number, number]) {
  return `(${v.map((x) => (Math.abs(x) < 5e-7 ? 0 : x).toFixed(3)).join(', ')})`;
}

function surfaceLabel(t: FaceInfo['surfaceType']) {
  const labels: Partial<Record<FaceInfo['surfaceType'], string>> = {
    PLANE: 'Plana', CYLINDRE: 'Cilíndrica', CONE: 'Cónica', SPHERE: 'Esférica', TORUS: 'Tórica',
  };
  return labels[t] ?? t;
}

function curveLabel(t: string) {
  const labels: Record<string, string> = { LINE: 'Recta', CIRCLE: 'Circular', ELLIPSE: 'Elíptica', BSPLINE_CURVE: 'B-spline' };
  return labels[t] ?? t;
}
