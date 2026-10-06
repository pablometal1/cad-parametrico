// Panel de parámetros de la feature seleccionada en el timeline.
import { Icon } from './icons';
import { For, Match, Show, Switch } from 'solid-js';
import type {
  BasePlane, BooleanOperation, ChamferFeature, ExtrudeDirection, ExtrudeFeature, FilletFeature, ProfileFeature,
  RevolveFeature, ShellFeature, SketchFeature, PatternFeature, MirrorFeature, GlobalAxis, SweepFeature, LoftFeature, FeatureId, PlaneFeature, HoleFeature, ThreadFeature, ImportFeature,
} from '../document/types';
import { coarsePitch, HOLE_PRESETS, holeCenters, PRESET_GROUPS, threadBore, type HolePresetGroup } from '../document/holes';
import { ExprField, NumberField, SelectField, TextField } from './fields';
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
              <Match when={feature().type === 'pattern' || feature().type === 'mirror'}>
                <CopyPanel store={store} feature={feature() as PatternFeature | MirrorFeature} />
              </Match>
              <Match when={feature().type === 'import'}>
                <ImportPanel store={store} feature={feature() as ImportFeature} />
              </Match>
              <Match when={feature().type === 'thread'}>
                <ThreadPanel store={store} feature={feature() as ThreadFeature} />
              </Match>
              <Match when={feature().type === 'hole'}>
                <HolePanel store={store} feature={feature() as HoleFeature} />
              </Match>
              <Match when={feature().type === 'plane'}>
                <PlanePanel store={store} feature={feature() as PlaneFeature} />
              </Match>
              <Match when={feature().type === 'sweep'}>
                <SweepPanel store={store} feature={feature() as SweepFeature} />
              </Match>
              <Match when={feature().type === 'loft'}>
                <LoftPanel store={store} feature={feature() as LoftFeature} />
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
  const planeValue = () => (f().plane.kind === 'face' ? 'face' : (f().plane as { plane: string }).plane);
  const planeOptions = () => [
    ...PLANES,
    ...constructionPlaneOptions(props.store, f().id),
    ...(f().plane.kind === 'face' ? [{ value: 'face', label: 'Cara del sólido' }] : []),
  ];
  return (
    <>
      <h3>Sketch</h3>
      <SelectField label="Plano" value={planeValue()} options={planeOptions()}
        onChange={(v) => {
          if (v === 'face') return;
          const offset = f().plane.offset;
          update({ plane: v === 'XY' || v === 'XZ' || v === 'YZ' ? { kind: 'base', plane: v, offset } : { kind: 'plane', plane: v, offset } });
        }} />
      <Num store={props.store} id={f().id} path="plane.offset" label="Desplazamiento" unit="mm" />
      <button class="wide with-icon" onClick={() => props.store.beginPick(f().id)} title="Elegir una cara plana del modelo como plano del sketch">
        <Icon name="select" size={15} />{f().plane.kind === 'face' ? 'Cambiar cara de apoyo…' : 'Apoyar en una cara…'}
      </button>
      <p class="hint">
        {curves()} curva{curves() === 1 ? '' : 's'} · {f().constraints.length} restricci{f().constraints.length === 1 ? 'ón' : 'ones'}
        <Show when={props.info}> · {props.info}</Show>
      </p>
      <button class="primary wide with-icon" onClick={() => props.store.editSketch(f().id)}><Icon name="sketch" size={15} />Editar sketch</button>
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
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => {
        // Cortar desde un sketch apoyado en una cara: hacia adentro del material (grabar, bolsillos).
        const sk = props.store.doc().features.find((x) => x.id === f().sketch);
        const onFace = sk?.type === 'sketch' && sk.plane.kind === 'face';
        if (operation === 'cut' && onFace && f().direction === 'normal') update({ operation, direction: 'reversed' });
        else if (operation !== 'cut' && onFace && f().direction === 'reversed') update({ operation, direction: 'normal' });
        else update({ operation });
      }} />
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
      <button class="wide with-icon" onClick={() => props.store.beginPick(f().id)}><Icon name="select" size={15} />Elegir aristas…</button>
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
      <button class="wide with-icon" onClick={() => props.store.beginPick(f().id)}><Icon name="select" size={15} />Elegir caras a quitar…</button>
    </>
  );
}

const HOLE_KINDS = [
  { value: 'simple', label: 'Simple' },
  { value: 'counterbore', label: 'Cajeado (cabeza cilíndrica)' },
  { value: 'countersink', label: 'Avellanado (cabeza plana)' },
] as const satisfies readonly { value: HoleFeature['kind']; label: string }[];

