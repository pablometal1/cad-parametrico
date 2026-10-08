// Agujero: un sólido de revolución por cada centro del sketch, restado del sólido.
import { assembleWire, cast, getOC, makeFace, makeLine, type Edge } from 'replicad';
import { holeCenters, holeProblem, threadBore } from '../../document/holes';
import { cutThread, INTERNAL_DEPTH, threadGroove } from './thread';
import { toWorld, type Vec3 } from '../../document/planes';
import type { HoleFeature } from '../../document/types';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { describeError, FeatureError } from '../occtUtils';
import { combine } from './boolean';
import type { EvaluatedSketch } from './sketch';

/**
 * Cuánto sobresale la herramienta por encima del plano del sketch. Cero: si sobresaliera, cortaría
 * material cuando el sketch está dentro de la pieza o la dirección está al revés.
 */
const ABOVE = 0;
/** Ángulo de la punta de una mecha estándar. */
const DRILL_ANGLE = 118;

type ProfilePoint = { r: number; z: number; next: string | null };

export function runHole(feature: HoleFeature, sketch: EvaluatedSketch, input: NamedShape | null): NamedShape {
  if (!input) throw new FeatureError('No hay un sólido para agujerear');
  const problem = holeProblem(feature);
  if (problem) throw new FeatureError(problem);
  const centers = holeCenters(sketch.data);
  if (centers.length === 0) {
    throw new FeatureError('El sketch no tiene centros de agujero: dibujá puntos (herramienta Punto, O) o círculos');
  }

  // Hacia adentro del material: contra la normal del sketch (o a favor si está invertido).
  const n = sketch.frame.normal;
  const out: Vec3 = feature.reversed ? [-n[0], -n[1], -n[2]] : n;
  const [min, max] = input.shape.boundingBox.bounds;
  const through = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 2 + 10;
  // Con rosca se perfora al diámetro menor (más la holgura).
  const bore = feature.thread ? threadBore(feature.diameter, feature.threadPitch, feature.threadClearance) : feature.diameter;
  const profile = holeProfile({ ...feature, diameter: bore }, feature.extent === 'through' ? through : feature.depth);
  // Hasta dónde llega el material en la dirección del agujero (para no roscar kilómetros de aire).
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);

  let acc: NamedShape = input;
  try {
    for (const c of centers) {
      const tool = buildHoleTool(profile, toWorld(sketch.frame, c.pos[0], c.pos[1]), sketch.frame.xDir, out, `${feature.id}`, c.id);
      let next: NamedShape;
      try {
        next = combine('cut', acc, tool, feature.id);
      } catch (err) {
        const msg = (err as Error).message;
        if (/no intersecta/.test(msg)) {
          throw new FeatureError(`El agujero en el punto ${c.id} no toca el sólido: revisá la posición o usá "Invertir dirección"`);
        }
        throw err;
      }
      if (acc !== input) acc.shape.delete();
      acc = next;
      if (feature.thread) {
        const C = toWorld(sketch.frame, c.pos[0], c.pos[1]);
        const P = feature.threadPitch;
        const top = -wallTop(feature, bore);
        // Dónde hay material a lo largo del eje: lo marcan las paredes recién perforadas de este
        // agujero. Un surco mucho más largo que el material (atravesando aire) hace que la booleana
        // de OCCT falle sin avisar.
        const along = (p: number[]) => (p[0] - C[0]) * out[0] + (p[1] - C[1]) * out[1] + (p[2] - C[2]) * out[2];
        const wallName = `${feature.id}:wall:${c.id}`;
        let zLow = Infinity;
        acc.shape.faces.forEach((f, i) => {
          if (!acc.names[i]?.includes(wallName)) return;
          for (const e of f.edges) for (let t = 0; t <= 4; t++) zLow = Math.min(zLow, along(e.pointAt(t / 4).toTuple()));
        });
        const materialDepth = Number.isFinite(zLow)
          ? -zLow
          : Math.max(...corners.map((k) => -along(k)));
        const bottom = feature.extent === 'through' ? -(materialDepth + P / 2) : -feature.depth;
        if (!(top - bottom > P)) throw new FeatureError('El tramo para la rosca es más corto que un hilo');
        const groove = threadGroove(C, out, bore / 2 - 0.05, feature.diameter / 2 + feature.threadClearance / 2, P, bottom, top);
        const threaded = cutThread(acc, groove, feature.id, `thread:${c.id}`);
        acc.shape.delete();
        acc = threaded;
      }
    }
    return acc;
  } catch (err) {
    if (acc !== input) acc.shape.delete();
    throw err;
  }
}

