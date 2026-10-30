import { NextRequest } from "next/server";
import { json, err, requireApiUser } from "@/lib/api";
import { createJob, listUserJobs, applyDailyCredits } from "@/lib/jobs";
import { RestrictedLicenseError } from "@/lib/catalog/license-gate";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    await applyDailyCredits(user.id);
    const body = await req.json();
    const job = await createJob(user.id, {
      endpointId: String(body.endpoint_id ?? body.endpointId ?? ""),
      params: body.params ?? {},
      projectId: body.project_id ?? body.projectId ?? null,
      title: body.title,
      visibility: body.visibility === "public" ? "public" : undefined,
      idempotencyKey: req.headers.get("idempotency-key") ?? body.idempotency_key ?? undefined,
      presetId: body.preset_id ?? null,
      presetKind: body.preset_kind ?? null,
      parentJobId: body.parent_job_id ?? null,
      graphJson: body.graph_json ?? null,
      graphForkedFrom: body.graph_forked_from ?? null,
    });
    return json({ job }, 201);
  } catch (e) {
    if (e instanceof RestrictedLicenseError) return json(e.body, e.status);
    return err(e);
  }
}

export async function GET(req: NextRequest) {
  try {
    const { user } = await requireApiUser(req);
    const jobs = await listUserJobs(user.id, Number(req.nextUrl.searchParams.get("limit")) || 60);
    return json({ jobs });
  } catch (e) {
    return err(e);
  }
}
