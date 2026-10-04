// Features de terminación sobre el sólido existente: redondeo, chaflán y vaciado.
import { cast, getOC, type AnyShape } from 'replicad';
import type { ChamferFeature, FilletFeature, ShellFeature } from '../../document/types';
import { edgeNames, historyOf, NameBuilder, resolveEdge, resolveFace, ShapeTable, type History, type NamedShape } from '../naming';
import { describeError, FeatureError, isValidShape } from '../occtUtils';
import { volume } from './measure';

/** Redondeo o chaflán de las aristas referenciadas. */
export function runEdgeFeature(feature: FilletFeature | ChamferFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  const isFillet = feature.type === 'fillet';
  const size = isFillet ? feature.radius : feature.distance;
  const what = isFillet ? 'redondear' : 'achaflanar';
  if (!input) throw new FeatureError(`No hay un sólido para ${what}`);
  if (feature.edges.length === 0) throw new FeatureError('Elegí al menos una arista');
  if (!(size > 0)) throw new FeatureError(`${isFillet ? 'El radio' : 'La distancia'} debe ser mayor que 0 (es ${size})`);

  const table = ShapeTable.edges(input.shape);
  const indices = [...new Set(feature.edges.map((ref) => resolveEdge(input, ref)))];

  const builder = isFillet
    ? new oc.BRepFilletAPI_MakeFillet(input.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(input.shape.wrapped);
  const range = new oc.Message_ProgressRange();
  try {
    for (const i of indices) builder.Add(size, table.items[i].wrapped);
    builder.Build(range);
    if (!builder.IsDone()) throw new Error('not done');
    const result = cast(builder.Shape());
    checkResult(result, `No se pudo ${what}`);
    const history = historyOf(builder);
    const nb = new NameBuilder(result);
    nb.carry(input, history);
    const { names } = edgeNames(input);
    const kind = isFillet ? 'fillet' : 'chamfer';
    for (const i of indices) nb.generated(history, table.items[i].wrapped, `${feature.id}:${kind}:${names[i]}`);
    return nb.finish(feature.id);
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    const hint = isFillet
      ? `No se pudo redondear con radio ${size} mm: probá con un radio menor o con otras aristas`
      : `No se pudo achaflanar con ${size} mm: probá con una distancia menor o con otras aristas`;
    throw new FeatureError(err instanceof Error && err.message === 'not done' ? hint : `${hint} (${describeError(err)})`);
  } finally {
    builder.delete();
    range.delete();
  }
}

/** Vaciado hacia adentro con el espesor dado, quitando las caras referenciadas. */
export function runShell(feature: ShellFeature, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (!input) throw new FeatureError('No hay un sólido para vaciar');
  if (!(feature.thickness > 0)) throw new FeatureError(`El espesor debe ser mayor que 0 (es ${feature.thickness})`);

  const faces = input.shape.faces;
  const removed = new Set(feature.faces.map((ref) => resolveFace(input, ref)));
  const list = new oc.NCollection_List_TopoDS_Shape();
  for (const i of removed) list.Append(faces[i].wrapped);
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  const range = new oc.Message_ProgressRange();
  try {
    builder.MakeThickSolidByJoin(
      input.shape.wrapped, list, -feature.thickness, 1e-3,
      oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, range,
    );
    if (!builder.IsDone()) throw new Error('not done');
    const result = cast(builder.Shape());
    checkResult(result, 'No se pudo vaciar');
    // OCCT puede devolver un sólido "válido" pero absurdo si el espesor es demasiado grande:
    // un vaciado hacia adentro debe quitar material y quedar dentro de la caja original.
    if (!(volume(result) < volume(input.shape)) || !insideBox(result, input.shape)) {
      result.delete();
      throw new Error('not done');
    }
    const history: History = historyOf(builder);
    const nb = new NameBuilder(result);
    // Las caras quitadas no conservan su nombre (OCCT las reporta como "modificadas" en el borde).
    nb.carry(input, history, { skip: removed });
    faces.forEach((f, i) => {
      if (!removed.has(i)) nb.generated(history, f.wrapped, `${feature.id}:inner:${input.names[i][0]}`);
    });
    const { table, names } = edgeNames(input);
    table.items.forEach((e, i) => nb.generated(history, e.wrapped, `${feature.id}:rim:${names[i]}`));
    return nb.finish(feature.id);
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    const hint = `No se pudo vaciar con espesor ${feature.thickness} mm: probá con un espesor menor (y menor que el radio de los redondeos)`;
    throw new FeatureError(err instanceof Error && err.message === 'not done' ? hint : `${hint} (${describeError(err)})`);
  } finally {
    builder.delete();
    range.delete();
    list.delete();
  }
}

function insideBox(inner: AnyShape, outer: AnyShape): boolean {
  const [a0, a1] = inner.boundingBox.bounds;
  const [b0, b1] = outer.boundingBox.bounds;
  const tol = 1e-4 * Math.max(1, ...b1.map((v, i) => v - b0[i]));
  return [0, 1, 2].every((i) => a0[i] >= b0[i] - tol && a1[i] <= b1[i] + tol);
}

function checkResult(result: AnyShape, prefix: string) {
  if (result.solids.length === 0 || !isValidShape(result)) {
    result.delete();
    throw new FeatureError(`${prefix}: el resultado no es un sólido válido`);
  }
}
