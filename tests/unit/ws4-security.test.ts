import { describe, it, expect, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { POST } from "@/app/api/refs/route";
import { generatedPathFor } from "@/lib/storage";
import { getAuth } from "@/lib/auth";

/* Path guards: a /files url is database/user data - a traversal
 * string must never resolve outside the storage root, whether it reaches the
 * refs API's ownership check or the generated-file delete helper. */

async function makeUser(tag: string): Promise<{ id: string; cookie: string }> {
  const auth = await getAuth();
  const out = await auth.api.signUpEmail({
    body: { email: `${tag}-${randomUUID().slice(0, 8)}@ws4.test`, password: "password-1234", name: tag },
    returnHeaders: true,
  });
  const cookie = String(out.headers.get("set-cookie") ?? "").split(";")[0];
  expect(cookie).toContain("session_token");
  return { id: out.response.user.id, cookie };
}

describe("path guards", () => {
  it("refs POST with a traversal /files url → 404, not a resolved path", async () => {
    const me = await makeUser("ws4-sec");
    const r = await POST(new NextRequest("http://localhost/api/refs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: me.cookie },
      body: JSON.stringify({
        name: "trav", category: "character", kind: "person",
        images: ["/files/../../etc/hosts"],
        // a person ref needs the assertion before the ownership check runs
        likeness_consent: true,
      }),
    }));
    expect(r.status).toBe(404);
  }, 30_000);

  it.each([
    "/files/../../etc/hosts",
    "/files/../secret",
    "/files/generated/../../outside.mp4",
    "/files/uploads/real-upload.png",   // uploads live outside generated/
    "/files/generated/",               // the root itself, not a file in it
    "/files/generated",                // same, without trailing slash
    "https://evil.example/x.mp4",
    "/etc/passwd",
  ])("generatedPathFor refuses %s", (u) => {
    expect(generatedPathFor(u)).toBeNull();
  });

  it("generatedPathFor resolves a real generated url", () => {
    expect(generatedPathFor("/files/generated/re-edit/x.mp4"))
      .toBe(path.resolve(process.cwd(), "public", "files", "generated", "re-edit", "x.mp4"));
  });
});

/* Likeness consent - person-kind refs and the identity params on the
 * swap/portrait workflows all refuse a job without an explicit
 * likeness_consent: true (docs/POLICY.md). */
import { needsLikenessConsent, likenessConsentCheck } from "@/lib/likeness";
import { findWorkflow } from "@/lib/jobs";

