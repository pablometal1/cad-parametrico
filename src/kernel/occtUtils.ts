// Utilidades de bajo nivel sobre OpenCascade.
import { getOC, type AnyShape } from 'replicad';

/** Error de una feature que se muestra tal cual en el timeline. */
export class FeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureError';
  }
}

/** Convierte cualquier excepción (incluidas las de C++ que llegan como puntero numérico) en texto legible. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'number') {
    try {
      const oc = getOC();
      const failure = oc.OCJS.getStandard_FailureData(err);
      const msg = failure.GetMessageString();
      const type = failure.ExceptionType();
      return msg ? `OpenCascade (${type}): ${msg}` : `OpenCascade lanzó ${type}`;
    } catch {
      return `Excepción interna de OpenCascade (código ${err})`;
    }
  }
  return String(err);
}

/** Verifica la validez topológica y geométrica del sólido resultante. */
export function isValidShape(shape: AnyShape): boolean {
  const oc = getOC();
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try {
    return analyzer.IsValid();
  } finally {
    analyzer.delete();
  }
}

/** Hash de texto rápido (cyrb53), suficiente para claves de cache. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
