// Utilidades de bajo nivel sobre OpenCascade.
import { getOC, type AnyShape } from 'replicad';

/** Error de una feature que se muestra tal cual en el timeline. */
export class FeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeatureError';
  }
}

/** Traducción de mensajes frecuentes de OCCT. */
const OCCT_MESSAGES: Record<string, string> = {
  'There are no suitable edges for chamfer or fillet':
    'ninguna de las aristas admite redondeo/chaflán (son tangentes o costuras)',
};

/** Convierte cualquier excepción (incluidas las de C++ que llegan desde WASM) en texto legible. */
export function describeError(err: unknown): string {
  // Fallas de ejecución dentro del WASM de OCCT (p. ej. "null function or function signature mismatch").
  if (err instanceof Error && err.name === 'RuntimeError') return 'error interno de OpenCascade';
  if (err instanceof Error) return err.message;
  // Excepciones C++ con el manejo nativo de WASM (WebAssembly.Exception).
  if (typeof WebAssembly !== 'undefined' && 'Exception' in WebAssembly && err instanceof (WebAssembly as unknown as { Exception: new () => object }).Exception) {
    try {
      const oc = getOC() as unknown as { getExceptionMessage(e: unknown): [string, string] };
      const [type, msg] = oc.getExceptionMessage(err);
      return OCCT_MESSAGES[msg] ?? (msg ? `OpenCascade (${type}): ${msg}` : `OpenCascade lanzó ${type}`);
    } catch {
      return 'Excepción interna de OpenCascade';
    }
  }
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
