// Feature de sketch en el kernel: resuelve las restricciones y construye las caras de sus perfiles.
import { assembleWire, makeCircle, makeFace, makeLine, makeThreePointArc, type Edge, type Face } from 'replicad';
import { basePlaneFrame, scale, toWorld, type PlaneFrame } from '../../document/planes';
import type { SketchData, SketchFeature } from '../../document/types';
import { arcParams } from '../../sketch/geometry';
import { SketchIndex } from '../../sketch/model';
import { findProfiles, ProfileError, type ProfileLoop, type ProfileRegion } from '../../sketch/profiles';
import { solveSketch } from '../../sketch/solver';
import { FeatureError, isValidShape } from '../occtUtils';

/** Resultado de evaluar un sketch: lo que necesitan las features que lo usan. */
export interface EvaluatedSketch {
  frame: PlaneFrame;
  data: SketchData;
  regions: ProfileRegion[];
  openChains: number;
  dof: number;
}

export function evaluateSketch(feature: SketchFeature): EvaluatedSketch {
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
    frame: basePlaneFrame(feature.plane),
    data: solved.data,
    regions: analysis.regions,
    openChains: analysis.openChains,
    dof: solved.dof,
  };
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
