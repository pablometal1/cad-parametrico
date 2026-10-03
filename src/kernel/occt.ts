// Inicialización de OpenCascade (WASM) compartida entre el worker y los tests en Node.
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';

type OCInstance = Awaited<ReturnType<typeof opencascade>>;

let instance: Promise<OCInstance> | null = null;

/**
 * Carga OCCT una sola vez y lo registra en replicad.
 * @param wasmUrl URL del .wasm (navegador). En Node se omite y emscripten lo busca junto al .js.
 */
export function initOCCT(wasmUrl?: string): Promise<OCInstance> {
  if (!instance) {
    instance = opencascade(
      wasmUrl ? { locateFile: () => wasmUrl } : undefined,
    ).then((oc) => {
      setOC(oc);
      return oc;
    });
  }
  return instance;
}
