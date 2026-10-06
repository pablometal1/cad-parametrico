// Agujero: un sólido de revolución por cada centro del sketch, restado del sólido.
import { assembleWire, cast, getOC, makeFace, makeLine, type Edge } from 'replicad';
import { holeCenters, holeProblem } from '../../document/holes';
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
  const profile = holeProfile(feature, feature.extent === 'through' ? through : feature.depth);

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
    }
    return acc;
  } catch (err) {
    if (acc !== input) acc.shape.delete();
    throw err;
  }
}

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
