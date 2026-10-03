import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createKernelClient } from '../kernel/client';
import type { FaceInfo, MeshPayload } from '../kernel/protocol';
import { Viewport } from '../viewport/Viewport';
import { FeatureEditor } from './FeatureEditor';
import { createCadStore } from './store';
import { Timeline } from './Timeline';

export function App() {
  let viewportEl!: HTMLDivElement;
  let viewport: Viewport | undefined;
  let framed = false;
  const kernel = createKernelClient();

  const [selection, setSelection] = createSignal<FaceInfo[]>([]);
  const [hovered, setHovered] = createSignal<number | null>(null);
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

  const store = createCadStore(kernel, showMesh);

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

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">CAD</span>
        <button class="primary" onClick={() => store.addExtrude()} disabled={!ready()} title="Agregar una extrusión">
          ▤ Extrusión
        </button>
        <span class="sep" />
        <button onClick={() => viewport?.fitView()} disabled={!ready()} title="Encuadrar (F)">Encuadrar</button>
        <button onClick={() => viewport?.setSelection([])} disabled={selection().length === 0}>Limpiar selección</button>
      </header>

      <aside class="left">
        <Timeline store={store} />
      </aside>

      <main class="viewport" tabIndex={0} onKeyDown={(e) => {
        if (e.key === 'f' || e.key === 'F') viewport?.fitView();
        if (e.key === 'Escape') viewport?.setSelection([]);
      }}>
        {/* Contenedor propio para el canvas: Solid no debe reconciliar sus hijos. */}
        <div class="viewport-canvas" ref={viewportEl} />
        <Show when={store.kernelState().state === 'loading'}>
          <div class="overlay">Cargando OpenCascade…</div>
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
