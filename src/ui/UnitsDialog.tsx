// Cuadro de diálogo para ajustar unidades y escala del proyecto (mm, cm, m, pulgadas).
import { createSignal, For, Show } from 'solid-js';
import { Icon } from './icons';
import type { CadStore } from './store';
import type { LengthUnit } from '../document/types';

const UNITS: { id: LengthUnit; name: string; symbol: string; hint: string }[] = [
  { id: 'mm', name: 'Milímetros', symbol: 'mm', hint: 'Estándar para diseño mecánico e impresión 3D' },
  { id: 'cm', name: 'Centímetros', symbol: 'cm', hint: 'Piezas medianas, maquetas y carpintería' },
  { id: 'in', name: 'Pulgadas', symbol: 'in', hint: 'Sistema imperial (1 in = 25,4 mm)' },
  { id: 'm', name: 'Metros', symbol: 'm', hint: 'Estructuras grandes y arquitectura' },
];

const PRESET_SCALES: { label: string; factor: number }[] = [
  { label: '1:10 (0.1×)', factor: 0.1 },
  { label: '1:5 (0.2×)', factor: 0.2 },
  { label: '1:2 (0.5×)', factor: 0.5 },
  { label: '2:1 (2×)', factor: 2 },
  { label: '5:1 (5×)', factor: 5 },
  { label: '10:1 (10×)', factor: 10 },
];

export function UnitsDialog(props: { store: CadStore; onClose: () => void }) {
  const currentUnit = () => props.store.doc().units;
  const [selectedUnit, setSelectedUnit] = createSignal<LengthUnit>(currentUnit());
  const [convertGeometry, setConvertGeometry] = createSignal(true);
  const [scaleFactor, setScaleFactor] = createSignal('2');
  const [scaleError, setScaleError] = createSignal<string | null>(null);

  const hasFeatures = () => props.store.doc().features.length > 0;

  const applyUnits = () => {
    const next = selectedUnit();
    if (next !== currentUnit()) {
      props.store.setUnits(next, convertGeometry());
    }
    props.onClose();
  };

  const applyScale = (factorNum?: number) => {
    const f = factorNum ?? Number(scaleFactor().trim().replace(',', '.'));
    if (!Number.isFinite(f) || f <= 0) {
      setScaleError('Ingresá un factor de escala positivo (ej. 2 o 0.5)');
      return;
    }
    if (f === 1) {
      setScaleError('El factor 1 no altera el modelo');
      return;
    }
    setScaleError(null);
    props.store.scaleProject(f);
    props.onClose();
  };

  return (
    <div class="tool-dialog units-dialog" role="dialog" aria-label="Unidades y escala del proyecto">
      <div class="tool-dialog-title with-icon">
        <Icon name="scale" size={16} /> Unidades y Escala del Proyecto
      </div>
      <div class="tool-dialog-body">
        <h3 class="section-title">Unidad de trabajo</h3>
        <p class="muted" style={{ margin: '0 0 10px' }}>
          Elegí la unidad en la que deseas ingresar y visualizar medidas (cotas, radios, extrusiones):
        </p>

        <div class="unit-options">
          <For each={UNITS}>
            {(u) => (
              <label class="radio-row unit-option" classList={{ selected: selectedUnit() === u.id }}>
                <input
                  type="radio"
                  name="unitSelection"
                  checked={selectedUnit() === u.id}
                  onChange={() => setSelectedUnit(u.id)}
                />
                <span class="unit-option-content">
                  <b>{u.name} ({u.symbol})</b>
                  <span class="muted"> — {u.hint}</span>
                </span>
              </label>
            )}
          </For>
        </div>

        <Show when={hasFeatures() && selectedUnit() !== currentUnit()}>
          <div class="unit-conversion-box">
            <b>Al cambiar de {currentUnit()} a {selectedUnit()}:</b>
            <label class="radio-row" style={{ 'margin-top': '6px' }}>
              <input
                type="radio"
                name="conversionMode"
                checked={convertGeometry()}
                onChange={() => setConvertGeometry(true)}
              />
              <span>
                <b>Convertir dimensiones</b> <span class="muted">(recomendado: mantiene el tamaño real de la pieza; ej. 25.4 mm ➔ 1 in)</span>
              </span>
            </label>
            <label class="radio-row" style={{ 'margin-top': '4px' }}>
              <input
                type="radio"
                name="conversionMode"
                checked={!convertGeometry()}
                onChange={() => setConvertGeometry(false)}
              />
              <span>
                <b>Reinterpretar números</b> <span class="muted">(los números quedan iguales, la pieza cambia de tamaño; ej. 10 mm ➔ 10 in)</span>
              </span>
            </label>
          </div>
        </Show>

        <div class="dialog-actions-row" style={{ 'margin-top': '10px' }}>
          <button
            class="primary with-icon"
            disabled={selectedUnit() === currentUnit()}
            onClick={applyUnits}
          >
            <Icon name="check" size={14} /> Aplicar Unidad ({selectedUnit()})
          </button>
        </div>

        <h3 class="section-title" style={{ 'margin-top': '18px' }}>Escalar modelo completo</h3>
        <p class="muted" style={{ margin: '0 0 10px' }}>
          Multiplica todas las dimensiones del modelo por un factor de escala (bocetos, extrusiones, redondeos, etc.):
        </p>

        <div class="scale-presets">
          <For each={PRESET_SCALES}>
            {(p) => (
              <button
                class="scale-preset-btn"
                disabled={!hasFeatures()}
                onClick={() => applyScale(p.factor)}
                title={`Multiplicar modelo por ${p.factor}`}
              >
                {p.label}
              </button>
            )}
          </For>
        </div>

        <div class="scale-custom-row" style={{ 'margin-top': '8px' }}>
          <label class="field" style={{ flex: '1' }}>
            <span class="field-label">Factor</span>
            <span class="field-input">
              <input
                type="text"
                inputmode="decimal"
                value={scaleFactor()}
                onInput={(e) => {
                  setScaleFactor(e.currentTarget.value);
                  setScaleError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyScale();
                }}
                placeholder="ej. 2 o 0.5"
              />
              <span class="unit">×</span>
            </span>
          </label>
          <button
            class="primary with-icon"
            style={{ 'margin-left': '8px' }}
            disabled={!hasFeatures()}
            onClick={() => applyScale()}
          >
            <Icon name="check" size={14} /> Escalar
          </button>
        </div>
        <Show when={scaleError()}>
          <div class="field-error" style={{ 'margin-top': '4px' }}>{scaleError()}</div>
        </Show>
      </div>
      <div class="tool-dialog-actions">
        <button onClick={props.onClose}>Cerrar</button>
      </div>
    </div>
  );
}
