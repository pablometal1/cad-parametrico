// Tabla de parámetros con nombre: `ancho = largo / 2`. Renombrar actualiza todas las referencias.
import { createSignal, Index, Show } from 'solid-js';
import type { Parameter } from '../document/types';
import type { CadStore } from './store';

export function ParameterTable(props: { store: CadStore; onClose: () => void }) {
  const { store } = props;
  const values = () => new Map(store.evaluated().parameters.map((p) => [p.id, p]));
  let panel!: HTMLDivElement;
  const add = () => {
    store.addParameter();
    // Foco en el nombre de la fila nueva, listo para escribir.
    queueMicrotask(() => {
      const input = panel.querySelector<HTMLInputElement>('tbody tr:last-child input');
      input?.focus();
      input?.select();
    });
  };

  return (
    <div class="param-panel" ref={panel} onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLElement).tagName !== 'INPUT' && props.onClose()}>
      <div class="tool-dialog-title param-title">
        <span>ƒx Parámetros</span>
        <button class="icon-btn" title="Cerrar" onClick={props.onClose}>✕</button>
      </div>
      <div class="param-body">
        <Show
          when={store.doc().parameters.length > 0}
          fallback={<p class="muted">Sin parámetros. Agregá uno y usalo en cualquier campo numérico o cota escribiendo su nombre, ej. <code>largo / 2</code>.</p>}
        >
          <table class="param-table">
            <thead>
              <tr><th>Nombre</th><th>Expresión</th><th>Valor</th><th>Comentario</th><th /></tr>
            </thead>
            <tbody>
              {/* Index (no For): las filas se reutilizan al cambiar un parámetro y el foco no se pierde. */}
              <Index each={store.doc().parameters}>
                {(p) => (
                  <ParamRow
                    store={store}
                    param={p()}
                    value={values().get(p().id)?.value}
                    error={values().get(p().id)?.error}
                  />
                )}
              </Index>
            </tbody>
          </table>
        </Show>
        <p class="hint">Funciones: sin, cos, tan (en grados), sqrt, abs, min, max, round, pow, hypot y la constante pi.</p>
      </div>
      <div class="tool-dialog-actions">
        <button class="primary" onClick={add}>＋ Agregar parámetro</button>
      </div>
    </div>
  );
}

function ParamRow(props: { store: CadStore; param: Parameter; value?: number; error?: string }) {
  const [nameError, setNameError] = createSignal<string | null>(null);
  const [exprError, setExprError] = createSignal<string | null>(null);
  const p = () => props.param;

  const confirmDelete = () => {
    const usage = props.store.parameterUsage(p().name);
    if (usage.length && !window.confirm(`"${p().name}" se usa en: ${usage.join(', ')}.\nSi lo borrás, esas expresiones quedan con error. ¿Borrar igual?`)) return;
    props.store.deleteParameter(p().id);
  };

  return (
    <tr>
      <td>
        <CellInput
          value={p().name}
          invalid={!!nameError()}
          title={nameError() ?? ''}
          onCommit={(v) => setNameError(props.store.renameParameter(p().id, v))}
        />
      </td>
      <td>
        <CellInput
          value={p().expression}
          invalid={!!exprError() || !!props.error}
          title={exprError() ?? props.error ?? ''}
          onCommit={(v) => setExprError(props.store.setParameterExpression(p().id, v))}
        />
      </td>
      <td class="param-value" classList={{ error: !!props.error }} title={props.error ?? ''}>
        {props.error ? '⚠ error' : props.value !== undefined ? fmt(props.value) : ''}
      </td>
      <td>
        <CellInput value={p().comment ?? ''} onCommit={(v) => props.store.setParameterComment(p().id, v)} />
      </td>
      <td>
        <button class="icon-btn danger" title="Borrar parámetro" onClick={confirmDelete}>✕</button>
      </td>
    </tr>
  );
}

/** Celda editable: confirma con Enter o al salir; Esc descarta. */
function CellInput(props: { value: string; onCommit: (v: string) => void; invalid?: boolean; title?: string }) {
  return (
    <input
      class="cell"
      classList={{ invalid: !!props.invalid }}
      title={props.title}
      value={props.value}
      onBlur={(e) => e.currentTarget.value.trim() !== props.value && props.onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = props.value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function fmt(v: number) {
  return String(Math.round(v * 1e6) / 1e6);
}
