// Propiedades de la pieza: volumen, área, medidas y masa estimada según el material de impresión.
import { createSignal, For, Show } from 'solid-js';
import type { MassProperties } from '../kernel/protocol';

/** Densidades típicas (g/cm³) de materiales de impresión 3D. */
export const MATERIALS: { id: string; label: string; density: number }[] = [
  { id: 'pla', label: 'PLA', density: 1.24 },
  { id: 'petg', label: 'PETG', density: 1.27 },
  { id: 'abs', label: 'ABS', density: 1.04 },
  { id: 'asa', label: 'ASA', density: 1.07 },
  { id: 'tpu', label: 'TPU', density: 1.21 },
  { id: 'nylon', label: 'Nylon (PA)', density: 1.14 },
  { id: 'resin', label: 'Resina estándar', density: 1.12 },
];

/** Masa (g) de un volumen en mm³ para una densidad en g/cm³. */
export function massGrams(volumeMm3: number, density: number) {
  return (volumeMm3 / 1000) * density;
}

/** Metros de filamento de 1,75 mm equivalentes a un volumen (100 % de relleno). */
export function filamentMeters(volumeMm3: number, diameter = 1.75) {
  const section = Math.PI * (diameter / 2) ** 2;
  return volumeMm3 / section / 1000;
}

export function PartInfo(props: { props: MassProperties | null }) {
  const [material, setMaterial] = createSignal(loadMaterial());
  const density = () => MATERIALS.find((m) => m.id === material())?.density ?? 1.24;
  const fmt = (v: number, d = 1) => v.toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: d });

  return (
    <Show when={props.props} fallback={<p class="muted">Sin sólido.</p>}>
      {(p) => {
        const size = () => p().bboxMax.map((v, i) => v - p().bboxMin[i]);
        return (
          <dl class="face-info part-info">
            <dt>Medidas</dt><dd>{size().map((v) => fmt(v)).join(' × ')} mm</dd>
            <dt>Volumen</dt><dd>{fmt(p().volume / 1000, 2)} cm³</dd>
            <dt>Área</dt><dd>{fmt(p().area / 100, 1)} cm²</dd>
            <dt>Cuerpos</dt><dd>{p().bodies}</dd>
            <dt>Material</dt>
            <dd>
              <select value={material()} onChange={(e) => { setMaterial(e.currentTarget.value); saveMaterial(e.currentTarget.value); }}>
                <For each={MATERIALS}>{(m) => <option value={m.id}>{m.label} ({m.density} g/cm³)</option>}</For>
              </select>
            </dd>
            <dt>Masa</dt><dd>{fmt(massGrams(p().volume, density()))} g <span class="muted">(100 % relleno)</span></dd>
            <Show when={material() !== 'resin'}>
              <dt>Filamento</dt><dd>{fmt(filamentMeters(p().volume), 2)} m <span class="muted">de 1,75 mm</span></dd>
            </Show>
          </dl>
        );
      }}
    </Show>
  );
}

const KEY = 'cad-parametrico:material';
function loadMaterial() {
  try {
    return localStorage.getItem(KEY) ?? 'pla';
  } catch {
    return 'pla';
  }
}
function saveMaterial(v: string) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // preferencia opcional
  }
}
