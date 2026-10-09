// Operaciones entre cuerpos: combinar, dividir con un plano y mover/copiar.
import { cast, getOC, makeCompound, type AnyShape } from 'replicad';
import { offsetFrame, type PlaneFrame } from '../../document/planes';
import type { CombineFeature, FaceRef, FeatureId, GlobalAxis, MoveFeature, SplitFeature } from '../../document/types';
import { historyOf, NameBuilder, resolveFace, ShapeTable, type History, type NamedShape, type OcShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';
import { volume } from './measure';
import { referenceFrame } from './plane';

/** Cuerpo (sólido) de la pieza, con los nombres de sus caras. */
interface Body {
  named: NamedShape;
}

/** Los sólidos de la pieza, cada uno con sus nombres. */
function bodiesOf(input: NamedShape): Body[] {
  const table = ShapeTable.faces(input.shape);
  return input.shape.solids.map((solid) => ({
    named: {
      shape: solid,
      names: solid.faces.map((f) => {
        const i = table.indexOf(f.wrapped, f.hashCode);
        return i >= 0 ? input.names[i] : [];
      }),
    },
  }));
}

/** Índice del cuerpo que contiene la cara referenciada. */
function bodyIndex(input: NamedShape, bodies: Body[], ref: FaceRef): number {
  const face = input.shape.faces[resolveFace(input, ref)];
  const k = bodies.findIndex((b) => b.named.shape.faces.some((f) => f.wrapped.IsSame(face.wrapped)));
  if (k < 0) throw new FeatureError('La cara elegida no pertenece a ningún cuerpo sólido');
  return k;
}

/** Junta cuerpos en un resultado con nombres (un sólido solo, o un compound). */
function assemble(parts: NamedShape[], featureId: string): NamedShape {
  if (parts.length === 1) {
    const nb = new NameBuilder(parts[0].shape);
    nb.carry(parts[0], null);
    return nb.finish(featureId);
  }
  // makeCompound se queda con lo que recibe: van copias (los cuerpos siguen siendo del llamador).
  const compound = makeCompound(parts.map((p) => p.shape.clone()));
  const nb = new NameBuilder(compound);
  for (const p of parts) nb.carry(p, null);
  return nb.finish(featureId);
}

/** Lleva los nombres de un cuerpo a través de una operación: devuelve un NamedShape del resultado. */
function through(result: AnyShape, sources: NamedShape[], history: History, featureId: string, extra?: (nb: NameBuilder) => void): NamedShape {
  const nb = new NameBuilder(result);
  for (const s of sources) nb.carry(s, history);
  extra?.(nb);
  return nb.finish(featureId);
}

// ---------------------------------------------------------------- combinar

export function runCombine(feature: CombineFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay cuerpos para combinar');
  const bodies = bodiesOf(input);
  const t = bodyIndex(input, bodies, feature.target);
  const tools = [...new Set(feature.tools.map((r) => bodyIndex(input, bodies, r)))].filter((k) => k !== t);
  if (tools.length === 0) throw new FeatureError('Elegí al menos un cuerpo herramienta distinto del cuerpo de destino');

  const target = bodies[t].named;
  const toolNamed = tools.map((k) => bodies[k].named);
  const toolShape = toolNamed.length === 1 ? toolNamed[0].shape : makeCompound(toolNamed.map((n) => n.shape.clone()));
  const range = new oc.Message_ProgressRange();
  const op = feature.operation;
  const algo = op === 'join'
    ? new oc.BRepAlgoAPI_Fuse(target.shape.wrapped, toolShape.wrapped, range)
    : op === 'cut'
      ? new oc.BRepAlgoAPI_Cut(target.shape.wrapped, toolShape.wrapped, range)
      : new oc.BRepAlgoAPI_Common(target.shape.wrapped, toolShape.wrapped, range);
  try {
    if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError('No se pudieron combinar los cuerpos');
    if (op === 'join') algo.SimplifyResult(true, true, 1e-6);
    const result = cast(algo.Shape());
    if (result.solids.length === 0) {
      result.delete();
      throw new FeatureError(op === 'cut' ? 'El corte elimina todo el cuerpo' : op === 'intersect' ? 'Los cuerpos no se superponen' : 'La unión no dio un sólido');
    }
    if (!isValidShape(result)) {
      result.delete();
      throw new FeatureError('El resultado no es un sólido válido');
    }
    if (op === 'cut' && Math.abs(volume(result) - volume(target.shape)) <= 1e-9 * Math.max(1, volume(target.shape))) {
      result.delete();
      throw new FeatureError('Las herramientas no tocan el cuerpo de destino');
    }
    const combined = through(result, [target, ...toolNamed], historyOf(algo), feature.id);
    const others = bodies.filter((_, k) => k !== t && (feature.keepTools || !tools.includes(k))).map((b) => b.named);
    return assemble([combined, ...others], feature.id);
  } finally {
    algo.delete();
    range.delete();
    if (toolNamed.length > 1) toolShape.delete();
  }
}

// ---------------------------------------------------------------- dividir

export function runSplit(feature: SplitFeature, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame>): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay cuerpos para dividir');
  if (!Number.isFinite(feature.offset)) throw new FeatureError('El desplazamiento no es un número válido');
  const frame = offsetFrame(referenceFrame(feature.plane, input, planes, feature.id), feature.offset);
  const bodies = bodiesOf(input);
  const targets = feature.body ? [bodyIndex(input, bodies, feature.body)] : bodies.map((_, k) => k);

  // Cara plana bien más grande que la pieza.
  const [lo, hi] = input.shape.boundingBox.bounds;
  const size = 4 * Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])) + 4 * Math.hypot(...frame.origin);
  const keep: { delete(): void }[] = [];
  const pnt = new oc.gp_Pnt(...frame.origin);
  const dir = new oc.gp_Dir(...frame.normal);
  const pln = new oc.gp_Pln(pnt, dir);
  const mf = new oc.BRepBuilderAPI_MakeFace(pln, -size, size, -size, size);
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const range = new oc.Message_ProgressRange();
  keep.push(pnt, dir, pln, mf, args, tools, splitter, range);
  try {
    const cutter = mf.Face();
    for (const k of targets) args.Append(bodies[k].named.shape.wrapped);
    tools.Append(cutter);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build(range);
    if (!splitter.IsDone() || splitter.HasErrors()) throw new FeatureError('No se pudo dividir con ese plano');
    const result = cast(splitter.Shape());
    const pieces = result.solids;
    if (pieces.length <= targets.length) {
      result.delete();
      throw new FeatureError('El plano no corta ningún cuerpo');
    }
    const history = historyOf(splitter);
    const split = through(result, targets.map((k) => bodies[k].named), history, feature.id, (nb) => {
      for (const g of [...history.modified(cutter as OcShape), ...history.generated(cutter as OcShape)]) nb.add(g, `${feature.id}:split`);
    });
    const parts = bodiesOf(split).map((b) => b.named);
    const others = bodies.filter((_, k) => !targets.includes(k)).map((b) => b.named);
    return assemble([...parts, ...others], feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}

// ---------------------------------------------------------------- mover / copiar

const AXIS: Record<GlobalAxis, [number, number, number]> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export function runMove(feature: MoveFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay cuerpos para mover');
  const { dx, dy, dz, angle } = feature;
  if (![dx, dy, dz, angle].every(Number.isFinite)) throw new FeatureError('Algún valor no es un número válido');
  if (Math.hypot(dx, dy, dz) < 1e-12 && Math.abs(angle) < 1e-12) throw new FeatureError('Poné una traslación o un ángulo distinto de 0');
  const bodies = bodiesOf(input);
  const targets = feature.bodies.length ? [...new Set(feature.bodies.map((r) => bodyIndex(input, bodies, r)))] : bodies.map((_, k) => k);

  // Primero el giro (alrededor del eje global por el origen), después la traslación.
  const keep: { delete(): void }[] = [];
  const rot = new oc.gp_Trsf();
  const tr = new oc.gp_Trsf();
  const p0 = new oc.gp_Pnt(0, 0, 0);
  const ax = new oc.gp_Dir(...AXIS[feature.axis]);
  const a1 = new oc.gp_Ax1(p0, ax);
  const v = new oc.gp_Vec(dx, dy, dz);
  keep.push(rot, tr, p0, ax, a1, v);
  rot.SetRotation(a1, (angle * Math.PI) / 180);
  tr.SetTranslation(v);
  tr.Multiply(rot);
  try {
    const moved = targets.map((k) => {
      const src = bodies[k].named;
      const builder = new oc.BRepBuilderAPI_Transform(src.shape.wrapped, tr, true, false);
      keep.push(builder);
      // La copia lleva nombres propios; el cuerpo movido conserva los suyos.
      const named = feature.copy ? { shape: src.shape, names: src.names.map((ns) => ns.map((n) => `${feature.id}:${n}`)) } : src;
      return through(cast(builder.Shape()), [named], historyOf(builder), feature.id);
    });
    const untouched = bodies.filter((_, k) => feature.copy || !targets.includes(k)).map((b) => b.named);
    return assemble([...untouched, ...moved], feature.id);
  } finally {
    keep.forEach((k) => k.delete());
  }
}
