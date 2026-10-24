// Comprobación de la pieza para imprimir: sólido válido, malla cerrada, normales hacia afuera y
// cuerpos que no se superponen.
import { cast, getOC, type AnyShape } from 'replicad';
import type { PartCheck } from '../protocol';
import { checkWatertight, meshVolume, weldMesh } from '../export/meshExport';
import { isValidShape } from '../occtUtils';
import { volume } from './measure';

/** Hasta cuántos cuerpos se comparan de a pares (las booleanas cuestan). */
const MAX_OVERLAP_BODIES = 8;

export function checkPart(shape: AnyShape): PartCheck {
  const oc = getOC();
  const solids = shape.solids;
  let openEdges = 0;
  let flippedEdges = 0;
  let invertedBodies = 0;
  for (const solid of solids) {
    // Volumen del B-rep: negativo si el sólido está "dado vuelta" (normales hacia adentro).
    const brepVolume = volume(solid);
    // La malla que se exporta: cerrada (cada arista con un vecino) y con el mismo sentido de giro
    // en triángulos vecinos; si una cara está invertida, sus aristas se repiten en el mismo sentido.
    const raw = solid.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
    const m = weldMesh(raw.vertices, raw.triangles);
    const w = checkWatertight(m);
    openEdges += w.boundaryEdges;
    flippedEdges += w.nonManifoldEdges;
    if (brepVolume <= 0 || meshVolume(m) <= 0) invertedBodies++;
  }

  let overlappingPairs = 0;
  const n = Math.min(solids.length, MAX_OVERLAP_BODIES);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const range = new oc.Message_ProgressRange();
      const common = new oc.BRepAlgoAPI_Common(solids[i].wrapped, solids[j].wrapped, range);
      try {
        if (!common.IsDone() || common.HasErrors()) continue;
        const c = cast(common.Shape());
        if (volume(c) > 1e-6) overlappingPairs++;
        c.delete();
      } finally {
        common.delete();
        range.delete();
      }
    }
  }

  return {
    valid: isValidShape(shape),
    openEdges,
    flippedEdges,
    invertedBodies,
    overlappingPairs,
    checkedOverlap: solids.length <= MAX_OVERLAP_BODIES,
    sheetFaces: shape.faces.length - solids.reduce((n, sd) => n + sd.faces.length, 0),
  };
}
