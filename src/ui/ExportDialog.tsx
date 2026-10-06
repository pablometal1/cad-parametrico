// Exportar el modelo a STL, 3MF o STEP, con calidad de malla.
import { Icon } from './icons';
import { createSignal, For, Show } from 'solid-js';
import type { KernelClient } from '../kernel/client';
import type { ExportFormat, ExportQuality } from '../kernel/protocol';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: '3mf', label: '3MF', hint: 'Recomendado para impresión 3D: unidades en mm y un objeto por cuerpo.' },
  { id: 'stl', label: 'STL', hint: 'Malla universal para cualquier slicer (binario).' },
  { id: 'step', label: 'STEP', hint: 'Geometría exacta (B-rep) para otros programas CAD.' },
];

const QUALITIES: { id: ExportQuality; label: string }[] = [
  { id: 'low', label: 'Baja (0,1 mm)' },
  { id: 'medium', label: 'Media (0,02 mm)' },
  { id: 'high', label: 'Alta (0,005 mm)' },
];

export function ExportDialog(props: { kernel: KernelClient; fileName: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [format, setFormat] = createSignal<ExportFormat>('3mf');
  const [quality, setQuality] = createSignal<ExportQuality>('medium');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await props.kernel.exportModel(format(), quality());
      download(r.data, `${props.fileName}.${r.extension}`, r.mime);
      const mesh = r.triangles !== undefined
        ? ` · ${r.triangles.toLocaleString('es-AR')} triángulos · ${r.openEdges === 0 ? 'malla cerrada ✓' : `⚠ ${r.openEdges} aristas abiertas`}`
        : '';
      props.onDone(`Exportado ${props.fileName}.${r.extension} (${r.bodies} cuerpo${r.bodies === 1 ? '' : 's'}${mesh})`);
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="tool-dialog export-dialog">
      <div class="tool-dialog-title with-icon"><Icon name="export" size={16} />Exportar</div>
      <div class="tool-dialog-body">
        <For each={FORMATS}>
          {(f) => (
            <label class="radio-row">
              <input type="radio" name="fmt" checked={format() === f.id} onChange={() => setFormat(f.id)} />
              <span><b>{f.label}</b> <span class="muted">— {f.hint}</span></span>
            </label>
          )}
        </For>
        <Show when={format() !== 'step'}>
          <label class="field">
            <span class="field-label">Calidad</span>
            <span class="field-input">
              <select value={quality()} onChange={(e) => setQuality(e.currentTarget.value as ExportQuality)}>
                <For each={QUALITIES}>{(q) => <option value={q.id}>{q.label}</option>}</For>
              </select>
            </span>
          </label>
          <p class="hint">Desvío máximo de la malla respecto de la superficie real. Alta = curvas más suaves y archivo más grande.</p>
        </Show>
        <Show when={error()}><div class="editor-error">{error()}</div></Show>
      </div>
      <div class="tool-dialog-actions">
        <button onClick={props.onClose}>Cancelar</button>
        <button class="primary" disabled={busy()} onClick={() => void run()}>{busy() ? 'Exportando…' : 'Exportar'}</button>
      </div>
    </div>
  );
}

function download(data: Uint8Array, name: string, mime: string) {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
