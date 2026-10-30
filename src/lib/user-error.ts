/** Client-side error plumbing: every fetch failure becomes a UserError -
 *  plain text plus an action link where there is a next step (log in, top
 *  up). Render via <ErrNote>. Never hand a raw server string to the page. */

export type UserError = {
  message: string;
  status?: number;
  action?: { label: string; href: string };
};

export class ApiError extends Error {
  ue: UserError;
  constructor(ue: UserError) {
    super(ue.message);
    this.ue = ue;
  }
}

/** Server message worth keeping verbatim? Our refusal/validation strings are
 *  already plain language ("needs an image for image_url - attach one") -
 *  only the two bare codes get replaced outright. */
const KEEP = (m: string) => m && m !== "unauthorized" && m !== "internal error";

export function userError(status: number | undefined, serverMsg: unknown): UserError {
  const raw = typeof serverMsg === "string" ? serverMsg : "";
  const s = status ?? 0;
  let message: string;
  switch (s) {
    case 401:
      message = "You're not logged in - log in to upload files and run jobs.";
      break;
    case 402:
      message = KEEP(raw) ? raw : "Not enough credits for that - top up on the plans page.";
      break;
    case 403:
      message = KEEP(raw) ? raw : "You don't have access to that.";
      break;
    case 404:
      message = KEEP(raw) ? raw : "Not found - it may have been deleted.";
      break;
    case 413:
      message = KEEP(raw) ? raw : "That file is too large.";
      break;
    case 415:
      message = KEEP(raw) ? raw : "That file type isn't supported here.";
      break;
    case 429:
      message = KEEP(raw) ? raw : "Too many requests - give it a moment and try again.";
      break;
    default:
      message = KEEP(raw)
        ? raw
        : s >= 500
          ? "Something went wrong on our side - try again in a moment."
          : "Something went wrong - try again.";
  }
  const action =
    s === 401 ? { label: "Log in", href: "/login" }
    : s === 402 ? { label: "See plans", href: "/pricing" }
    : undefined;
  return { message, status: s || undefined, action };
}

/** fetch threw, a shape check failed, or a page threw an Error - normalize
 *  everything a catch block can see into a UserError. */
export function userErrorFrom(e: unknown): UserError {
  if (e instanceof ApiError) return e.ue;
  if (e instanceof TypeError) return { message: "Couldn't reach the server - is the app still running?" };
  if (e instanceof Error) return userError(undefined, e.message);
  return userError(undefined, String(e));
}

/** Parse a response the way the pages need it: throws ApiError(UserError)
 *  on !ok, returns the parsed body otherwise. */
export async function apiJson<T = Record<string, unknown>>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(userError(r.status, (d as { error?: unknown })?.error));
  return d as T;
}

/** Upload one file → the /files/ url. Throws ApiError(UserError) - callers
 *  catch and hand userErrorFrom(e) to <ErrNote>. */
export async function uploadFile(
  file: File | Blob,
  name?: string,
): Promise<{ url: string; mime?: string; bytes?: number; name?: string }> {
  const fd = new FormData();
  fd.set("file", file, name ?? (file instanceof File ? file.name : "upload.bin"));
  let r: Response;
  try {
    r = await fetch("/api/uploads", { method: "POST", body: fd });
  } catch {
    throw new ApiError({ message: "Couldn't reach the server - is the app still running?" });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d?.url) throw new ApiError(userError(r.status, d?.error ?? "upload failed"));
  return d;
}
