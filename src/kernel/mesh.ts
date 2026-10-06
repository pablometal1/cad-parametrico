// Teselación de un sólido de OCCT a buffers para Three.js, conservando qué triángulos son de qué cara.
import type { AnyShape } from 'replicad';
import type { MeshPayload } from './protocol';

export interface MeshOptions {
  /** Desvío lineal máximo en mm. */
  tolerance: number;
  /** Desvío angular máximo en radianes. */
  angularTolerance: number;
}

export const DEFAULT_MESH_OPTIONS: MeshOptions = { tolerance: 0.01, angularTolerance: 0.1 };

/**
 * Precisión de la malla que se muestra, según el tamaño de la pieza: 0,01 mm fijo en una rosca
 * de 60 mm daba cientos de miles de triángulos. La exportación tiene su propia calidad.
 */
export function displayMeshOptions(shape: AnyShape, coarse = false): MeshOptions {
  const [min, max] = shape.boundingBox.bounds;
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const tolerance = Math.min(0.2, Math.max(0.01, diag / 2000));
  return coarse ? { tolerance: tolerance * 5, angularTolerance: 0.5 } : { tolerance, angularTolerance: 0.25 };
}

export function shapeToMesh(shape: AnyShape, edgeKinds?: Uint8Array, opts: MeshOptions = DEFAULT_MESH_OPTIONS): MeshPayload {
  const faces = shape.faces;
  const edges = shape.edges;
  const m = shape.mesh(opts);
  const em = shape.meshEdges(opts);

  // replicad identifica cada grupo por el hash de la cara; lo traducimos al índice en shape.faces.
  const faceIndexByHash = indexByHash(faces);
  const faceRanges = new Uint32Array(faces.length * 2);
  for (const g of m.faceGroups) {
    const i = lookup(faceIndexByHash, g.faceId, 'cara');
    faceRanges[2 * i] = g.start;
    faceRanges[2 * i + 1] = g.count;
  }

  const edgeIndexByHash = indexByHash(edges);
  const edgeRanges = new Uint32Array(edges.length * 2);
  for (const g of em.edgeGroups) {
    const i = lookup(edgeIndexByHash, g.edgeId, 'arista');
    edgeRanges[2 * i] = g.start;
    edgeRanges[2 * i + 1] = g.count;
  }

  const bb = shape.boundingBox;
  const [min, max] = bb.bounds;

  return {
    positions: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    indices: new Uint32Array(m.triangles),
    faceRanges,
    edgePositions: new Float32Array(em.lines),
    edgeRanges,
    edgeKinds: edgeKinds ?? new Uint8Array(edges.length),
    bbox: { min: [...min] as [number, number, number], max: [...max] as [number, number, number] },
  };
}

/** Buffers a transferir con postMessage. */
export function meshTransferables(m: MeshPayload): ArrayBuffer[] {
  return [m.positions, m.normals, m.indices, m.faceRanges, m.edgePositions, m.edgeRanges, m.edgeKinds]
    .map((a) => a.buffer as ArrayBuffer);
}

function indexByHash(items: { hashCode: number; isSame(o: never): boolean }[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  items.forEach((it, i) => {
    const list = map.get(it.hashCode);
    if (list) list.push(i);
    else map.set(it.hashCode, [i]);
  });
  return map;
}

function lookup(map: Map<number, number[]>, hash: number, kind: string): number {
  const list = map.get(hash);
  if (!list || list.length === 0) throw new Error(`Malla: ${kind} con hash ${hash} no encontrada en el sólido`);
  // Ante colisión de hash, los grupos llegan en el mismo orden que la exploración: consumimos en orden.
  return list.length === 1 ? list[0] : list.shift()!;
}
