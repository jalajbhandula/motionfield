/**
 * cards.ts — render the title/outro/credits cards through the app's own
 * SceneSpec exporter (scripts/render/export.ts + /render/motion). The card
 * specs ship as JSON under scripts/demo/cards/ with {{TOKEN}} slots that
 * this file fills from real data (node class names parsed out of the
 * shipped Comfy pack, license badges resolved from the catalog, the music
 * credit) — nothing in the cards is invented text.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSceneSpec, type SceneSpec } from "../../src/lib/render/spec";
import { CARD_IDS, CARDS_DIR, nodeClassNames, type Badge } from "./shots";
import { REPO, parseArgs, resolveDemoOutDir } from "./util";

export interface CardMeta { id: string; file: string; duration_s: number }

/** One text layer per badge line — the credits card's layer count follows
 *  the badge list, so a shot gaining a model gains a credit line too. */
function badgeLayers(lines: string[]): unknown[] {
  const top = 130;
  return lines.map((t, i) => ({
    id: `badge_${i}`,
    type: "text",
    props: { text: t, size: 36, weight: 500, color: "#f2f5ff", reveal: 1 },
    transform: { position: [0, top - i * 82, 0] },
    keyframes: [
      { t: 0.5 + i * 0.35, path: "props.reveal", value: 0 },
      { t: 1.1 + i * 0.35, path: "props.reveal", value: 1, ease: "easeInOut" },
    ],
  }));
}

/** Fill {{TOKEN}} slots (and the "__BADGE_LINES__" layer-list marker) in a
 *  card spec, then zod-parse — a token left unfilled fails loudly instead of
 *  rendering. */
export function resolveCard(id: string, tokens: Record<string, string>, layers: Record<string, unknown[]> = {}): SceneSpec {
  const raw = fs.readFileSync(path.join(CARDS_DIR, `${id}.json`), "utf8");
  let out = raw;
  for (const [k, v] of Object.entries(layers)) out = out.split(`"__${k}__"`).join(v.map((x) => JSON.stringify(x)).join(","));
  for (const [k, v] of Object.entries(tokens)) out = out.split(`{{${k}}}`).join(v);
  const leftover = out.match(/\{\{[A-Z0-9_]+\}\}|"__[A-Z0-9_]+__"/g);
  if (leftover) throw new Error(`card ${id}.json has unresolved tokens: ${[...new Set(leftover)].join(", ")}`);
  return parseSceneSpec(JSON.parse(out));
}

function splitColumns(items: string[], perLine: number): [string, string] {
  const a = items.slice(0, perLine).join("   ");
  const b = items.slice(perLine).join("   ");
  return [a, b || "·"];
}

/** The credits card keeps every shot's badge + the demo brain + the node
 *  pack — deduped by name so repeated endpoints don't double-list. */
export function creditLines(badges: Badge[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const b of badges) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    lines.push(`${b.name} · ${b.license}`);
  }
  return lines;
}

export function buildCardSpecs(opts: { badges: Badge[]; musicCredit: string }): Record<string, SceneSpec> {
  const nodes = nodeClassNames();
  const [nodesA, nodesB] = splitColumns(nodes, 6);
  const credits = creditLines(opts.badges);
  return {
    title: resolveCard("title", { SUBLINE: "the open creative surface — ws1 demo" }),
    outro: resolveCard("outro", { NODES_A: nodesA, NODES_B: nodesB }),
    credits: resolveCard("credits", { MUSIC: opts.musicCredit }, { BADGE_LINES: badgeLayers(credits) }),
  };
}

/** Render each card spec through scripts/render/export.ts against the
 *  running app's /render/motion (specs are real renders, not stills). */
export function renderCards(opts: {
  out: string;                 // demo out root
  base: string;
  specs: Record<string, SceneSpec>;
}): CardMeta[] {
  const specDir = path.join(opts.out, "cards", "spec");
  const mp4Dir = path.join(opts.out, "cards", "mp4");
  fs.mkdirSync(specDir, { recursive: true });
  fs.mkdirSync(mp4Dir, { recursive: true });
  const metas: CardMeta[] = [];
  for (const id of CARD_IDS) {
    const spec = opts.specs[id];
    if (!spec) throw new Error(`no card spec for ${id}`);
    const specFile = path.join(specDir, `${id}.json`);
    const mp4 = path.join(mp4Dir, `${id}.mp4`);
    fs.writeFileSync(specFile, JSON.stringify(spec));
    execFileSync(process.execPath, [
      "--experimental-strip-types", path.join(REPO, "scripts", "render", "export.ts"),
      "--spec", specFile, "--out", mp4, "--base", opts.base,
    ], { stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
    metas.push({ id, file: mp4, duration_s: spec.duration });
  }
  return metas;
}

/* -------------------------------- CLI ---------------------------------- */

const isMain = !!process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/demo/cards.ts");
if (isMain) {
  void (async () => {
    const { opts } = parseArgs(process.argv.slice(2));
    const out = resolveDemoOutDir(String(opts.out ?? "/tmp/of-demo-dev"));
    const base = String(opts.base ?? "http://localhost:3110");
    const { badgesForEndpoints, nodePackBadge } = await import("./shots");
    const specs = buildCardSpecs({
      badges: [
        ...badgesForEndpoints(["motionfield/person-swap/v1.0", "motionfield/director/generate", "motionfield/reshoot/video"]),
        nodePackBadge(),
      ],
      musicCredit: "music: ACE-Step 1.5 · MIT (mock bed for dry run)",
    });
    const metas = renderCards({ out, base, specs });
    for (const m of metas) console.log(`card ${m.id} → ${m.file}`);
  })().catch((e) => { console.error(`cards: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
