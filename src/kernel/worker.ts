/// <reference lib="webworker" />
// Web Worker del kernel: recibe pedidos RPC y los ejecuta sobre KernelService.
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { KernelService } from './service';
import { meshTransferables } from './mesh';
import type { MeshPayload, RpcRequest, RpcResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const service = new KernelService(wasmUrl);

self.onmessage = async (ev: MessageEvent<RpcRequest>) => {
  const { id, method, args } = ev.data;
  try {
    const fn = service[method] as (...a: unknown[]) => unknown;
    if (typeof fn !== 'function') throw new Error(`Método desconocido: ${String(method)}`);
    const result = await fn.apply(service, args);
    const transfer = isMesh(result) ? meshTransferables(result) : [];
    self.postMessage({ id, ok: true, result } satisfies RpcResponse, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: describeError(err) } satisfies RpcResponse);
  }
};

function isMesh(x: unknown): x is MeshPayload {
  return typeof x === 'object' && x !== null && 'faceRanges' in x && 'positions' in x;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Las excepciones C++ de OCCT llegan como números (punteros) desde WASM.
  if (typeof err === 'number') return `Excepción interna de OpenCascade (código ${err})`;
  return String(err);
}
