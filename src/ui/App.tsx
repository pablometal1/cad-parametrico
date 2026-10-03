import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { findFeature, unusedSketches } from '../document/ops';
import type { BasePlane, SketchFeature } from '../document/types';
import { createKernelClient } from '../kernel/client';
import type { FaceInfo, MeshPayload, RecomputeResult } from '../kernel/protocol';
import { Viewport } from '../viewport/Viewport';
import { FeatureEditor } from './FeatureEditor';
import { createSketchSession } from './sketch/session';
import { SketchEditor } from './sketch/SketchEditor';
import { createCadStore } from './store';
import { Timeline } from './Timeline';

const PLANE_MENU: { plane: BasePlane; label: string }[] = [
  { plane: 'XY', label: 'Plano XY (planta)' },
  { plane: 'XZ', label: 'Plano XZ (frente)' },
  { plane: 'YZ', label: 'Plano YZ (lateral)' },
];

export function App() {
  let viewportEl!: HTMLDivElement;
  let viewport: Viewport | undefined;
  let framed = false;
  const kernel = createKernelClient();

  const [selection, setSelection] = createSignal<FaceInfo[]>([]);
  const [hovered, setHovered] = createSignal<number | null>(null);
  const [planeMenu, setPlaneMenu] = createSignal(false);
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

  // Sketches visibles en 3D: los que todavía no usa ninguna feature, más el seleccionado.
  createEffect(() => {
    const visible = new Set(unusedSketches(store.doc()).map((s) => s.id));
    const sel = store.selectedFeature();
    if (sel?.type === 'sketch') visible.add(sel.id);
    viewport?.setSketches(sketchLines(), visible);
  });

  // Sesión de edición del sketch activo: se crea una sola vez al entrar al modo sketch
  // (cambios del documento mientras tanto no la reinician).
  const session = createMemo(() => {
    const e = store.editing();
    if (!e) return null;
    const f = untrack(() => findFeature(store.doc(), e.featureId)) as SketchFeature | undefined;
    return f ? { feature: f, session: createSketchSession({ entities: f.entities, constraints: f.constraints }) } : null;
  });

  onMount(() => {
    viewport = new Viewport(viewportEl, {
      onHoverChange: setHovered,
      onSelectionChange: async (faces) => {
        const req = ++selectionRequest;
        try {
          const infos = await Promise.all(faces.map((f) => kernel.faceInfo(f)));
          if (req === selectionRequest) setSelection(infos);
        } catch {
          if (req === selectionRequest) setSelection([]);
        }
      },
    });
    void store.start();
  });

  onCleanup(() => viewport?.dispose());

  const ready = () => store.kernelState().state === 'ready';

  const extrude = () => {
    const err = store.addExtrude();
    store.setNotice(err);
  };

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">CAD</span>
        <div class="menu-anchor">
          <button class="primary" onClick={() => setPlaneMenu(!planeMenu())} disabled={!ready() || !!store.editing()} title="Nuevo sketch">
            ✎ Sketch ▾
          </button>
          <Show when={planeMenu()}>
            <div class="menu" onMouseLeave={() => setPlaneMenu(false)}>
              <For each={PLANE_MENU}>
                {(p) => (
                  <button onClick={() => { setPlaneMenu(false); store.setNotice(null); store.newSketch(p.plane); }}>{p.label}</button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <button class="primary" onClick={extrude} disabled={!ready() || !!store.editing()} title="Extruir el sketch seleccionado o el último sin usar">
          ▤ Extrusión
        </button>
        <span class="sep" />
        <button onClick={() => viewport?.fitView()} disabled={!ready() || !!store.editing()} title="Encuadrar (F)">Encuadrar</button>
        <button onClick={() => viewport?.setSelection([])} disabled={selection().length === 0}>Limpiar selección</button>
        <Show when={store.notice()}>
          <span class="notice" onClick={() => store.setNotice(null)}>{store.notice()}</span>
        </Show>
      </header>

      <aside class="left">
        <Timeline store={store} />
      </aside>

      <main class="viewport" tabIndex={0} onKeyDown={(e) => {
        if (store.editing()) return;
        if (e.key === 'f' || e.key === 'F') viewport?.fitView();
        if (e.key === 'Escape') viewport?.setSelection([]);
      }}>
        {/* Contenedor propio para el canvas: Solid no debe reconciliar sus hijos. */}
        <div class="viewport-canvas" ref={viewportEl} />
        <Show when={store.kernelState().state === 'loading'}>
          <div class="overlay">Cargando OpenCascade…</div>
        </Show>
        <Show when={session()} keyed>
          {(s) => (
            <SketchEditor
              session={s.session}
              title={`${s.feature.name} · plano ${s.feature.plane.plane}`}
              onFinish={() => store.finishSketch(s.session.data())}
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
        <FeatureEditor store={store} />

        <h2 class="section-gap">Selección</h2>
        <Show when={selection().length > 0} fallback={<p class="muted">Clic en una cara para seleccionarla. Shift/Ctrl + clic para agregar o quitar.</p>}>
          <For each={selection()}>
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
        <span>{hovered() !== null ? `Cara #${hovered()}` : ''}</span>
        <span>mm</span>
      </footer>
    </div>
  );
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
