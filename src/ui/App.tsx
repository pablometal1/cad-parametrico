import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createKernelClient } from '../kernel/client';
import type { FaceInfo } from '../kernel/protocol';
import { Viewport } from '../viewport/Viewport';

/** Caja de demostración de la fase 1 (mm). En la fase 2 la reemplaza el documento de features. */
const DEMO_BOX = { width: 40, depth: 30, height: 20 };

type KernelStatus =
  | { state: 'loading' }
  | { state: 'ready'; occtLoadMs: number; buildMs: number }
  | { state: 'error'; message: string };

export function App() {
  let viewportEl!: HTMLDivElement;
  let viewport: Viewport | undefined;
  const kernel = createKernelClient();

  const [status, setStatus] = createSignal<KernelStatus>({ state: 'loading' });
  const [selection, setSelection] = createSignal<FaceInfo[]>([]);
  const [hovered, setHovered] = createSignal<number | null>(null);
  let selectionRequest = 0;

  onMount(async () => {
    viewport = new Viewport(viewportEl, {
      onHoverChange: setHovered,
      onSelectionChange: async (faces) => {
        const req = ++selectionRequest;
        try {
          const infos = await Promise.all(faces.map((f) => kernel.faceInfo(f)));
          if (req === selectionRequest) setSelection(infos);
        } catch (err) {
          setStatus({ state: 'error', message: (err as Error).message });
        }
      },
    });
    try {
      const { occtLoadMs } = await kernel.init();
      const t0 = performance.now();
      const mesh = await kernel.buildBox(DEMO_BOX.width, DEMO_BOX.depth, DEMO_BOX.height);
      const buildMs = Math.round(performance.now() - t0);
      viewport.setMesh(mesh);
      viewport.fitView();
      setStatus({ state: 'ready', occtLoadMs, buildMs });
    } catch (err) {
      setStatus({ state: 'error', message: (err as Error).message });
    }
  });

  onCleanup(() => viewport?.dispose());

  return (
    <div class="app">
      <header class="toolbar">
        <span class="brand">CAD</span>
        <button onClick={() => viewport?.fitView()} disabled={status().state !== 'ready'} title="Encuadrar (F)">
          Encuadrar
        </button>
        <button onClick={() => viewport?.setSelection([])} disabled={selection().length === 0}>
          Limpiar selección
        </button>
      </header>

      <main class="viewport" tabIndex={0} onKeyDown={(e) => {
        if (e.key === 'f' || e.key === 'F') viewport?.fitView();
        if (e.key === 'Escape') viewport?.setSelection([]);
      }}>
        {/* Contenedor propio para el canvas: Solid no debe reconciliar sus hijos. */}
        <div class="viewport-canvas" ref={viewportEl} />
        <Show when={status().state === 'loading'}>
          <div class="overlay">Cargando OpenCascade…</div>
        </Show>
      </main>

      <aside class="panel">
        <h2>Selección</h2>
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
          const s = status();
          if (s.state === 'loading') return <span>Kernel: cargando…</span>;
          if (s.state === 'error') return <span class="error">Error: {s.message}</span>;
          return <span>Kernel listo · OCCT {s.occtLoadMs} ms · caja {s.buildMs} ms</span>;
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
