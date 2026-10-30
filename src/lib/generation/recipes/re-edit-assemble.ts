/**
 * re-edit-assemble - one MotionField job that rebuilds a reference edit.
 *
 * For each generation window of the chain's shots: cut the segment out of
 * the source, run the flow's Wan VACE graph through the ENV provider
 * (getProvider() - mock in tests, comfy in production), record the window's
 * output on the chain, then assemble every window into ONE file that keeps
 * the original shot order, timing, aspect, fps and soundtrack.
 *
 * No child jobs - sub-steps are provider submissions inside this single
 * recipe job so the run respects the plan's one-active-job gate.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { findEndpoint } from "../../catalog/video-models";
import { filePathFor, generatedPathFor, saveBytes } from "../../storage";
import { getProvider } from "../index";
import { resolveParams } from "../../jobs";
import {
  claimChainRun, detectVideo, flowEndpoint, insertChain, jobOwner, linkChainJob,
  loadChain, otherLiveChainJob, parseShotOutputs, parseShots,
  saveWindowOutput, updateChain,
  RE_EDIT_FLOWS,
  type ShotSpec,
} from "../../re-edit";
import { resolveOwnedMedia } from "../../media-owned";
import { RESTYLE_PRESET_IDS } from "../../catalog/video/swap";
import {
  PERSON_WF, REFCUT_WF, classifyEvidence, stripCoverage, keepEvidence,
  mean, pct, PERSON_SWAP_MIN_MATTE, videoItem,
} from "./person-swap";
import {
  assembleWindows, chooseAspect, cutSegment, windowFrames, withTempDir,
  probeVideo, RE_EDIT_GEN_FPS, RE_EDIT_MIN_S, RE_EDIT_MAX_S,
  type ProbeInfo, type ShotSpan,
} from "../../re-edit-ffmpeg";
import type { RecipeCtx, RecipeFn } from "../recipe";
import type { ModelDef, WorkflowDef } from "../../catalog/types";
import type {
  GenerationProvider, ProviderOutputItem, SubmitInput,
} from "../types";

/** Test seam - unit tests inject a counting fake; everything else uses the
 *  env provider (GENERATION_PROVIDER), i.e. mock in e2e and comfy live. */
let stepProvider: GenerationProvider | null = null;
export function setReEditStepProvider(p: GenerationProvider | null): void {
  stepProvider = p;
}
const provider = () => stepProvider ?? getProvider();

const WINDOW_TIMEOUT_MS = Number(process.env.RE_EDIT_WINDOW_TIMEOUT_MS || 15 * 60_000);
/** A busy GPU queue is not a stuck window - waiting in line has its own,
 *  much longer, ceiling; the run budget starts when the window starts. */
const WINDOW_QUEUE_MAX_MS = Number(process.env.RE_EDIT_WINDOW_QUEUE_MAX_MS || 3 * 60 * 60_000);
const POLL_MS = 2500;

const round32 = (n: number) => Math.max(32, Math.round(n / 32) * 32);
const aspectOf = (ar: string): number =>
  ({ "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4,
     "21:9": 21 / 9, "3:2": 1.5, "2:3": 2 / 3, "4:5": 0.8, "5:4": 1.25 })[ar] ?? 16 / 9;
