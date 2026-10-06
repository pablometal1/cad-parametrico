// Tipos mínimos de opentype.js (el paquete no trae declaraciones).
declare module 'opentype.js' {
  interface Glyph {
    advanceWidth?: number;
    getPath(x: number, y: number, fontSize: number): { commands: { type: string }[] };
  }
  interface Font {
    unitsPerEm: number;
    tables: Record<string, unknown>;
    charToGlyph(ch: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  const opentype: { parse(buffer: ArrayBuffer): Font };
  export default opentype;
}