/** Profundidad donde empieza la pared recta (debajo del cajeado o del avellanado). */
function wallTop(f: HoleFeature, bore: number): number {
  if (f.kind === 'counterbore') return f.cbDepth;
  if (f.kind === 'countersink') return (f.csDiameter - bore) / 2 / Math.tan((f.csAngle * Math.PI) / 360);
  return 0;
}

/** Profundidad radial del hilo interno (para mensajes y tests). */
export const threadDepth = (pitch: number) => INTERNAL_DEPTH * pitch;

/**
 * Perfil del agujero en coordenadas (r, z): r desde el eje, z hacia afuera del material
 * (0 = plano del sketch). Cada punto lleva el nombre de la cara que genera el tramo hasta el siguiente.
 */
export function holeProfile(f: HoleFeature, depth: number): ProfilePoint[] {
  const r = f.diameter / 2;
  const pts: ProfilePoint[] = [{ r: 0, z: ABOVE, next: null }];
  if (f.kind === 'counterbore') {
    const R = f.cbDiameter / 2;
    pts.push({ r: R, z: ABOVE, next: 'cbwall' }, { r: R, z: -f.cbDepth, next: 'cbfloor' }, { r, z: -f.cbDepth, next: 'wall' });
  } else if (f.kind === 'countersink') {
    const R = f.csDiameter / 2;
    const coneDepth = (R - r) / Math.tan((f.csAngle * Math.PI) / 360);
    pts.push({ r: R, z: ABOVE, next: 'csrim' }, { r: R, z: 0, next: 'cone' }, { r, z: -coneDepth, next: 'wall' });
  } else {
    pts.push({ r, z: ABOVE, next: 'wall' });
  }
  // El primer tramo (tapa de arriba, fuera del material) no se nombra: no queda en el resultado.
  pts[0].next = 'top';
  const drill = f.extent === 'distance' && f.tip === 'drill';
  pts.push({ r, z: -depth, next: drill ? 'tip' : 'floor' });
  pts.push({ r: 0, z: drill ? -depth - r / Math.tan((DRILL_ANGLE * Math.PI) / 360) : -depth, next: null });
  return pts;
}

function buildHoleTool(profile: ProfilePoint[], center: Vec3, xDir: Vec3, axis: Vec3, featureId: string, pointId: string): NamedShape {
  const oc = getOC();
  const P = (p: ProfilePoint): Vec3 => [0, 1, 2].map((i) => center[i] + xDir[i] * p.r + axis[i] * p.z) as Vec3;
  const edges: { edge: Edge; name: string | null }[] = [];
  for (let i = 0; i < profile.length; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % profile.length];
    if (Math.hypot(a.r - b.r, a.z - b.z) < 1e-9) continue;
    edges.push({ edge: makeLine(P(a), P(b)), name: a.next });
  }
  const wire = assembleWire(edges.map((e) => e.edge));
  const face = makeFace(wire);
  wire.delete();
  const pnt = new oc.gp_Pnt(...center);
  const dir = new oc.gp_Dir(...axis);
  const ax = new oc.gp_Ax1(pnt, dir);
  const revol = new oc.BRepPrimAPI_MakeRevol(face.wrapped, ax, Math.PI * 2, false);
  try {
    if (!revol.IsDone()) throw new FeatureError('No se pudo construir el agujero');
    const shape = cast(revol.Shape());
    const nb = new NameBuilder(shape);
    const history = historyOf(revol);
    // Las aristas de la cara de perfil (no las del wire original) son las que conoce la revolución.
    for (const fe of face.edges) {
      const m = fe.pointAt(0.5).toTuple();
      const match = edges.find((e) => {
        const q = e.edge.pointAt(0.5).toTuple();
        return Math.hypot(m[0] - q[0], m[1] - q[1], m[2] - q[2]) < 1e-7;
      });
      if (match?.name && match.name !== 'top') nb.generated(history, fe.wrapped, `${featureId}:${match.name}:${pointId}`);
    }
    return nb.finish(featureId);
  } catch (err) {
    if (err instanceof FeatureError) throw err;
    throw new FeatureError(`No se pudo construir el agujero (${describeError(err)})`);
  } finally {
    revol.delete();
    ax.delete();
    dir.delete();
    pnt.delete();
    face.delete();
    edges.forEach((e) => e.edge.delete());
  }
}
