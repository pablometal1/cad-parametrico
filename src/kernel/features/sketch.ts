// Feature de sketch en el kernel: resuelve las restricciones y construye las caras de sus perfiles.
import { assembleWire, makeCircle, makeFace, makeLine, makeThreePointArc, type AnyShape, type Edge, type Face } from 'replicad';
import { basePlaneFrame, faceFrame, scale, toPlane, toWorld, type PlaneFrame } from '../../document/planes';
import type { SketchData, SketchFeature } from '../../document/types';
import { arcParams, curveDistance } from '../../sketch/geometry';
import { SketchIndex } from '../../sketch/model';
import { findProfiles, ProfileError, type ProfileLoop, type ProfileRegion } from '../../sketch/profiles';
import { solveSketch } from '../../sketch/solver';
import { resolveFace, type History, type NameBuilder, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';

/** Resultado de evaluar un sketch: lo que necesitan las features que lo usan. */
export interface EvaluatedSketch {
  frame: PlaneFrame;
  data: SketchData;
  regions: ProfileRegion[];
  openChains: number;
  dof: number;
  /** Contorno de la cara de apoyo en coordenadas del sketch (pares u,v por segmento). */
  reference: number[];
}

export function evaluateSketch(feature: SketchFeature, input: NamedShape | null): EvaluatedSketch {
  const { frame, reference } = sketchFrame(feature, input);
  let solved;
  try {
    solved = solveSketch(feature);
  } catch (err) {
    throw new FeatureError((err as Error).message);
  }
  if (!solved.ok) {
    const detail = solved.conflicting.length ? `: en conflicto ${solved.conflicting.join(', ')}` : '';
    throw new FeatureError(`Las restricciones no tienen solución${detail}`);
  }
  if (solved.conflicting.length) {
    throw new FeatureError(`Restricciones en conflicto: ${solved.conflicting.join(', ')}`);
  }
  let analysis;
  try {
    analysis = findProfiles(solved.data);
  } catch (err) {
    if (err instanceof ProfileError) throw new FeatureError(err.message);
    throw err;
  }
  return {
    frame,
    reference,
    data: solved.data,
    regions: analysis.regions,
    openChains: analysis.openChains,
    dof: solved.dof,
  };
}

/** Plano del sketch: base, o la cara plana referenciada del sólido de entrada. */
function sketchFrame(feature: SketchFeature, input: NamedShape | null): { frame: PlaneFrame; reference: number[] } {
  const plane = feature.plane;
  if (plane.kind === 'base') return { frame: basePlaneFrame(plane), reference: [] };
  if (!input) throw new FeatureError('No hay un sólido donde apoyar el sketch');
  const face = input.shape.faces[resolveFace(input, plane.face)];
  if (face.geomType !== 'PLANE') throw new FeatureError('La cara de apoyo del sketch ya no es plana');
  const c = face.center;
  const frame = faceFrame(c.toTuple(), face.normalAt(c).toTuple(), plane.offset);
  return { frame, reference: outline(face, frame) };
}

/** Bordes de una cara proyectados al plano del sketch, como segmentos (u1,v1,u2,v2,…). */
function outline(face: Face, frame: PlaneFrame): number[] {
  const out: number[] = [];
  for (const e of face.edges) {
    const n = e.geomType === 'LINE' ? 1 : 32;
    let prev = toPlane(frame, e.pointAt(0).toTuple());
    for (let i = 1; i <= n; i++) {
      const p = toPlane(frame, e.pointAt(i / n).toTuple());
      out.push(prev[0], prev[1], p[0], p[1]);
      prev = p;
    }
  }
  return out;
}

/**
 * Nombra las caras laterales de un barrido (prisma o revolución) según la curva del sketch
 * que generó cada arista del perfil: `<feature>:side:<curva>`.
 */
export function nameSweep(nb: NameBuilder, history: History, s: EvaluatedSketch, profile: AnyShape, featureId: string) {
  const index = new SketchIndex(s.data);
  const curves = index.curves().filter((c) => !c.construction);
  for (const edge of profile.edges) {
    const [u, v] = toPlane(s.frame, edge.pointAt(0.5).toTuple());
    let best: { id: string; d: number } | null = null;
    for (const c of curves) {
      const d = curveDistance(index, c, [u, v]);
      if (!best || d < best.d) best = { id: c.id, d };
    }
    if (best && best.d < 1e-4) nb.generated(history, edge.wrapped, `${featureId}:side:${best.id}`);
  }
}

/** Texto informativo para el historial. */
export function describeSketch(s: EvaluatedSketch): string {
  if (s.data.entities.length === 0) return 'Vacío';
  const def = s.dof === 0 ? 'Totalmente definido' : `${s.dof} grado${s.dof === 1 ? '' : 's'} de libertad`;
  const profiles = s.regions.length === 1 ? '1 perfil' : `${s.regions.length} perfiles`;
  const open = s.openChains > 0 ? ` · ${s.openChains} abierto${s.openChains === 1 ? '' : 's'}` : '';
  return `${def} · ${profiles}${open}`;
}

/**
 * Construye las caras planas de todas las regiones, desplazadas `offset` mm sobre la normal.
 * El llamador es dueño de las caras devueltas.
 */
export function buildSketchFaces(s: EvaluatedSketch, offset = 0): Face[] {
  const frame: PlaneFrame = { ...s.frame, origin: s.frame.origin.map((v, i) => v + s.frame.normal[i] * offset) as PlaneFrame['origin'] };
  const index = new SketchIndex(s.data);
  const faces: Face[] = [];
  for (const region of s.regions) {
    const outer = buildWire(index, frame, region.outer);
    const holes = region.holes.map((h) => buildWire(index, frame, h));
    let face: Face;
    try {
      face = makeFace(outer, holes);
    } catch {
      throw new FeatureError('No se pudo construir la cara de un perfil del sketch');
    } finally {
      outer.delete();
      holes.forEach((h) => h.delete());
    }
    if (!isValidShape(face)) {
      face.delete();
      throw new FeatureError('Un perfil del sketch se cruza consigo mismo o con otro perfil');
    }
    faces.push(face);
  }
  return faces;
}

function buildWire(index: SketchIndex, frame: PlaneFrame, loop: ProfileLoop) {
  const P = (id: string) => {
    const [u, v] = index.point(id);
    return toWorld(frame, u, v);
  };
  const edges: Edge[] = loop.edges.map(({ curve, reversed }) => {
    switch (curve.type) {
      case 'line':
        return reversed ? makeLine(P(curve.p2), P(curve.p1)) : makeLine(P(curve.p1), P(curve.p2));
      case 'circle': {
        const [cu, cv] = index.point(curve.center);
        // Un círculo de agujero se recorre en sentido horario: normal invertida.
        const isHole = loop.area < 0;
        return makeCircle(curve.radius, toWorld(frame, cu, cv), isHole ? scale(frame.normal, -1) : frame.normal);
      }
      case 'arc': {
        const ap = arcParams(index, curve);
        const mid = (ap.startAngle + ap.endAngle) / 2;
        const m = toWorld(frame, ap.center[0] + ap.radius * Math.cos(mid), ap.center[1] + ap.radius * Math.sin(mid));
        return reversed ? makeThreePointArc(P(curve.end), m, P(curve.start)) : makeThreePointArc(P(curve.start), m, P(curve.end));
      }
    }
  });
  try {
    return assembleWire(edges);
  } catch (err) {
    throw new FeatureError(`El contorno del sketch no forma un wire cerrado (${(err as Error).message})`);
  } finally {
    edges.forEach((e) => e.delete());
  }
}