function HolePanel(props: { store: CadStore; feature: HoleFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<HoleFeature>) => props.store.updateFeature<HoleFeature>(f().id, patch);
  const centers = () => {
    const sk = props.store.doc().features.find((x) => x.id === f().sketch);
    return sk?.type === 'sketch' ? holeCenters(sk).length : 0;
  };
  const groups = Object.keys(PRESET_GROUPS) as HolePresetGroup[];
  return (
    <>
      <h3>Agujero</h3>
      <SelectField label="Sketch" value={f().sketch} options={sketchOptions(props.store, f().id, f().sketch)} onChange={(sketch) => update({ sketch })} />
      <label class="field">
        <span class="field-label">Medida</span>
        <span class="field-input">
          <select value="" onChange={(e) => {
            const p = HOLE_PRESETS.find((x) => x.id === e.currentTarget.value);
            e.currentTarget.value = '';
            if (p) update(p.values);
          }}>
            <option value="">Elegir tornillo o inserto…</option>
            <For each={groups}>
              {(g) => (
                <optgroup label={PRESET_GROUPS[g]}>
                  <For each={HOLE_PRESETS.filter((p) => p.group === g)}>{(p) => <option value={p.id}>{p.label}</option>}</For>
                </optgroup>
              )}
            </For>
          </select>
        </span>
      </label>
      <SelectField label="Tipo" value={f().kind} options={HOLE_KINDS} onChange={(kind) => update({ kind })} />
      <label class="field">
        <span class="field-label">Rosca</span>
        <span class="field-input">
          <input type="checkbox" checked={f().thread}
            onChange={(e) => update(e.currentTarget.checked ? { thread: true, threadPitch: coarsePitch(f().diameter) } : { thread: false })} />
          <span class="muted">modelada (se imprime)</span>
        </span>
      </label>
      <Num store={props.store} id={f().id} path="diameter" label={f().thread ? 'Ø nominal' : 'Diámetro'} unit="mm" />
      <Show when={f().thread}>
        <Num store={props.store} id={f().id} path="threadPitch" label="Paso" unit="mm" />
        <Num store={props.store} id={f().id} path="threadClearance" label="Holgura" unit="mm" />
        <p class="hint">
          M{fmtMm(f().diameter)} × {fmtMm(f().threadPitch)}: se perfora a Ø{fmtMm(threadBore(f().diameter, f().threadPitch, f().threadClearance))}.
          La holgura agranda la rosca para que el tornillo entre en una pieza impresa (0,2 mm suele andar en FDM).
        </p>
      </Show>
      <Show when={f().kind === 'counterbore'}>
        <Num store={props.store} id={f().id} path="cbDiameter" label="Ø cajeado" unit="mm" />
        <Num store={props.store} id={f().id} path="cbDepth" label="Prof. cajeado" unit="mm" />
      </Show>
      <Show when={f().kind === 'countersink'}>
        <Num store={props.store} id={f().id} path="csDiameter" label="Ø avellanado" unit="mm" />
        <Num store={props.store} id={f().id} path="csAngle" label="Ángulo" unit="°" />
      </Show>
      <SelectField label="Hasta" value={f().extent}
        options={[{ value: 'through', label: 'Pasante (atraviesa todo)' }, { value: 'distance', label: 'Profundidad' }] as const}
        onChange={(extent) => update({ extent })} />
      <Show when={f().extent === 'distance'}>
        <Num store={props.store} id={f().id} path="depth" label="Profundidad" unit="mm" />
        <SelectField label="Fondo" value={f().tip}
          options={[{ value: 'flat', label: 'Plano' }, { value: 'drill', label: 'Punta de mecha (118°)' }] as const}
          onChange={(tip) => update({ tip })} />
      </Show>
      <label class="field">
        <span class="field-label">Dirección</span>
        <span class="field-input">
          <input type="checkbox" checked={f().reversed} onChange={(e) => update({ reversed: e.currentTarget.checked })} />
          <span class="muted">invertir</span>
        </span>
      </label>
      <p class="hint">
        {centers()} agujero{centers() === 1 ? '' : 's'}: uno por cada punto suelto o círculo del sketch.
        Las medidas de la lista son para impresión 3D; en FDM los agujeros suelen salir algo más chicos, probá con una pieza de prueba.
      </p>
    </>
  );
}

const fmtMm = (v: number) => String(Math.round(v * 1000) / 1000);

