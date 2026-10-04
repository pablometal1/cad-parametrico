// Feature de extrusión: prisma de los perfiles del sketch y operación booleana con el sólido previo.
import { cast, getOC, makeCompound } from 'replicad';
import type { ExtrudeFeature } from '../../document/types';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { FeatureError } from '../occtUtils';
import { combine } from './boolean';
import { buildSketchFaces, nameSweep, type EvaluatedSketch } from './sketch';

export { volume } from './measure';

/**
 * Extruye todos los perfiles cerrados del sketch y los combina con `input`.
 * No modifica `input`; devuelve un sólido nuevo propiedad del llamador.
 */
export function runExtrude(feature: ExtrudeFeature, sketch: EvaluatedSketch, input: NamedShape | null): NamedShape {
  const oc = getOC();
  const d = feature.distance;
  if (!(d > 0)) throw new FeatureError(`La distancia debe ser mayor que 0 (es ${d})`);
  if (feature.operation !== 'new' && !input) {
    throw new FeatureError(`No hay un sólido previo para ${feature.operation === 'join' ? 'unir' : 'cortar'}`);
  }
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

  // Varias regiones se extruyen juntas como un compound de caras.
  const profile = faces.length === 1 ? faces[0] : makeCompound(faces);
  const prism = new oc.BRepPrimAPI_MakePrism(profile.wrapped, vec, false, true);
  let tool: NamedShape;
  try {
    if (!prism.IsDone()) throw new FeatureError('No se pudo extruir el perfil');
    const shape = cast(prism.Shape());
    const nb = new NameBuilder(shape);
    nameSweep(nb, historyOf(prism), sketch, profile, feature.id);
    nb.addAll(cast(prism.FirstShape()), `${feature.id}:start`);
    nb.addAll(cast(prism.LastShape()), `${feature.id}:end`);
    tool = nb.finish(feature.id);
  } finally {
    prism.delete();
    vec.delete();
    profile.delete();
  }
  return combine(feature.operation, input, tool, feature.id);
}
