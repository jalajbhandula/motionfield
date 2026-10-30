import { licenseClassForSpdx, RED_FLAG_WEIGHTS } from "@/lib/catalog/licenses";
import { hostedMode, isLoopbackUrl } from "@/lib/llm/offline";

/**
 * Hugging Face hub guards - pure, unit-testable policy shared by every
 * /api/models/hub route:
 *  - repo name + repo-relative file path validation (fail closed)
 *  - the weight-extension filter (pickle files are refused outright)
 *  - GGUF quant-tag parsing
 *  - card classification (worst licence id wins; gated/private refuses)
 *  - the two dev/test seams: MOTIONFIELD_HF_BASE (loopback http only) and
 *    MOTIONFIELD_HUB_TEST_FREE_GB - both dead under NODE_ENV=production or
 *    hosted mode
 *  - the per-redirect-hop host/policy rule for file downloads
 */

/* ------------------------------ repo name ------------------------------ */

const REPO_PART = /^[A-Za-z0-9._-]{1,96}$/;

/** "owner/name": letters, digits, . _ - ; no ".."; each part ≤96 chars. */
export function isRepoName(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2
    && parts.every((p) => REPO_PART.test(p) && /[A-Za-z0-9]/.test(p) && !p.includes(".."));
}

/* --------------------------- repo file paths ---------------------------- */

const FILE_SEG = /^[A-Za-z0-9._-]+$/;

/** A file path inside the repo ("dir/model.safetensors"): same alphabet as
 *  repo names, '/'-separated, no "..", never absolute, no escapes. */
export function repoFileError(file: string): string | null {
  if (!file || file.length > 400 || file.startsWith("/") || file.includes("\\") || file.includes("%"))
    return "invalid file path";
  if (file.split("/").some((s) => !FILE_SEG.test(s) || s.includes(".."))) return "invalid file path";
  return null;
}

/* --------------------------- weight extensions --------------------------- */

export const WEIGHT_FILE_RE = /\.(safetensors|sft|gguf)$/i;
export const PICKLE_FILE_RE = /\.(pth|pt|ckpt|bin)$/i;
export const PICKLE_REASON = "pickle files can run code when loaded";

/** The catalog's banned-weight patterns applied to a repo or repo-relative
 *  file path - a hit means "this weight is on MotionField's banned list" and
 *  the request refuses before any hub call or byte is written. */
export function redFlagWeight(name: string): boolean {
  return RED_FLAG_WEIGHTS.some((re) => re.test(name));
}

/** Why a repo file may not be downloaded as weights, or null. */
export function weightFileError(file: string): string | null {
  if (PICKLE_FILE_RE.test(file)) return PICKLE_REASON;
  if (!WEIGHT_FILE_RE.test(file)) return "only .safetensors, .sft and .gguf files may be downloaded";
  return null;
}

/* ----------------------------- ComfyUI dirs ------------------------------ */

export const MODEL_SUBFOLDERS = [
  "checkpoints", "diffusion_models", "unet", "loras", "vae",
  "text_encoders", "clip", "clip_vision", "controlnet", "upscale_models", "embeddings",
] as const;
export type ModelSubfolder = (typeof MODEL_SUBFOLDERS)[number];
export const isModelSubfolder = (s: string): s is ModelSubfolder =>
  (MODEL_SUBFOLDERS as readonly string[]).includes(s);

/* ------------------------------ GGUF quants ------------------------------ */

const QUANT_RE = /^[A-Za-z]{1,3}\d[A-Za-z0-9_]*$/;

/** The quant tag of a .gguf file - the last [.-]-separated token before the
 *  extension ('_' is kept: Q4_K_M, IQ2_XXS, TQ1_0, F16, BF16). A plain
 *  single-token name like "model.gguf" has no tag. */
export function quantTagFor(file: string): string | null {
  if (!/\.gguf$/i.test(file)) return null;
  const seg = file.slice(0, -5).split(/[.\-]/).pop() ?? "";
  return QUANT_RE.test(seg) ? seg : null;
}