const IMPORT_OPS = [
  { value: 'reference', label: 'Solo referencia (no se exporta)' },
  { value: 'new', label: 'Cuerpo nuevo' },
  { value: 'join', label: 'Unir' },
  { value: 'cut', label: 'Cortar (encastre)' },
] as const satisfies readonly { value: ImportFeature['operation']; label: string }[];

function ImportPanel(props: { store: CadStore; feature: ImportFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<ImportFeature>) => props.store.updateFeature<ImportFeature>(f().id, patch);
  const setAt = (key: 'position' | 'rotation', i: number, v: number) => {
    const next = [...f()[key]] as [number, number, number];
    next[i] = v;
    update({ [key]: next });
  };
  const sizeKb = () => Math.round((f().data.length * 3) / 4 / 1024);
  return (
    <>
      <h3>Importado</h3>
      <p class="hint">{f().fileName} · {f().format.toUpperCase()} · {sizeKb()} KB (va dentro del documento)</p>
      <SelectField label="Operación" value={f().operation} options={IMPORT_OPS} onChange={(operation) => update({ operation })} />
      <NumberField label="X" unit="mm" value={f().position[0]} onCommit={(v) => setAt('position', 0, v)} />
      <NumberField label="Y" unit="mm" value={f().position[1]} onCommit={(v) => setAt('position', 1, v)} />
      <NumberField label="Z" unit="mm" value={f().position[2]} onCommit={(v) => setAt('position', 2, v)} />
      <NumberField label="Giro X" unit="°" value={f().rotation[0]} onCommit={(v) => setAt('rotation', 0, v)} />
      <NumberField label="Giro Y" unit="°" value={f().rotation[1]} onCommit={(v) => setAt('rotation', 1, v)} />
      <NumberField label="Giro Z" unit="°" value={f().rotation[2]} onCommit={(v) => setAt('rotation', 2, v)} />
      <Num store={props.store} id={f().id} path="scale" label="Escala" unit="×" />
      <p class="hint">
        Para un encastre: ubicá la pieza donde va y elegí Cortar; queda su forma restada de tu sólido. Si el STL viene en
        pulgadas, escala 25,4. Un STL abierto (con agujeros) solo sirve como referencia.
      </p>
    </>
  );
}

function ThreadPanel(props: { store: CadStore; feature: ThreadFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<ThreadFeature>) => props.store.updateFeature<ThreadFeature>(f().id, patch);
  return (
    <>
      <h3>Rosca</h3>
      <Num store={props.store} id={f().id} path="pitch" label="Paso" unit="mm" />
      <Num store={props.store} id={f().id} path="clearance" label="Holgura" unit="mm" />
      <Num store={props.store} id={f().id} path="length" label="Largo" unit="mm" />
      <Show when={f().length > 0}>
        <label class="field">
          <span class="field-label">Desde</span>
          <span class="field-input">
            <input type="checkbox" checked={f().fromStart} onChange={(e) => update({ fromStart: e.currentTarget.checked })} />
            <span class="muted">el otro extremo</span>
          </span>
        </label>
      </Show>
      <button class="wide with-icon" onClick={() => props.store.beginPick(f().id)}><Icon name="select" size={15} />Cambiar cara…</button>
      <p class="hint">
        En un agujero la rosca es interna (su diámetro es el menor de la rosca); en una barra, externa (su diámetro es el
        mayor). Largo 0 = toda la cara. Paso grueso ISO: M4 0,7 · M5 0,8 · M6 1 · M8 1,25 · M10 1,5 · M12 1,75.
        La holgura deja juego para que enrosque impreso.
      </p>
    </>
  );
}

/** Planos de construcción anteriores a la feature `before`. */
function constructionPlaneOptions(store: CadStore, before: FeatureId) {
  const features = store.doc().features;
  const i = features.findIndex((x) => x.id === before);
  return features.slice(0, i).filter((x) => x.type === 'plane').map((x) => ({ value: x.id, label: x.name }));
}

const PLANE_AXES = [
  { value: 'none', label: 'Sin giro' },
  { value: 'X', label: 'Eje X' },
  { value: 'Y', label: 'Eje Y' },
  { value: 'Z', label: 'Eje Z' },
  { value: 'edge', label: 'Arista del modelo…' },
] as const satisfies readonly { value: PlaneFeature['axis']; label: string }[];

