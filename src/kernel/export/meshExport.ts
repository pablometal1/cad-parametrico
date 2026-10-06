// Mallas para exportar: vértices soldados (malla estanca para los slicers), STL binario y 3MF.
import { strToU8, zipSync } from 'fflate';

export interface IndexedMesh {
  /** xyz por vértice (sin duplicados). */
  positions: Float64Array;
  /** Tres índices por triángulo. */
  triangles: Uint32Array;
}

/**
 * Suelda vértices que coinciden (a menos de `tol` mm) y quita triángulos degenerados.
 * La teselación de OCCT duplica los vértices en el borde de cada cara; sin soldar, la malla
 * no es cerrada y los slicers la reportan con "agujeros".
 */
export function weldMesh(vertices: ArrayLike<number>, triangles: ArrayLike<number>, tol = 1e-5): IndexedMesh {
  const key = (i: number) =>
    `${Math.round(vertices[3 * i] / tol)},${Math.round(vertices[3 * i + 1] / tol)},${Math.round(vertices[3 * i + 2] / tol)}`;
  const map = new Map<string, number>();
  const remap = new Uint32Array(vertices.length / 3);
  const pos: number[] = [];
  for (let i = 0; i < vertices.length / 3; i++) {
    const k = key(i);
    let j = map.get(k);
    if (j === undefined) {
      j = pos.length / 3;
      map.set(k, j);
      pos.push(vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]);
    }
    remap[i] = j;
  }
  const tris: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = remap[triangles[t]];
    const b = remap[triangles[t + 1]];
    const c = remap[triangles[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris) };
}

/** Diagnóstico de estanqueidad: cada arista debe estar en exactamente dos triángulos, en sentidos opuestos. */
export function checkWatertight(m: IndexedMesh): { boundaryEdges: number; nonManifoldEdges: number } {
  const count = new Map<string, number>();
  for (let t = 0; t < m.triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = m.triangles[t + k];
      const b = m.triangles[t + ((k + 1) % 3)];
      const id = `${a},${b}`;
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const [id, n] of count) {
    const [a, b] = id.split(',');
    const back = count.get(`${b},${a}`) ?? 0;
    if (n > 1) nonManifoldEdges++;
    else if (back === 0) boundaryEdges++;
  }
  return { boundaryEdges, nonManifoldEdges };
}

/** Volumen encerrado por la malla (teorema de la divergencia); sirve para verificar la exportación. */
export function meshVolume(m: IndexedMesh): number {
  let v = 0;
  const p = m.positions;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const [a, b, c] = [m.triangles[t] * 3, m.triangles[t + 1] * 3, m.triangles[t + 2] * 3];
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

/** STL binario (estándar para impresión 3D). */
export function toBinarySTL(meshes: IndexedMesh[], header = 'CAD parametrico'): Uint8Array {
  const total = meshes.reduce((n, m) => n + m.triangles.length / 3, 0);
  const buf = new ArrayBuffer(84 + total * 50);
  const view = new DataView(buf);
  const head = strToU8(header.slice(0, 79));
  new Uint8Array(buf, 0, head.length).set(head);
  view.setUint32(80, total, true);
  let off = 84;
  for (const m of meshes) {
    const p = m.positions;
    for (let t = 0; t < m.triangles.length; t += 3) {
      const ia = m.triangles[t] * 3, ib = m.triangles[t + 1] * 3, ic = m.triangles[t + 2] * 3;
      const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2];
      const vx = p[ic] - p[ia], vy = p[ic + 1] - p[ia + 1], vz = p[ic + 2] - p[ia + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz]) { view.setFloat32(off, v, true); off += 4; }
      for (const i of [ia, ib, ic]) {
        view.setFloat32(off, p[i], true);
        view.setFloat32(off + 4, p[i + 1], true);
        view.setFloat32(off + 8, p[i + 2], true);
        off += 12;
      }
      view.setUint16(off, 0, true);
      off += 2;
    }
  }
  return new Uint8Array(buf);
}

/**
 * Archivo 3MF (zip con XML, unidades en mm). Cada cuerpo es un objeto separado, así el slicer
 * los reconoce como piezas independientes.
 */
export function to3MF(meshes: IndexedMesh[], names: string[] = []): Uint8Array {
  const f = (v: number) => (Math.abs(v) < 1e-12 ? '0' : String(Math.round(v * 1e6) / 1e6));
  const objects = meshes.map((m, i) => {
    const verts: string[] = [];
    for (let j = 0; j < m.positions.length; j += 3) {
      verts.push(`<vertex x="${f(m.positions[j])}" y="${f(m.positions[j + 1])}" z="${f(m.positions[j + 2])}"/>`);
    }
    const tris: string[] = [];
    for (let t = 0; t < m.triangles.length; t += 3) {
      tris.push(`<triangle v1="${m.triangles[t]}" v2="${m.triangles[t + 1]}" v3="${m.triangles[t + 2]}"/>`);
    }
    const name = escapeXml(names[i] ?? `Cuerpo ${i + 1}`);
    return `<object id="${i + 1}" name="${name}" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`;
  });
  const items = meshes.map((_, i) => `<item objectid="${i + 1}"/>`).join('');
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xml:lang="es-AR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<resources>${objects.join('')}</resources><build>${items}</build></model>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';
  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