/* --------------------------- licence verdicts ---------------------------- */

export type HubLicenceClass = "open" | "permissive-terms" | "restricted" | "refused";

export interface LicenceVerdict {
  cls: HubLicenceClass;
  /** the licence id that produced the worst class ("" for gated/private) */
  licenseId: string;
  reason: string;
}

const CLS_RANK: Record<HubLicenceClass, number> = {
  open: 0, "permissive-terms": 1, restricted: 2, refused: 3,
};

/** Several licence ids → the worst class wins; the table fails closed so
 *  NC / "other" / unknown / empty are always "refused". */
export function classifyLicenseIds(ids: readonly string[]): LicenceVerdict {
  let worst: LicenceVerdict = { cls: "open", licenseId: "", reason: "permissive licence" };
  for (const id of ids.length ? ids : [""]) {
    const { class: c, reason } = licenseClassForSpdx(id);
    const cls: HubLicenceClass = c === "open" || c === "permissive-terms" || c === "restricted" ? c : "refused";
    if (CLS_RANK[cls] > CLS_RANK[worst.cls]) worst = { cls, licenseId: id, reason };
  }
  return worst;
}

/** The card verdict before the opt-in dimension: gated (any value but
 *  false/missing) and private refuse outright with their own reason. */
export function classifyRepoCard(card: {
  licenseIds: readonly string[];
  gated?: unknown;
  priv?: unknown;
}): LicenceVerdict {
  const gatedPrivate = { cls: "refused" as const, licenseId: "", reason: "gated or private repos aren't supported" };
  if (card.gated !== undefined && card.gated !== false && card.gated !== null) return gatedPrivate;
  if (card.priv === true) return gatedPrivate;
  return classifyLicenseIds(card.licenseIds);
}

/* ------------------------------- test seams ------------------------------ */

/** Seams exist only outside production builds and never in hosted mode. */
export function hubSeamsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && !hostedMode();
}

const REAL_HF_BASE = "https://huggingface.co";

/** The HF API base. MOTIONFIELD_HF_BASE (dev/test only) must be a loopback
 *  http URL - anything else falls back to the real base. */
export function hfBase(): string {
  if (hubSeamsEnabled()) {
    const raw = process.env.MOTIONFIELD_HF_BASE;
    if (raw) {
      try {
        const u = new URL(raw);
        if (u.protocol === "http:" && isLoopbackUrl(raw)) return raw.replace(/\/+$/, "");
      } catch { /* fall through to the real base */ }
    }
  }
  return REAL_HF_BASE;
}

export const usingHubTestBase = () => hfBase() !== REAL_HF_BASE;

/** MOTIONFIELD_HUB_TEST_FREE_GB (dev/test only) overrides statfs free bytes. */
export function hubTestFreeBytes(): number | null {
  if (!hubSeamsEnabled()) return null;
  const raw = process.env.MOTIONFIELD_HUB_TEST_FREE_GB;
  if (raw === undefined) return null;
  const gb = Number(raw);
  return Number.isFinite(gb) && gb >= 0 ? gb * 2 ** 30 : null;
}

/* --------------------------- download hop policy ------------------------- */

function isHubHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "huggingface.co" || h === "hf.co"
    || h.endsWith(".huggingface.co") || h.endsWith(".hf.co");
}

/** Every redirect hop (and the first request): https on huggingface.co /
 *  *.huggingface.co / *.hf.co. Under the test seam only loopback http(s)
 *  is reachable. Returns a refusal reason or null. */
export function downloadHopError(url: string, testBase: boolean): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "destination not allowed"; }
  if (testBase) {
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackUrl(url)
      ? null
      : "the test hub base may only redirect to loopback";
  }
  if (u.protocol !== "https:") return "hub downloads require https";
  return isHubHost(u.hostname) ? null : "redirects may only stay on huggingface.co / hf.co";
}