function PlanePanel(props: { store: CadStore; feature: PlaneFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<PlaneFeature>) => props.store.updateFeature<PlaneFeature>(f().id, patch);
  const refValue = () => (f().reference.kind === 'face' ? 'face' : (f().reference as { plane: string }).plane);
  const refOptions = () => [
    ...PLANES,
    ...constructionPlaneOptions(props.store, f().id),
    ...(f().reference.kind === 'face' ? [{ value: 'face', label: 'Cara del sólido' }] : []),
  ];
  return (
    <>
      <h3>Plano de construcción</h3>
      <SelectField label="Referencia" value={refValue()} options={refOptions()} onChange={(v) => {
        if (v === 'face') return;
        update({ reference: v === 'XY' || v === 'XZ' || v === 'YZ' ? { kind: 'base', plane: v } : { kind: 'plane', plane: v } });
      }} />
      <button class="wide with-icon" onClick={() => props.store.beginPick(f().id)}>
        <Icon name="select" size={15} />{f().reference.kind === 'face' ? 'Cambiar cara de referencia…' : 'Usar una cara del modelo…'}
      </button>
      <SelectField label="Girar en" value={f().axis} options={PLANE_AXES} onChange={(axis) => {
        // Arista: se elige en el modelo (si ya había una, se reutiliza).
        if (axis === 'edge' && !f().axisEdge) props.store.beginPick(f().id, true);
        else update({ axis });
      }} />
      <Show when={f().axis === 'edge'}>
        <button class="wide with-icon" onClick={() => props.store.beginPick(f().id, true)}><Icon name="select" size={15} />Cambiar arista del eje…</button>
      </Show>
      <Show when={f().axis !== 'none'}>
        <Num store={props.store} id={f().id} path="angle" label="Ángulo" unit="°" />
      </Show>
      <Num store={props.store} id={f().id} path="distance" label="Distancia" unit="mm" />
      <p class="hint">
        {f().axis === 'edge'
          ? 'Se gira alrededor de la recta de la arista elegida'
          : `Se gira alrededor de un eje paralelo a ${f().axis === 'none' ? 'X, Y o Z' : f().axis} que pasa por el origen de la referencia`},
        y después se desplaza sobre la nueva normal. Distancia negativa: hacia el otro lado.
      </p>
      <button class="primary wide with-icon" onClick={() => props.store.newSketchOnPlane(f().id)}>
        <Icon name="sketch" size={15} />Nuevo sketch en este plano
      </button>
    </>
  );
}

/** Sketches anteriores a la feature `before`, como opciones de un selector. */
function sketchOptions(store: CadStore, before: FeatureId, current?: FeatureId) {
  const features = store.doc().features;
  const i = features.findIndex((x) => x.id === before);
  const opts = features.slice(0, i).filter((x) => x.type === 'sketch').map((x) => ({ value: x.id, label: x.name }));
  if (current && !opts.some((o) => o.value === current)) opts.unshift({ value: current, label: '(sketch no disponible)' });
  return opts;
}

function SweepPanel(props: { store: CadStore; feature: SweepFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<SweepFeature>) => props.store.updateFeature<SweepFeature>(f().id, patch);
  return (
    <>
      <h3>Barrido</h3>
      <SelectField label="Perfil" value={f().profile} options={sketchOptions(props.store, f().id, f().profile)} onChange={(profile) => update({ profile })} />
      <SelectField label="Trayectoria" value={f().path} options={sketchOptions(props.store, f().id, f().path)} onChange={(path) => update({ path })} />
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => update({ operation })} />
      <p class="hint">
        El perfil (contorno cerrado) recorre la trayectoria: líneas y arcos unidos en una sola cadena, o un círculo.
        Conviene dibujar el perfil en un plano perpendicular al comienzo de la trayectoria.
      </p>
    </>
  );
}

