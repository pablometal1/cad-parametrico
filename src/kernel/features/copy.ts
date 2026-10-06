// Patrón (lineal o circular) y simetría: copias transformadas del cuerpo de otra feature.
import { cast, getOC, makeCompound } from 'replicad';
import type { BasePlane, GlobalAxis, MirrorFeature, PatternFeature, ProfileFeature } from '../../document/types';
import { historyOf, NameBuilder, type NamedShape } from '../naming';
import { FeatureError } from '../occtUtils';
import { combine } from './boolean';
import { buildExtrudeTool } from './extrude';
import { buildRevolveTool } from './revolve';
import type { EvaluatedSketch } from './sketch';

const AXIS: Record<GlobalAxis, [number, number, number]> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PLANE_NORMAL: Record<BasePlane, [number, number, number]> = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };

/** Cuerpo herramienta de la feature de origen (prisma o revolución), sin combinar. */
export function sourceTool(source: ProfileFeature, sketch: EvaluatedSketch): NamedShape {
  return source.type === 'extrude' ? buildExtrudeTool(source, sketch) : buildRevolveTool(source, sketch);
}

type TrsfBuilder = (trsf: InstanceType<ReturnType<typeof getOC>['gp_Trsf']>) => void;

/**
 * Copia transformada de un cuerpo nombrado. Las caras de la copia se llaman
 * `<feature>:<copia>:<nombre original>`, así cada copia tiene referencias propias y estables.
 */
function transformed(tool: NamedShape, setup: TrsfBuilder, featureId: string, copy: number): NamedShape {
  const oc = getOC();
  const trsf = new oc.gp_Trsf();
  setup(trsf);
  const builder = new oc.BRepBuilderAPI_Transform(tool.shape.wrapped, trsf, true, false);
  try {
    const shape = cast(builder.Shape());
    const nb = new NameBuilder(shape);
    const renamed: NamedShape = { shape: tool.shape, names: tool.names.map((ns) => ns.map((n) => `${featureId}:${copy}:${n}`)) };
    nb.carry(renamed, historyOf(builder));
    return nb.finish(featureId);
  } finally {
    builder.delete();
    trsf.delete();
  }
}

/** Junta varios cuerpos nombrados en un compound (y libera los originales). */
function compoundOf(parts: NamedShape[], featureId: string): NamedShape {
  if (parts.length === 1) return parts[0];
  const compound = makeCompound(parts.map((p) => p.shape.clone()));
  const nb = new NameBuilder(compound);
  for (const p of parts) nb.carry(p, null);
  parts.forEach((p) => p.shape.delete());
  return nb.finish(featureId);
}

export function runPattern(feature: PatternFeature, source: ProfileFeature, sketch: EvaluatedSketch, input: NamedShape | null): NamedShape {
  const oc = getOC();
  const count = feature.count;
  if (!Number.isInteger(count) || count < 2) throw new FeatureError(`La cantidad debe ser un entero de al menos 2 (es ${count})`);
  if (count > 200) throw new FeatureError('La cantidad máxima de copias es 200');
  if (feature.kind === 'linear' && !(Math.abs(feature.spacing) > 0)) throw new FeatureError('La separación no puede ser 0');
  if (feature.kind === 'circular' && !(feature.angle > 0 && feature.angle <= 360)) {
    throw new FeatureError(`El ángulo debe estar entre 0 y 360° (es ${feature.angle})`);
  }
  if (source.operation !== 'new' && !input) throw new FeatureError('No hay un sólido sobre el cual aplicar el patrón');

  const tool = sourceTool(source, sketch);
  const [ax, ay, az] = AXIS[feature.axis];
  // Vuelta completa: copias equiespaciadas sin repetir la primera; si no, de 0 al ángulo total.
  const step = feature.kind === 'circular'
    ? ((feature.angle >= 360 ? feature.angle / count : feature.angle / (count - 1)) * Math.PI) / 180
    : feature.spacing;
  const copies: NamedShape[] = [];
  try {
    for (let k = 1; k < count; k++) {
      copies.push(transformed(tool, (t) => {
        if (feature.kind === 'linear') {
          const v = new oc.gp_Vec(ax * step * k, ay * step * k, az * step * k);
          t.SetTranslation(v);
          v.delete();
        } else {
          const p = new oc.gp_Pnt(0, 0, 0);
          const d = new oc.gp_Dir(ax, ay, az);
          const a1 = new oc.gp_Ax1(p, d);
          t.SetRotation(a1, step * k);
          a1.delete();
          d.delete();
          p.delete();
        }
      }, feature.id, k));
    }
  } finally {
    tool.shape.delete();
  }
  return combine(source.operation, input, compoundOf(copies, feature.id), feature.id);
}

export function runMirror(feature: MirrorFeature, source: ProfileFeature, sketch: EvaluatedSketch, input: NamedShape | null): NamedShape {
  const oc = getOC();
  if (source.operation !== 'new' && !input) throw new FeatureError('No hay un sólido sobre el cual aplicar la simetría');
  const tool = sourceTool(source, sketch);
  let copy: NamedShape;
  try {
    const [nx, ny, nz] = PLANE_NORMAL[feature.plane];
    copy = transformed(tool, (t) => {
      const p = new oc.gp_Pnt(0, 0, 0);
      const n = new oc.gp_Dir(nx, ny, nz);
      const ax2 = new oc.gp_Ax2(p, n);
      t.SetMirror(ax2);
      ax2.delete();
      n.delete();
      p.delete();
    }, feature.id, 1);
  } finally {
    tool.shape.delete();
  }
  return combine(source.operation, input, copy, feature.id);
}
