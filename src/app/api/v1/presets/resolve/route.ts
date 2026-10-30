import { NextRequest } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/lib/api/auth-bearer";
import { v1json, v1err, v1error } from "@/lib/api/v1";
import { findEndpoint } from "@/lib/catalog/video-models";
import { resolveParams } from "@/lib/jobs";

export const runtime = "nodejs";

const Body = z.strictObject({
  endpoint: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * POST /api/v1/presets/resolve {endpoint, params} - run the preset
 * resolution stage only. Returns the endpoint plus the params block
 * resolveParams produces (params that may carry preset ids - `preset_id`,
 * `*_preset` - merged into apply values and prompt fragments, marker fields
 * stripped). Lets an MCP client see exactly what a preset marker will do to
 * its params before spending credits on the real submission.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireBearer(req);
    if (auth instanceof Response) return auth;
    let body: z.infer<typeof Body>;
    try {
      body = Body.parse(await req.json());
    } catch {
      return v1error("bad_request", "invalid body - expected { endpoint, params? }", 400);
    }
    const found = findEndpoint(body.endpoint);
    if (!found) return v1error("unknown_endpoint", `unknown endpoint ${body.endpoint}`, 404);
    return v1json({ endpoint: body.endpoint, params: resolveParams(body.params) });
  } catch (e) {
    return v1err(e);
  }
}