function LoftPanel(props: { store: CadStore; feature: LoftFeature }) {
  const f = () => props.feature;
  const update = (patch: Partial<LoftFeature>) => props.store.updateFeature<LoftFeature>(f().id, patch);
  const setAt = (i: number, id: FeatureId) => update({ sections: f().sections.map((s, k) => (k === i ? id : s)) });
  const remove = (i: number) => update({ sections: f().sections.filter((_, k) => k !== i) });
  const swap = (i: number, j: number) => {
    const next = f().sections.slice();
    [next[i], next[j]] = [next[j], next[i]];
    update({ sections: next });
  };
  const free = () => sketchOptions(props.store, f().id).filter((o) => !f().sections.includes(o.value));
  return (
    <>
      <h3>Solevación</h3>
      <For each={f().sections}>
        {(id, i) => (
          <div class="section-row">
            <SelectField label={`Sección ${i() + 1}`} value={id} options={sketchOptions(props.store, f().id, id)} onChange={(v) => setAt(i(), v)} />
            <span class="section-actions">
              <button class="icon-btn" disabled={i() === 0} onClick={() => swap(i(), i() - 1)} aria-label="Subir sección" data-tip="Subir sección">
                <Icon name="toTop" size={13} />
              </button>
              <button class="icon-btn" disabled={i() === f().sections.length - 1} onClick={() => swap(i(), i() + 1)} aria-label="Bajar sección" data-tip="Bajar sección">
                <Icon name="toBottom" size={13} />
              </button>
              <button class="icon-btn danger" disabled={f().sections.length <= 2} onClick={() => remove(i())} aria-label="Quitar sección" data-tip="Quitar sección">
                <Icon name="close" size={13} />
              </button>
            </span>
          </div>
        )}
      </For>
      <Show when={free().length > 0}>
        <SelectField label="Agregar" value={'' as FeatureId} options={[{ value: '' as FeatureId, label: 'Elegir sketch…' }, ...free()]}
          onChange={(id) => id && update({ sections: [...f().sections, id] })} />
      </Show>
      <label class="field">
        <span class="field-label">Reglada</span>
        <span class="field-input">
          <input type="checkbox" checked={f().ruled} onChange={(e) => update({ ruled: e.currentTarget.checked })} />
          <span class="muted">caras planas entre secciones</span>
        </span>
      </label>
      <SelectField label="Operación" value={f().operation} options={OPERATIONS} onChange={(operation) => update({ operation })} />
      <p class="hint">Cada sección es un sketch con un solo contorno cerrado, en el orden en que se unen.</p>
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

const AXES = [
  { value: 'X', label: 'Eje X' },
  { value: 'Y', label: 'Eje Y' },
  { value: 'Z', label: 'Eje Z' },
] as const satisfies readonly { value: GlobalAxis; label: string }[];

const MIRROR_PLANES = [
  { value: 'YZ', label: 'Plano YZ (refleja X)' },
  { value: 'XZ', label: 'Plano XZ (refleja Y)' },
  { value: 'XY', label: 'Plano XY (refleja Z)' },
] as const satisfies readonly { value: BasePlane; label: string }[];

/** Patrón (lineal/circular) y simetría: feature de origen y parámetros de la copia. */
function CopyPanel(props: { store: CadStore; feature: PatternFeature | MirrorFeature }) {
  const f = () => props.feature;
  const sources = () => {
    const features = props.store.doc().features;
    const i = features.findIndex((x) => x.id === f().id);
    const opts = features.slice(0, i).filter((x) => x.type === 'extrude' || x.type === 'revolve').map((x) => ({ value: x.id, label: x.name }));
    if (!opts.some((o) => o.value === f().source)) opts.unshift({ value: f().source, label: '(no disponible)' });
    return opts;
  };
  const pattern = () => (f().type === 'pattern' ? (f() as PatternFeature) : null);
  return (
    <>
      <h3>{f().type === 'pattern' ? 'Patrón' : 'Simetría'}</h3>
      <SelectField label="Repetir" value={f().source} options={sources()}
        onChange={(source) => props.store.updateFeature<PatternFeature>(f().id, { source })} />
      <Show when={pattern()} fallback={
        <SelectField label="Plano" value={(f() as MirrorFeature).plane} options={MIRROR_PLANES}
          onChange={(plane) => props.store.updateFeature<MirrorFeature>(f().id, { plane })} />
      }>
        {(p) => (
          <>
            <SelectField label="Tipo" value={p().kind}
              options={[{ value: 'linear', label: 'Lineal' }, { value: 'circular', label: 'Circular' }] as const}
              onChange={(kind) => props.store.updateFeature<PatternFeature>(f().id, { kind })} />
            <SelectField label={p().kind === 'linear' ? 'Dirección' : 'Eje'} value={p().axis} options={AXES}
              onChange={(axis) => props.store.updateFeature<PatternFeature>(f().id, { axis })} />
            <Num store={props.store} id={f().id} path="count" label="Cantidad" unit="" />
            <Show when={p().kind === 'linear'} fallback={<Num store={props.store} id={f().id} path="angle" label="Ángulo total" unit="°" />}>
              <Num store={props.store} id={f().id} path="spacing" label="Separación" unit="mm" />
            </Show>
            <p class="hint">
              {p().kind === 'linear'
                ? 'Separación negativa: en el sentido contrario del eje.'
                : 'Alrededor del eje por el origen. 360° reparte las copias en la vuelta completa.'}
            </p>
          </>
        )}
      </Show>
      <p class="hint">Se combina igual que la feature original (unir, cortar o cuerpo nuevo).</p>
    </>
  );
}
