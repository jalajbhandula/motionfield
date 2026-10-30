/* Shared studio submit contract - every generate-style studio tool submits
 * one job, optionally waits a bounded time, and returns the job view.
 * Kept to one place so the 17 wrappers stay thin. */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MotionFieldError } from "../../../../sdk-ts/src/index.ts";
import { notAvailable, ok, toolError, type ToolCtx } from "../../registry.mts";

export const WAIT_CAP_S = 50;

/** the `wait_s` knob every studio generate tool advertises */
export const waitField = z.number().positive().max(WAIT_CAP_S).optional()
  .describe(`poll this many seconds for completion (max ${WAIT_CAP_S})`);

export async function submitJob(
  ctx: ToolCtx, endpoint: string, params: Record<string, unknown>, wait_s?: number,
): Promise<CallToolResult> {
  const created = await ctx.client.submit(endpoint, params);
  if (!wait_s) return ok(created);
  try {
    return ok(await ctx.client.wait(created.id, { timeoutMs: Math.min(wait_s, WAIT_CAP_S) * 1000 }));
  } catch (e) {
    // wait budget expired is a status, not a failure - surface the live view
    if (e instanceof MotionFieldError && e.code === "wait_timeout")
      return ok(await ctx.client.get(created.id));
    throw e;
  }
}

/** likeness-consuming endpoints (character swap, motion transfer, talking
 *  portraits, lip sync) refuse without an explicit likeness_consent:true -
 *  checked in the handler so the refusal is the consent_required tool error,
 *  not a protocol-level schema rejection. */
export const consentField = z.boolean().optional()
  .describe("required true - you assert the right to use this person's likeness (docs/POLICY.md)");

/* ---------- live-schema check ---------- */

/* The shape the startup model catalog carries for `inputs`: a JSON Schema
 * object whose `properties` map name → subschema. Only `enum` is read - the
 * catalog record is zod-parsed (never cast) so a malformed inputs blob can't
 * smuggle a fake property list into the check. */
const PropSchema = z.looseObject({ enum: z.array(z.unknown()).optional() });
const InputsSchema = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
});

export type SchemaProps = Record<string, unknown>;

/** The endpoint's declared input properties from the startup catalog - null
 *  when the catalog fetch failed or never listed it. */
export function schemaProps(ctx: ToolCtx, endpoint: string): SchemaProps | null {
  const model = ctx.models?.get(endpoint);
  if (!model) return null;
  const parsed = InputsSchema.safeParse(model.inputs);
  return parsed.success ? (parsed.data.properties ?? {}) : {};
}

/** Live-schema check for a mapped params object: `endpoint` must be in the
 *  startup catalog (else notAvailable), every mapped key must be a declared
 *  input (else invalid_params naming it), and a field whose schema lists
 *  `enum` values must pick one of them. null = the mapped set is submittable. */
export function checkAgainstSchema(
  ctx: ToolCtx, endpoint: string, mapped: Record<string, unknown>,
): CallToolResult | null {
  const properties = schemaProps(ctx, endpoint);
  if (!properties)
    return notAvailable(`endpoint ${endpoint} is not in the startup model catalog`);
  for (const [name, value] of Object.entries(mapped)) {
    const prop = properties[name];
    if (!prop)
      return toolError("invalid_params", `endpoint ${endpoint} declares no '${name}' param`);
    const allowed = PropSchema.safeParse(prop);
    const list = allowed.success ? allowed.data.enum : undefined;
    if (Array.isArray(list) && list.length && !list.includes(value))
      return toolError("invalid_params",
        `${name}: "${String(value)}" is not one of ${list.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  return null;
}
