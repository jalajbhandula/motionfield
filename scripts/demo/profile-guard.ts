/**
 * Demo profile guard — the Oct-28 demo must stay open-weights, local-first.
 * The profile pins the planner brain + the MCP client; this guard refuses
 * closed/remote picks before any capture runs, so a drive-by edit to
 * profile.json can't quietly sneak a hosted model into the story.
 *
 * CLI: `npx tsx scripts/demo/profile-guard.ts [profile.json]` → 0 ok, 1 refuse.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { providerById } from "../../src/lib/llm/providers";
import { REPO } from "./util";

export const profileSchema = z.strictObject({
  version: z.literal(1),
  brain: z.strictObject({
    provider: z.string().min(1),
    model: z.string().min(1).max(120),
    license: z.string().min(1).max(80),
    base_url: z.string().max(300),
  }),
  mcp: z.strictObject({
    client: z.enum(["opencode", "claude-code", "cursor", "codex", "generic"]),
    tool_sequence: z.array(z.string().min(1).max(80)).min(1),
    note: z.string().max(500).optional(),
  }),
});
export type DemoProfile = z.infer<typeof profileSchema>;

/** Model names that are always closed-source weights — refused regardless of
 *  provider. Local-only ids (qwen*, llama*, deepseek on ollama, …) pass. */
const CLOSED_MODEL = /(^|[/:\s_-])(gpt|o[134](?:-|\.|pro|mini)|claude|opus|sonnet|haiku|gemini|grok|dall-?e|imagen|veo|sora|runway|kling|pika|luma|minimax|kimi|moonshot|mistral-medium|command-r|clyde|jetmo)/i;

function loopbackOnly(baseUrl: string): boolean {
  if (!baseUrl) return true; // "" = provider default (local presets all loop back)
  try {
    const u = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(u.hostname)
      || u.hostname.endsWith(".localhost");
  } catch { return false; }
}

export function checkProfile(profile: DemoProfile): string[] {
  const problems: string[] = [];
  const preset = providerById(profile.brain.provider);
  if (!preset) problems.push(`brain.provider "${profile.brain.provider}" is not a registered provider`);
  else if (!preset.local)
    problems.push(`brain.provider "${preset.id}" (${preset.label}) is a remote endpoint — the demo brain must run on-box`);
  if (!loopbackOnly(profile.brain.base_url))
    problems.push(`brain.base_url "${profile.brain.base_url}" is not a loopback address`);
  if (CLOSED_MODEL.test(profile.brain.model))
    problems.push(`brain.model "${profile.brain.model}" names a closed-weights model`);
  return problems;
}

export function loadProfile(file = path.join(REPO, "scripts", "demo", "profile.json")): DemoProfile {
  const parsed = profileSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new Error(`profile.json invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const problems = checkProfile(parsed.data);
  if (problems.length) throw new Error(`profile refused:\n  - ${problems.join("\n  - ")}`);
  return parsed.data;
}

/* ------------------------------- CLI ---------------------------------- */

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/profile-guard.ts");
if (isMain) {
  const file = process.argv[2] ?? path.join(REPO, "scripts", "demo", "profile.json");
  try {
    const raw = profileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    const problems = checkProfile(raw);
    if (problems.length) {
      for (const p of problems) console.error(`refuse: ${p}`);
      process.exit(1);
    }
    console.log(`profile ok — brain ${raw.brain.model} via ${raw.brain.provider}, mcp client ${raw.mcp.client}`);
  } catch (e) {
    console.error(`refuse: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
