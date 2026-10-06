// Planos de construcción: sistemas de coordenadas para apoyar sketches (no tocan el sólido).
import { basePlaneFrame, constructionFrame, faceFrame, type PlaneFrame } from '../../document/planes';
import type { FeatureId, PlaneFeature } from '../../document/types';
import { resolveFace, type NamedShape } from '../naming';
import { FeatureError } from '../occtUtils';

export function evaluatePlane(feature: PlaneFeature, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame>): PlaneFrame {
  if (!Number.isFinite(feature.angle)) throw new FeatureError('El ángulo no es un número válido');
  if (!Number.isFinite(feature.distance)) throw new FeatureError('La distancia no es un número válido');
  return constructionFrame(referenceFrame(feature, input, planes), feature.axis, feature.angle, feature.distance);
}

function referenceFrame(feature: PlaneFeature, input: NamedShape | null, planes: ReadonlyMap<FeatureId, PlaneFrame>): PlaneFrame {
  const ref = feature.reference;
  switch (ref.kind) {
    case 'base':
      return basePlaneFrame({ kind: 'base', plane: ref.plane, offset: 0 });
    case 'plane': {
      if (ref.plane === feature.id) throw new FeatureError('Un plano no puede usarse a sí mismo como referencia');
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
  if (f.axis !== 'none' && f.angle !== 0) parts.push(`girado ${round(f.angle)}° en ${f.axis}`);
  if (f.distance !== 0) parts.push(`a ${round(f.distance)} mm`);
  return parts.length ? parts.join(' · ') : 'Igual a la referencia';
}

const round = (v: number) => String(Math.round(v * 1000) / 1000);
