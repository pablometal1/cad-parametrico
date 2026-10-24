// Combinación del cuerpo de una feature (herramienta) con el sólido previo, propagando nombres.
import { cast, getOC, makeCompound, type Face } from 'replicad';
import type { BooleanOperation } from '../../document/types';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';
import { volume } from './measure';

/** Arriba de esta cantidad de caras entre ambos cuerpos no se unifican caras tras la booleana. */
const SIMPLIFY_MAX_FACES = 2000;

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
  // Unir sin nada antes (p. ej. tras reordenar el historial) crea el cuerpo, como en Fusion.
  if (!input && op === 'join') return tool;
  if (!input) {
    tool.shape.delete();
    throw new FeatureError(op === 'cut' ? 'No hay un sólido previo para cortar' : 'No hay un sólido previo con el cual intersectar');
  }

  const oc = getOC();
  const range = new oc.Message_ProgressRange();
  const build = () => op === 'join'
    ? new oc.BRepAlgoAPI_Fuse(input.shape.wrapped, tool.shape.wrapped, range)
    : op === 'intersect'
      ? new oc.BRepAlgoAPI_Common(input.shape.wrapped, tool.shape.wrapped, range)
      : new oc.BRepAlgoAPI_Cut(input.shape.wrapped, tool.shape.wrapped, range);
  let algo = build();
  try {
    if (!algo.IsDone() || algo.HasErrors()) {
      throw new FeatureError(
        op === 'join' ? 'Falló la unión con el sólido previo' : op === 'intersect' ? 'Falló la intersección con el sólido previo' : 'Falló el corte del sólido previo',
      );
    }
    // Unifica caras coplanares y aristas colineales que deja la booleana (conserva la historia).
    // Con miles de caras (mallas importadas) no se simplifica: es lento y no aporta.
    const simplify = input.shape.faces.length + tool.shape.faces.length <= SIMPLIFY_MAX_FACES;
    if (simplify) algo.SimplifyResult(true, true, 1e-6);
    let result = cast(algo.Shape());
    if (simplify && result.solids.length > 0 && !isValidShape(result)) {
      // Con caras casi coplanares (mallas importadas) la unificación puede dejar caras inválidas:
      // se rehace la booleana y se queda el resultado sin simplificar.
      result.delete();
      algo.delete();
      algo = build();
      result = cast(algo.Shape());
    }
    if (result.solids.length === 0) {
      result.delete();
      throw new FeatureError(
        op === 'cut' ? 'El corte elimina todo el sólido' : op === 'intersect' ? 'El cuerpo no se superpone con el sólido previo' : 'La unión no produjo un sólido',
      );
    }
    if (!isValidShape(result)) {
      result.delete();
      throw new FeatureError('El resultado de la operación booleana no es un sólido válido');
    }
    // OCCT a veces devuelve un sólido "válido" pero absurdo (p. ej. con aristas que coinciden justo
    // con las del sólido): una unión más chica que sus partes o un corte que agrega material.
    const [vi, vt, vr] = [volume(input.shape), volume(tool.shape), volume(result)];
    const tol = 1e-3 * Math.max(1, vi, vt);
    if ((op === 'join' && (vr < Math.max(vi, vt) - tol || vr > vi + vt + tol)) || (op === 'cut' && vr > vi + tol) || (op === 'intersect' && vr > Math.min(vi, vt) + tol)) {
      result.delete();
      throw new FeatureError(
        op === 'join' ? 'La unión dio un resultado incoherente: probá con «Nuevo cuerpo» o cambiá la forma un poco'
          : op === 'cut' ? 'El corte dio un resultado incoherente: probá cambiando la forma un poco'
            : 'La intersección dio un resultado incoherente: probá cambiando la forma un poco',
      );
    }
    if (op === 'cut' && Math.abs(vi - vr) <= 1e-9 * Math.max(1, vi)) {
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
