// Panel con todos los atajos de teclado (se abre con "?" o el botón de ayuda).
import { For } from 'solid-js';
import { Icon } from './icons';
import { SHORTCUT_SECTIONS as SECTIONS } from './tools';

export function ShortcutHelp(props: { onClose: () => void }) {
  return (
    <div class="tool-dialog help-dialog" role="dialog" aria-label="Atajos de teclado">
      <div class="tool-dialog-title param-title">
        <span class="with-icon"><Icon name="help" size={16} />Atajos de teclado</span>
        <button class="icon-btn" aria-label="Cerrar" onClick={props.onClose}><Icon name="close" size={14} /></button>
      </div>
      <div class="help-body">
        <For each={SECTIONS}>
          {(sec) => (
            <section>
              <h3>{sec.title}</h3>
              <dl>
                <For each={sec.rows}>{([k, d]) => <><dt><kbd>{k}</kbd></dt><dd>{d}</dd></>}</For>
              </dl>
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
