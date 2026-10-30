import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GENRES, GENRE_GOALS, buildGameSpec, draftOf, gameDraftSchema, gameSpecSchema, normalizeDraft, type GameDraft,
} from "@/lib/games/spec";
import { detectGenre, detectLook, detectTheme, templateDraft, titleFrom } from "@/lib/games/templates";
import { buildPlayHtml, inertJson, playCsp } from "@/lib/games/play";

vi.mock("@/lib/render/generate", () => ({ writerReady: async () => false }));

describe("games · templates", () => {
  it("picks the genre from the idea", () => {
    expect(detectGenre("match-3 with tropical fruits")).toBe("puzzle");
    expect(detectGenre("a racer through traffic")).toBe("racer");
    expect(detectGenre("space shooter vs crystal bugs")).toBe("shooter");
    expect(detectGenre("endless runner on rooftops")).toBe("runner");
    expect(detectGenre("explore a dungeon maze")).toBe("adventure");
    expect(detectGenre("a frog hopping home")).toBe("platformer");
  });

  it("matches theme words by prefix, not only whole words", () => {
    expect(detectTheme("snowy mountain traffic", "racer")).toBe("snow");
    expect(detectTheme("lily pads on a pond", "platformer")).toBe("ocean");
    expect(detectTheme("a haunted crypt", "adventure")).toBe("cave");
    expect(detectTheme("arcade racer", "racer")).toBe("city"); // "arcade" is not a neon cue
    expect(detectTheme("nothing in particular", "shooter")).toBe("space");
  });

  it("follows the hero from the prompt, and keeps vehicles to their genres", () => {
    expect(detectLook("a tiny frog")).toBe("frog");
    expect(detectLook("a delivery robot")).toBe("robot");
    expect(detectLook("plain idea")).toBeNull();
    expect(buildGameSpec(templateDraft("a frog on lily pads", "platformer"), 1).player.look).toBe("frog");
    expect(buildGameSpec(templateDraft("a frog in traffic", "racer"), 1).player.look).toBe("car");
    expect(buildGameSpec(templateDraft("a cat pilot", "shooter"), 1).player.look).toBe("ship");
  });

  it("titles from the first content words", () => {
    expect(titleFrom("a tiny frog jumping across lily pads")).toBe("Tiny Frog Jumping");
    expect(titleFrom("!!!")).toBe("Untitled Game");
    expect(titleFrom("x".repeat(80)).length).toBeLessThanOrEqual(48);
  });

  it("every genre template is a valid, finishable spec", () => {
    for (const g of GENRES) {
      const spec = buildGameSpec(templateDraft("something fun", g), 42);
      expect(gameSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec.genre).toBe(g);
      expect(GENRE_GOALS[g]).toContain(spec.goal.kind);
    }
  });
});

describe("games · spec", () => {
  const base = (): GameDraft => templateDraft("a frog", "platformer");

  it("rejects unknown keys, bad colours and out-of-range numbers", () => {
    expect(gameDraftSchema.safeParse({ ...base(), script: "alert(1)" }).success).toBe(false);
    expect(gameDraftSchema.safeParse({ ...base(), palette: { ...base().palette, sky: "red" } }).success).toBe(false);
    expect(gameDraftSchema.safeParse({ ...base(), difficulty: 9 }).success).toBe(false);
    expect(gameDraftSchema.safeParse({ ...base(), enemies: [] }).success).toBe(false);
  });

  it("normalizes goals the genre can't end on and clamps targets", () => {
    const puzzle = normalizeDraft({ ...base(), genre: "puzzle", goal: { kind: "reach_end", target: 1 } });
    expect(puzzle.goal).toEqual({ kind: "score", target: 50 });
    expect(normalizeDraft({ ...base(), goal: { kind: "collect", target: 500 } }).goal.target).toBe(60);
    expect(normalizeDraft({ ...base(), genre: "runner", goal: { kind: "survive", target: 2 } }).goal.target).toBe(20);
  });

  it("the server owns version and seed", () => {
    const spec = buildGameSpec(base(), -1);
    expect(spec.version).toBe(1);
    expect(spec.seed).toBe(0xffffffff);
    expect(draftOf(spec)).not.toHaveProperty("seed");
    expect(buildGameSpec(draftOf(spec), spec.seed)).toEqual(spec);
  });
});

describe("games · play page", () => {
  it("embeds the spec as inert JSON", () => {
    const s = inertJson({ t: "</script><script>alert(1)</script>&\u2028\u2029" });
    expect(s).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(s).t).toContain("</script>");
  });

  it("locks the frame to our own runtime", () => {
    const csp = playCsp("http://localhost:3000");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src http://localhost:3000/games/runtime.js");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("a hostile title cannot break out of the spec tag", () => {
    const spec = buildGameSpec({ ...templateDraft("x y z", "runner"), title: "</script><img src=x onerror=1>" }, 7);
    const html = buildPlayHtml(spec);
    expect(html.match(/<script/g)?.length).toBe(2); // the spec tag + the runtime
    expect(html).not.toContain("<img");
  });

  it("the runtime is plain script - no eval, no network", () => {
    const js = readFileSync(join(process.cwd(), "public/games/runtime.js"), "utf8");
    expect(js).not.toMatch(/\beval\s*\(|new Function|fetch\s*\(|XMLHttpRequest|WebSocket|importScripts/);
  });
});

describe("games · writer without a local model", () => {
  it("falls back to the template and says so", async () => {
    const { writeGame } = await import("@/lib/games/writer");
    const r = await writeGame("u1", "a ninja running across rooftops");
    expect(r.via).toBe("template");
    expect(r.spec.genre).toBe("runner");
    expect(r.spec.player.look).toBe("ninja");
  });
});
