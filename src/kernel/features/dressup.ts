// Features de terminación sobre el sólido existente: redondeo, chaflán y vaciado.
import { cast, getOC, makeCompound, type AnyShape } from 'replicad';
import type { ChamferFeature, FilletFeature, ShellFeature } from '../../document/types';
import { edgeNames, historyOf, NameBuilder, resolveEdge, resolveFace, ShapeTable, type History, type NamedShape, type OcShape } from '../naming';
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
    if (err instanceof FeatureError && !err.message.endsWith('no es un sólido válido')) throw err;
    // Busca el valor más grande que sí entra, para que el mensaje diga cuánto probar.
    const max = largestThatWorks(size, (v) => edgeFeatureWorks(input, indices, isFillet, v));
    const what = isFillet ? `redondear con radio ${fmtNum(size)} mm` : `achaflanar con ${fmtNum(size)} mm`;
    const hint =
      max === null
        ? `No se pudo ${what}: ninguna medida entra en estas aristas; probá con otras`
        : `No se pudo ${what}: en estas aristas entra hasta ≈ ${fmtMax(max)} mm ` +
          '(no puede superar el ancho de las caras que toca; en una pieza vaciada, el espesor de la pared)';
    throw new FeatureError(err instanceof Error && (err.message === 'not done' || err instanceof FeatureError) ? hint : `${hint} (${describeError(err)})`);
  } finally {
    builder.delete();
    range.delete();
  }
}

