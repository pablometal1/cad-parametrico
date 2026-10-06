// Texto en sketches: contornos de las letras (Roboto) como líneas y curvas de Bézier, en
// coordenadas del sketch. Lo usan el editor (vista previa), la vista 3D y el kernel (caras).
import opentype from 'opentype.js';
import regularUrl from '@fontsource/roboto/files/roboto-latin-400-normal.woff?inline';
import boldUrl from '@fontsource/roboto/files/roboto-latin-700-normal.woff?inline';
import type { SketchText } from '../document/types';
import type { Vec2 } from './model';

/** Tramo de un contorno: recta (2 puntos) o Bézier cuadrática (3) / cúbica (4). */
export type TextSegment = Vec2[];
/** Contorno cerrado (el último punto coincide con el primero del primer tramo). */
export type TextContour = TextSegment[];

type Font = ReturnType<typeof opentype.parse>;
let fonts: { regular: Font; bold: Font } | null = null;
let loading: Promise<void> | null = null;

function decode(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Carga las fuentes (una sola vez). Hay que esperarla antes de evaluar sketches con texto. */
export function loadFonts(): Promise<void> {
  loading ??= Promise.resolve().then(() => {
    fonts = { regular: opentype.parse(decode(regularUrl)), bold: opentype.parse(decode(boldUrl)) };
  });
  return loading;
}

export function fontsLoaded() {
  return fonts !== null;
}

/**
 * Contornos del texto, con la esquina inferior izquierda de la primera letra (sobre la línea de
 * base) en `anchor`. `height` es la altura de las mayúsculas; `angle` gira el texto en grados.
 */
export function textContours(t: Pick<SketchText, 'text' | 'height' | 'angle' | 'bold'>, anchor: Vec2): TextContour[] {
  if (!fonts) throw new Error('Las fuentes todavía no están cargadas');
  const font = t.bold ? fonts.bold : fonts.regular;
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  const cap = os2?.sCapHeight || font.unitsPerEm * 0.7;
  const size = (t.height * font.unitsPerEm) / cap;
  const rad = (t.angle * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // La ruta de opentype tiene y hacia abajo: se invierte, se gira y se traslada.
  const tr = (x: number, y: number): Vec2 => [anchor[0] + x * c + y * s, anchor[1] + x * s - y * c];

  const contours: TextContour[] = [];
  let x = 0;
  let prev: ReturnType<Font['charToGlyph']> | null = null;
  // Sin "shaping" de opentype (falla con algunas tablas de Roboto): letra por letra con kerning.
  for (const ch of t.text) {
    const g = font.charToGlyph(ch);
    if (prev) x += (font.getKerningValue(prev, g) * size) / font.unitsPerEm;
    const path = g.getPath(x, 0, size);
    let cur: TextContour | null = null;
    let start: Vec2 = [0, 0];
    let last: Vec2 = [0, 0];
    const close = () => {
      if (cur && cur.length) {
        // Cierra el contorno si la fuente no lo hizo.
        if (Math.hypot(last[0] - start[0], last[1] - start[1]) > 1e-9) cur.push([last, start]);
        contours.push(cur);
      }
      cur = null;
    };
    for (const cmd of path.commands as { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]) {
      if (cmd.type === 'M') {
        close();
        cur = [];
        start = last = tr(cmd.x!, cmd.y!);
      } else if (cmd.type === 'L') {
        const p = tr(cmd.x!, cmd.y!);
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) cur?.push([last, p]);
        last = p;
      } else if (cmd.type === 'Q') {
        const p = tr(cmd.x!, cmd.y!);
        cur?.push([last, tr(cmd.x1!, cmd.y1!), p]);
        last = p;
      } else if (cmd.type === 'C') {
        const p = tr(cmd.x!, cmd.y!);
        cur?.push([last, tr(cmd.x1!, cmd.y1!), tr(cmd.x2!, cmd.y2!), p]);
        last = p;
      } else if (cmd.type === 'Z') {
        close();
      }
    }
    close();
    x += ((g.advanceWidth ?? 0) * size) / font.unitsPerEm;
    prev = g;
  }
  return contours;
}

/** Polilínea de un contorno (las curvas en `steps` tramos). */
export function flattenContour(contour: TextContour, steps = 6): Vec2[] {
  const pts: Vec2[] = [];
  for (const seg of contour) {
    if (pts.length === 0) pts.push(seg[0]);
    if (seg.length === 2) {
      pts.push(seg[1]);
      continue;
    }
    for (let k = 1; k <= steps; k++) pts.push(bezier(seg, k / steps));
  }
  return pts;
}

function bezier(p: Vec2[], t: number): Vec2 {
  // De Casteljau: sirve para cuadráticas y cúbicas.
  let pts = p;
  while (pts.length > 1) {
    const next: Vec2[] = [];
    for (let i = 0; i + 1 < pts.length; i++) next.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
    pts = next;
  }
  return pts[0];
}

/** Área con signo de una polilínea cerrada (positiva = antihoraria). */
export function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Agrupa los contornos de un texto en regiones: contorno exterior y sus agujeros (la panza de la
 * "o", el ojo de la "A"…), según cuántos contornos rodean a cada uno (par = exterior).
 */
export function textRegions(contours: TextContour[]): { outer: TextContour; holes: TextContour[] }[] {
  const polys = contours.map((c) => flattenContour(c));
  const area = polys.map((p) => Math.abs(signedArea(p)));
  const depth = polys.map((p, i) => polys.filter((q, j) => j !== i && area[j] > area[i] && pointInPolygon(p[0], q)).length);
  const regions: { index: number; holes: number[] }[] = [];
  polys.forEach((_, i) => {
    if (depth[i] % 2 === 0) regions.push({ index: i, holes: [] });
  });
  polys.forEach((p, i) => {
    if (depth[i] % 2 === 0) return;
    // El exterior más chico que lo contiene.
    const parent = regions
      .filter((r) => area[r.index] > area[i] && pointInPolygon(p[0], polys[r.index]))
      .sort((a, b) => area[a.index] - area[b.index])[0];
    parent?.holes.push(i);
  });
  return regions.map((r) => ({ outer: contours[r.index], holes: r.holes.map((h) => contours[h]) }));
}
