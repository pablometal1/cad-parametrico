// Modelado directo sobre caras: empujar/tirar (Press Pull) y ángulo de desmoldeo.
import { cast, getOC, makeCompound, type AnyShape } from 'replicad';
import type { DraftFeature, PushPullFeature } from '../../document/types';
import { edgeNames, historyOf, NameBuilder, resolveFace, type History, type NamedShape } from '../naming';
import { describeError, FeatureError, isValidShape } from '../occtUtils';
import { volume } from './measure';

/**
 * Empujar/tirar caras planas: prisma de cada cara sobre su normal. Positivo se une (la cara
 * avanza hacia afuera); negativo se resta (la cara retrocede hacia adentro). La cara movida
 * conserva sus nombres, así lo que se apoyaba en ella (sketches, redondeos) la sigue encontrando.
 */
export function runPushPull(feature: PushPullFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay un sólido para empujar o tirar');
  if (feature.faces.length === 0) throw new FeatureError('Elegí al menos una cara plana');
  const d = feature.distance;
  if (!(Math.abs(d) > 0) || !Number.isFinite(d)) throw new FeatureError(`La distancia no puede ser 0 (es ${d})`);

  const indices = [...new Set(feature.faces.map((ref) => resolveFace(input, ref)))];
  const faces = indices.map((i) => input.shape.faces[i]);
  if (faces.some((f) => f.geomType !== 'PLANE')) throw new FeatureError('Empujar/tirar solo funciona con caras planas');

  const { table, names: edgeNameList } = edgeNames(input);
  const prisms: { shape: AnyShape; history: History; cap: AnyShape; face: number }[] = [];
  const keep: { delete(): void }[] = [];
  try {
    for (const [k, face] of faces.entries()) {
      const n = face.normalAt(face.center).toTuple();
      const vec = new oc.gp_Vec(n[0] * d, n[1] * d, n[2] * d);
      const prism = new oc.BRepPrimAPI_MakePrism(face.wrapped, vec, false, true);
      keep.push(vec, prism);
      if (!prism.IsDone()) throw new FeatureError('No se pudo extruir la cara');
      prisms.push({ shape: cast(prism.Shape()), history: historyOf(prism), cap: cast(prism.LastShape()), face: indices[k] });
    }

    // Herramienta con nombres: la tapa del prisma hereda los de la cara; los lados, los de la arista.
    const toolShape = prisms.length === 1 ? prisms[0].shape : makeCompound(prisms.map((p) => p.shape.clone()));
    const tb = new NameBuilder(toolShape);
    for (const p of prisms) {
      for (const n of input.names[p.face]) tb.addAll(p.cap, n);
      for (const e of input.shape.faces[p.face].edges) {
        const ei = table.indexOf(e.wrapped, e.hashCode);
        if (ei >= 0) tb.generated(p.history, e.wrapped, `${feature.id}:side:${edgeNameList[ei]}`);
      }
    }
    const tool = tb.finish(feature.id);

    const range = new oc.Message_ProgressRange();
    const algo = d > 0
      ? new oc.BRepAlgoAPI_Fuse(input.shape.wrapped, tool.shape.wrapped, range)
      : new oc.BRepAlgoAPI_Cut(input.shape.wrapped, tool.shape.wrapped, range);
    keep.push(range, algo);
    if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(d > 0 ? 'No se pudo tirar de la cara' : 'No se pudo empujar la cara');
    algo.SimplifyResult(true, true, 1e-6);
    const result = cast(algo.Shape());
    if (result.solids.length === 0 || !isValidShape(result)) {
      result.delete();
      throw new FeatureError(d < 0 ? 'Empujar tanto deja la pieza sin material' : 'El resultado no es un sólido válido');
    }
    const history = historyOf(algo);
    const nb = new NameBuilder(result);
    // La cara original queda adentro (al tirar) o se borra (al empujar): sus nombres pasan a la tapa.
    nb.carry(input, history, { skip: new Set(indices) });
    nb.carry(tool, history);
    if (prisms.length > 1) toolShape.delete();
    return nb.finish(feature.id);
  } finally {
    keep.forEach((k) => k.delete());
    for (const p of prisms) {
      p.shape.delete();
      p.cap.delete();
    }
  }
}

/**
 * Ángulo de desmoldeo (BRepOffsetAPI_DraftAngle): las caras giran sobre su intersección con el
 * plano neutro, alejándose de la dirección de desmolde con ángulo positivo (la pieza se angosta
 * hacia arriba, como para sacarla de un molde).
 */
export function runDraft(feature: DraftFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay un sólido para darle ángulo de desmoldeo');
  if (feature.faces.length === 0) throw new FeatureError('Elegí las caras a inclinar');
  const a = feature.angle;
  if (!(Math.abs(a) > 0 && Math.abs(a) < 89)) throw new FeatureError(`El ángulo tiene que estar entre 0 y 89° (es ${a})`);

  const neutral = input.shape.faces[resolveFace(input, feature.neutral)];
  if (neutral.geomType !== 'PLANE') throw new FeatureError('La cara neutra tiene que ser plana');
  const c = neutral.center.toTuple();
  // Dirección de desmolde: desde la cara neutra hacia adentro de la pieza.
  const n = neutral.normalAt(neutral.center).toTuple().map((x) => -x);
  const indices = [...new Set(feature.faces.map((ref) => resolveFace(input, ref)))];

  const keep: { delete(): void }[] = [];
  const pnt = new oc.gp_Pnt(c[0], c[1], c[2]);
  const dir = new oc.gp_Dir(n[0], n[1], n[2]);
  const pln = new oc.gp_Pln(pnt, dir);
  const draft = new oc.BRepOffsetAPI_DraftAngle(input.shape.wrapped);
  keep.push(pnt, dir, pln, draft);
  try {
    for (const i of indices) {
      const face = input.shape.faces[i];
      // Cada cara se inclina hacia adentro: el signo depende de para dónde mira respecto del desmolde.
      draft.Add(oc.TopoDS.Face(face.wrapped), dir, (a * Math.PI) / 180, pln, true);
      if (!draft.AddDone()) {
        throw new FeatureError('No se puede inclinar una de las caras (tiene que cortar al plano neutro y no ser paralela a él)');
      }
    }
    const range = new oc.Message_ProgressRange();
    keep.push(range);
    try {
      draft.Build(range);
    } catch (err) {
      throw new FeatureError(`No se pudo aplicar el desmoldeo (${describeError(err)})`);
    }
    if (!draft.IsDone()) throw new FeatureError('No se pudo aplicar el desmoldeo: probá con un ángulo menor o con otras caras');
    const result = cast(draft.Shape());
    if (result.solids.length === 0 || !isValidShape(result) || !(volume(result) > 0)) {
      result.delete();
      throw new FeatureError('El desmoldeo no dio un sólido válido: probá con un ángulo menor');
    }
    const nb = new NameBuilder(result);
    nb.carry(input, historyOf(draft));
    return nb.finish(feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}
