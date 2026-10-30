/**
 * Director security rows:
 *  - the default backend resolves to the Wan VACE graphs (open) - never LTX
 *  - backend:"ltx" resolves restricted through the licence gate and refuses
 *    without a current opt-in (the 403 source)
 *  - the comfy progress Bearer travels same-origin only - a foreign or
 *    malformed events url gets no header, and no key means no header
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

let row: { version: string }[] = [];
vi.mock("@/db", () => ({
  getDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => row }) }) }),
  }),
  schema: { licenseOptins: { userId: {} } },
}));

import { DIRECTOR } from "@/lib/catalog/video/generate";
import { assertLicenseAllowed, RestrictedLicenseError, endpointLicense } from "@/lib/catalog/license-gate";
import { progressHeaders, streamProgress } from "@/lib/generation/comfy";
import type { WorkflowDef } from "@/lib/catalog/types";
import http from "node:http";
import type { AddressInfo } from "node:net";

const wf: WorkflowDef = DIRECTOR.workflows[0];
const wfFor = (p: Record<string, unknown>) => wf.providers.comfy!.workflowFor?.(p) ?? wf.providers.comfy!.workflow;

describe("director backend routing + licence gate", () => {
  it("default backend resolves Wan VACE - never LTX", () => {
    expect(wfFor({})).toBe("director-wan-txt.json");              // no start frame → keyframe variant
    expect(wfFor({ image_url: "/files/a.png" })).toBe("director-wan.json");
    expect(wfFor({ backend: "wan-vace" })).toBe("director-wan-txt.json");
    // ltx only when explicitly asked for
    expect(wfFor({ backend: "ltx" })).toBe("ltx-txt2video.json");
    expect(wfFor({ backend: "ltx", image_url: "/files/a.png" })).toBe("ltx-img2video.json");
  });

  it("backend ltx resolves restricted + refuses without opt-in", async () => {
    expect(endpointLicense(wf).class).toBe("open");              // base badge
    expect(endpointLicense(wf, { backend: "ltx" }).class).toBe("restricted");
    await expect(assertLicenseAllowed(wf, "u", { backend: "ltx" }))
      .rejects.toBeInstanceOf(RestrictedLicenseError);
    await expect(assertLicenseAllowed(wf, "u")).resolves.toBeUndefined(); // default stays open
  });
});

describe("comfy progress Bearer", () => {
  const KEY = "sk-test-not-a-real-key";
  beforeEach(() => { process.env.COMFY_API_KEY = KEY; delete process.env.COMFY_BASE_URL; });
  afterEach(() => { delete process.env.COMFY_API_KEY; });

  it("same-origin gets the header; foreign + malformed urls get none; no key → none", () => {
    // default base is http://127.0.0.1:8189
    expect(progressHeaders("http://127.0.0.1:8189/events")).toEqual({ authorization: `Bearer ${KEY}` });
    expect(progressHeaders("http://127.0.0.1:8189/x")).toEqual({ authorization: `Bearer ${KEY}` });
    expect(progressHeaders("https://evil.example.com/events")).toEqual({});
    expect(progressHeaders("not a url")).toEqual({});
    delete process.env.COMFY_API_KEY;
    expect(progressHeaders("http://127.0.0.1:8189/events")).toEqual({});
  });

  it("the wire: the configured endpoint receives the Bearer, a foreign one doesn't", async () => {
    // two local stubs record what actually arrives on the wire - the
    // configured base gets the key, the foreign origin gets nothing
    const seen: { url?: string; authorization?: string }[] = [];
    const stub = () => new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const srv = http.createServer((req, res) => {
        seen.push({ url: req.url, authorization: req.headers.authorization });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"value":1}\n\n');
      });
      srv.listen(0, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((done) => srv.close(() => done())),
        }));
    });
    const configured = await stub();
    const foreign = await stub();
    try {
      process.env.COMFY_BASE_URL = configured.url;
      const ac = new AbortController();
      await streamProgress(`${configured.url}/events`, () => {}, ac.signal);
      await streamProgress(`${foreign.url}/events`, () => {}, ac.signal);
      expect(seen[0].authorization).toBe(`Bearer ${KEY}`);
      expect(seen[1].authorization).toBeUndefined();
    } finally {
      delete process.env.COMFY_BASE_URL;
      await configured.close();
      await foreign.close();
    }
  });
});
