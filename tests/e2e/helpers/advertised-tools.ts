import { execFileSync } from "node:child_process";

/* The advertised MCP tool set for a given toolset list - computed, never
 *  hard-coded. Mirrors `toolAvailable()` in packages/mcp/src/registry.mts:
 *  pending tools never list; then enabled toolset AND (no gate declared OR
 *  capability reported OR any declared endpoint in the model catalog). The
 *  .mts sources load through node --experimental-strip-types because the
 *  root tsconfig can't import .mts directly. */

export interface ToolDefLite {
  name: string;
  toolset: string;
  capability: string | null;
  endpoints: string[] | null;
  pending: boolean;
}

export const toolDefs = (): ToolDefLite[] =>
  JSON.parse(execFileSync("node", ["--experimental-strip-types", "-e",
    `import("./packages/mcp/src/tools/index.mts").then(m => console.log(JSON.stringify(m.TOOLS.map(t => ({ name: t.name, toolset: t.toolset, capability: t.capability ?? null, endpoints: t.endpoints ?? null, pending: t.pending ?? false })))))`],
    { encoding: "utf8", timeout: 30_000 })) as ToolDefLite[];

export const advertisedSet = (
  toolsets: string[],
  caps: readonly string[],
  endpoints: readonly string[],
): string[] => {
  const enabled = new Set(toolsets);
  const capSet = new Set(caps);
  const epSet = new Set(endpoints);
  return toolDefs()
    .filter((t) => !t.pending)
    .filter((t) => enabled.has(t.toolset))
    .filter((t) =>
      (t.capability === null && !(t.endpoints?.length)) ||
      (t.capability !== null && capSet.has(t.capability)) ||
      (t.endpoints ?? []).some((e) => epSet.has(e)))
    .map((t) => t.name)
    .sort();
};
