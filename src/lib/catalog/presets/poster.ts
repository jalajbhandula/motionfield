/** Poster convention: a verified preview lives at
 *  `public/examples/<catalog>/<id>.(webp|mp4|png|jpg)`. Same lazy-fs pattern
 *  as the verify store - undefined in client bundles and when no real asset
 *  exists yet, so tiles keep their neutral poster until evidence lands. */
export function posterFor(catalog: string, id: string): string | undefined {
  const get = globalThis.process?.getBuiltinModule?.bind(globalThis.process);
  if (!get) return undefined;
  const fs = get("node:fs") as typeof import("node:fs");
  const path = get("node:path") as typeof import("node:path");
  for (const ext of ["webp", "mp4", "png", "jpg"]) {
    const p = `/examples/${catalog}/${id}.${ext}`;
    if (fs.existsSync(path.join(process.cwd(), "public", p))) return p;
  }
  return undefined;
}
