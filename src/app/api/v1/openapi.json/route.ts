import { v1json } from "@/lib/api/v1";
import { buildOpenApi } from "@/lib/api/openapi";

export const runtime = "nodejs";

/** GET /api/v1/openapi.json - public OpenAPI 3.1 document built from the catalog. */
export async function GET() {
  return v1json(buildOpenApi());
}
