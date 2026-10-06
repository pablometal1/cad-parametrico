// Combinación del cuerpo de una feature (herramienta) con el sólido previo, propagando nombres.
import { cast, getOC, makeCompound, type Face } from 'replicad';
import type { BooleanOperation } from '../../document/types';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';
import { volume } from './measure';

/**
 * Aplica la operación. Toma posesión de `tool` (lo libera); no modifica `input`.
 * Devuelve un sólido nuevo, propiedad del llamador.
 */
export function combine(op: BooleanOperation, input: NamedShape | null, tool: NamedShape, featureId: string): NamedShape {
  if (op === 'new') {
    if (!input) return tool;
    // Nuevo cuerpo junto al anterior: compound de ambos (las caras no cambian).
    const compound = makeCompound([input.shape.clone(), tool.shape.clone()]);
    const nb = new NameBuilder(compound);
    nb.carry(input, null);
    nb.carry(tool, null);
    tool.shape.delete();
    return nb.finish(featureId);
  }
  if (!input) {
    tool.shape.delete();
    throw new FeatureError(`No hay un sólido previo para ${op === 'join' ? 'unir' : 'cortar'}`);
  }

  const oc = getOC();
  const range = new oc.Message_ProgressRange();
  const algo = op === 'join'
    ? new oc.BRepAlgoAPI_Fuse(input.shape.wrapped, tool.shape.wrapped, range)
    : new oc.BRepAlgoAPI_Cut(input.shape.wrapped, tool.shape.wrapped, range);
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
    if (op === 'cut' && Math.abs(volume(input.shape) - volume(result)) <= 1e-9 * Math.max(1, volume(input.shape))) {
      // No es error para OCCT, pero casi siempre indica un corte que no toca el sólido.
      result.delete();
      throw new FeatureError('El corte no intersecta el sólido');
    }
    const history = historyOf(algo);
    const nb = new NameBuilder(result);
    nb.carry(input, history);
    nb.carry(tool, history);
    return nb.finish(featureId);
  } finally {
    algo.delete();
    range.delete();
    tool.shape.delete();
  }
}

/**
 * Barre las caras de un sketch. Si las regiones se superponen, barre cada una por separado y
 * une los cuerpos (así un círculo que cruza un rectángulo suma su área en lugar de dar error).
 */
export function sweepRegions(faces: Face[], overlapping: boolean, sweep: (group: Face[]) => NamedShape, featureId: string): NamedShape {
  if (!overlapping || faces.length < 2) return sweep(faces);
  const parts = faces.map((f) => sweep([f]));
  let acc = parts[0];
  for (const p of parts.slice(1)) {
    const next = combine('join', acc, p, featureId);
    acc.shape.delete();
    acc = next;
  }
  return acc;
}
