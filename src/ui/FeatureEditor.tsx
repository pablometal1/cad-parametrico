// Panel de parámetros de la feature seleccionada en el timeline.
import { Match, Show, Switch } from 'solid-js';
import type {
  BasePlane, BooleanOperation, ChamferFeature, ExtrudeDirection, ExtrudeFeature, FilletFeature, ProfileFeature,
  RevolveFeature, ShellFeature, SketchFeature,
} from '../document/types';
import { ExprField, SelectField, TextField } from './fields';
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
                <SketchPanel store={store} feature={feature() as SketchFeature} info={result()?.info} />
              </Match>
              <Match when={feature().type === 'extrude'}>
                <ExtrudePanel store={store} feature={feature() as ExtrudeFeature} />
              </Match>
              <Match when={feature().type === 'revolve'}>
                <RevolvePanel store={store} feature={feature() as RevolveFeature} />
              </Match>
              <Match when={feature().type === 'fillet' || feature().type === 'chamfer'}>
                <EdgeFeaturePanel store={store} feature={feature() as FilletFeature | ChamferFeature} />
              </Match>
              <Match when={feature().type === 'shell'}>
                <ShellPanel store={store} feature={feature() as ShellFeature} />
              </Match>
            </Switch>
          </div>
        );
      }}
    </Show>
  );
}

function SketchPanel(props: { store: CadStore; feature: SketchFeature; info?: string }) {
  const f = () => props.feature;
  const update = (patch: Partial<SketchFeature>) => props.store.updateFeature<SketchFeature>(f().id, patch);
  const curves = () => f().entities.filter((e) => e.type !== 'point').length;
  const planeValue = () => (f().plane.kind === 'base' ? (f().plane as { plane: BasePlane }).plane : 'face');
  const planeOptions = () => [
    ...PLANES,
    ...(f().plane.kind === 'face' ? [{ value: 'face' as const, label: 'Cara del sólido' }] : []),
  ];
  return (
    <>
      <h3>Sketch</h3>
      <SelectField label="Plano" value={planeValue()} options={planeOptions()}
        onChange={(v) => v !== 'face' && update({ plane: { kind: 'base', plane: v, offset: f().plane.offset } })} />
      <Num store={props.store} id={f().id} path="plane.offset" label="Desplazamiento" unit="mm" />
      <button class="wide" onClick={() => props.store.beginPick(f().id)} title="Elegir una cara plana del modelo como plano del sketch">
        ◧ {f().plane.kind === 'face' ? 'Cambiar cara de apoyo…' : 'Apoyar en una cara…'}
      </button>
      <p class="hint">
        {curves()} curva{curves() === 1 ? '' : 's'} · {f().constraints.length} restricci{f().constraints.length === 1 ? 'ón' : 'ones'}
        <Show when={props.info}> · {props.info}</Show>
      </p>
      <button class="primary wide" onClick={() => props.store.editSketch(f().id)}>✎ Editar sketch</button>
    </>
  );
}

/** Selector de sketch: solo los anteriores a la feature. */
function SketchSelect(props: { store: CadStore; feature: ProfileFeature; onChange: (id: string) => void }) {
  const options = () => {
    const features = props.store.doc().features;
    const i = features.findIndex((x) => x.id === props.feature.id);
    const opts = features.slice(0, i).filter((x) => x.type === 'sketch').map((x) => ({ value: x.id, label: x.name }));
    if (!opts.some((o) => o.value === props.feature.sketch)) opts.unshift({ value: props.feature.sketch, label: '(sketch no disponible)' });
    return opts;
  };
  return <SelectField label="Sketch" value={props.feature.sketch} options={options()} onChange={props.onChange} />;
}

