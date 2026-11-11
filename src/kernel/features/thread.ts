// Roscas modeladas: un surco de perfil triangular (60°) barrido por una hélice y restado del sólido.
import { assembleWire, cast, getOC, makeHelix, makeLine, type AnyShape, type Face } from 'replicad';
import { cross, dot, normalize, sub, type Vec3 } from '../../document/planes';
import type { ThreadFeature } from '../../document/types';
import { matchThreadSize, THREAD_SIZES, threadFaceDiameter, threadNominal } from '../../document/holes';
import { resolveFace, type NamedShape } from '../naming';
import { describeError, FeatureError, isValidShape } from '../occtUtils';
import { combine } from './boolean';
import { NameBuilder } from '../naming';

/** Profundidad de rosca ISO: interna (D − D1)/2 = 1,0825·P/2; externa (d − d3)/2 = 0,6134·P. */
export const INTERNAL_DEPTH = 1.0825 / 2;
export const EXTERNAL_DEPTH = 0.6134;
/** El surco arranca apenas dentro del vacío (o del aire) para no dejar caras tangentes. */
const OVERLAP = 0.05;

/**
 * Surco helicoidal alrededor de un eje: triángulo de 60° con la base en el radio `rb` y la punta
 * en `ra` (hacia afuera en roscas internas, hacia adentro en externas), entre `z0` y `z1`
 * (coordenadas sobre el eje desde `origin`). Rosca derecha.
 */
export function threadGroove(origin: Vec3, axis: Vec3, rb: number, ra: number, pitch: number, z0: number, z1: number): AnyShape {
  const oc = getOC();
  const half = Math.abs(ra - rb) * Math.tan(Math.PI / 6);
  const height = z1 - z0 - 2 * half;
  if (!(height > 1e-6)) throw new FeatureError('El tramo a roscar es más corto que un hilo');
  const a = normalize(axis);
  const start: Vec3 = [0, 1, 2].map((i) => origin[i] + a[i] * (z0 + half)) as Vec3;
  const helix = makeHelix(pitch, height, rb, start, a);
  // Plano del perfil: el que contiene al eje y al punto inicial de la hélice.
  const s = helix.startPoint.toTuple() as Vec3;
  const rel = sub(s, start);
  const radial = normalize(sub(rel, [0, 1, 2].map((i) => a[i] * dot(rel, a)) as Vec3));
  const P = (r: number, z: number): Vec3 => [0, 1, 2].map((i) => start[i] + radial[i] * r + a[i] * z) as Vec3;
  const edges = [makeLine(P(rb, -half), P(ra, 0)), makeLine(P(ra, 0), P(rb, half)), makeLine(P(rb, half), P(rb, -half))];
  const profile = assembleWire(edges);
  edges.forEach((e) => e.delete());
  const dir = new oc.gp_Dir(...a);
  const pipe = new oc.BRepOffsetAPI_MakePipeShell(helix.wrapped);
  const range = new oc.Message_ProgressRange();
  try {
    // Modo binormal: el perfil se mantiene en un plano que contiene al eje (no se tuerce).
    pipe.SetMode(dir);
    pipe.Add(profile.wrapped, false, false);
    pipe.Build(range);
    if (!pipe.IsDone() || !pipe.MakeSolid()) throw new FeatureError('No se pudo construir la rosca');
    const groove = cast(pipe.Shape());
    if (groove.solids.length === 0 || !isValidShape(groove)) {
      groove.delete();
      throw new FeatureError('La rosca salió inválida: probá con otro paso o diámetro');
    }
    return groove;
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw new FeatureError(`No se pudo construir la rosca (${describeError(err)})`);
  } finally {
    pipe.delete();
    range.delete();
    dir.delete();
    profile.delete();
    helix.delete();
  }
}

/** Resta un surco de rosca de un sólido, nombrando sus caras `<feature>:thread`. Toma posesión del surco. */
export function cutThread(input: NamedShape, groove: AnyShape, featureId: string, label = 'thread'): NamedShape {
  const nb = new NameBuilder(groove);
  nb.addAll(groove, `${featureId}:${label}`);
  return combine('cut', input, nb.finish(featureId), featureId);
}

