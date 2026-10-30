import { ALL_MODELS } from "@/lib/catalog/video-models";
import { endpointLicenseFor } from "@/lib/catalog/licenses";

/** `threed` is reported only while the catalog ships at least one callable
 *  kind:"threed" endpoint - a banned one doesn't count. Clients gate 3D
 *  prompts/toolsets on this string, so it must track the real catalog. */
const HAS_THREED = ALL_MODELS.some((m) =>
  m.workflows.some((w) => w.kind === "threed" && endpointLicenseFor(w).class !== "banned"));

/** Static capability registry behind GET /api/v1/capabilities.
 *  Clients (CLI, SDKs, MCP) gate optional command groups on these strings.
 *  WS1 owns this file - other lanes REQUEST a line here when their surface
 *  lands ("runs", "skills.import", "stage", "ads", "sites", …). `threed`
 *  appears/disappears with the catalog, not by hand - see HAS_THREED. */
export const V1_CAPABILITIES = [
  "jobs",
  "jobs.list",
  "jobs.source",
  "runs",
  "skills.read",
  "system",
  "models",
  "estimate",
  "uploads",
  "assets",
  "presets",
  "refs",
  "stage",
  ...(HAS_THREED ? (["threed"] as const) : []),
] as const;

export type V1Capability = (typeof V1_CAPABILITIES)[number];
