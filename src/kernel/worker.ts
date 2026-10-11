/// <reference lib="webworker" />
// Web Worker del kernel: recibe pedidos RPC y los ejecuta sobre KernelService.
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import solverWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { KernelService } from './service';
import { meshTransferables } from './mesh';
import { describeError } from './occtUtils';
import type { MeshPayload, RecomputeResult, RpcRequest, RpcResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const service = new KernelService(wasmUrl, solverWasmUrl);

self.onmessage = async (ev: MessageEvent<RpcRequest>) => {
  const { id, method, args } = ev.data;
  try {
    const fn = service[method] as (...a: unknown[]) => unknown;
    if (typeof fn !== 'function') throw new Error(`Método desconocido: ${String(method)}`);
    const result = await fn.apply(service, args);
    const transfer = transferables(result);
    self.postMessage({ id, ok: true, result } satisfies RpcResponse, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: describeError(err) } satisfies RpcResponse);
  }
};

function isMesh(x: unknown): x is MeshPayload {
  return typeof x === 'object' && x !== null && 'faceRanges' in x && 'positions' in x;
}

/** Buffers que se pueden transferir sin copia (mallas y curvas de sketch). */
function transferables(result: unknown): ArrayBuffer[] {
  if (isMesh(result)) return meshTransferables(result);
  if (typeof result === 'object' && result !== null && 'data' in result && (result as { data: unknown }).data instanceof Uint8Array) {
    return [(result as { data: Uint8Array }).data.buffer as ArrayBuffer];
  }
  if (typeof result === 'object' && result !== null && 'features' in result && 'sketches' in result) {
    const r = result as RecomputeResult;
    return [
      ...(r.mesh ? meshTransferables(r.mesh) : []),
      ...r.references.flatMap((x) => meshTransferables(x.mesh)),
      ...r.sketches.flatMap((s) => [s.segments, s.construction, s.reference].map((a) => a.buffer as ArrayBuffer)),
    ];
  }
  return [];
}


