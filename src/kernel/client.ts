// Cliente RPC tipado del worker del kernel (hilo principal).
import type { KernelApi, KernelMethod, RpcRequest, RpcResponse } from './protocol';

export type KernelClient = {
  [K in KernelMethod]: (...args: Parameters<KernelApi[K]>) => Promise<ReturnType<KernelApi[K]>>;
} & {
  /**
   * Descarta el worker y arranca uno nuevo (memoria de OpenCascade limpia). Se usa cuando un
   * recálculo falla de forma inesperada: después de un error interno el estado del WASM no es confiable.
   */
  restart(): Promise<void>;
};

export function createKernelClient(): KernelClient {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const spawn = () => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<RpcResponse>) => {
      const msg = ev.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    w.onerror = (ev) => {
      const err = new Error(`El worker del kernel falló: ${ev.message}`);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    return w;
  };
  let worker = spawn();

  const call = (method: KernelMethod, args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args } satisfies RpcRequest);
    });

  // Objeto explícito (no Proxy) para que no parezca "thenable" al pasarlo por promesas.
  const client = {} as Record<KernelMethod, (...a: unknown[]) => Promise<unknown>> & { restart(): Promise<void> };
  for (const m of KERNEL_METHODS) client[m] = (...args) => call(m, args);
  client.restart = async () => {
    worker.terminate();
    const err = new Error('El kernel se reinició');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = spawn();
    await call('init', []);
  };
  return client as KernelClient;
}

const KERNEL_METHODS = ['init', 'recompute', 'faceInfo', 'edgeInfo', 'faceRefs', 'edgeRefs', 'vertices', 'vertexRefs', 'manipulator', 'exportModel', 'massProperties', 'measure'] as const satisfies readonly KernelMethod[];
// Error de compilación si se agrega un método a KernelApi y no a la lista.
type _AllListed = Exclude<KernelMethod, (typeof KERNEL_METHODS)[number]> extends never ? true : never;
const _check: _AllListed = true;
void _check;
