// Feature de extrusión: prisma del perfil y operación booleana con el sólido previo.
import { cast, getOC, makeCompound, type AnyShape } from 'replicad';
import type { ExtrudeFeature } from '../../document/types';
import { FeatureError, isValidShape } from '../occtUtils';
import { buildProfileFace } from './profile';

/**
 * Ejecuta la extrusión. No modifica ni libera `input`; devuelve un sólido nuevo propiedad del llamador.
 */
export function runExtrude(feature: ExtrudeFeature, input: AnyShape | null): AnyShape {
  const oc = getOC();
  const d = feature.distance;
  if (!(d > 0)) throw new FeatureError(`La distancia debe ser mayor que 0 (es ${d})`);
  if (feature.operation !== 'new' && !input) {
    throw new FeatureError(`No hay un sólido previo para ${feature.operation === 'join' ? 'unir' : 'cortar'}`);
  }

  const start = feature.direction === 'symmetric' ? -d / 2 : 0;
  const { face, normal } = buildProfileFace(feature.profile, start);
  const sign = feature.direction === 'reversed' ? -1 : 1;
  const vec = new oc.gp_Vec(normal.x * d * sign, normal.y * d * sign, normal.z * d * sign);
  normal.delete();

  const prism = new oc.BRepPrimAPI_MakePrism(face.wrapped, vec, false, true);
  let tool: AnyShape;
  try {
    if (!prism.IsDone()) throw new FeatureError('No se pudo extruir el perfil');
    tool = cast(prism.Shape());
  } finally {
    prism.delete();
    vec.delete();
    face.delete();
  }

  if (feature.operation === 'new') {
    return input ? makeCompound([input.clone(), tool]) : tool;
  }

  const result = boolean(feature.operation, input!, tool);
  tool.delete();
  return result;
}

function boolean(op: 'join' | 'cut', input: AnyShape, tool: AnyShape): AnyShape {
  const oc = getOC();
  const range = new oc.Message_ProgressRange();
  const algo = op === 'join'
    ? new oc.BRepAlgoAPI_Fuse(input.wrapped, tool.wrapped, range)
    : new oc.BRepAlgoAPI_Cut(input.wrapped, tool.wrapped, range);
  try {
    if (!algo.IsDone() || algo.HasErrors()) {
      throw new FeatureError(op === 'join' ? 'Falló la unión con el sólido previo' : 'Falló el corte del sólido previo');
    }
    // Unifica caras coplanares y aristas colineales que deja la booleana (conserva la historia).
    algo.SimplifyResult(true, true, 1e-6);
    const result = cast(algo.Shape());
    if (result.solids.length === 0) {
      result.delete();
      throw new FeatureError(op === 'cut' ? 'El corte elimina todo el sólido' : 'La unión no produjo un sólido');
    }
    if (!isValidShape(result)) {
      result.delete();
      throw new FeatureError('El resultado de la operación booleana no es un sólido válido');
    }
    if (op === 'cut' && sameVolumeAsInput(input, result)) {
      // No es error para OCCT, pero casi siempre indica un corte que no toca el sólido.
      result.delete();
      throw new FeatureError('El corte no intersecta el sólido');
    }
    return result;
  } finally {
    algo.delete();
    range.delete();
  }
}

function sameVolumeAsInput(input: AnyShape, result: AnyShape): boolean {
  const v0 = volume(input);
  const v1 = volume(result);
  return Math.abs(v0 - v1) <= 1e-9 * Math.max(1, v0);
}

export function volume(shape: AnyShape): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(shape.wrapped, props, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}