function ExtrudePanel(props: { store: CadStore; feature: ExtrudeFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<ExtrudeFeature>) => props.store.updateFeature<ExtrudeFeature>(f().id, patch);
  return (
    <>
      <h3>Extrusión</h3>
      <SketchSelect store={props.store} feature={f()} onChange={(sketch) => update({ sketch })} />
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => update({ operation })} />
      <Num store={props.store} id={f().id} path="distance" label="Distancia" unit="mm" />
      <SelectField label="Dirección" value={f().direction} options={DIRECTIONS} onChange={(direction) => update({ direction })} />
    </>
  );
}

function RevolvePanel(props: { store: CadStore; feature: RevolveFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<RevolveFeature>) => props.store.updateFeature<RevolveFeature>(f().id, patch);
  const axisValue = () => (f().axis.kind === 'sketchAxis' ? `axis:${(f().axis as { axis: string }).axis}` : `line:${(f().axis as { line: string }).line}`);
  const axisOptions = () => {
    const sk = props.store.doc().features.find((x) => x.id === f().sketch);
    const lines = sk?.type === 'sketch' ? sk.entities.filter((e) => e.type === 'line') : [];
    return [
      { value: 'axis:u', label: 'Eje horizontal del sketch' },
      { value: 'axis:v', label: 'Eje vertical del sketch' },
      ...lines.map((l) => ({ value: `line:${l.id}`, label: `Línea ${l.id}${'construction' in l && l.construction ? ' (construcción)' : ''}` })),
    ];
  };
  return (
    <>
      <h3>Revolución</h3>
      <SketchSelect store={props.store} feature={f()} onChange={(sketch) => update({ sketch })} />
      <SelectField label="Eje" value={axisValue()} options={axisOptions()} onChange={(v) => {
        const [kind, id] = v.split(':');
        update({ axis: kind === 'axis' ? { kind: 'sketchAxis', axis: id as 'u' | 'v' } : { kind: 'sketchLine', line: id } });
      }} />
      <Num store={props.store} id={f().id} path="angle" label="Ángulo" unit="°" />
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => update({ operation })} />
      <p class="hint">Tip: dibujá una línea de construcción en el sketch para usarla como eje.</p>
    </>
  );
}

function EdgeFeaturePanel(props: { store: CadStore; feature: FilletFeature | ChamferFeature }) {
  const f = () => props.feature;
  const isFillet = () => f().type === 'fillet';
  return (
    <>
      <h3>{isFillet() ? 'Redondeo' : 'Chaflán'}</h3>
      <Num store={props.store} id={f().id} path={isFillet() ? 'radius' : 'distance'} label={isFillet() ? 'Radio' : 'Distancia'} unit="mm" />
      <p class="hint">{f().edges.length} arista{f().edges.length === 1 ? '' : 's'}</p>
      <button class="wide" onClick={() => props.store.beginPick(f().id)}>⌁ Elegir aristas…</button>
    </>
  );
}

function ShellPanel(props: { store: CadStore; feature: ShellFeature }) {
  const f = () => props.feature;
  return (
    <>
      <h3>Vaciado</h3>
      <Num store={props.store} id={f().id} path="thickness" label="Espesor" unit="mm" />
      <p class="hint">
        {f().faces.length === 0 ? 'Sin caras quitadas: queda hueco y cerrado.' : `${f().faces.length} cara${f().faces.length === 1 ? '' : 's'} quitada${f().faces.length === 1 ? '' : 's'}`}
      </p>
      <button class="wide" onClick={() => props.store.beginPick(f().id)}>◧ Elegir caras a quitar…</button>
    </>
  );
}

/** Campo numérico de una feature, con soporte de expresiones y parámetros. */
function Num(props: { store: CadStore; id: string; path: string; label: string; unit: string }) {
  return (
    <ExprField
      label={props.label}
      unit={props.unit}
      value={props.store.fieldValue(props.id, props.path)}
      expr={props.store.fieldExpression(props.id, props.path)}
      onCommit={(text) => props.store.setFieldText(props.id, props.path, text)}
    />
  );
}
