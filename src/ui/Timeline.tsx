// Historial de features: estado de cada una, supresión, borrado y marcador de retroceso.
import { createSignal, For, Show } from 'solid-js';
import { FEATURE_ICONS, Icon, tip } from './icons';
import { activeCount, moveBlocker } from '../document/ops';
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

  // Con deshacer disponible, borrar no pide confirmación (avisa en la barra y se deshace con Ctrl+Z).
  const confirmDelete = (f: Feature) => store.deleteFeature(f.id);

  // Arrastrar para reordenar: `slot` es la posición de inserción (0 = antes de la primera).
  const [drag, setDrag] = createSignal<{ id: string; slot: number | null; error: string | null } | null>(null);
  const targetIndex = (id: string, slot: number) => {
    const from = store.doc().features.findIndex((f) => f.id === id);
    return slot > from ? slot - 1 : slot;
  };
  const move = (id: string, toIndex: number) => {
    const err = store.moveFeature(id, toIndex);
    store.setNotice(err);
  };
  const onDragOver = (e: DragEvent, index: number) => {
    const d = drag();
    if (!d) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const slot = e.clientY < r.top + r.height / 2 ? index : index + 1;
    if (slot === d.slot) return;
    const to = targetIndex(d.id, slot);
    setDrag({ ...d, slot, error: moveBlocker(store.doc(), d.id, to) });
    if (e.dataTransfer) e.dataTransfer.dropEffect = drag()!.error ? 'none' : 'move';
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const d = drag();
    setDrag(null);
    if (!d || d.slot === null) return;
    if (d.error) return store.setNotice(d.error);
    const to = targetIndex(d.id, d.slot);
    const from = store.doc().features.findIndex((f) => f.id === d.id);
    if (to !== from) move(d.id, to);
  };


  const Marker = () => (
    <li class="marker" title="Marcador de historial: solo se calcula lo que está por encima">
      <span class="marker-line" />
      <span class="marker-label">Marcador</span>
      <Show when={active() > 0}>
        <button class="icon-btn" {...tip('Retroceder al inicio')} onClick={() => store.setRollback(0)}><Icon name="toTop" size={14} /></button>
      </Show>
      <Show when={active() < total()}>
        <button class="icon-btn" {...tip('Avanzar al final')} onClick={() => store.setRollback(null)}><Icon name="toBottom" size={14} /></button>
      </Show>
    </li>
  );

  return (
    <div class="timeline">
      <h2>Historial</h2>
      <Show when={drag()?.error}>
        <p class="drag-error">{drag()!.error}</p>
      </Show>
      <Show when={total() > 0} fallback={<p class="muted">Sin features todavía. Dibujá un perfil y extruilo para empezar.</p>}>
        <ol
          class="timeline-list"
          tabIndex={0}
          onKeyDown={(e) => {
            const f = store.selectedFeature();
            if (f && (e.key === 'Delete' || e.key === 'Supr')) confirmDelete(f);
            // Alt + flecha: mover la feature elegida un lugar.
            if (f && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              const i = store.doc().features.findIndex((x) => x.id === f.id);
              const to = e.key === 'ArrowUp' ? i - 1 : i + 1;
              if (to >= 0 && to < store.doc().features.length) move(f.id, to);
            }
          }}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrag((d) => (d ? { ...d, slot: null, error: null } : d));
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
                    classList={{
                      dragging: drag()?.id === f.id,
                      'drop-before': drag()?.slot === i(),
                      'drop-after': drag()?.slot === i() + 1 && i() === store.doc().features.length - 1,
                      'drop-blocked': !!drag()?.error && (drag()?.slot === i() || (drag()?.slot === i() + 1 && i() === store.doc().features.length - 1)),
                    }}
                    draggable={true}
                    onDragStart={(e) => {
                      setDrag({ id: f.id, slot: null, error: null });
                      e.dataTransfer?.setData('text/plain', f.id);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => onDragOver(e, i())}
                    onDrop={onDrop}
                    onDragEnd={() => setDrag(null)}
                    onClick={() => store.selectFeature(f.id)}
                    onDblClick={() => (f.type === 'sketch' ? store.editSketch(f.id) : store.openDialog(f.id, false))}
                    title={status() === 'pending' ? 'Calculando…' : STATUS_LABEL[status() as FeatureStatus]}
                  >
                    <span class="feature-icon" aria-hidden="true">
                      <Icon name={status() === 'error' ? 'warning' : FEATURE_ICONS[f.type]} size={16} />
                    </span>
                    <span class="feature-main">
                      <span class="feature-name">{f.name}</span>
                      <Show when={status() === 'error'}>
                        <span class="feature-error">{result()?.error}</span>
                      </Show>
                      <Show when={status() === 'ok' && result()?.info}>
                        <span class="feature-info">{result()?.info}</span>
                      </Show>
                    </span>
                    <span class="feature-actions" onClick={(e) => e.stopPropagation()}>
                      <Show when={f.type === 'sketch'}>
                        <button class="icon-btn" {...tip('Editar sketch')} onClick={() => store.editSketch(f.id)}><Icon name="sketch" size={14} /></button>
                      </Show>
                      <button class="icon-btn" {...tip(f.suppressed ? 'Reactivar' : 'Suprimir')} onClick={() => store.toggleSuppressed(f.id)}>
                        <Icon name={f.suppressed ? 'eyeOff' : 'eye'} size={14} />
                      </button>
                      <button class="icon-btn" {...tip('Mover el marcador hasta acá')} onClick={() => store.rollbackAfter(f.id)}><Icon name="rollTo" size={14} /></button>
                      <button class="icon-btn danger" {...tip('Borrar', 'Supr')} onClick={() => confirmDelete(f)}><Icon name="trash" size={14} /></button>
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
