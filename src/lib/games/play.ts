import type { GameSpec } from "./spec";

/**
 * The document a game runs in: one canvas, the spec as an inert JSON data
 * block, and our runtime script. It is served by /api/games/<id>/play into an
 * iframe sandboxed to allow-scripts only (an opaque origin - no cookies, no
 * storage, no access to the app), under a CSP that admits exactly one script
 * and no network at all.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** JSON that can sit inside <script> without ending it or opening markup. */
export function inertJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export const RUNTIME_PATH = "/games/runtime.js";

export function playCsp(origin: string): string {
  return [
    "default-src 'none'",
    `script-src ${origin}${RUNTIME_PATH}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function buildPlayHtml(spec: GameSpec): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(spec.title)}</title>
<style>html,body{margin:0;height:100%;background:#07080d;overflow:hidden}body{display:flex;align-items:center;justify-content:center}canvas{display:block;touch-action:none;outline:none}</style>
</head>
<body>
<canvas id="game" width="960" height="540" tabindex="0" aria-label="${escapeHtml(spec.title)} - game"></canvas>
<script type="application/json" id="spec">${inertJson(spec)}</script>
<script src="${RUNTIME_PATH}"></script>
</body>
</html>
`;
}
