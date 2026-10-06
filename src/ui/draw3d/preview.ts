// Geometría de la vista previa del dibujo directo en 3D (pura: se prueba sin navegador).
import { toWorld, type PlaneFrame, type Vec3 } from '../../document/planes';
import { dist } from '../../sketch/geometry';
import type { Vec2 } from '../../sketch/model';
import { slotRadius, type Pending } from '../sketch/session';

/** Segmentos 2D (pares de puntos) de lo que se está dibujando, hasta el cursor. */
export function previewSegments2D(pending: Pending | null, cursor: Vec2 | null, sides = 6): Vec2[] {
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
    case 'centerRect': {
      const [cx, cy] = pending.center.pos;
      const dx = Math.abs(cursor[0] - cx);
      const dy = Math.abs(cursor[1] - cy);
      const k: Vec2[] = [[cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy]];
      return [k[0], k[1], k[1], k[2], k[2], k[3], k[3], k[0], k[0], k[2], k[1], k[3]];
    }
    case 'polygon': {
      const c = pending.center.pos;
      const r = dist(c, cursor);
      const a0 = Math.atan2(cursor[1] - c[1], cursor[0] - c[0]);
      const n = sides;
      const pts: Vec2[] = [];
      for (let i = 0; i <= n; i++) pts.push([c[0] + r * Math.cos(a0 + (2 * Math.PI * i) / n), c[1] + r * Math.sin(a0 + (2 * Math.PI * i) / n)]);
      return polyline(pts);
    }
    case 'slot': {
      if (!pending.c2) return [pending.c1.pos, cursor];
      return slotOutline(pending.c1.pos, pending.c2.pos, slotRadius(pending.c1.pos, pending.c2.pos, cursor));
    }
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
    case 'polygon':
      return `R ${f(dist(pending.center.pos, cursor))} mm`;
    case 'centerRect':
      return `${f(2 * Math.abs(cursor[0] - pending.center.pos[0]))} × ${f(2 * Math.abs(cursor[1] - pending.center.pos[1]))} mm`;
    case 'slot':
      return pending.c2
        ? `ancho ${f(2 * slotRadius(pending.c1.pos, pending.c2.pos, cursor))} mm`
        : `${f(dist(pending.c1.pos, cursor))} mm`;
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

/** Contorno de una ranura (dos semicírculos y dos lados). */
export function slotOutline(c1: Vec2, c2: Vec2, r: number): Vec2[] {
  const L = dist(c1, c2);
  if (L < 1e-9 || r < 1e-9) return [c1, c2];
  const a = Math.atan2(c2[1] - c1[1], c2[0] - c1[0]);
  const half = Math.PI / 2;
  const pts = [
    ...circlePoints(c2, r, a - half, a + half),
    ...circlePoints(c1, r, a + half, a + 3 * half),
  ];
  pts.push(pts[0]);
  return polyline(pts);
}