/** Eje y radio de una cara cilíndrica. `internal`: es un agujero (las normales miran al eje). */
export function cylinderOf(face: Face): { point: Vec3; axis: Vec3; radius: number; internal: boolean; z0: number; z1: number } {
  if (face.geomType !== 'CYLINDRE') throw new FeatureError('La cara elegida no es cilíndrica');
  const sample = (u: number) => {
    const p = face.pointOnSurface(u, 0.5);
    const n = normalize(face.normalAt(p).toTuple() as Vec3);
    return { p: p.toTuple() as Vec3, n };
  };
  const s1 = sample(0.1);
  const s2 = sample(0.37);
  const s3 = sample(0.71);
  const axis = normalize(cross(s1.n, s2.n));
  const perp = (v: Vec3): Vec3 => sub(v, [0, 1, 2].map((i) => axis[i] * dot(v, axis)) as Vec3);
  const q1 = perp(s1.p);
  const q2 = perp(s2.p);
  const dn = sub(s1.n, s2.n);
  // p − R·n está sobre el eje: R > 0 si las normales salen del eje (barra), R < 0 si miran a él (agujero).
  const R = dot(sub(q1, q2), dn) / dot(dn, dn);
  const point: Vec3 = [0, 1, 2].map((i) => s1.p[i] - R * s1.n[i]) as Vec3;
  const dist3 = Math.hypot(...perp(sub(s3.p, point)));
  if (!(Math.abs(R) > 1e-6) || Math.abs(dist3 - Math.abs(R)) > 1e-4 * Math.max(1, Math.abs(R))) {
    throw new FeatureError('No se pudo reconocer el cilindro de la cara');
  }
  // Extensión de la cara sobre el eje.
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const e of face.edges) {
    for (let k = 0; k <= 8; k++) {
      const z = dot(sub(e.pointAt(k / 8).toTuple() as Vec3, point), axis);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
  }
  return { point, axis, radius: Math.abs(R), internal: R < 0, z0, z1 };
}

/** Datos de la cara a roscar (para describir la rosca y elegir su tipo): interna o externa y diámetro. */
export function threadFace(feature: ThreadFeature, input: NamedShape): { internal: boolean; diameter: number } {
  const c = cylinderOf(input.shape.faces[resolveFace(input, feature.face)]);
  return { internal: c.internal, diameter: 2 * c.radius };
}

/** Texto para el historial y aviso si el diámetro de la cara no da una medida estándar con ese paso. */
export function describeThread(t: { internal: boolean; diameter: number }, pitch: number): { info: string; warning?: string } {
  const f = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
  const nominal = threadNominal(t.internal, t.diameter, pitch);
  const where = t.internal ? `Interna · agujero Ø${f(t.diameter)}` : `Externa · barra Ø${f(t.diameter)}`;
  const size = matchThreadSize(nominal, pitch);
  if (size) return { info: `${where} · ${size.name}` };
  // La medida estándar más cercana con ese paso, para decir cuánto tendría que medir la cara.
  const near = THREAD_SIZES.filter((s) => Math.abs(s.pitch - pitch) < 1e-9).sort((a, b) => Math.abs(a.nominal - nominal) - Math.abs(b.nominal - nominal))[0];
  const info = `${where} · Ø${f(nominal)} × ${f(pitch)} (no estándar)`;
  if (!near) return { info };
  const what = t.internal ? 'el agujero' : 'la barra';
  return {
    info,
    warning: `No es una medida estándar: para ${near.name}, ${what} tiene que medir ${f(threadFaceDiameter(t.internal, near))} mm (mide ${f(t.diameter)})`,
  };
}

/** Rosca sobre una cara cilíndrica (interna si es un agujero, externa si es una barra). */
export function runThread(feature: ThreadFeature, input: NamedShape | null): NamedShape {
  if (!input) throw new FeatureError('No hay un sólido para roscar');
  if (!(feature.pitch > 0)) throw new FeatureError(`El paso debe ser mayor que 0 (es ${feature.pitch})`);
  if (!(feature.clearance >= 0)) throw new FeatureError('La holgura no puede ser negativa');
  const face = input.shape.faces[resolveFace(input, feature.face)];
  const c = cylinderOf(face);
  const P = feature.pitch;
  let rb: number;
  let ra: number;
  if (c.internal) {
    // El agujero existente es el diámetro menor; el surco llega al mayor (más la holgura).
    rb = c.radius - OVERLAP;
    ra = c.radius + INTERNAL_DEPTH * P + feature.clearance / 2;
  } else {
    // La barra es el diámetro mayor; el surco baja hasta el menor (más la holgura).
    rb = c.radius + OVERLAP;
    ra = c.radius - EXTERNAL_DEPTH * P - feature.clearance / 2;
    if (!(ra > 0)) throw new FeatureError('El paso es demasiado grande para este diámetro');
  }
  let z0 = c.z0;
  let z1 = c.z1;
  if (feature.length > 0 && feature.length < z1 - z0) {
    if (feature.fromStart) z1 = z0 + feature.length;
    else z0 = z1 - feature.length;
  }
  // cutThread se queda con el surco (la booleana lo libera).
  return cutThread(input, threadGroove(c.point, c.axis, rb, ra, P, z0, z1), feature.id);
}

