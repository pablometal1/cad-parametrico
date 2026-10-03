// Campos de formulario del panel de parámetros. Confirman el valor con Enter o al salir del campo.
import { createEffect, createSignal, For, type JSX } from 'solid-js';

/** Acepta coma o punto como separador decimal. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n: number) {
  return String(Math.round(n * 1e6) / 1e6);
}

export function NumberField(props: {
  label: string;
  value: number;
  unit?: string;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = createSignal(formatNumber(props.value));
  const [invalid, setInvalid] = createSignal(false);
  // Si el valor cambia desde afuera (otra feature, recálculo), se refleja en el campo.
  createEffect(() => {
    setText(formatNumber(props.value));
    setInvalid(false);
  });

  const commit = () => {
    const n = parseNumber(text());
    if (n === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (n !== props.value) props.onCommit(n);
    else setText(formatNumber(n));
  };

  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <span class="field-input">
        <input
          type="text"
          inputmode="decimal"
          classList={{ invalid: invalid() }}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setText(formatNumber(props.value));
              setInvalid(false);
            }
          }}
        />
        {props.unit && <span class="unit">{props.unit}</span>}
      </span>
    </label>
  );
}

export function TextField(props: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = createSignal(props.value);
  createEffect(() => setText(props.value));
  const commit = () => {
    const t = text().trim();
    if (t && t !== props.value) props.onCommit(t);
    else setText(props.value);
  };
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <span class="field-input">
        <input
          type="text"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setText(props.value);
          }}
        />
      </span>
    </label>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      <span class="field-input">
        <select value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as T)}>
          <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
        </select>
      </span>
    </label>
  );
}
