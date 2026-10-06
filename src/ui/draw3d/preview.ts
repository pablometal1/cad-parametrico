// Geometría de la vista previa del dibujo directo en 3D (pura: se prueba sin navegador).
import { toWorld, type PlaneFrame, type Vec3 } from '../../document/planes';
import { dist } from '../../sketch/geometry';
import type { Vec2 } from '../../sketch/model';
import type { Pending } from '../sketch/session';

/** Segmentos 2D (pares de puntos) de lo que se está dibujando, hasta el cursor. */
export function previewSegments2D(pending: Pending | null, cursor: Vec2 | null): Vec2[] {
  if (!pending || !cursor) return [];
  switch (pending.tool) {
    case 'line':
      return [pending.start.pos, cursor];
    case 'rectangle': {
      const [x0, y0] = pending.corner.pos;
      const [x1, y1] = cursor;
      return [[x0, y0], [x1, y0], [x1, y0], [x1, y1], [x1, y1], [x0, y1], [x0, y1], [x0, y0]];
    }
    case 'circle':
      return polyline(circlePoints(pending.center.pos, dist(pending.center.pos, cursor), 0, Math.PI * 2));
    case 'arc': {
      const c = pending.center.pos;
      if (!pending.start) return [c, cursor];
      const r = dist(c, pending.start.pos);
      const a0 = Math.atan2(pending.start.pos[1] - c[1], pending.start.pos[0] - c[0]);
      let a1 = Math.atan2(cursor[1] - c[1], cursor[0] - c[0]);
      while (a1 <= a0) a1 += Math.PI * 2;
      return [c, pending.start.pos, ...polyline(circlePoints(c, r, a0, a1))];
    }
  }
}

/** Texto de medidas en vivo (largo, ancho × alto, radio). */
export function previewLabel(pending: Pending | null, cursor: Vec2 | null): string | null {
  if (!pending || !cursor) return null;
  const f = (v: number) => String(Math.round(v * 100) / 100);
  switch (pending.tool) {
    case 'line':
      return `${f(dist(pending.start.pos, cursor))} mm`;
    case 'rectangle':
      return `${f(Math.abs(cursor[0] - pending.corner.pos[0]))} × ${f(Math.abs(cursor[1] - pending.corner.pos[1]))} mm`;
    case 'circle':
      return `R ${f(dist(pending.center.pos, cursor))} mm`;
    case 'arc': {
      if (!pending.start) return `R ${f(dist(pending.center.pos, cursor))} mm`;
      const c = pending.center.pos;
      const a0 = Math.atan2(pending.start.pos[1] - c[1], pending.start.pos[0] - c[0]);
      let a1 = Math.atan2(cursor[1] - c[1], cursor[0] - c[0]);
      while (a1 <= a0) a1 += Math.PI * 2;
      return `${f(((a1 - a0) * 180) / Math.PI)}°`;
    }
  }
}

/** Pasa segmentos del plano del sketch a 3D (xyz consecutivos). */
export function toWorldSegments(frame: PlaneFrame, segs: Vec2[]): number[] {
  const out: number[] = [];
  for (const [u, v] of segs) out.push(...toWorld(frame, u, v));
  return out;
}

/** Ajuste a la grilla (paso en mm). */
export function snapToGrid(p: Vec2, step: number): Vec2 {
  return [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
}

/** Paso de grilla "redondo" (1, 2, 5 × 10^n) para que una celda mida unos `targetPx` píxeles. */
export function gridStep(mmPerPx: number, targetPx = 18): number {
  const raw = mmPerPx * targetPx;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
}

export function worldPoint(frame: PlaneFrame, p: Vec2): Vec3 {
  return toWorld(frame, p[0], p[1]);
}

function circlePoints(c: Vec2, r: number, a0: number, a1: number): Vec2[] {
  const n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 64));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return pts;
}

/** Polilínea → pares de segmentos. */
function polyline(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push(pts[i], pts[i + 1]);
  return out;
}
