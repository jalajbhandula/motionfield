import { NextResponse } from "next/server";
import { JobError, type JobSource } from "@/lib/jobs";
import { InsufficientCredits } from "@/lib/credits";
import { RestrictedLicenseError } from "@/lib/catalog/license-gate";
import type { ParamField } from "@/lib/catalog/types";

/** v1 envelope: every response is { ... } or { error: { code, message } }. */
export function v1json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers });
}

export function v1error(code: string, message: string, status: number, headers?: Record<string, string>) {
  return v1json({ error: { code, message } }, status, headers);
}

const STATUS_CODES: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "payment_required",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable_entity",
  429: "rate_limited",
};

export function v1err(e: unknown): NextResponse {
  if (e instanceof RestrictedLicenseError) return v1json({ error: { ...e.body.error, message: e.message } }, 403);
  if (e instanceof JobError) {
    const headers = e.status === 429 ? { "Retry-After": "5" } : undefined;
    return v1error(e.code ?? STATUS_CODES[e.status] ?? "error", e.message, e.status, headers);
  }
  if (e instanceof InsufficientCredits) return v1error("insufficient_credits", e.message, 402);
  console.error(e);
  return v1error("internal_error", "internal error", 500);
}

/** Serialize a Date-or-string timestamp as ISO-8601. */
export { ts } from "./job-shape";

export function jobLinks(id: string) {
  return {
    self: `/api/v1/jobs/${id}`,
    cancel: `/api/v1/jobs/${id}/cancel`,
    result: `/api/v1/jobs/${id}/result`,
  };
}

/**
 * Provenance for v1 writes: `X-MotionField-Source: cli|mcp` from our own
 * clients; anything else (or absent) is a bare API caller → "api". The DB
 * CHECK also allows 'ui' (default) and 'agent' (WS2 lane).
 */
export function requestSource(req: { headers: Headers }): JobSource {
  const v = req.headers.get("x-motionfield-source");
  return v === "cli" || v === "mcp" ? v : "api";
}

/* ---------- catalog param fields -> JSON Schema ---------- */

const STRING_TYPES = new Set(["text", "textarea", "prompt"]);
const NUMBER_TYPES = new Set(["number", "slider"]);
const MEDIA_TYPES = new Set(["image", "video", "audio", "media"]);
const ARRAY_TYPES = new Set(["images", "multishots"]);

function fieldSchema(f: ParamField): Record<string, unknown> {
  let s: Record<string, unknown>;
  if (f.enum && f.enum.length) {
    s = { enum: [...f.enum] };
    if (f.enum.every((x) => typeof x === "number")) s.type = "number";
    else if (f.enum.every((x) => typeof x === "string")) s.type = "string";
  } else if (STRING_TYPES.has(f.type)) s = { type: "string" };
  else if (f.type === "integer") s = { type: "integer" };
  else if (NUMBER_TYPES.has(f.type)) s = { type: "number" };
  else if (f.type === "boolean") s = { type: "boolean" };
  else if (ARRAY_TYPES.has(f.type)) {
    s = {
      type: "array",
      items: f.type === "multishots"
        ? { type: "object" }
        : { type: "string", "x-media": "image", description: "media URL - upload via POST /api/v1/uploads" },
    };
  } else if (f.type === "media") {
    // "media" fields are arrays of media urls of any kind (every catalog use
    // is a *_urls field); the accepts mime hint narrows which kinds a client
    // may send - x-media lives on the items like other media arrays.
    s = {
      type: "array",
      items: { type: "string", "x-media": "media", description: "media URL - upload via POST /api/v1/uploads" },
    };
    if (f.accepts) s.accepts = f.accepts;
  } else if (MEDIA_TYPES.has(f.type)) {
    s = {
      type: "string",
      "x-media": f.type,
      description: `media URL - upload via POST /api/v1/uploads${f.description ? ` - ${f.description}` : ""}`,
    };
  } else s = {};
  if (f.min !== undefined && (s.type === "number" || s.type === "integer")) s.minimum = f.min;
  if (f.max !== undefined && (s.type === "number" || s.type === "integer")) s.maximum = f.max;
  if (f.minItems !== undefined) s.minItems = f.minItems;
  if (f.maxItems !== undefined) s.maxItems = f.maxItems;
  if (f.description && s.description === undefined) s.description = f.description;
  if (f.default !== undefined) s.default = f.default;
  return s;
}

/** JSON Schema object built from a workflow's catalog param fields. */
export function paramsJsonSchema(fields: ParamField[]) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldSchema(f);
    if (f.required) required.push(f.name);
  }
  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: true };
  if (required.length) schema.required = required;
  return schema;
}
