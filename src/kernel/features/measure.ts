// Medidas de sólidos.
import { getOC, type AnyShape } from 'replicad';

/** Precisión relativa de la integración de propiedades de masa. */
const MASS_EPS = 1e-6;

/**
 * Propiedades de volumen (masa y, si `center`, centro de masa). Usa Gauss-Kronrod adaptativo
 * tramo a tramo: la integración común de OCCT usa una cantidad fija de puntos por arista y en
 * caras B-spline (splines, NURBS, solevaciones) se equivoca en décimas de mm³.
 */
export function volumeProps(shape: AnyShape, center = false) {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumePropertiesGK(shape.wrapped, props, MASS_EPS, false, true, center, false, false);
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

/** Área de todas las caras (integración adaptativa, como `volumeProps`). */
export function area(shape: AnyShape): number {
  const oc = getOC();
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(shape.wrapped, props, MASS_EPS, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}