/** ¿Se puede redondear/achaflanar esas aristas con esa medida? (sin quedarse con el resultado) */
function edgeFeatureWorks(input: NamedShape, indices: number[], isFillet: boolean, size: number): boolean {
  const oc = getOC();
  const table = ShapeTable.edges(input.shape);
  const builder = isFillet
    ? new oc.BRepFilletAPI_MakeFillet(input.shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(input.shape.wrapped);
  const range = new oc.Message_ProgressRange();
  try {
    for (const i of indices) builder.Add(size, table.items[i].wrapped);
    builder.Build(range);
    if (!builder.IsDone()) return false;
    const result = cast(builder.Shape());
    const ok = result.solids.length > 0 && isValidShape(result);
    result.delete();
    return ok;
  } catch {
    return false;
  } finally {
    builder.delete();
    range.delete();
  }
}

/**
 * Mayor valor en (0, failed) para el que `works` da verdadero, por bisección. null si ni
 * siquiera el 1 % funciona. Se corta a los 1.5 s para no trabar el recálculo en piezas grandes.
 */
export function largestThatWorks(failed: number, works: (v: number) => boolean): number | null {
  let lo = failed * 0.01;
  if (!works(lo)) return null;
  let hi = failed;
  const start = performance.now();
  for (let k = 0; k < 12 && performance.now() - start < 1500; k++) {
    const mid = (lo + hi) / 2;
    if (works(mid)) lo = mid;
    else hi = mid;
    if (hi - lo < Math.max(0.005, failed * 0.002)) break;
  }
  return lo;
}

/** Redondea hacia abajo con 2 decimales (el valor que se muestra tiene que funcionar). */
function fmtMax(v: number) {
  const r = Math.floor(v * 100) / 100;
  return r > 0 ? String(r) : String(Math.floor(v * 1000) / 1000);
}

/** Vaciado hacia adentro con el espesor dado, quitando las caras referenciadas. */
export function runShell(feature: ShellFeature, input: NamedShape | null): NamedShape {
  if (!input) throw new FeatureError('No hay un sólido para vaciar');
  if (!(feature.thickness > 0)) throw new FeatureError(`El espesor debe ser mayor que 0 (es ${feature.thickness})`);

  const faces = input.shape.faces;
  const removed = [...new Set(feature.faces.map((ref) => resolveFace(input, ref)))];
  let run: ShellRun | null = null;
  try {
    run = shellBodies(input, removed, feature.thickness);
    const { result, history } = run;
    const skip = new Set(removed);
    const nb = new NameBuilder(result);
    // Las caras quitadas no conservan su nombre (OCCT las reporta como "modificadas" en el borde).
    nb.carry(input, history, { skip });
    faces.forEach((f, i) => {
      if (!skip.has(i)) nb.generated(history, f.wrapped, `${feature.id}:inner:${input.names[i][0]}`);
    });
    const { table, names } = edgeNames(input);
    table.items.forEach((e, i) => nb.generated(history, e.wrapped, `${feature.id}:rim:${names[i]}`));
    return nb.finish(feature.id);
  } catch (err) {
    run?.result.delete();
    if (err instanceof FeatureError && !err.message.endsWith('no es un sólido válido')) throw err;
    const max = largestThatWorks(feature.thickness, (t) => shellWorks(input, removed, t));
    const t = fmtNum(feature.thickness);
    const hint =
      max === null
        ? `No se pudo vaciar con espesor ${t} mm quitando esas caras; probá con otras caras`
        : `No se pudo vaciar con espesor ${t} mm: entra hasta ≈ ${fmtMax(max)} mm ` +
          '(tiene que ser menor que el radio de los redondeos y que las partes más finas de la pieza)';
    throw new FeatureError(err instanceof Error && (err.message === 'not done' || err instanceof FeatureError) ? hint : `${hint} (${describeError(err)})`);
  } finally {
    run?.dispose();
  }
}

interface ShellRun {
  result: AnyShape;
  history: History;
  /** Libera los constructores de OCCT (no el resultado). */
  dispose(): void;
}

/**
 * Vacía solo los cuerpos que contienen las caras quitadas; los demás cuerpos (por ejemplo, un
 * segundo perfil extruido aparte) quedan iguales. OCCT no sabe vaciar varios sólidos juntos.
 * Lanza Error('not done') si algún cuerpo no se puede vaciar con ese espesor.
 */
function shellBodies(input: NamedShape, removed: number[], thickness: number): ShellRun {
  const faces = input.shape.faces;
  const solids = input.shape.solids;
  const byBody = new Map<number, number[]>();
  for (const i of removed) {
    const k = solids.findIndex((sol) => sol.faces.some((f) => f.wrapped.IsSame(faces[i].wrapped)));
    if (k < 0) throw new Error('not done');
    byBody.set(k, [...(byBody.get(k) ?? []), i]);
  }

  const builders: Deletable[] = [];
  const histories: History[] = [];
  const shelled: AnyShape[] = [];
  const dispose = () => builders.forEach((b) => b.delete());
  try {
    const parts: AnyShape[] = solids.map((sol, k) => {
      const own = byBody.get(k);
      if (!own) return sol;
      const ownFaces = own.map((i) => faces[i]);
      // Primero el vaciado directo de OCCT; si falla (pasa con redondeos tóricos), por booleanas.
      const body = thickSolid(sol, ownFaces, thickness, builders) ?? shellByCut(sol, ownFaces, thickness, builders);
      if (!body) throw new Error('not done');
      shelled.push(body.result);
      histories.push(body.history);
      return body.result;
    });
    const result = solids.length === 1 ? parts[0] : makeCompound(parts);
    if (solids.length > 1) shelled.forEach((r) => r.delete());
    const history: History = {
      modified: (x) => histories.flatMap((h) => h.modified(x)),
      generated: (x) => histories.flatMap((h) => h.generated(x)),
      isDeleted: (x) => histories.some((h) => h.isDeleted(x)),
    };
    return { result, history, dispose };
  } catch (err) {
    shelled.forEach((r) => r.delete());
    dispose();
    throw err;
  }
}

type Deletable = { delete(): void };

/** Un vaciado hacia adentro tiene que quitar material y quedar dentro de la caja original. */
function plausibleShell(r: AnyShape, original: AnyShape) {
  return r.solids.length > 0 && isValidShape(r) && volume(r) < volume(original) && insideBox(r, original);
}

/** Vaciado directo (BRepOffsetAPI_MakeThickSolid). null si OCCT no puede o da algo absurdo. */
function thickSolid(sol: AnyShape, removed: AnyShape[], thickness: number, keep: Deletable[]): { result: AnyShape; history: History } | null {
  const oc = getOC();
  const list = new oc.NCollection_List_TopoDS_Shape();
  for (const f of removed) list.Append(f.wrapped);
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  const range = new oc.Message_ProgressRange();
  keep.push(builder, range, list);
  try {
    builder.MakeThickSolidByJoin(
      sol.wrapped, list, -thickness, 1e-3,
      oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, range,
    );
    if (!builder.IsDone()) return null;
  } catch {
    return null;
  }
  const r = cast(builder.Shape());
  if (!plausibleShell(r, sol)) {
    r.delete();
    return null;
  }
  return { result: r, history: historyOf(builder) };
}

/**
 * Vaciado por booleanas: hueco = sólido desplazado hacia adentro (offset cerrado, que OCCT
 * resuelve aun con redondeos donde MakeThickSolid falla), más un prisma por cada cara quitada
 * para abrirla. Resultado = sólido − hueco. Solo con caras quitadas planas.
 * La historia que devuelve imita a la del vaciado directo: `modified` lleva cada cara exterior
 * a su versión final y `generated` lleva cada cara a su pared interior.
 */
function shellByCut(sol: AnyShape, removed: AnyShape[], thickness: number, keep: Deletable[]): { result: AnyShape; history: History } | null {
  const oc = getOC();
  if (removed.some((f) => (f as { geomType?: string }).geomType !== 'PLANE')) return null;
  const offset = new oc.BRepOffsetAPI_MakeOffsetShape();
  const range = new oc.Message_ProgressRange();
  keep.push(offset, range);
  let cavity: AnyShape;
  try {
    offset.PerformByJoin(sol.wrapped, -thickness, 1e-3, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false, range);
    if (!offset.IsDone()) return null;
    cavity = cast(offset.Shape());
  } catch {
    return null;
  }
  const temps: AnyShape[] = [cavity];
  const fail = () => {
    temps.forEach((t) => t.delete());
    return null;
  };
  if (cavity.solids.length !== 1 || !isValidShape(cavity) || !(volume(cavity) < volume(sol))) return fail();
  const offsetHistory = historyOf(offset);

  // Prismas que abren cada cara quitada: desde su copia interior hacia afuera, el doble del espesor.
  let tool: AnyShape = cavity;
  const fuseHistories: History[] = [];
  for (const f of removed) {
    const inner = [...offsetHistory.generated(f.wrapped), ...offsetHistory.modified(f.wrapped)];
    if (inner.length !== 1) return fail();
    const innerFace = cast(inner[0]);
    temps.push(innerFace);
    const a = (innerFace as unknown as { center: { toTuple(): number[] } }).center.toTuple();
    const b = (f as unknown as { center: { toTuple(): number[] } }).center.toTuple();
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > thickness * 0.5)) return fail();
    const k = (2 * thickness) / len;
    const vec = new oc.gp_Vec(d[0] * k, d[1] * k, d[2] * k);
    const prism = new oc.BRepPrimAPI_MakePrism(innerFace.wrapped, vec, false, true);
    keep.push(vec, prism);
    if (!prism.IsDone()) return fail();
    const plug = cast(prism.Shape());
    temps.push(plug);
    const fr = new oc.Message_ProgressRange();
    const fuse = new oc.BRepAlgoAPI_Fuse(tool.wrapped, plug.wrapped, fr);
    keep.push(fr, fuse);
    if (!fuse.IsDone() || fuse.HasErrors()) return fail();
    tool = cast(fuse.Shape());
    temps.push(tool);
    fuseHistories.push(historyOf(fuse));
  }

  const cr = new oc.Message_ProgressRange();
  const cut = new oc.BRepAlgoAPI_Cut(sol.wrapped, tool.wrapped, cr);
  keep.push(cr, cut);
  if (!cut.IsDone() || cut.HasErrors()) return fail();
  const result = cast(cut.Shape());
  if (result.solids.length !== 1 || !plausibleShell(result, sol)) {
    result.delete();
    return fail();
  }
  const cutHistory = historyOf(cut);
  // Lleva formas a través de una cadena de operaciones (las que no cambian siguen igual).
  const through = (hs: History[], xs: OcShape[]) =>
    hs.reduce((acc, h) => acc.flatMap((x) => (h.isDeleted(x) ? [] : h.modified(x).length ? h.modified(x) : [x])), xs);
  const history: History = {
    modified: (x) => {
      const out = through([cutHistory], [x]);
      return out.length === 1 && out[0] === x ? [] : out;
    },
    generated: (x) => {
      const inner = [...offsetHistory.generated(x), ...offsetHistory.modified(x)];
      return inner.length ? through([...fuseHistories, cutHistory], inner) : [];
    },
    isDeleted: (x) => cutHistory.isDeleted(x),
  };
  // El resultado queda vivo; los intermedios (hueco, prismas, herramienta) ya no hacen falta.
  temps.forEach((t) => t.delete());
  return { result, history };
}

/** ¿Se puede vaciar con ese espesor? (mismas comprobaciones que runShell, sin quedarse con el resultado) */
function shellWorks(input: NamedShape, removed: number[], thickness: number): boolean {
  try {
    const run = shellBodies(input, removed, thickness);
    run.result.delete();
    run.dispose();
    return true;
  } catch {
    return false;
  }
}

/** Número legible en mensajes (0.30000000000000004 → 0.3). */
function fmtNum(v: number) {
  return String(Number(v.toPrecision(10)));
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
