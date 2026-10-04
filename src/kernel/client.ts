// Cliente RPC tipado del worker del kernel (hilo principal).
import type { KernelApi, KernelMethod, RpcRequest, RpcResponse } from './protocol';

export type KernelClient = {
  [K in KernelMethod]: (...args: Parameters<KernelApi[K]>) => Promise<ReturnType<KernelApi[K]>>;
};

export function createKernelClient(): KernelClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  worker.onmessage = (ev: MessageEvent<RpcResponse>) => {
    const msg = ev.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (ev) => {
    const err = new Error(`El worker del kernel falló: ${ev.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const call = (method: KernelMethod, args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args } satisfies RpcRequest);
    });

  // Objeto explícito (no Proxy) para que no parezca "thenable" al pasarlo por promesas.
  const client = {} as Record<KernelMethod, (...a: unknown[]) => Promise<unknown>>;
  for (const m of KERNEL_METHODS) client[m] = (...args) => call(m, args);
  return client as KernelClient;
}

const KERNEL_METHODS = ['init', 'recompute', 'faceInfo', 'edgeInfo', 'faceRefs', 'edgeRefs'] as const satisfies readonly KernelMethod[];
// Error de compilación si se agrega un método a KernelApi y no a la lista.
type _AllListed = Exclude<KernelMethod, (typeof KERNEL_METHODS)[number]> extends never ? true : never;
const _check: _AllListed = true;
void _check;
