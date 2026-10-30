/** Minimal typing for the opentype.js 1.3.4 ESM build - only the surface
 *  font.ts's TTF→typeface-JSON conversion touches. */
declare module "opentype.js" {
  interface PathCommand {
    type: string;
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  interface OtGlyph {
    advanceWidth: number;
    xMin: number;
    xMax: number;
    unicode?: number;
    unicodes?: number[];
    path: { commands: PathCommand[] };
  }
  interface OtFont {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    encoding: { cmap: { glyphIndexMap: Record<string, number> } };
    glyphs: { glyphs: OtGlyph[] };
    tables: {
      post: { underlinePosition: number; underlineThickness: number };
      head: { xMin: number; xMax: number; yMin: number; yMax: number };
      name: Record<string, unknown>;
    };
    getEnglishName(key: string): string;
  }
  const opentype: { parse(buffer: ArrayBuffer): OtFont };
  export default opentype;
}
