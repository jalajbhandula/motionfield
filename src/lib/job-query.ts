import { processJobs } from "@/lib/jobs";

let ticking = false;

/** Opportunistically advance the queue on reads (dev-mode worker substitute). */
export async function tickPublicJob(_id: string) {
  if (ticking) return;
  ticking = true;
  try {
    await processJobs();
  } finally {
    ticking = false;
  }
}
