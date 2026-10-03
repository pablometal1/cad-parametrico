// Sistemas de coordenadas de los planos de sketch. Compartido por la UI y el kernel.
import type { BasePlane, SketchPlaneRef } from './types';

export type Vec3 = [number, number, number];

export interface PlaneFrame {
  origin: Vec3;
  /** Eje u del sketch en 3D. */
  xDir: Vec3;
  /** Eje v del sketch en 3D (normal × xDir). */
  yDir: Vec3;
  /** Normal del plano: dirección "normal" de extrusión. */
  normal: Vec3;
}

/** Igual que los planos con nombre de replicad (XZ mira hacia -Y, de modo que v = +Z). */
const BASE_FRAMES: Record<BasePlane, Omit<PlaneFrame, 'origin'>> = {
  XY: { xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
};

export function basePlaneFrame(ref: SketchPlaneRef): PlaneFrame {
  const f = BASE_FRAMES[ref.plane];
  return { ...f, origin: scale(f.normal, ref.offset) };
}

export function toWorld(frame: PlaneFrame, u: number, v: number): Vec3 {
  return [0, 1, 2].map((i) => frame.origin[i] + frame.xDir[i] * u + frame.yDir[i] * v) as Vec3;
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
