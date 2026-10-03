// Curvas de un sketch evaluado como segmentos 3D, para mostrarlas en el viewport.
import { toWorld } from '../document/planes';
import { sampleCurve } from '../sketch/geometry';
import { SketchIndex } from '../sketch/model';
import type { EvaluatedSketch } from './features/sketch';

export function sketchSegments(s: EvaluatedSketch): { segments: Float32Array; construction: Float32Array } {
  const index = new SketchIndex(s.data);
  const normal: number[] = [];
  const aux: number[] = [];
  for (const c of index.curves()) {
    const pts = sampleCurve(index, c).map(([u, v]) => toWorld(s.frame, u, v));
    const out = c.construction ? aux : normal;
    for (let i = 0; i + 1 < pts.length; i++) out.push(...pts[i], ...pts[i + 1]);
  }
  return { segments: new Float32Array(normal), construction: new Float32Array(aux) };
}
