/* Process configuration - env only, no flags, no config file. */

/** Toolsets this server can expose. "studio" carries the studio surface
 *  (image/video/avatar/audio job wrappers, plan runs, refs); "3d", "sites"
 *  and "blender" land as their wrappers are built. */
export const TOOLSETS = ["core", "studio", "3d", "sites", "blender"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface Env {
  url: string;
  key: string;
  toolsets: Set<string>;
  outDir: string;
}

export const DEFAULT_URL = "http://localhost:3000";
export const DEFAULT_OUT_DIR = "./motionfield-out";

/** Parse env. Missing MOTIONFIELD_API_KEY is fatal: stderr message, exit 2 -
 *  the key itself is never echoed anywhere. */
export function parseEnv(): Env {
  const key = process.env.MOTIONFIELD_API_KEY;
  if (!key) {
    process.stderr.write(
      "motionfield-mcp: MOTIONFIELD_API_KEY is required (MOTIONFIELD_URL defaults to " + DEFAULT_URL + ")\n");
    process.exit(2);
  }
  const url = (process.env.MOTIONFIELD_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const raw = (process.env.MOTIONFIELD_TOOLSETS ?? "core,3d").trim();
  const toolsets = raw.toLowerCase() === "all"
    ? new Set<string>(TOOLSETS)
    : new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return {
    url,
    key,
    toolsets,
    outDir: process.env.MOTIONFIELD_MCP_OUT_DIR ?? DEFAULT_OUT_DIR,
  };
}
