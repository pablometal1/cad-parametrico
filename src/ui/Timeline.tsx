// Historial de features: estado de cada una, supresión, borrado y marcador de retroceso.
import { For, Show } from 'solid-js';
import { activeCount } from '../document/ops';
import type { Feature } from '../document/types';
import type { FeatureStatus } from '../kernel/protocol';
import type { CadStore } from './store';

const STATUS_LABEL: Record<FeatureStatus, string> = {
  ok: 'Correcta',
  error: 'Error',
  suppressed: 'Suprimida',
  rolledBack: 'Después del marcador',
};

export function Timeline(props: { store: CadStore }) {
  const { store } = props;
  const active = () => activeCount(store.doc());
  const total = () => store.doc().features.length;

  const confirmDelete = (f: Feature) => {
    // Hasta la fase 5 no hay deshacer: pedimos confirmación.
    if (window.confirm(`¿Borrar "${f.name}"? Todavía no hay deshacer.`)) store.deleteFeature(f.id);
  };

  const Marker = () => (
    <li class="marker" title="Marcador de historial: solo se calcula lo que está por encima">
      <span class="marker-line" />
      <span class="marker-label">Marcador</span>
      <Show when={active() > 0}>
        <button class="icon-btn" title="Retroceder al inicio" onClick={() => store.setRollback(0)}>⤒</button>
      </Show>
      <Show when={active() < total()}>
        <button class="icon-btn" title="Avanzar al final" onClick={() => store.setRollback(null)}>⤓</button>
      </Show>
    </li>
  );

  return (
    <div class="timeline">
      <h2>Historial</h2>
      <Show when={total() > 0} fallback={<p class="muted">Sin features. Agregá una extrusión desde la barra.</p>}>
        <ol
          class="timeline-list"
          tabIndex={0}
          onKeyDown={(e) => {
            const f = store.selectedFeature();
            if (f && (e.key === 'Delete' || e.key === 'Supr')) confirmDelete(f);
          }}
        >
          <Show when={active() === 0}><Marker /></Show>
          <For each={store.doc().features}>
            {(f, i) => {
              const result = () => store.results().get(f.id);
              const status = (): FeatureStatus | 'pending' =>
                f.suppressed ? 'suppressed' : i() >= active() ? 'rolledBack' : result()?.status ?? 'pending';
              return (
                <>
                  <li
                    class={`feature status-${status()}${store.selectedId() === f.id ? ' selected' : ''}`}
                    onClick={() => store.selectFeature(f.id)}
                    title={status() === 'pending' ? 'Calculando…' : STATUS_LABEL[status() as FeatureStatus]}
                  >
                    <span class="feature-icon" aria-hidden="true">
                      {status() === 'error' ? '!' : f.type === 'extrude' ? '▤' : '•'}
                    </span>
                    <span class="feature-main">
                      <span class="feature-name">{f.name}</span>
                      <Show when={status() === 'error'}>
                        <span class="feature-error">{result()?.error}</span>
                      </Show>
                    </span>
                    <span class="feature-actions" onClick={(e) => e.stopPropagation()}>
                      <button class="icon-btn" title={f.suppressed ? 'Reactivar' : 'Suprimir'} onClick={() => store.toggleSuppressed(f.id)}>
                        {f.suppressed ? '◌' : '●'}
                      </button>
                      <button class="icon-btn" title="Mover el marcador hasta acá" onClick={() => store.rollbackAfter(f.id)}>⇥</button>
                      <button class="icon-btn danger" title="Borrar" onClick={() => confirmDelete(f)}>✕</button>
                    </span>
                  </li>
                  <Show when={i() + 1 === active() && active() > 0}><Marker /></Show>
                </>
              );
            }}
          </For>
        </ol>
      </Show>
    </div>
  );
}
