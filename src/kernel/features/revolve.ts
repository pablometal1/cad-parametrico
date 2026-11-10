// Feature de revolución: gira los perfiles del sketch alrededor de un eje y combina con el sólido previo.
import { cast, getOC, makeCompound, type Face } from 'replicad';
import { toWorld, type Vec3 } from '../../document/planes';
import type { RevolveFeature } from '../../document/types';
import { SketchIndex } from '../../sketch/model';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { FeatureError, isValidShape } from '../occtUtils';
import { combine, sweepRegions } from './boolean';
import { buildSketchFaces, nameSweep, type EvaluatedSketch, hasProfiles } from './sketch';

export function runRevolve(feature: RevolveFeature, sketch: EvaluatedSketch, input: NamedShape | null): NamedShape {
  if (feature.operation === 'cut' && !input) {
    throw new FeatureError('No hay un sólido previo para cortar');
  }
  return combine(feature.operation, input, buildRevolveTool(feature, sketch), feature.id);
}

/** Cuerpo de la revolución, antes de combinarlo con el sólido previo. */
export function buildRevolveTool(feature: RevolveFeature, sketch: EvaluatedSketch): NamedShape {
  const oc = getOC();
  if (!(feature.angle > 0 && feature.angle <= 360)) {
    throw new FeatureError(`El ángulo debe estar entre 0 y 360° (es ${feature.angle})`);
  }
  if (!hasProfiles(sketch)) throw new FeatureError('El sketch no tiene perfiles cerrados');

  const [origin, dir] = revolveAxis(feature, sketch);
  const faces = buildSketchFaces(sketch);
  const pnt = new oc.gp_Pnt(...origin);
  const gdir = new oc.gp_Dir(...dir);
  const ax = new oc.gp_Ax1(pnt, gdir);
  try {
    return sweepRegions(faces, sketch.overlapping, (group) => revolveGroup(group), feature.id);
  } finally {
    ax.delete();
    gdir.delete();
    pnt.delete();
  }

  function revolveGroup(group: Face[]): NamedShape {
    const profile = group.length === 1 ? group[0] : makeCompound(group);
    const revol = new oc.BRepPrimAPI_MakeRevol(profile.wrapped, ax, (feature.angle * Math.PI) / 180, false);
    let tool: NamedShape;
    try {
      if (!revol.IsDone()) throw new FeatureError('No se pudo generar la revolución: revisá que el perfil no cruce el eje');
      const shape = cast(revol.Shape());
      if (!isValidShape(shape)) {
        shape.delete();
        throw new FeatureError('La revolución no es válida: el perfil no debe cruzar el eje');
      }
      const nb = new NameBuilder(shape);
      nameSweep(nb, historyOf(revol), sketch, profile, feature.id);
      if (feature.angle < 360) {
        nb.addCap(revol.FirstShape(), `${feature.id}:start`);
        nb.addCap(revol.LastShape(), `${feature.id}:end`);
      }
      tool = nb.finish(feature.id);
    } catch (err) {
      if (err instanceof FeatureError) throw err;
      throw new FeatureError('No se pudo generar la revolución: revisá que el perfil no cruce el eje');
    } finally {
      revol.delete();
      profile.delete();
    }
    return tool;
  }
}

/** Punto y dirección del eje en 3D. */
export function revolveAxis(feature: RevolveFeature, s: EvaluatedSketch): [Vec3, Vec3] {
  const f = s.frame;
  if (feature.axis.kind === 'sketchAxis') return [f.origin, feature.axis.axis === 'u' ? f.xDir : f.yDir];
  const index = new SketchIndex(s.data);
  const line = index.get(feature.axis.line);
  if (line?.type !== 'line') throw new FeatureError('La línea usada como eje ya no existe en el sketch');
  const a = toWorld(f, ...index.point(line.p1));
  const b = toWorld(f, ...index.point(line.p2));
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  if (Math.hypot(...d) < 1e-9) throw new FeatureError('La línea usada como eje tiene longitud cero');
  return [a, d];
}
