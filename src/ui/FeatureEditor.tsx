// Panel de parámetros de la feature seleccionada en el timeline.
import { Match, Show, Switch } from 'solid-js';
import type { BasePlane, BooleanOperation, ExtrudeDirection, ExtrudeFeature, SketchFeature } from '../document/types';
import { NumberField, SelectField, TextField } from './fields';
import type { CadStore } from './store';

const PLANES = [
  { value: 'XY', label: 'XY (planta)' },
  { value: 'XZ', label: 'XZ (frente)' },
  { value: 'YZ', label: 'YZ (lateral)' },
] as const satisfies readonly { value: BasePlane; label: string }[];

const DIRECTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'reversed', label: 'Invertida' },
  { value: 'symmetric', label: 'Simétrica' },
] as const satisfies readonly { value: ExtrudeDirection; label: string }[];

const OPERATIONS = [
  { value: 'new', label: 'Nuevo cuerpo' },
  { value: 'join', label: 'Unir' },
  { value: 'cut', label: 'Cortar' },
] as const satisfies readonly { value: BooleanOperation; label: string }[];

export function FeatureEditor(props: { store: CadStore }) {
  const { store } = props;
  return (
    <Show when={store.selectedFeature()} fallback={<p class="muted">Elegí una feature en el historial para editar sus parámetros.</p>}>
      {(feature) => {
        const result = () => store.results().get(feature().id);
        return (
          <div class="editor">
            <Show when={result()?.status === 'error'}>
              <div class="editor-error">{result()!.error}</div>
            </Show>
            <TextField label="Nombre" value={feature().name} onCommit={(name) => store.updateFeature(feature().id, { name })} />
            <Switch>
              <Match when={feature().type === 'sketch'}>
                <SketchEditorPanel store={store} feature={feature() as SketchFeature} info={result()?.info} />
              </Match>
              <Match when={feature().type === 'extrude'}>
                <ExtrudeEditor store={store} feature={feature() as ExtrudeFeature} />
              </Match>
            </Switch>
          </div>
        );
      }}
    </Show>
  );
}

function SketchEditorPanel(props: { store: CadStore; feature: SketchFeature; info?: string }) {
  const f = () => props.feature;
  const update = (patch: Partial<SketchFeature>) => props.store.updateFeature<SketchFeature>(f().id, patch);
  const curves = () => f().entities.filter((e) => e.type !== 'point').length;
  return (
    <>
      <h3>Sketch</h3>
      <SelectField label="Plano" value={f().plane.plane} options={PLANES}
        onChange={(plane) => update({ plane: { ...f().plane, plane } })} />
      <NumberField label="Desplazamiento" unit="mm" value={f().plane.offset}
        onCommit={(offset) => update({ plane: { ...f().plane, offset } })} />
      <p class="hint">
        {curves()} curva{curves() === 1 ? '' : 's'} · {f().constraints.length} restricci{f().constraints.length === 1 ? 'ón' : 'ones'}
        <Show when={props.info}> · {props.info}</Show>
      </p>
      <button class="primary wide" onClick={() => props.store.editSketch(f().id)}>✎ Editar sketch</button>
    </>
  );
}

function ExtrudeEditor(props: { store: CadStore; feature: ExtrudeFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<ExtrudeFeature>) => props.store.updateFeature<ExtrudeFeature>(f().id, patch);
  // Solo se pueden elegir sketches anteriores a la extrusión.
  const sketchOptions = () => {
    const features = props.store.doc().features;
    const i = features.findIndex((x) => x.id === f().id);
    const opts = features.slice(0, i).filter((x) => x.type === 'sketch').map((x) => ({ value: x.id, label: x.name }));
    if (!opts.some((o) => o.value === f().sketch)) opts.unshift({ value: f().sketch, label: '(sketch no disponible)' });
    return opts;
  };

  return (
    <>
      <h3>Extrusión</h3>
      <SelectField label="Sketch" value={f().sketch} options={sketchOptions()} onChange={(sketch) => update({ sketch })} />
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => update({ operation })} />
      <NumberField label="Distancia" unit="mm" value={f().distance} onCommit={(distance) => update({ distance })} />
      <SelectField label="Dirección" value={f().direction} options={DIRECTIONS} onChange={(direction) => update({ direction })} />
    </>
  );
}
