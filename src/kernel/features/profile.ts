// Construcción del perfil provisorio (fase 2) como cara plana de OCCT.
import { drawCircle, drawRectangle, Sketch, type Face, type Vector } from 'replicad';
import type { Profile } from '../../document/types';
import { FeatureError } from '../occtUtils';

export interface ProfileFace {
  face: Face;
  /** Normal unitaria del plano del perfil (dirección "normal" de extrusión). */
  normal: Vector;
}

/**
 * Crea la cara del perfil desplazada `extraOffset` mm sobre la normal del plano
 * (se usa para la extrusión simétrica).
 */
export function buildProfileFace(profile: Profile, extraOffset = 0): ProfileFace {
  const drawing = (() => {
    switch (profile.kind) {
      case 'rectangle':
        if (!(profile.width > 0)) throw new FeatureError(`El ancho del rectángulo debe ser mayor que 0 (es ${profile.width})`);
        if (!(profile.height > 0)) throw new FeatureError(`El alto del rectángulo debe ser mayor que 0 (es ${profile.height})`);
        return drawRectangle(profile.width, profile.height);
      case 'circle':
        if (!(profile.radius > 0)) throw new FeatureError(`El radio del círculo debe ser mayor que 0 (es ${profile.radius})`);
        return drawCircle(profile.radius);
    }
  })().translate(profile.center[0], profile.center[1]);

  const sketch = drawing.sketchOnPlane(profile.plane, profile.offset + extraOffset);
  if (!(sketch instanceof Sketch)) {
    throw new FeatureError('El perfil no generó un contorno cerrado único');
  }
  const normal = sketch.defaultDirection.normalized();
  const face = sketch.face();
  sketch.delete();
  return { face, normal };
}
