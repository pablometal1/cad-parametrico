// Medidas de sólidos.
import { getOC, type AnyShape } from 'replicad';

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
