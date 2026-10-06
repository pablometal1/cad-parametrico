import { describe, it, expect } from 'vitest';
import { isShadingMode, matcapPixels, nextShading, SHADING_MODES, type ShadingMode } from '../src/viewport/shading';
import { DRAW_KEYS } from '../src/ui/tools';

const SIZE = 64;
/** Luminancia (0..255) del píxel (i, j); j = 0 es la fila de abajo. */
function lum(px: Uint8Array, i: number, j: number) {
  const o = 4 * (j * SIZE + i);
  return 0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2];
}

describe('sombreado de análisis', () => {
  it('Z recorre todos los modos y vuelve al estándar', () => {
    let m: ShadingMode = 'standard';
    const seen = new Set<ShadingMode>();
    for (let k = 0; k < SHADING_MODES.length; k++) {
      seen.add(m);
      m = nextShading(m);
    }
    expect(m).toBe('standard');
    expect(seen.size).toBe(SHADING_MODES.length);
    expect(isShadingMode('zebra')).toBe(true);
    expect(isShadingMode('otro')).toBe(false);
    expect(isShadingMode(null)).toBe(false);
    expect(DRAW_KEYS.z).toBeUndefined();
  });

  it('matcap arcilla: esfera opaca, iluminada arriba a la izquierda', () => {
    const px = matcapPixels('clay', SIZE);
    expect(px).toHaveLength(SIZE * SIZE * 4);
    for (let o = 3; o < px.length; o += 4) expect(px[o]).toBe(255);
    const upperLeft = lum(px, Math.round(SIZE * 0.35), Math.round(SIZE * 0.65));
    const lowerRight = lum(px, Math.round(SIZE * 0.7), Math.round(SIZE * 0.3));
    expect(upperLeft).toBeGreaterThan(lowerRight + 40);
    // Sin saltos bruscos: la arcilla no debe inventar bordes.
    for (let j = 1; j < SIZE * 0.8; j++) {
      expect(Math.abs(lum(px, SIZE / 2, j) - lum(px, SIZE / 2, j - 1))).toBeLessThan(30);
    }
  });

  it('matcap cromo: cara de frente clara y un horizonte nítido más abajo', () => {
    const px = matcapPixels('chrome', SIZE);
    const c = SIZE / 2;
    expect(lum(px, c, c)).toBeGreaterThan(140);
    // Bajando por la columna central aparece una transición fuerte (el horizonte).
    let maxJump = 0;
    let darkest = 255;
    for (let j = 1; j < c; j++) {
      maxJump = Math.max(maxJump, Math.abs(lum(px, c, j) - lum(px, c, j - 1)));
      darkest = Math.min(darkest, lum(px, c, j));
    }
    expect(maxJump).toBeGreaterThan(40);
    expect(darkest).toBeLessThan(40);
  });
});
