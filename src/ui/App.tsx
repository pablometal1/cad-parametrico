import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { findFeature, isProfileFeature, TYPE_LABELS, unusedSketches } from '../document/ops';
import type { BasePlane, SketchFeature } from '../document/types';
import { createKernelClient } from '../kernel/client';
import type { EdgeInfo, FaceInfo, MeshPayload, RecomputeResult } from '../kernel/protocol';
import { Viewport, type PickItem, type ViewportSelection } from '../viewport/Viewport';
import { FeatureEditor } from './FeatureEditor';
import { createSketchSession } from './sketch/session';
import { SketchEditor } from './sketch/SketchEditor';
import { createCadStore } from './store';
import { FEATURE_ICONS, Timeline } from './Timeline';
import { ParameterTable } from './ParameterTable';
import { ExportDialog } from './ExportDialog';
import { PartInfo } from './PartInfo';
import type { MassProperties } from '../kernel/protocol';
import { createDirectDraw, type DrawTool } from './draw3d/controller';
import { basePlaneFrame, faceFrame } from '../document/planes';

const PLANE_MENU: { plane: BasePlane; label: string }[] = [
  { plane: 'XY', label: 'Plano XY (planta)' },
  { plane: 'XZ', label: 'Plano XZ (frente)' },
  { plane: 'YZ', label: 'Plano YZ (lateral)' },
];

