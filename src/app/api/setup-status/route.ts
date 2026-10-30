export const runtime = "nodejs";

/** What a first-time visitor needs to know before they hit Generate.
 *  Mock mode never touches a GPU. Comfy mode is "connected" only when the
 *  local proxy answers. The URL and any API key stay on the server. */
export async function GET() {
  const provider = (process.env.GENERATION_PROVIDER || "comfy").trim();
  if (provider === "mock") {
    return Response.json({
      gpu: "not_used",
      label: "GPU not used",
      detail: "Mock mode is on. Every page works. Renders are synthetic until you switch to ComfyUI.",
    });
  }
  const base = (process.env.COMFY_BASE_URL || "http://127.0.0.1:8189").replace(/\/+$/, "");
  const key = process.env.COMFY_API_KEY;
  try {
    const res = await fetch(`${base}/api/v2/health`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (res.ok) {
      return Response.json({
        gpu: "connected",
        label: "GPU connected",
        detail: "ComfyUI is reachable. A generate action renders on your GPU.",
      });
    }
    return Response.json({
      gpu: "not_connected",
      label: "GPU not connected",
      detail: "ComfyUI did not answer. Start ComfyUI, then the API proxy, for a real render.",
    });
  } catch {
    return Response.json({
      gpu: "not_connected",
      label: "GPU not connected",
      detail: "ComfyUI is not reachable. Start ComfyUI, then the API proxy, for a real render.",
    });
  }
}
