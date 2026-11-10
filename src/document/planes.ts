// Sistemas de coordenadas de los planos de sketch. Compartido por la UI y el kernel.
import type { BasePlane, SketchPlaneRef } from './types';

type BasePlaneRef = Extract<SketchPlaneRef, { kind: 'base' }>;

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

export function basePlaneFrame(ref: BasePlaneRef): PlaneFrame {
  const f = BASE_FRAMES[ref.plane];
  return { ...f, origin: scale(f.normal, ref.offset) };
}

/**
 * Sistema de coordenadas de un sketch sobre una cara plana con normal `normal` que pasa por `point`.
 * - Origen: proyección del origen global sobre el plano (estable si la cara cambia de tamaño).
 * - Eje u: proyección del eje X global (o del Y si la normal es paralela a X).
 * - Eje v: normal × u (sistema derecho visto desde afuera de la cara).
 * Para caras con la misma normal que un plano base (XY, XZ, YZ) coincide con ese plano.
 */
export function faceFrame(point: Vec3, normal: Vec3, offset = 0): PlaneFrame {
  const n = normalize(normal);
  const d = dot(point, n) + offset;
  const ref: Vec3 = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const xDir = normalize(sub(ref, scale(n, dot(ref, n))));
  const yDir = cross(n, xDir);
  return { origin: scale(n, d), xDir, yDir, normal: n };
}

/** Coordenadas (u, v) de un punto 3D en el plano. */
export function toPlane(frame: PlaneFrame, p: Vec3): [number, number] {
  const r = sub(p, frame.origin);
  return [dot(r, frame.xDir), dot(r, frame.yDir)];
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function toWorld(frame: PlaneFrame, u: number, v: number): Vec3 {
  return [0, 1, 2].map((i) => frame.origin[i] + frame.xDir[i] * u + frame.yDir[i] * v) as Vec3;
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** Gira un vector `deg` grados alrededor del eje unitario `k` (Rodrigues). */
export function rotate(v: Vec3, k: Vec3, deg: number): Vec3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [0, 1, 2].map((i) => v[i] * c + kv[i] * s + k[i] * kd) as Vec3;
}

const AXIS_DIRS: Record<'X' | 'Y' | 'Z', Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/**
 * Plano de construcción a partir de una referencia: giro alrededor de un eje paralelo a X/Y/Z
 * que pasa por el origen de la referencia, y después desplazamiento sobre la nueva normal.
 */
export function constructionFrame(
  ref: PlaneFrame, axis: 'none' | 'X' | 'Y' | 'Z' | { point: Vec3; dir: Vec3 }, angle: number, distance: number,
): PlaneFrame {
  let { origin, xDir, yDir, normal } = ref;
  if (axis !== 'none' && angle !== 0) {
    // Eje global (por el origen de la referencia) o una recta cualquiera (arista del modelo).
    const k = typeof axis === 'string' ? AXIS_DIRS[axis] : normalize(axis.dir);
    const pivot = typeof axis === 'string' ? ref.origin : axis.point;
    xDir = normalize(rotate(xDir, k, angle));
    yDir = normalize(rotate(yDir, k, angle));
    normal = normalize(rotate(normal, k, angle));
    const r = rotate(sub(origin, pivot), k, angle);
    origin = add(pivot, r);
  }
  const moved = add(origin, scale(normal, distance));
  return { origin: moved, xDir, yDir, normal };
}

/** Desplaza un plano a lo largo de su normal. */
export function offsetFrame(f: PlaneFrame, offset: number): PlaneFrame {
  return offset ? { ...f, origin: add(f.origin, scale(f.normal, offset)) } : f;
}
