// Contains code adapted from three.js (TTFLoader/FontLoader) - MIT licensed,
// Copyright © 2010-2026 three.js authors.
import { Font } from "three/examples/jsm/loaders/FontLoader.js";
import type { FontData } from "three/examples/jsm/loaders/FontLoader.js";
import type opentype from "opentype.js";

/**
 * Runtime TTF → three.js Font bridge for the `text3d` layer.
 *
 * three r186's own TTFLoader imports opentype.js from a CDN specifier
 * (https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/+esm), which bundlers and
 * offline/headless environments can't resolve - so we parse the TTF with the
 * same opentype.js release (npm, MIT) and feed Font the same typeface-JSON
 * shape FontLoader produces. opentype.js is imported dynamically inside
 * getRenderFont - specs without a text3d layer never pay its bundle cost.
 */

type OtFont = ReturnType<typeof opentype.parse>;

/** Adapted from three.js TTFLoader.parse (MIT) - glyph outlines → typeface JSON. */
function ttfToFontData(font: OtFont): FontData {
  const round = Math.round;
  const glyphs: FontData["glyphs"] = {};
  const scale = 100000 / ((font.unitsPerEm || 2048) * 72);
  const glyphIndexMap = font.encoding.cmap.glyphIndexMap;
  for (const unicode of Object.keys(glyphIndexMap)) {
    const glyph = font.glyphs.glyphs[glyphIndexMap[unicode]];
    if (!glyph) continue;
    const token: { ha: number; x_min: number; x_max: number; o: string } = {
      ha: round(glyph.advanceWidth * scale),
      x_min: round(glyph.xMin * scale),
      x_max: round(glyph.xMax * scale),
      o: "",
    };
    for (const cmd of glyph.path.commands) {
      const c = cmd.type.toLowerCase() === "c" ? { ...cmd, type: "b" } : cmd;
      token.o += c.type.toLowerCase() + " ";
      if (c.x !== undefined && c.y !== undefined) token.o += `${round(c.x * scale)} ${round(c.y * scale)} `;
      if (c.x1 !== undefined && c.y1 !== undefined) token.o += `${round(c.x1 * scale)} ${round(c.y1 * scale)} `;
      if (c.x2 !== undefined && c.y2 !== undefined) token.o += `${round(c.x2 * scale)} ${round(c.y2 * scale)} `;
    }
    const unicodes = Array.isArray(glyph.unicodes) && glyph.unicodes.length ? glyph.unicodes : [glyph.unicode];
    for (const u of unicodes) if (u !== undefined) glyphs[String.fromCodePoint(u)] = token;
  }
  return {
    glyphs,
    familyName: font.getEnglishName("fullName"),
    ascender: round(font.ascender * scale),
    descender: round(font.descender * scale),
    underlinePosition: font.tables.post.underlinePosition,
    underlineThickness: font.tables.post.underlineThickness,
    boundingBox: {
      xMin: font.tables.head.xMin,
      xMax: font.tables.head.xMax,
      yMin: font.tables.head.yMin,
      yMax: font.tables.head.yMax,
    },
    resolution: 1000,
    original_font_information: font.tables.name as unknown as Record<string, string>,
  };
}

const cache = new Map<string, Promise<Font>>();

/** Fetch + parse + cache a TTF as a three.js Font. One in-flight load per URL. */
export function getRenderFont(url: string): Promise<Font> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      const ot = (await import("opentype.js")).default;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font fetch failed (${res.status}) for ${url}`);
      const buf = await res.arrayBuffer();
      return new Font(ttfToFontData(ot.parse(buf)));
    })();
    cache.set(url, p);
    p.catch(() => cache.delete(url)); // a failed font may succeed on retry
  }
  return p;
}