const seedFor = (jobId: string, shot: number): number => {
  let h = shot + 1;
  for (const c of jobId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
};

/** The smallest 8n+1 frame count ≥ the window's frames at RE_EDIT_GEN_FPS,
 *  expressed as a duration the graph's {{FRAMES}} math reproduces exactly. */
const windowDuration = (span: ShotSpan): number => {
  const need = windowFrames(span, RE_EDIT_GEN_FPS);
  return (8 * Math.ceil(Math.max(1, need - 1) / 8) + 1) / RE_EDIT_GEN_FPS;
};

/** Poll one window sub-job to completion; returns ALL output items - the
 *  person graph emits matte/coverage evidence next to its video. */
async function runWindow(
  input: SubmitInput,
  ctx: RecipeCtx,
  subJobId: string,
  endpoint: { model: ModelDef; workflow: WorkflowDef },
  params: Record<string, unknown>,
): Promise<ProviderOutputItem[]> {
  const p = provider();
  const sub = await p.submit({
    jobId: subJobId,
    model: endpoint.model,
    workflow: endpoint.workflow,
    params,
    appBaseUrl: input.appBaseUrl,
  });
  const queuedUntil = Date.now() + WINDOW_QUEUE_MAX_MS;
  let deadline = Number.POSITIVE_INFINITY; // set when the window leaves the queue
  try {
    while (true) {
      if (ctx.signal.aborted) throw new Error("canceled");
      const st = await p.poll(sub.providerJobId, sub.meta ?? {});
      if (st.state === "queued") {
        if (Date.now() > queuedUntil) throw new Error("window waited too long in the GPU queue");
      } else if (deadline === Number.POSITIVE_INFINITY) {
        deadline = Date.now() + WINDOW_TIMEOUT_MS;
      }
      if (st.state === "completed") {
        if (!st.output.items.length) throw new Error("window produced no outputs");
        return st.output.items;
      }
      if (st.state === "failed" || st.state === "nsfw" || st.state === "canceled")
        throw new Error(("error" in st && st.error) ? String(st.error) : `window sub-job ${st.state}`);
      if (Date.now() > deadline) throw new Error("window timed out");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, POLL_MS);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("canceled"));
        }, { once: true });
      });
    }
  } catch (e) {
    await p.cancel(sub.providerJobId, sub.meta ?? {}).catch(() => {});
    throw e;
  }
}

/** A provider output url or absolute path → a file path on this host. */
function mediaFile(url: string): string {
  if (url.startsWith("/files/")) return filePathFor(url) ?? url;
  if (url.startsWith("file://")) return new URL(url).pathname;
  return url;
}

interface RunUnit { shot: number; win: number; span: ShotSpan }

