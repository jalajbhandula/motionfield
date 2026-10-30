/**
 * WS5 recipe smoke — call motionRenderRecipe directly (no job/API layer):
 *
 *   npx tsx scripts/render/smoke.ts --base http://localhost:3150 [--inline]
 *
 * Needs a dev server already running at --base (the recipe shells out to
 * scripts/render/export.ts, which drives /render/motion headlessly).
 * Default mode seeds a throwaway user + jobs row + render_specs row in the
 * local db and exercises the spec_id path (the recipe checks
 * render_specs.user_id === jobs.user_id); --inline passes the fixture spec
 * object directly (no db needed). Output lands in public/files/generated/.
 */
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const base = arg("base") || `http://localhost:${process.env.PORT || "3150"}`;
  const spec = JSON.parse(readFileSync("tests/fixtures/ws5-launch.json", "utf8"));
  const { motionRenderRecipe } = await import("../../src/lib/generation/recipes/motion-render");

  let params: Record<string, unknown>;
  let jobId = `smoke-ws5-${Date.now()}`;
  if (process.argv.includes("--inline")) {
    params = { spec, values: { titleScale: 1.15 } };
  } else {
    const { getDb, schema } = await import("../../src/db/index");
    const db = await getDb();
    const uid = `smoke-ws5-${Date.now()}`;
    await db.insert(schema.user).values({ id: uid, name: "smoke", email: `${uid}@test.local` });
    const [row] = await db.insert(schema.renderSpecs).values({ userId: uid, spec })
      .returning({ id: schema.renderSpecs.id });
    // spec_id path requires a jobs row owned by the same user
    jobId = crypto.randomUUID();
    await db.insert(schema.jobs).values({
      id: jobId, userId: uid, kind: "video", modelId: "motion-render",
      endpointId: "motionfield/motion-render/mp4", workflow: "mp4", provider: "recipe",
    });
    params = { spec_id: row.id };
    console.log(`seeded render_specs row ${row.id} + job ${jobId}`);
  }

  const ac = new AbortController();
  const items = await motionRenderRecipe(
    {
      jobId,
      model: {} as never,
      workflow: {} as never,
      params,
      appBaseUrl: base,
    },
    { signal: ac.signal, progress: (p, s) => process.stdout.write(`\r${p}% ${s ?? ""}   `) },
  );
  console.log("\nitems:", JSON.stringify(items));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