const DRAW_TOOLS: { id: DrawTool; label: string; icon: string; key: string }[] = [
  { id: 'line', label: 'Línea', icon: '╱', key: 'L' },
  { id: 'rectangle', label: 'Rectángulo', icon: '▭', key: 'R' },
  { id: 'circle', label: 'Círculo', icon: '◯', key: 'C' },
  { id: 'arc', label: 'Arco', icon: '◜', key: 'A' },
];

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
  let fileInput!: HTMLInputElement;

  const openFile = async (file: File) => {
    if (store.dirty() && !window.confirm('Hay cambios sin guardar. ¿Abrir otro proyecto igual?')) return;
    const err = store.open(await file.text(), file.name);
    store.setNotice(err ?? `Se abrió "${file.name}"`);
    framed = false; // encuadrar el proyecto nuevo
  };
  const newProject = () => {
    if (store.dirty() && !window.confirm('Hay cambios sin guardar. ¿Empezar un proyecto nuevo igual?')) return;
    store.newDocument();
  };

  // Atajos globales (no mientras se escribe en un campo ni dentro del editor de sketch, que tiene los suyos).
  const onGlobalKey = (e: KeyboardEvent) => {
    if (store.editing()) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (!(e.ctrlKey || e.metaKey)) return;
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

  const store = createCadStore(kernel, { onMesh: showMesh, onSketches: setSketchLines });
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

  // Sketches visibles en 3D: los que todavía no usa ninguna feature, más el seleccionado y el
  // de la extrusión/revolución seleccionada (vista previa del perfil y de su plano de trabajo).
  createEffect(() => {
    const visible = new Set(unusedSketches(store.doc()).map((s) => s.id));
    const planes = new Set<string>();
    const sel = store.selectedFeature();
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
    if (!feature || feature.type === 'sketch' || store.editing() || store.picking() || store.drawing() || !ready()) {
      viewport?.setManipulator(null, null);
      return;
    }
    kernel.manipulator(feature.id).then(
      (m) => {
        if (req !== manipulatorRequest) return;
        viewport?.setManipulator(m, m && {
          // El nombre del parámetro coincide con el campo de la feature (distance, radius, angle…).
          onDrag: (value) => store.setFieldFromManipulator(m.featureId, m.param, value),
          onCommit: (value) => store.setFieldFromManipulator(m.featureId, m.param, value),
        });
      },
      () => req === manipulatorRequest && viewport?.setManipulator(null, null),
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
      onHoverChange: setHovered,
      onSelectionChange: async (sel) => {
        setViewSel(sel);
        const req = ++selectionRequest;
        try {
          const [faces, edges] = await Promise.all([
            Promise.all(sel.faces.map((f) => kernel.faceInfo(f))),
            Promise.all(sel.edges.map((e) => kernel.edgeInfo(e))),
          ]);
          if (req === selectionRequest) {
            setFaceInfos(faces);
            setEdgeInfos(edges);
          }
        } catch {
          if (req === selectionRequest) {
            setFaceInfos([]);
            setEdgeInfos([]);
          }
        }
      },
    });
    void store.start();
  });

  onCleanup(() => viewport?.dispose());

  const ready = () => store.kernelState().state === 'ready';
  const busy = () => !ready() || !!store.editing() || !!store.picking() || store.drawing();
  const singleFace = () => viewSel().faces.length === 1 && viewSel().edges.length === 0;

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">CAD</span>
        <div class="menu-anchor">
          <button onClick={() => setFileMenu(!fileMenu())} disabled={!!store.editing()}>Archivo ▾</button>
          <Show when={fileMenu()}>
            <div class="menu" onMouseLeave={() => setFileMenu(false)}>
              <button onClick={() => { setFileMenu(false); newProject(); }}>Nuevo</button>
              <button onClick={() => { setFileMenu(false); fileInput.click(); }}>Abrir… <span class="kbd">Ctrl+O</span></button>
              <button onClick={() => { setFileMenu(false); store.save(); }}>Guardar <span class="kbd">Ctrl+S</span></button>
              <button onClick={() => {
                setFileMenu(false);
                const name = window.prompt('Nombre del archivo', store.fileName());
                if (name?.trim()) {
                  store.setFileName(name.trim());
                  store.save();
                }
              }}>Guardar como…</button>
              <button disabled={!mass()} onClick={() => { setFileMenu(false); setExportOpen(true); }}>
                Exportar STL / 3MF / STEP… <span class="kbd">Ctrl+E</span>
              </button>
            </div>
          </Show>
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
        <span class="file-name" title={store.dirty() ? 'Hay cambios sin guardar en el archivo' : 'Guardado'}>
          {store.fileName()}{store.dirty() ? ' •' : ''}
        </span>
        <button class="icon-only" title="Deshacer (Ctrl+Z)" onClick={() => store.undo()}
          disabled={!store.canUndo() || !!store.editing() || !!store.dialog() || !!store.picking()}>↶</button>
        <button class="icon-only" title="Rehacer (Ctrl+Y)" onClick={() => store.redo()}
          disabled={!store.canRedo() || !!store.editing() || !!store.dialog() || !!store.picking()}>↷</button>
        <span class="sep" />
        <div class="menu-anchor">
          <button class="primary" onClick={() => setPlaneMenu(!planeMenu())} disabled={busy()} title="Nuevo sketch">
            ✎ Sketch ▾
          </button>
          <Show when={planeMenu()}>
            <div class="menu" onMouseLeave={() => setPlaneMenu(false)}>
              <For each={PLANE_MENU}>
                {(p) => (
                  <button onClick={() => { setPlaneMenu(false); store.setNotice(null); store.newSketch(p.plane); }}>{p.label}</button>
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
        <span class="sep" />
        <span class="tool-label">Dibujar</span>
        <For each={DRAW_TOOLS}>
          {(t) => (
            <button class="icon-only" disabled={busy()} onClick={() => void startDrawing(t.id)}
              title={`${t.label} en 3D (${t.key}) · sobre la cara o el sketch seleccionado, si no en el plano XY`}>{t.icon}</button>
          )}
        </For>
        <span class="sep" />
        <button onClick={() => store.setNotice(store.addExtrude())} disabled={busy()} title="Extruir el sketch seleccionado o el último sin usar">▤ Extrusión</button>
        <button onClick={() => store.setNotice(store.addRevolve())} disabled={busy()} title="Revolucionar el sketch seleccionado o el último sin usar">◔ Revolución</button>
        <span class="sep" />
        <button onClick={() => store.addEdgeFeature('fillet', viewSel().edges)} disabled={busy()} title="Redondear las aristas seleccionadas">◜ Redondeo</button>
        <button onClick={() => store.addEdgeFeature('chamfer', viewSel().edges)} disabled={busy()} title="Achaflanar las aristas seleccionadas">◸ Chaflán</button>
        <button onClick={() => store.addShell(viewSel().faces)} disabled={busy()} title="Vaciar quitando las caras seleccionadas">▢ Vaciado</button>
        <span class="sep" />
        <button classList={{ active: paramsOpen() }} onClick={() => setParamsOpen(!paramsOpen())} disabled={!!store.editing()}
          title="Tabla de parámetros con nombre (usables en cualquier campo numérico)">ƒx Parámetros</button>
        <span class="sep" />
        <button onClick={() => viewport?.fitView()} disabled={!ready() || !!store.editing()} title="Encuadrar (F)">Encuadrar</button>
      </header>

      <aside class="left">
        <Timeline store={store} />
      </aside>

      <main class="viewport" tabIndex={0} onKeyDown={(e) => {
        if (store.editing()) return;
        if (e.key === 'f' || e.key === 'F') viewport?.fitView();
        if (e.key === 'Escape') {
          if (store.picking()) store.cancelPick();
          else viewport?.setSelection({ faces: [], edges: [] });
        }
      }}>
        {/* Contenedor propio para el canvas: Solid no debe reconciliar sus hijos. */}
        <div class="viewport-canvas" ref={viewportEl} />
        <Show when={store.kernelState().state === 'loading'}>
          <div class="overlay">Cargando OpenCascade…</div>
        </Show>
        <Show when={store.dialog() && !store.picking() && store.selectedFeature()}>
          {(f) => (
            <div class="tool-dialog" onKeyDown={(e) => {
              if (e.key === 'Escape' && (e.target as HTMLElement).tagName !== 'INPUT') store.cancelDialog();
            }}>
              <div class="tool-dialog-title">
                <span>{FEATURE_ICONS[f().type]} {store.dialog()!.isNew ? newFeatureTitle(f().type) : `Editar ${f().name}`}</span>
              </div>
              <div class="tool-dialog-body">
                <FeatureEditor store={store} />
                <p class="hint">Arrastrá el asa naranja en el modelo o hacé clic en su valor para escribirlo.</p>
              </div>
              <div class="tool-dialog-actions">
                <button onClick={() => store.cancelDialog()}>Cancelar</button>
                <button class="primary" onClick={() => store.acceptDialog()}>✓ Aceptar</button>
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
              <span class="draw-title">✎ Dibujando en {a().label}</span>
              <div class="tool-group">
                <For each={DRAW_TOOLS}>
                  {(t) => (
                    <button classList={{ active: draw.tool() === t.id }} title={`${t.label} (${t.key})`} onClick={() => draw.setTool(t.id)}>
                      {t.icon} {t.label}
                    </button>
                  )}
                </For>
              </div>
              <Show when={a().plane.kind === 'base' && !draw.currentSketch()}>
                <select title="Plano de dibujo" value={(a().plane as { plane: BasePlane }).plane}
                  onChange={(e) => void startDrawing(draw.tool(), e.currentTarget.value as BasePlane)}>
                  <For each={PLANE_MENU}>{(p) => <option value={p.plane}>{p.plane}</option>}</For>
                </select>
              </Show>
              <label class="check" title="Ajustar a la grilla (G). Alt al hacer clic: posición libre">
                <input type="checkbox" checked={draw.gridSnap()} onChange={(e) => draw.setGridSnap(e.currentTarget.checked)} /> Grilla
              </label>
              <Show when={draw.currentSketch()}>
                <button title="Abrir el sketch en el editor para agregar cotas y restricciones" onClick={() => {
                  const id = draw.currentSketch()!;
                  draw.stop();
                  store.editSketch(id);
                }}>Cotas…</button>
              </Show>
              <button class="primary" onClick={() => draw.stop()} title="Terminar (Enter o Esc)">✓ Terminar</button>
              <Show when={draw.message()}><span class="error">{draw.message()}</span></Show>
              <span class="muted draw-hint">Clic para ubicar puntos · arrastrar: orbitar · Esc cancela · Ctrl+Z deshace</span>
            </div>
          )}
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
                <b>{findFeature(store.doc(), p().featureId)?.name}:</b> {PICK_TEXT[p().kind]}
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
              title={`${s.feature.name} · ${s.feature.plane.kind === 'base' ? `plano ${s.feature.plane.plane}` : 'sobre cara'}`}
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

      <footer class="statusbar">
        {(() => {
          const k = store.kernelState();
          if (k.state === 'loading') return <span>Kernel: cargando…</span>;
          if (k.state === 'error') return <span class="error">Error del kernel: {k.message}</span>;
          if (store.computing()) return <span>Recalculando…</span>;
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

/** "Nueva extrusión", "Nuevo redondeo"… */
function newFeatureTitle(type: keyof typeof TYPE_LABELS) {
  const feminine = type === 'extrude' || type === 'revolve';
  return `${feminine ? 'Nueva' : 'Nuevo'} ${TYPE_LABELS[type].toLowerCase()}`;
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
