import { describe, it, expect } from 'vitest';
import { ICONS } from '../src/ui/iconPaths';
import { DRAW_KEYS, DRAW_TOOLS, FEATURE_KEYS, FEATURE_TOOLS, SHORTCUT_SECTIONS } from '../src/ui/tools';

describe('barra de herramientas y atajos', () => {
  it('cada herramienta tiene una tecla propia', () => {
    const draw = DRAW_TOOLS.map((t) => t.key);
    expect(new Set(draw).size).toBe(draw.length);
    expect(Object.keys(DRAW_KEYS)).toHaveLength(DRAW_TOOLS.length);
    const feat = FEATURE_TOOLS.map((t) => t.key);
    expect(new Set(feat).size).toBe(feat.length);
    expect(Object.keys(FEATURE_KEYS)).toHaveLength(FEATURE_TOOLS.length);
    for (const k of feat) expect(k).toMatch(/^Shift\+[A-Z]$/);
  });

  it('las teclas de dibujo no pisan los atajos generales', () => {
    // F encuadra, K abre el menú de sketch, G alterna la grilla mientras se dibuja.
    for (const reserved of ['f', 'k', 'g']) expect(DRAW_KEYS[reserved]).toBeUndefined();
    // Shift+X abre los parámetros.
    expect(FEATURE_KEYS.x).toBeUndefined();
  });

  it('la ayuda lista todos los atajos sin repetir', () => {
    const rows = SHORTCUT_SECTIONS.flatMap((s) => s.rows);
    const keys = new Set(rows.map(([k]) => k));
    for (const t of [...DRAW_TOOLS, ...FEATURE_TOOLS]) expect(keys.has(t.key)).toBe(true);
    for (const s of SHORTCUT_SECTIONS) {
      const own = s.rows.map(([k]) => k);
      expect(new Set(own).size, s.title).toBe(own.length);
    }
  });

  it('los íconos son SVG simples y bien cerrados', () => {
    const element = /<(path|circle|rect|ellipse)(\s+[a-z-]+="[^"]*")+\s*\/>/g;
    for (const [name, markup] of Object.entries(ICONS)) {
      expect(markup.replace(element, ''), name).toBe('');
      expect(markup.length, name).toBeGreaterThan(10);
    }
    for (const t of [...DRAW_TOOLS, ...FEATURE_TOOLS]) expect(ICONS[t.icon]).toBeDefined();
  });
});