export const reEditAssembleRecipe: RecipeFn = async (input, ctx) => {
  const p = input.params;
  const chainId = typeof p.chain_id === "string" ? p.chain_id : null;
  let chain = chainId ? await loadChain(chainId) : null;

  // the job's owner is the only identity the run may act as - a chain_id
  // that names somebody else's chain is indistinguishable from a bad id
  const owner = await jobOwner(input.jobId);
  if (!owner) throw new Error("re-edit: could not resolve the job owner");
  if (chainId && (!chain || chain.userId !== owner)) throw new Error("re-edit chain not found");

  // the consent gate reads params.flow - a chain recorded under one flow must
  // never be driven by a job carrying another (a "restyle" submit that ran
  // character-swap would have skipped the likeness assertion). Both sides
  // present and different is a hard refuse, not a silent pick.
  if (chain && p.flow !== undefined && p.flow !== null && String(p.flow) !== "" && String(p.flow) !== chain.flow)
    throw new Error("flow does not match the chain");

  const flowRaw = String(chain?.flow ?? p.flow ?? "character-swap");
  const flow = RE_EDIT_FLOWS.find((f) => f === flowRaw);
  if (!flow) throw new Error(`unknown re-edit flow ${flowRaw}`);

  const videoUrl = String(chain?.videoUrl ?? p.video_url ?? "");
  const imageUrls = ((chain?.imageUrls as string[] | null) ??
    (Array.isArray(p.image_urls) ? p.image_urls.map(String) : [])) as string[];
  const instructions = String(chain?.instructions ?? p.instructions ?? "");
  const presetId = String(chain?.presetId ?? p.preset_id ?? "") || null;
  // the api route validates restyle presets; a direct /api/jobs caller
  // reaches the recipe without it - enforce the allowlist here too
  if (presetId && flow !== "restyle")
    throw new Error("preset_id only applies to the restyle flow");
  if (presetId && !(RESTYLE_PRESET_IDS as readonly string[]).includes(presetId))
    throw new Error(`unknown restyle preset_id ${presetId}`);
  const resolution = String(p.resolution ?? "480p");
  // steps is a declared catalog param (2-50) - absent means the flow
  // graph's own default, not a hidden low-quality one
  const stepsN = p.steps === undefined || p.steps === null || p.steps === "" || !Number.isFinite(Number(p.steps))
    ? undefined : Math.min(50, Math.max(2, Math.trunc(Number(p.steps))));
  const regenRaw = p.regenerate_index;
  const regen = typeof regenRaw === "number" ? Math.trunc(regenRaw)
    : typeof regenRaw === "string" && regenRaw.trim() !== "" ? Math.trunc(Number(regenRaw)) : null;

  const endpoint = findEndpoint(flowEndpoint(flow));
  if (!endpoint) throw new Error(`flow ${flow} has no workflow`);
  // character-swap windows run the PersonSwap person-window graph - a masked
  // matte-protected pass (BiRefNet + pose control), not the full-frame vace
  // swap the endpoint used to bundle; motion-transfer/restyle stay full-frame
  const windowEndpoint = flow === "character-swap"
    ? { model: endpoint.model, workflow: PERSON_WF }
    : endpoint;
  if (flow === "character-swap" && !imageUrls.length)
    throw new Error("character-swap needs at least one subject ref in image_urls");

  // one live job per chain - the claim flips queued→running for the whole
  // run, and a second live job pointing at this chain is a conflict
  if (chain) {
    if (!await claimChainRun(chain.id, owner))
      throw new Error("re-edit chain is not runnable");
    if (await otherLiveChainJob(chain.id, owner, input.jobId))
      throw new Error("another live job has this re-edit chain");
  }

  const srcPath = await resolveOwnedMedia(owner, videoUrl);
  for (const u of imageUrls) await resolveOwnedMedia(owner, u);
  const probe: ProbeInfo = await probeVideo(srcPath);
  if (probe.durationSec < RE_EDIT_MIN_S || probe.durationSec > RE_EDIT_MAX_S)
    throw new Error(`reference edit must be ${RE_EDIT_MIN_S}-${RE_EDIT_MAX_S} s (got ${probe.durationSec.toFixed(1)} s)`);
  const priorShots = chain ? parseShots(chain.shots) : [];
  const shots: ShotSpec[] = priorShots.length
    ? priorShots
    : (await detectVideo(srcPath)).shots;

  // windows this job runs - all of them on a full run; on a regenerate, the
  // target shot's windows plus every window that still has no output (the
  // failed-run leftovers this resume finishes)
  const prevOuts = new Map(parseShotOutputs(chain?.shotOutputs).map((o) => [o.index, o.urls]));
  const regenPrevUrls = regen !== null ? [...(prevOuts.get(regen) ?? [])] : [];
  const runs: RunUnit[] = regen === null
    ? shots.flatMap((s) => s.windows.map((span, win) => ({ shot: s.index, win, span })))
    : [
        ...(shots[regen]?.windows ?? []).map((span, win) => ({ shot: regen, win, span })),
        ...shots
          .filter((s) => s.index !== regen)
          .flatMap((s) => s.windows
            .map((span, win) => ({ shot: s.index, win, span }))
            .filter((r) => !(prevOuts.get(r.shot) ?? [])[r.win])),
      ];
  if (!runs.length) throw new Error(`shot ${regen} not found`);

  // honor the billed window count before any GPU work
  const paid = Math.trunc(Number(p.windows)) || 0;
  if (runs.length > paid)
    throw new Error(`needs ${runs.length} windows - job was charged for ${paid}`);

  if (!chain) {
    chain = await insertChain({
      userId: owner, videoUrl, flow,
      instructions, imageUrls, presetId, shots,
    });
    if (!chain) throw new Error("re-edit: chain insert failed");
    // the chain row didn't exist at submit time - backfill it onto this job's
    // params so /api/re-edit/[id] lookups and the lost-run reconcile see it
    await linkChainJob(input.jobId, chain.id);
  }
  const chainRow = chain;

  // cut box must match what the graph's {{WIDTH}}/{{HEIGHT}} resolves to:
  // height = resolution cap, width = height * aspect rounded to 32
  const ar = chooseAspect(probe.width, probe.height);
  const hi = resolution === "720p" ? 720 : 480;
  const [dw, dh] = [round32(hi * aspectOf(ar)), round32(hi)];

  const workDir = filePathFor(`/files/generated/.re-edit/${input.jobId}/`)
    ?? path.join(process.cwd(), "public", "files", "generated", ".re-edit", input.jobId);
  await fs.mkdir(workDir, { recursive: true });
  // matte/coverage evidence persists past the run's temp dir - the same
  // .person-swap/<job>/ evidence dir the recipe owns for its own surfaces
  const evidenceDir = flow === "character-swap"
    ? (filePathFor(`/files/generated/.person-swap/${input.jobId}/`)
      ?? path.join(process.cwd(), "public", "files", "generated", ".person-swap", input.jobId))
    : workDir;
  if (evidenceDir !== workDir) await fs.mkdir(evidenceDir, { recursive: true });
  ctx.progress(2, "re-edit: probing");

  // provider-side artifacts (ref cut-outs) - dropped once the windows that
  // consumed them are done, like the person-swap recipe's providerFiles cleanup
  const providerFiles: string[] = [];
  const dropLater = (u?: string | null) => { const fp = u ? filePathFor(u) : null; if (fp) providerFiles.push(fp); };
  const itemUrl = (items: ProviderOutputItem[], label: string) => {
    const out = items.find((o) => o.type === "video") ?? items[0];
    if (!out?.url) throw new Error(`${label} produced no output`);
    return out.url;
  };

  // character-swap: each identity ref goes through the BiRefNet white-plate
  // cut-out first - the same pre-pass the person-swap recipe runs (a clean plate
  // keys VACE's reference encoder far better than a busy scene photo)
  const personRefs: string[] = [];
  try {
    if (flow === "character-swap") {
      for (const [ri, ru] of imageUrls.slice(0, 3).entries()) {
        ctx.progress(2, `re-edit: identity ref ${ri + 1} - cut-out`);
        const rItems = await runWindow(input, ctx, `${input.jobId}-refcut${ri}`,
          { model: endpoint.model, workflow: REFCUT_WF }, { image_url: ru });
        const ev = await classifyEvidence(rItems);
        await keepEvidence(ev.strip, evidenceDir, `cov-ref${ri}.png`);
        // on the real graph the non-strip image IS the white-plate cut-out;
        // a strip-less provider (mock) returns its own render - keep the url
        const cut = ev.matte ?? rItems.find((i) => i.type === "image" && i.url)?.url
          ?? rItems.find((i) => i.url)?.url;
        if (!cut) throw new Error(`identity ref ${ri + 1} cut-out returned no image`);
        dropLater(cut);
        personRefs.push(cut);
      }
    }

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (ctx.signal.aborted) throw new Error("canceled");
      const cutUrl = `/files/generated/.re-edit/${input.jobId}/cut-${run.shot}-${run.win}.mp4`;
      const cutPath = path.join(workDir, path.basename(cutUrl));
      try {
        ctx.progress(2 + Math.round((i / runs.length) * 85),
          `re-edit: window ${i + 1}/${runs.length} - cutting`);
        await cutSegment(srcPath, cutPath, run.span, dw, dh, ctx.signal);
        const prompt = [shots[run.shot]?.hint, instructions].filter(Boolean).join(". ");
        ctx.progress(2 + Math.round((i / runs.length) * 85),
          `re-edit: window ${i + 1}/${runs.length} - generating`);
        let url: string;
        if (flow === "character-swap") {
          // the masked person pass: matte + coverage evidence, gated the
          // same way the person-swap recipe gates its windows (off-mock only)
          const items = await runWindow(input, ctx, `${input.jobId}-w${run.shot}x${run.win}`, windowEndpoint, {
            video_url: cutUrl,
            image_urls: personRefs,
            prompt: prompt || "the person in the reference photos, same pose and motion, seamlessly in the scene",
            negative_prompt: "blurry, distorted face, extra limbs, flicker, watermark, text",
            resolution,
            aspect_ratio: ar,
            fps: RE_EDIT_GEN_FPS,
            duration: windowDuration(run.span),
            ...(stepsN !== undefined ? { steps: stepsN } : {}),
            seed: seedFor(input.jobId, run.shot),
          });
          const ev = await classifyEvidence(items);
          const cov = ev.strip ? await stripCoverage(ev.strip) : null;
          const matteUrl = await keepEvidence(ev.matte, evidenceDir, `matte-s${run.shot}-w${run.win}.png`);
          await keepEvidence(ev.strip, evidenceDir, `cov-s${run.shot}-w${run.win}.png`);
          if (!cov?.person.length) {
            if (provider().name !== "mock")
              throw new Error("no matte coverage strip - refusing to run blind");
          } else if (mean(cov.person) < PERSON_SWAP_MIN_MATTE)
            throw new Error(`person not confidently found - mean matte coverage ${pct(mean(cov.person))} < ${pct(PERSON_SWAP_MIN_MATTE)}` +
              (matteUrl ? ` (matte evidence ${matteUrl})` : ""));
          url = videoItem(items, `shot ${run.shot + 1} window ${run.win + 1} person pass`);
        } else {
          const items = await runWindow(input, ctx, `${input.jobId}-w${run.shot}x${run.win}`, windowEndpoint,
            // resolveParams applies the restyle preset (prompt fragment +
            // negative) - the window submissions bypass createJob, so the
            // merge has to happen here
            resolveParams({
              video_url: cutUrl,
              image_urls: imageUrls,
              prompt,
              preset_id: presetId ?? undefined,
              resolution,
              aspect_ratio: ar,
              fps: RE_EDIT_GEN_FPS,
              duration: windowDuration(run.span),
              ...(stepsN !== undefined ? { steps: stepsN } : {}),
              seed: seedFor(input.jobId, run.shot),
            }));
          url = itemUrl(items, `shot ${run.shot + 1} window ${run.win + 1}`);
        }
        if (ctx.signal.aborted) throw new Error("canceled");
        await saveWindowOutput(chainRow.id, run.shot, run.win, url);
      } catch (e) {
        if (ctx.signal.aborted) throw new Error("canceled");
        const tail = String((e as Error).message ?? e).slice(0, 240);
        throw new Error(`shot ${run.shot + 1} failed: ${tail}`);
      } finally {
        await fs.rm(cutPath, { force: true }).catch(() => {});
      }
    }

    // the assembled sequence - every window's latest output, in shot order
    const fresh = await loadChain(chainRow.id);
    const outs = new Map(parseShotOutputs(fresh?.shotOutputs).map((o) => [o.index, o.urls]));
    const seq = shots.flatMap((s) => s.windows.map((span, win) => ({
      shot: s.index, span, url: outs.get(s.index)?.[win],
    })));
    const missing = seq.find((w) => !w.url);
    if (missing)
      throw new Error(`shot ${missing.shot + 1} has no output - regenerate it`);

    ctx.progress(92, "re-edit: assembling");
    await updateChain(chainRow.id, { status: "assembling" });
    const buf = await withTempDir(async (dir) => {
      const out = path.join(dir, "re-edit.mp4");
      await assembleWindows(
        seq.map((w) => ({ file: mediaFile(w.url!), span: w.span })),
        probe, out, ctx.signal);
      return fs.readFile(out);
    });
    if (ctx.signal.aborted) throw new Error("canceled");
    const url = await saveBytes(`generated/re-edit/${input.jobId}.mp4`, buf);
    if (ctx.signal.aborted) {
      // aborted mid-write - leave no result file behind
      const fp = generatedPathFor(url);
      if (fp) await fs.rm(fp, { force: true }).catch(() => {});
      throw new Error("canceled");
    }
    await updateChain(chainRow.id, { status: "completed", resultUrl: url, error: null });
    ctx.progress(100, "re-edit: done");
    // a regenerate replaces the shot's old window outputs - drop the files
    // the new urls superseded (never touch a url the run re-kept)
    if (regen !== null) {
      const kept = new Set(outs.get(regen) ?? []);
      for (const old of regenPrevUrls) {
        if (!old || kept.has(old)) continue;
        const fp = generatedPathFor(old);
        if (fp) await fs.rm(fp, { force: true }).catch(() => {});
      }
    }
    return [{
      type: "video" as const, url,
      width: probe.width, height: probe.height, duration: probe.durationSec,
    }];
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    // once aborted the only allowed write is the canceled status - no error
    // text, no outputs, no result
    await updateChain(chainRow.id, ctx.signal.aborted
      ? { status: "canceled" }
      : { status: "failed", error: msg });
    throw e;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    for (const fp of providerFiles) await fs.rm(fp, { force: true }).catch(() => {});
  }
};

export default reEditAssembleRecipe;
