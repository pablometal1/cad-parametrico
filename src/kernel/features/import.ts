// Importar STL/STEP: el archivo va dentro del documento (base64); se lee con OpenCascade y se
// ubica (escala, giros, traslado). Puede ser solo referencia, cuerpo nuevo, unirse o cortar.
import { cast, getOC, type AnyShape } from 'replicad';
import type { ImportFeature } from '../../document/types';
import { NameBuilder, type NamedShape } from '../naming';
import { describeError, FeatureError, hashString } from '../occtUtils';
import { combine } from './boolean';
import { volume } from './measure';
import { checkWatertight, weldMesh } from '../export/meshExport';

/** Archivos ya leídos, por contenido (leer un STL grande cuesta; mover la pieza no debería). */
const parsed = new Map<string, AnyShape>();
const MAX_PARSED = 4;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let fileCounter = 0;

/** Lee el archivo (sin ubicar). El resultado lo conserva la cache: el llamador debe clonarlo. */
export function readImport(format: ImportFeature['format'], data: string): AnyShape {
  const key = hashString(format + data);
  const hit = parsed.get(key);
  if (hit) return hit;
  const oc = getOC();
  const path = `/import-${++fileCounter}.${format === 'stl' ? 'stl' : 'step'}`;
  oc.FS.writeFile(path, base64ToBytes(data));
  let shape: AnyShape;
  try {
    shape = format === 'step' ? readSTEP(path) : readSTL(path);
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // ya borrado
    }
  }
  parsed.set(key, shape);
  if (parsed.size > MAX_PARSED) {
    const [oldKey, old] = parsed.entries().next().value as [string, AnyShape];
    parsed.delete(oldKey);
    old.delete();
  }
  return shape;
}

function readSTEP(path: string): AnyShape {
  const oc = getOC();
  const reader = new oc.STEPControl_Reader();
  try {
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new FeatureError('No se pudo leer el archivo STEP');
    reader.TransferRoots(new oc.Message_ProgressRange());
    const shape = cast(reader.OneShape());
    if (shape.faces.length === 0) throw new FeatureError('El archivo STEP no tiene caras');
    return shape;
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw new FeatureError(`No se pudo leer el archivo STEP (${describeError(err)})`);
  } finally {
    reader.delete();
  }
}

