// Feature de extrusión: prisma de los perfiles del sketch y operación booleana con el sólido previo.
import { cast, getOC, makeCompound, type Face } from 'replicad';
import type { ExtrudeFeature } from '../../document/types';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { FeatureError } from '../occtUtils';
import { combine, sweepRegions } from './boolean';
import { buildSketchFaces, nameSweep, type EvaluatedSketch } from './sketch';

export { volume } from './measure';

/**
 * Extruye todos los perfiles cerrados del sketch y los combina con `input`.
 * No modifica `input`; devuelve un sólido nuevo propiedad del llamador.
 */
export function runExtrude(feature: ExtrudeFeature, sketch: EvaluatedSketch, input: NamedShape | null): NamedShape {
  if (feature.operation !== 'new' && !input) {
    throw new FeatureError(`No hay un sólido previo para ${feature.operation === 'join' ? 'unir' : 'cortar'}`);
  }
  return combine(feature.operation, input, buildExtrudeTool(feature, sketch), feature.id);
}

/** Cuerpo de la extrusión (el prisma), antes de combinarlo con el sólido previo. */
export function buildExtrudeTool(feature: ExtrudeFeature, sketch: EvaluatedSketch): NamedShape {
  const oc = getOC();
  const d = feature.distance;
  if (!(d > 0)) throw new FeatureError(`La distancia debe ser mayor que 0 (es ${d})`);
  if (sketch.regions.length === 0) {
    throw new FeatureError(
      sketch.openChains > 0 ? 'El sketch no tiene perfiles cerrados (hay contornos abiertos)' : 'El sketch no tiene perfiles cerrados',
    );
  }

  const start = feature.direction === 'symmetric' ? -d / 2 : 0;
  const faces = buildSketchFaces(sketch, start);
  const n = sketch.frame.normal;
  const sign = feature.direction === 'reversed' ? -1 : 1;
  const vec = new oc.gp_Vec(n[0] * d * sign, n[1] * d * sign, n[2] * d * sign);

  // Varias regiones (sin superponerse) se extruyen juntas como un compound de caras.
  const sweep = (group: Face[]): NamedShape => {
    const profile = group.length === 1 ? group[0] : makeCompound(group);
    const prism = new oc.BRepPrimAPI_MakePrism(profile.wrapped, vec, false, true);
    try {
      if (!prism.IsDone()) throw new FeatureError('No se pudo extruir el perfil');
      const shape = cast(prism.Shape());
      const nb = new NameBuilder(shape);
      nameSweep(nb, historyOf(prism), sketch, profile, feature.id);
      nb.addAll(cast(prism.FirstShape()), `${feature.id}:start`);
      nb.addAll(cast(prism.LastShape()), `${feature.id}:end`);
      return nb.finish(feature.id);
    } finally {
      prism.delete();
      profile.delete();
    }
  };
  try {
    return sweepRegions(faces, sketch.overlapping, sweep, feature.id);
  } finally {
    vec.delete();
  }
}