describe("likeness consent gate", () => {
  it("refs POST person without likeness_consent → 400 before ownership is even checked", async () => {
    const me = await makeUser("ws4-likeness");
    const post = (body: unknown) => POST(new NextRequest("http://localhost/api/refs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: me.cookie },
      body: JSON.stringify(body),
    }));
    // the fake url below never reaches the ownership check - consent fires
    // first, so a 400 'likeness consent required' is the answer either way
    const noConsent = await post({ name: "p", kind: "person", images: ["/files/uploads/fake.png"] });
    expect(noConsent.status).toBe(400);
    expect((await noConsent.json()).error).toContain("likeness consent required");
    const categoryOnly = await post({ name: "c", category: "character", images: ["/files/uploads/fake.png"] });
    expect(categoryOnly.status).toBe(400);
    // with the assertion the request proceeds to the ownership check → 404
    const withConsent = await post({ name: "p2", kind: "person", images: ["/files/uploads/fake.png"], likeness_consent: true });
    expect(withConsent.status).toBe(404);
    // object/place refs aren't likeness - no box needed → ownership 404 again
    const prop = await post({ name: "pr", category: "prop", kind: "prop", images: ["/files/uploads/fake.png"] });
    expect(prop.status).toBe(404);
  }, 30_000);

  it("every declared identity workflow 400s 'likeness consent required' at validate", () => {
    const swaps = [
      ["wan-vace", "character-swap"],
      ["wan-vace", "motion-transfer"],
      ["wan-animate", "character-swap"],
    ] as const;
    for (const [model, wf] of swaps) {
      const w = findWorkflow(model, wf)!;
      const p = { video_url: "/files/x.mp4", image_urls: ["/files/x.png"] };
      expect(w.validate?.(p), `${model}/${wf}`).toBe("likeness consent required");
      expect(w.validate?.({ ...p, likeness_consent: true })).toBeNull();
    }
    const tp = findWorkflow("lipsync", "talking-portrait")!;
    expect(tp.validate?.({ image_url: "/files/x.png" })).toBe("likeness consent required");
    expect(tp.validate?.({ image_url: "/files/x.png", likeness_consent: true })).toBeNull();
    // lip-sync on a real person's clip is an identity point too - the
    // source video is the likeness upload
    const lsv = findWorkflow("lipsync", "lip-sync-video")!;
    expect(lsv.validate?.({ video_url: "/files/x.mp4" })).toBe("likeness consent required");
    expect(lsv.validate?.({ video_url: "/files/x.mp4", likeness_consent: true })).toBeNull();
  });

  it("re-edit gates on flow + a present subject ref; stringy consent doesn't count", () => {
    const id = "motionfield/re-edit/v1.0";
    expect(needsLikenessConsent(id, { flow: "character-swap", image_urls: ["/f/x.png"] })).toBe(true);
    expect(needsLikenessConsent(id, { flow: "character-swap" })).toBe(false);
    // motion-transfer re-renders the supplied subject - gated like the swap
    expect(needsLikenessConsent(id, { flow: "motion-transfer", image_urls: ["/f/x.png"] })).toBe(true);
    // only restyle touches no identity
    expect(needsLikenessConsent(id, { flow: "restyle", image_urls: ["/f/x.png"] })).toBe(false);
    // re-edit default flow is character-swap - a missing flow still gates
    expect(needsLikenessConsent(id, { image_urls: ["/f/x.png"] })).toBe(true);
    const v = likenessConsentCheck(id);
    expect(v({ flow: "motion-transfer", image_urls: ["/f/x.png"] })).toBe("likeness consent required");
    expect(v({ flow: "character-swap", image_urls: ["/f/x.png"], likeness_consent: "yes" })).toBe("likeness consent required");
  });
});

/* Shipped surfaces must never reference the removed upstream face segmenter
 * or its non-commercial weights - the patched MuseTalk derives the blend
 * region from OF_MouthMask instead (docs/POLICY.md licenses section). */
import { execFileSync } from "node:child_process";

describe("no face-segmenter remnants", () => {
  const DIRS = ["workflows", "scripts", "comfy-nodes/motionfield_nodes"];
  const TERMS = ["bisenet", "79999", "face-parse-bisent"];
  const grep = (term: string, dirs: string[]) => {
    try {
      return execFileSync("git", ["grep", "-n", "-i", "-E", term, "--", ...dirs],
        { cwd: process.cwd(), encoding: "utf8" }).trim();
    } catch (e) {
      return (e as { status?: number }).status === 1 ? "" : (() => { throw e; })();
    }
  };

  it.each(TERMS)("git grep %s in workflows/scripts/motionfield_nodes returns nothing", (term) => {
    const hits = grep(term, DIRS)
      .split("\n").filter((l) => l && !l.startsWith("comfy-nodes/tests/"));
    expect(hits).toEqual([]);
  });
});

/* Preset-gate boundary cases - a preset id must never smuggle its way past
 * the catalog rules: app-tile ids are never preset params, motion presets
 * are WS3's catalog (usable with an empty verify file), stale/failed/
 * pending records and fabricated records all fail closed. */
import "@/lib/catalog/presets/effects";
import "@/lib/catalog/presets/styles";
import "@/lib/catalog/presets/apps";
import "@/lib/catalog/presets/person-swap";
import {
  allSpecs, specById, specVisible, mechanismHash, type VerifyRecord,
} from "@/lib/catalog/presets/schema";
import { resolveParams, JobError } from "@/lib/jobs";

