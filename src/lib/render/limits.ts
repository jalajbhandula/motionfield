/**
 * Render budgets - a leaf module (no imports) so caption/exporter code can
 * enforce the same caps via a relative path even outside the "@/"-aware
 * loaders (e.g. a playwright spec lazily importing lib code).
 */
export const SPEC_LIMITS = {
  maxLayers: 128,      // including nested group children
  maxGroupDepth: 4,    // groups nested inside groups
  maxParticles: 50_000, // summed over all particles layers
  maxEdge: 3840,
  maxPixels: 3840 * 2160,
  maxFrames: 3600,     // round(duration × fps)
  maxParams: 32,
} as const;
