// Reparación de mallas importadas (STL) para que formen un sólido: quita triángulos repetidos,
// orienta todos los triángulos de forma coherente y cierra los agujeros. Trabaja sobre índices
// (después de soldar los vértices iguales), sin OpenCascade.
import type { IndexedMesh } from './export/meshExport';

export interface RepairReport {
  /** Triángulos repetidos quitados. */
  duplicates: number;
  /** Triángulos dados vuelta para que todos miren hacia el mismo lado. */
  flipped: number;
  /** Agujeros cerrados. */
  holes: number;
  /** Bordes sueltos que quedaron sin cerrar. */
  openEdges: number;
  /** Aristas compartidas por más de dos triángulos. */
  nonManifold: number;
}

const ukey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

export function repairMesh(input: IndexedMesh): { mesh: IndexedMesh; report: RepairReport } {
  const report: RepairReport = { duplicates: 0, flipped: 0, holes: 0, openEdges: 0, nonManifold: 0 };
  const positions = Array.from(input.positions);

  // 1. Triángulos repetidos (los mismos tres vértices, en cualquier orden).
  const seen = new Set<string>();
  let tris: [number, number, number][] = [];
  for (let t = 0; t < input.triangles.length; t += 3) {
    const tri: [number, number, number] = [input.triangles[t], input.triangles[t + 1], input.triangles[t + 2]];
    const k = [...tri].sort((x, y) => x - y).join(',');
    if (seen.has(k)) {
      report.duplicates++;
      continue;
    }
    seen.add(k);
    tris.push(tri);
  }

  // 2. Orientación coherente: dos triángulos vecinos recorren la arista común en sentidos opuestos.
  const edgeTris = new Map<string, number[]>();
  tris.forEach((tri, i) => {
    for (let k = 0; k < 3; k++) {
      const key = ukey(tri[k], tri[(k + 1) % 3]);
      const list = edgeTris.get(key);
      if (list) list.push(i);
      else edgeTris.set(key, [i]);
    }
  });
  const sameDirection = (a: [number, number, number], b: [number, number, number], u: number, v: number) => {
    const dir = (t: [number, number, number]) => {
      for (let k = 0; k < 3; k++) if (t[k] === u && t[(k + 1) % 3] === v) return 1;
      return -1;
    };
    return dir(a) === dir(b);
  };
  const visited = new Uint8Array(tris.length);
  for (let start = 0; start < tris.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const queue = [start];
    while (queue.length) {
      const i = queue.pop()!;
      const tri = tris[i];
      for (let k = 0; k < 3; k++) {
        const u = tri[k], v = tri[(k + 1) % 3];
        const list = edgeTris.get(ukey(u, v))!;
        if (list.length !== 2) continue; // borde o arista con más de dos caras: no se propaga
        const j = list[0] === i ? list[1] : list[0];
        if (visited[j]) continue;
        visited[j] = 1;
        if (sameDirection(tri, tris[j], u, v)) {
          const t = tris[j];
          tris[j] = [t[0], t[2], t[1]];
          report.flipped++;
        }
        queue.push(j);
      }
    }
  }
  // Se cuentan "dados vuelta" respecto de la mayoría (si se invirtió casi todo, era el primero el raro).
  if (report.flipped > tris.length / 2) report.flipped = tris.length - report.flipped;

  // 3. Agujeros: los bordes sueltos (arista en un solo triángulo) se encadenan en contornos y cada
  // contorno se cierra con un abanico desde su centro.
  const next = new Map<number, number[]>();
  for (const tri of tris) {
    for (let k = 0; k < 3; k++) {
      const u = tri[k], v = tri[(k + 1) % 3];
      const n = edgeTris.get(ukey(u, v))!.length;
      if (n > 2) continue;
      if (n === 1) {
        // El hueco se recorre al revés que el triángulo: el relleno usa v → u.
        const list = next.get(v);
        if (list) list.push(u);
        else next.set(v, [u]);
      }
    }
  }
  for (const list of edgeTris.values()) if (list.length > 2) report.nonManifold++;
  const added: [number, number, number][] = [];
  for (const startV of [...next.keys()]) {
    while ((next.get(startV)?.length ?? 0) > 0) {
      const loop = [startV];
      let cur = next.get(startV)!.pop()!;
      let guard = 0;
      while (cur !== startV && guard++ < 1_000_000) {
        loop.push(cur);
        const outs = next.get(cur);
        if (!outs || outs.length === 0) break;
        cur = outs.pop()!;
      }
      if (cur !== startV || loop.length < 3) {
        report.openEdges += loop.length;
        continue;
      }
      report.holes++;
      if (loop.length === 3) {
        added.push([loop[0], loop[1], loop[2]]);
        continue;
      }
      const c = positions.length / 3;
      const centroid = [0, 0, 0];
      for (const v of loop) for (let k = 0; k < 3; k++) centroid[k] += positions[3 * v + k] / loop.length;
      positions.push(...centroid);
      for (let i = 0; i < loop.length; i++) added.push([loop[i], loop[(i + 1) % loop.length], c]);
    }
  }
  tris = tris.concat(added);
  return {
    mesh: { positions: Float64Array.from(positions), triangles: Uint32Array.from(tris.flat()) },
    report,
  };
}

/** Resumen en castellano de lo que se reparó (vacío si no hizo falta nada). */
export function describeRepair(r: RepairReport): string {
  const parts: string[] = [];
  if (r.holes) parts.push(`${r.holes} agujero${r.holes === 1 ? '' : 's'} cerrado${r.holes === 1 ? '' : 's'}`);
  if (r.flipped) parts.push(`${r.flipped} cara${r.flipped === 1 ? '' : 's'} dada${r.flipped === 1 ? '' : 's'} vuelta`);
  if (r.duplicates) parts.push(`${r.duplicates} repetida${r.duplicates === 1 ? '' : 's'} quitada${r.duplicates === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * Suelda los vértices que quedan a menos de `tol` entre sí (grilla con vecinos: dos puntos
 * cercanos a ambos lados de una celda también se unen). Quita los triángulos que se aplastan.
 */
export function weldClose(tris: ArrayLike<number>, tol: number): IndexedMesh {
  const cell = (v: number) => Math.floor(v / tol);
  const grid = new Map<string, number[]>();
  const pos: number[] = [];
  const index = (x: number, y: number, z: number) => {
    const [cx, cy, cz] = [cell(x), cell(y), cell(z)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (Math.hypot(pos[3 * j] - x, pos[3 * j + 1] - y, pos[3 * j + 2] - z) <= tol) return j;
      }
    }
    const j = pos.length / 3;
    pos.push(x, y, z);
    const key = `${cx},${cy},${cz}`;
    const list = grid.get(key);
    if (list) list.push(j);
    else grid.set(key, [j]);
    return j;
  };
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 9) {
    const a = index(tris[t], tris[t + 1], tris[t + 2]);
    const b = index(tris[t + 3], tris[t + 4], tris[t + 5]);
    const c = index(tris[t + 6], tris[t + 7], tris[t + 8]);
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(out) };
}
