/** Standalone job worker: node --import tsx scripts/worker.ts */
import { processJobs, reapStuckJobs } from "../src/lib/jobs";
import { tickRuns } from "../src/lib/runs";

async function loop() {
  for (;;) {
    const remaining = await processJobs().catch((e) => { console.error(e); return 0; });
    // durable runs tick here too — a run whose client went away still drives
    // to its terminal state. Errors are logged, never fatal to the loop.
    await tickRuns().catch((e) => { console.error(e); });
    await reapStuckJobs().catch(() => {});
    await new Promise((r) => setTimeout(r, remaining > 0 ? 800 : 2500));
  }
}
loop();
