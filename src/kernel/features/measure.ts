// Medidas de sólidos.
import { getOC, type AnyShape } from 'replicad';

/**
 * Propiedades de volumen (masa y centro de masa). Integración común de OCCT: en caras B-spline
 * (splines, NURBS, solevaciones) puede errar en el orden de 1/5000 del volumen, invisible con la
 * precisión que muestra el panel. La adaptativa (Gauss-Kronrod) es exacta pero tarda segundos en
 * piezas con caras desfasadas (superficies engrosadas, vaciados).
 */
export function volumeProps(shape: AnyShape) {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape.wrapped, props, false, false, false);
  return props;
}

export function volume(shape: AnyShape): number {
  const props = volumeProps(shape);
  try {
    return props.Mass();
  } finally {
    props.delete();
  }
}

/** Área de todas las caras. */
export function area(shape: AnyShape): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(shape.wrapped, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}
