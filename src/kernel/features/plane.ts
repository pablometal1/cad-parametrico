// Planos de construcción: sistemas de coordenadas para apoyar sketches (no tocan el sólido).
import { basePlaneFrame, constructionFrame, faceFrame, type PlaneFrame, type Vec3 } from '../../document/planes';
import type { FeatureId, PlaneFeature, PlaneReference } from '../../document/types';
import { resolveEdge, resolveFace, type NamedShape } from '../naming';
import { FeatureError } from '../occtUtils';

export function evaluatePlane(feature: PlaneFeature, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame>): PlaneFrame {
  if (!Number.isFinite(feature.angle)) throw new FeatureError('El ángulo no es un número válido');
  if (!Number.isFinite(feature.distance)) throw new FeatureError('La distancia no es un número válido');
  return constructionFrame(referenceFrame(feature.reference, input, planes, feature.id), axisOf(feature, input), feature.angle, feature.distance);
}

/** Eje de giro: global, o la recta de una arista recta del modelo. */
function axisOf(feature: PlaneFeature, input: NamedShape | null): 'none' | 'X' | 'Y' | 'Z' | { point: Vec3; dir: Vec3 } {
  if (feature.axis !== 'edge') return feature.axis;
  if (!feature.axisEdge) throw new FeatureError('Elegí la arista que hace de eje');
  if (!input) throw new FeatureError('No hay un sólido con la arista del eje');
  const edge = input.shape.edges[resolveEdge(input, feature.axisEdge)];
  if (edge.geomType !== 'LINE') throw new FeatureError('La arista del eje tiene que ser recta');
  const a = edge.pointAt(0).toTuple() as Vec3;
  const b = edge.pointAt(1).toTuple() as Vec3;
  // Sentido canónico (componente mayor positiva): la arista puede invertirse al recalcular y
  // eso no debe cambiar para qué lado gira el plano.
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const big = d.reduce((m, v, i) => (Math.abs(v) > Math.abs(d[m]) ? i : m), 0);
  return { point: a, dir: d[big] < 0 ? [-d[0], -d[1], -d[2]] : d };
}

/** Sistema de un plano de referencia: base, de construcción o cara plana del sólido. */
export function referenceFrame(
  ref: PlaneReference, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame>, selfId: FeatureId,
): PlaneFrame {
  switch (ref.kind) {
    case 'base':
      return basePlaneFrame({ kind: 'base', plane: ref.plane, offset: 0 });
    case 'plane': {
      if (ref.plane === selfId) throw new FeatureError('Un plano no puede usarse a sí mismo como referencia');
      const f = planes.get(ref.plane);
      if (!f) throw new FeatureError('El plano de referencia no está disponible (borrado, suprimido, con error o más abajo en el historial)');
      return f;
    }
    case 'face': {
      if (!input) throw new FeatureError('No hay un sólido con la cara de referencia');
      const face = input.shape.faces[resolveFace(input, ref.face)];
      if (face.geomType !== 'PLANE') throw new FeatureError('La cara de referencia ya no es plana');
      const c = face.center;
      return faceFrame(c.toTuple(), face.normalAt(c).toTuple());
    }
  }
}

/** Texto informativo para el historial. */
export function describePlane(f: PlaneFeature): string {
  const parts: string[] = [];
  if (f.axis !== 'none' && f.angle !== 0) parts.push(`girado ${round(f.angle)}° en ${f.axis === 'edge' ? 'una arista' : f.axis}`);
  if (f.distance !== 0) parts.push(`a ${round(f.distance)} mm`);
  return parts.length ? parts.join(' · ') : 'Igual a la referencia';
}

const round = (v: number) => String(Math.round(v * 1000) / 1000);