const verifyTmp = mkdtempSync(path.join(tmpdir(), "of-ws4-sec-"));
const prevFile = process.env.PRESET_VERIFY_FILE;
let n = 0;
afterAll(() => { process.env.PRESET_VERIFY_FILE = prevFile; });

/** Point the gate at a fresh records file (a new name each time - the store
 *  memoises by mtime) and run fn under it. */
function withRecords<T>(records: Record<string, VerifyRecord>, fn: () => T): T {
  const file = path.join(verifyTmp, `v${n++}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, records }));
  process.env.PRESET_VERIFY_FILE = file;
  try { return fn(); } finally { process.env.PRESET_VERIFY_FILE = prevFile; }
}

const verifiedRec = (id: string): VerifyRecord => {
  const s = specById(id);
  return s ? { mechanism_hash: mechanismHash(s), status: "verified" } : { mechanism_hash: "x", status: "verified" };
};

describe("preset-gate boundary", () => {
  it.each(["color-grading", "lead-swap", "packshot", "camera-motion", "macro-shot"])(
    "an app-tile id is never a valid preset param - verified record or not (%s)",
    (id) => {
      const spec = specById(id)!;
      expect(spec.catalog).toBe("app");
      // even when the tile itself is verified, the param path can't name it
      expect(specVisible(spec, { [id]: verifiedRec(id) })).toBe(true);
      withRecords({ [id]: verifiedRec(id) }, () => {
        expect(() => resolveParams({ prompt: "x", preset_id: id })).toThrowError(JobError);
        expect(() => resolveParams({ prompt: "x", effect_preset: id })).toThrowError(JobError);
        expect(() => resolveParams({ prompt: "x", motion_preset: id })).toThrowError(JobError);
      });
    });

  it.each(["dolly-in", "arc-left", "360-orbit", "pov", "snap-zoom-in"])(
    "a WS3 motion preset resolves with an empty verify file (%s)",
    (id) => {
      withRecords({}, () => {
        expect(resolveParams({ prompt: "a dancer", motion_preset: id })).toBeTruthy();
      });
    });

  it.each([
    ["stale mechanism hash", { status: "verified" as const, mechanism_hash: "f".repeat(64) }],
    ["failed record", { status: "failed" as const }],
    ["pending record", { status: "pending" as const }],
  ])("a %s keeps a restyle preset unusable", (_label, rec) => {
    const s = specById("comic-panel")!;
    const records = { "comic-panel": { ...rec, mechanism_hash: (rec as { mechanism_hash?: string }).mechanism_hash ?? mechanismHash(s) } };
    expect(specVisible(s, records)).toBe(false);
    withRecords(records, () => {
      expect(() => resolveParams({ prompt: "x", preset_id: "comic-panel" })).toThrowError(JobError);
    });
  });

  it.each(["flash-frost", "scatter-to-ash", "general", "outfit-try-on"])(
    "a fabricated verified record cannot un-hide %s", (id) => {
      const s = specById(id)!;
      expect(s.hidden).toBeTruthy();
      expect(specVisible(s, { [id]: verifiedRec(id) })).toBe(false);
      withRecords({ [id]: verifiedRec(id) }, () => {
        expect(() => resolveParams({ prompt: "x", preset_id: id })).toThrowError(JobError);
      });
    });

  it("the hash pins the merge payload: restyle style text and apply both change it", () => {
    const a = specById("comic-panel")!, b = specById("marble-gold")!;
    expect(mechanismHash(a)).not.toBe(mechanismHash(b));
    // editing only the promptFragment invalidates the record
    expect(mechanismHash({ ...a, promptFragment: `${a.promptFragment} ` })).not.toBe(mechanismHash(a));
    // editing only apply invalidates the record
    expect(mechanismHash({ ...a, apply: { ...a.apply, extra: 1 } })).not.toBe(mechanismHash(a));
    // every restyle-mech spec gets a distinct hash - no shared "verified" umbrella
    const restyles = allSpecs().filter((s) => s.mechanism.kind === "restyle").map(mechanismHash);
    expect(new Set(restyles).size).toBe(restyles.length);
  });

  it("a motion preset can't be combined with an exclusive mechanism - and a restyle id never resolves as motion", () => {
    // trajectory + restyle is not a legal mix even when both are visible
    withRecords({ "comic-panel": verifiedRec("comic-panel") }, () => {
      expect(() => resolveParams({ prompt: "x", motion_preset: "dolly-in", preset_id: "comic-panel" })).toThrowError(JobError);
      // motion_preset names WS3 trajectory presets only - an effect id is 400
      expect(() => resolveParams({ prompt: "x", motion_preset: "comic-panel" })).toThrowError(JobError);
    });
  });
});

/* PersonSwap - the identity-swap surface. The endpoint's likeness gate, the
 * mode/ref requirement, and the route's ownership resolution are the
 * security surface; everything else is recipe plumbing. */
import { POST as personSwapPost } from "@/app/api/person-swap/route";
import { PERSON_SWAP_ENDPOINT } from "@/lib/generation/recipes/person-swap";

describe("person-swap consent + ownership", () => {
  const p = { video_url: "/files/uploads/clip.mp4", image_urls: ["/files/uploads/ref.png"], windows: 1 };

  it("the endpoint is registered - the clip alone triggers consent", () => {
    expect(needsLikenessConsent(PERSON_SWAP_ENDPOINT, { video_url: "/files/x.mp4" })).toBe(true);
    expect(needsLikenessConsent(PERSON_SWAP_ENDPOINT, { image_urls: ["/files/x.png"] })).toBe(true);
    expect(needsLikenessConsent(PERSON_SWAP_ENDPOINT, {})).toBe(false);
    // environment mode still gates - the person in the clip IS the likeness
    expect(needsLikenessConsent(PERSON_SWAP_ENDPOINT, { mode: "environment", video_url: "/files/x.mp4" })).toBe(true);
  });

  it("the workflow validate 400s on consent, then on missing identity refs", () => {
    const w = findWorkflow("person-swap", "swap")!;
    expect(w.validate?.(p)).toBe("likeness consent required");
    expect(w.validate?.({ ...p, likeness_consent: "yes" })).toBe("likeness consent required");
    expect(w.validate?.({ ...p, likeness_consent: true })).toBeNull();
    // person/both need an identity ref - environment doesn't
    expect(w.validate?.({ ...p, image_urls: [], likeness_consent: true }))
      .toBe("person and both modes need at least one identity ref in image_urls");
    expect(w.validate?.({ ...p, image_urls: [], mode: "environment", likeness_consent: true })).toBeNull();
  });

  it("POST /api/person-swap: a traversal or foreign-owned video url → 404/400 before any probe", async () => {
    const me = await makeUser("ws4-person-swap-sec");
    const post = (body: unknown) => personSwapPost(new NextRequest("http://localhost/api/person-swap", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: me.cookie },
      body: JSON.stringify(body),
    }));
    const trav = await post({ ...p, video_url: "/files/../../etc/hosts", likeness_consent: true });
    expect(trav.status).toBe(404);
    const foreign = await post({ ...p, video_url: "/files/uploads/not-mine.mp4", likeness_consent: true });
    expect(foreign.status).toBe(404);
    const external = await post({ ...p, video_url: "https://evil.example/x.mp4", likeness_consent: true });
    expect(external.status).toBe(400);
    // and consent still fires for a well-formed (but absent) upload - the
    // ownership check ran first? no: resolveOwnedMedia 404s - the consent is
    // enforced inside createJob, reachable only with a real owned url
    const noConsent = await post({ ...p });
    expect([400, 404]).toContain(noConsent.status);
  }, 30_000);
});

/* WS4 s7 - the klein lane's two guardrails that live at the catalog boundary:
 *   the non-commercial klein 9B weight must stay banned (the Apache-2.0 4B is
 *   the one we ship), and product-placement's normalised bbox contract must
 *   hold server-side - a scene+pasted box is the only path that may run the
 *   pixel-exact graph, and the box fields only bind when a scene is supplied
 *   (skills send their bbox defaults unconditionally, so a no-scene call with
 *   them must not 400). */
import { RED_FLAG_WEIGHTS } from "@/lib/catalog/licenses";
import { findEndpoint } from "@/lib/catalog/video-models";

describe("klein lane guardrails", () => {
  it("klein-9b weights stay banned - the audit fixture fails and the regex only spares the 4B filename", { timeout: 60_000 }, () => {
    const hits = (f: string) => RED_FLAG_WEIGHTS.filter((re) => re.test(f)).length;
    expect(hits("flux-2-klein-9b-fp8.safetensors")).toBeGreaterThan(0);
    expect(hits("Flux-2-Klein-9B.safetensors")).toBeGreaterThan(0); // case + dash variants
    expect(hits("flux-2-klein-4b-fp8.safetensors")).toBe(0);
    const fixture = path.join(process.cwd(), "tests/fixtures/license-audit/klein-9b");
    let failed = false, out = "";
    try {
      out = execFileSync("npx", ["tsx", "scripts/license-audit.ts", "--root", fixture],
        { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    } catch (e) {
      failed = true;
      const ex = e as { stdout?: string; stderr?: string };
      out = `${ex.stdout ?? ""}\n${ex.stderr ?? ""}`;
    }
    expect(failed, out).toBe(true);
    expect(out).toContain("flux-2-klein-9b-fp8.safetensors");
  });

  it("product-placement enforces the normalised bbox contract at validate", () => {
    const w = findWorkflow("product-placement", "place")!;
    expect(w.providers.comfy?.workflowFor?.({ image_url: "/f/s.png" })).toBe("klein-product-compose.json");
    expect(w.providers.comfy?.workflowFor?.({})).toBeUndefined();
    const base = { product_image_url: "/files/uploads/p.png", image_url: "/files/uploads/s.png" };
    // scene present → all four box fields, each 0-1, and the box must fit
    expect(w.validate?.(base)).toContain("bbox_x");
    expect(w.validate?.({ ...base, bbox_x: 0.1, bbox_y: 0.1, bbox_w: 0.2, bbox_h: 0.2 })).toBeNull();
    expect(w.validate?.({ ...base, bbox_x: 1.4, bbox_y: 0, bbox_w: 0.2, bbox_h: 0.2 })).toContain("between 0 and 1");
    expect(w.validate?.({ ...base, bbox_x: 0.9, bbox_y: 0, bbox_w: 0.2, bbox_h: 0.2 })).toContain("fit inside the frame");
    // a box without a scene is simply ignored - the no-scene arm runs the
    // generated-scene graph (ugc-ad always sends its bbox defaults)
    const noScene = { product_image_url: "/files/uploads/p.png" };
    expect(w.validate?.(noScene)).toBeNull();
    expect(w.validate?.({ ...noScene, bbox_x: 0.2, bbox_y: 0.2, bbox_w: 0.3, bbox_h: 0.3 })).toBeNull();
    // refs cap - the API accepts ≤10, the graph consumes the first three
    const many = { ...noScene, image_urls: Array(11).fill("/files/uploads/p.png") };
    expect(w.validate?.(many)).toContain("10");
    // and the schnell endpoints are genuinely gone - tombstones never resolve
    for (const e of ["motionfield/flux-schnell/text-to-image", "motionfield/flux-schnell/img2img", "motionfield/flux-schnell/inpaint"])
      expect(findEndpoint(e)).toBeNull();
    for (const e of ["motionfield/flux2-klein/text-to-image", "motionfield/flux2-klein/edit", "motionfield/flux2-klein/inpaint", "motionfield/product-placement"])
      expect(findEndpoint(e)).toBeTruthy();
  });
});
