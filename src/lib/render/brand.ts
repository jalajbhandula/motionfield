import crypto from "crypto";
import { z } from "zod";
import { saveBytes } from "@/lib/storage";
import {
  dropBody,
  guardedFetch,
  readBody,
  type SafeFetchDeps,
} from "./safe-fetch";

/**
 * Brand context - fetch a public website's <title>/meta/colors/og:image to
 * give the LLM spec-writer real brand grounding.
 *
 * The SSRF boundary lives in ./safe-fetch (guardedFetch): only http/https,
 * every hop DNS-vetted public, redirects re-checked, size-capped reads.
 * The extracted data is untrusted - generate.ts embeds it in a delimited
 * <brand_context> block.
 */

export const brandContextSchema = z.strictObject({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  siteName: z.string().optional(),
  themeColor: z.string().optional(),
  colors: z.array(z.string()),
  /** og:image saved through storage → "/files/…" */
  ogImage: z.string().optional(),
  /** visible text excerpt for the LLM (tags stripped) */
  excerpt: z.string().optional(),
});
export type BrandContext = z.infer<typeof brandContextSchema>;

/** back-compat alias - callers pass {lookup, fetchImpl, signal} */
export type BrandDeps = SafeFetchDeps;

// the guard primitives moved to ./safe-fetch - re-exported so existing
// imports of "@/lib/render/brand" keep working
export { isPublicIp, publicOnlyLookup, guardedFetch } from "./safe-fetch";
export type { RequestLookup, LookupFn, FetchFn } from "./safe-fetch";

const MAX_HTML = 1 * 1024 * 1024;
const MAX_IMG = 4 * 1024 * 1024;

/* ---------- meta extraction ---------- */

function metaContent(html: string, key: string, attr: "name" | "property"): string | undefined {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return undefined;
  const c = /content=["']([^"']*)["']/i.exec(m[0]);
  return c?.[1];
}

export function extractBrand(html: string, pageUrl: string): Omit<BrandContext, "ogImage"> {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const colors = new Set<string>();
  const theme = metaContent(html, "theme-color", "name");
  if (theme && /^#[0-9a-f]{3,8}$/i.test(theme)) colors.add(theme);
  for (const m of html.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    if (colors.size >= 6) break;
    colors.add(m[0].toLowerCase());
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    url: pageUrl,
    title: title?.trim().slice(0, 200),
    description: metaContent(html, "description", "name")?.slice(0, 500),
    siteName: metaContent(html, "og:site_name", "property")?.slice(0, 200),
    themeColor: theme,
    colors: [...colors],
    excerpt: text.slice(0, 3000),
  };
}

/** og:image allowlist - extension comes from the declared content-type. */
const OG_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The declared type must also match the payload's magic bytes - a relabelled
 *  HTML/SVG payload never reaches storage. */
function magicMatches(bytes: Uint8Array, ctype: string): boolean {
  if (ctype === "image/png") return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (ctype === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ctype === "image/webp") {
    return bytes.length > 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 // RIFF
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50; // WEBP
  }
  return false;
}

export async function fetchBrandContext(url: string, deps: BrandDeps = {}): Promise<BrandContext> {
  const { res, finalUrl } = await guardedFetch(url, deps, "text/html");
  if (!res.ok) {
    dropBody(res);
    throw new Error(`site returned ${res.status}`);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/html")) {
    dropBody(res);
    throw new Error(`not an HTML page (${ctype.split(";")[0] || "unknown"})`);
  }
  const html = new TextDecoder().decode(await readBody(res, MAX_HTML));
  const ctx: BrandContext = { ...extractBrand(html, finalUrl) };

  const og = metaContent(html, "og:image", "property");
  if (og) {
    try {
      const imgUrl = new URL(og, finalUrl).toString();
      const got = await guardedFetch(imgUrl, deps, "image/png,image/jpeg,image/webp");
      const ict = (got.res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const ext = OG_IMAGE_EXT[ict];
      if (got.res.ok && ext) {
        const bytes = await readBody(got.res, MAX_IMG);
        if (magicMatches(bytes, ict)) {
          ctx.ogImage = await saveBytes(`generated/brand/${crypto.randomUUID()}.${ext}`, Buffer.from(bytes));
        }
      } else {
        dropBody(got.res);
      }
    } catch {
      // og:image is a nice-to-have - a blocked/broken image never kills the context
    }
  }
  return ctx;
}
