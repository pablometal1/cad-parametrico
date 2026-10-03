// Panel de parámetros de la feature seleccionada en el timeline.
import { Match, Show, Switch } from 'solid-js';
import type { BasePlane, BooleanOperation, ExtrudeDirection, ExtrudeFeature, Profile } from '../document/types';
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

const PROFILE_KINDS = [
  { value: 'rectangle', label: 'Rectángulo' },
  { value: 'circle', label: 'Círculo' },
] as const satisfies readonly { value: Profile['kind']; label: string }[];

type RectangleProfile = Extract<Profile, { kind: 'rectangle' }>;
type CircleProfile = Extract<Profile, { kind: 'circle' }>;

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

function ExtrudeEditor(props: { store: CadStore; feature: ExtrudeFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<ExtrudeFeature>) => props.store.updateFeature<ExtrudeFeature>(f().id, patch);
  const updateProfile = (patch: Partial<Profile>) => update({ profile: { ...f().profile, ...patch } as Profile });

  const changeKind = (kind: Profile['kind']) => {
    const p = f().profile;
    if (p.kind === kind) return;
    const common = { plane: p.plane, offset: p.offset, center: p.center };
    update({
      profile: p.kind === 'rectangle'
        ? { kind: 'circle', ...common, radius: Math.min(p.width, p.height) / 2 }
        : { kind: 'rectangle', ...common, width: p.radius * 2, height: p.radius * 2 },
    });
  };

  return (
    <>
      <h3>Extrusión</h3>
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => update({ operation })} />
      <NumberField label="Distancia" unit="mm" value={f().distance} onCommit={(distance) => update({ distance })} />
      <SelectField label="Dirección" value={f().direction} options={DIRECTIONS} onChange={(direction) => update({ direction })} />

      <h3>Perfil <span class="tag">provisorio</span></h3>
      <p class="hint">En la fase 3 el perfil pasa a ser un sketch con restricciones.</p>
      <SelectField label="Forma" value={f().profile.kind} options={PROFILE_KINDS} onChange={changeKind} />
      <SelectField label="Plano" value={f().profile.plane} options={PLANES} onChange={(plane) => updateProfile({ plane })} />
      <NumberField label="Desplazamiento" unit="mm" value={f().profile.offset} onCommit={(offset) => updateProfile({ offset })} />
      <NumberField label="Centro X" unit="mm" value={f().profile.center[0]}
        onCommit={(x) => updateProfile({ center: [x, f().profile.center[1]] })} />
      <NumberField label="Centro Y" unit="mm" value={f().profile.center[1]}
        onCommit={(y) => updateProfile({ center: [f().profile.center[0], y] })} />
      {/* Los campos leen el perfil de forma reactiva: no se recrean al cambiar un valor. */}
      <Show
        when={f().profile.kind === 'rectangle'}
        fallback={
          <NumberField label="Radio" unit="mm" value={(f().profile as CircleProfile).radius}
            onCommit={(radius) => updateProfile({ radius })} />
        }
      >
        <NumberField label="Ancho" unit="mm" value={(f().profile as RectangleProfile).width}
          onCommit={(width) => updateProfile({ width })} />
        <NumberField label="Alto" unit="mm" value={(f().profile as RectangleProfile).height}
          onCommit={(height) => updateProfile({ height })} />
      </Show>
    </>
  );
}
