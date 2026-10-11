// Biblioteca de modelos: plantillas paramétricas listas para abrir y ajustar desde la tabla fx.
import { createSignal, For, Show } from 'solid-js';
import { TEMPLATE_LIST, type TemplateInfo } from '../templates';
import { Icon } from './icons';

export function LibraryDialog(props: { onOpen: (t: TemplateInfo) => Promise<string | null>; onClose: () => void }) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const open = async (t: TemplateInfo) => {
    setBusy(t.id);
    setError(null);
    const err = await props.onOpen(t);
    setBusy(null);
    if (err) setError(err);
    else props.onClose();
  };
  return (
    <div class="tool-dialog export-dialog library-dialog">
      <div class="tool-dialog-title with-icon"><Icon name="library" size={16} />Biblioteca de modelos</div>
      <div class="tool-dialog-body">
        <p class="hint">Modelos paramétricos listos: se abren como un proyecto nuevo con todo el historial. Las medidas
          se cambian en la tabla de parámetros (fx, Shift+X).</p>
        <For each={TEMPLATE_LIST}>
          {(t) => (
            <button class="library-item" disabled={!!busy()} onClick={() => void open(t)}>
              <b>{t.name}</b>
              <span class="muted">{busy() === t.id ? 'Armando el modelo…' : t.description}</span>
            </button>
          )}
        </For>
        <Show when={error()}><div class="editor-error">{error()}</div></Show>
      </div>
      <div class="tool-dialog-actions">
        <button onClick={props.onClose}>Cerrar</button>
      </div>
    </div>
  );
}