/** Triángulos de un STL binario o ASCII: posiciones xyz consecutivas (3 vértices por triángulo). */
export function parseSTL(bytes: Uint8Array): Float32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + 50 * n === bytes.length) {
      const out = new Float32Array(n * 9);
      for (let t = 0; t < n; t++) {
        const o = 84 + 50 * t + 12; // salta la normal
        for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(o + 4 * k, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  const nums: number[] = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (nums.length === 0 || nums.length % 9 !== 0 || nums.some((v) => !Number.isFinite(v))) throw new FeatureError('El archivo STL está dañado o vacío');
  return Float32Array.from(nums);
}

/** Arriba de esta cantidad de triángulos no se unifican las caras coplanares (es lento). */
const UNIFY_MAX_TRIANGLES = 4000;

/**
 * STL → sólido. Los vértices iguales se sueldan y cada vértice y arista de OpenCascade se crea
 * una sola vez: los triángulos vecinos comparten aristas y la cáscara queda cerrada sin "coser"
 * (coser con OCCT tardaba minutos con 25.000 triángulos). Malla abierta → solo superficie.
 */
function readSTL(path: string): AnyShape {
  const oc = getOC();
  const tris = parseSTL(oc.FS.readFile(path) as Uint8Array);
  const mesh = weldMesh(tris, Uint32Array.from({ length: tris.length / 3 }, (_, i) => i));
  if (mesh.triangles.length === 0) throw new FeatureError('El STL no tiene triángulos');
  const keep: { delete(): void }[] = [];
  const vertex = new Map<number, unknown>();
  const edge = new Map<string, unknown>();
  const V = (i: number) => {
    let v = vertex.get(i);
    if (!v) {
      const p = new oc.gp_Pnt(mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]);
      const mk = new oc.BRepBuilderAPI_MakeVertex(p);
      v = mk.Vertex();
      keep.push(p, mk);
      vertex.set(i, v);
    }
    return v;
  };
  const E = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let e = edge.get(key);
    if (!e) {
      const mk = new oc.BRepBuilderAPI_MakeEdge(V(Math.min(a, b)) as never, V(Math.max(a, b)) as never);
      e = mk.Edge();
      keep.push(mk);
      edge.set(key, e);
    }
    return e;
  };
  const builder = new oc.TopoDS_Builder();
  const shell = new oc.TopoDS_Shell();
  builder.MakeShell(shell);
  try {
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      const [a, b, c] = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
      const wire = new oc.BRepBuilderAPI_MakeWire(E(a, b) as never, E(b, c) as never, E(c, a) as never);
      if (!wire.IsDone()) {
        wire.delete();
        continue;
      }
      const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true);
      // La primera arista se creó de menor a mayor índice y el contorno sigue su sentido: si eso
      // invierte el giro del triángulo (a > b), la cara se da vuelta para que mire hacia afuera.
      if (face.IsDone()) builder.Add(shell, a < b ? face.Face() : face.Face().Reversed());
      face.delete();
      wire.delete();
    }
    let result: AnyShape = cast(shell);
    // Pocas caras: se unifican las coplanares (booleanas más limpias). Con muchas, no vale la pena.
    if (mesh.triangles.length / 3 <= UNIFY_MAX_TRIANGLES) {
      const unify = new oc.ShapeUpgrade_UnifySameDomain(shell, true, true, false);
      unify.Build();
      result = cast(unify.Shape());
      unify.delete();
    }
    if (checkWatertight(mesh).boundaryEdges > 0) return result; // malla abierta: solo referencia
    const exp = new oc.TopExp_Explorer(result.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    const maker = new oc.BRepBuilderAPI_MakeSolid();
    try {
      for (; exp.More(); exp.Next()) maker.Add(oc.TopoDS.Shell(exp.Current()));
      const solid = oc.TopoDS.Solid(maker.Solid());
      oc.BRepLib.OrientClosedSolid(solid);
      const shape = cast(solid);
      if (shape.solids.length > 0 && volume(shape) > 0) return shape;
      shape.delete();
    } catch {
      // sigue como superficie
    } finally {
      exp.delete();
      maker.delete();
    }
    return result;
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw new FeatureError(`No se pudo leer el archivo STL (${describeError(err)})`);
  } finally {
    keep.forEach((k) => k.delete());
    builder.delete();
  }
}

/** Copia ubicada: escala, giro en X, luego Y, luego Z (grados, alrededor del origen), y traslado. */
export function placeImport(f: ImportFeature, raw: AnyShape): AnyShape {
  if (!(f.scale > 0)) throw new FeatureError(`La escala debe ser mayor que 0 (es ${f.scale})`);
  let s = raw.clone();
  if (f.scale !== 1) s = s.scale(f.scale, [0, 0, 0]);
  if (f.rotation[0]) s = s.rotate(f.rotation[0], [0, 0, 0], [1, 0, 0]);
  if (f.rotation[1]) s = s.rotate(f.rotation[1], [0, 0, 0], [0, 1, 0]);
  if (f.rotation[2]) s = s.rotate(f.rotation[2], [0, 0, 0], [0, 0, 1]);
  if (f.position.some((v) => v !== 0)) s = s.translate(f.position[0], f.position[1], f.position[2]);
  return s;
}

/** Cuerpo importado y ubicado, con un nombre por cara (`<feature>:import:<n>`). */
export function importedBody(f: ImportFeature): NamedShape {
  const shape = placeImport(f, readImport(f.format, f.data));
  const nb = new NameBuilder(shape);
  shape.faces.forEach((face, i) => nb.add(face.wrapped, `${f.id}:import:${i}`));
  return nb.finish(f.id);
}

/**
 * Aplica la importación. Con 'reference' el sólido no cambia y el cuerpo se devuelve aparte
 * (se muestra translúcido y no se exporta).
 */
export function runImport(f: ImportFeature, input: NamedShape | null): { output: NamedShape | null; reference?: NamedShape } {
  const body = importedBody(f);
  if (f.operation === 'reference') return { output: input, reference: body };
  if (body.shape.solids.length === 0) {
    body.shape.delete();
    throw new FeatureError('El archivo no forma un sólido cerrado: solo se puede usar como referencia');
  }
  return { output: combine(f.operation, input, body, f.id) };
}
