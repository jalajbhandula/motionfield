import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage", () => ({ saveBytes: vi.fn(async (key: string) => `/files/${key}`) }));

import { saveBytes } from "@/lib/storage";
import {
  extractBrand,
  fetchBrandContext,
  isPublicIp,
  publicOnlyLookup,
  type BrandDeps,
} from "@/lib/render/brand";

describe("isPublicIp", () => {
  it.each([
    ["8.8.8.8", true], ["1.1.1.1", true], ["172.32.0.1", true],
    ["10.0.0.1", false], ["127.0.0.1", false], ["172.16.0.1", false], ["172.31.255.1", false],
    ["192.168.1.1", false], ["169.254.169.254", false], ["169.254.0.1", false],
    ["100.64.0.1", false], ["0.0.0.0", false], ["224.0.0.1", false], ["255.255.255.255", false],
    ["192.0.0.1", false], ["192.0.0.255", false], ["192.0.1.1", true],
    ["198.18.0.1", false], ["198.19.255.254", false], ["198.20.0.1", true],
    // documentation ranges and 6to4/AS112 reserved - unroutable, blocked
    ["192.0.2.10", false], ["198.51.100.10", false], ["203.0.113.10", false],
    ["192.88.99.1", false], ["192.175.48.1", false], ["192.31.196.1", false],
    ["192.52.193.1", false], ["192.0.3.1", true], ["198.51.101.1", true],
  ])("v4 %s → %s", (ip, ok) => expect(isPublicIp(ip)).toBe(ok));

  it.each([
    ["::1", false], ["fe80::1", false], ["fc00::1", false], ["fdff::1", false],
    ["ff02::1", false], ["::", false], ["::ffff:10.0.0.1", false], ["::ffff:8.8.8.8", true],
    ["2606:4700::1111", true], ["2001:db8::1", false],
    // 64:ff9b::/96 NAT64 and 2002::/16 6to4 - judged by the embedded v4
    ["64:ff9b::10.0.0.1", false], ["64:ff9b::808:808", true], ["64:ff9b::ffff:0a00:0001", false],
    ["2002:0a00:0001::", false], ["2002:0808:0808::", true], ["2002:7f00:1::", false],
    ["::ffff:192.0.0.9", false], ["::ffff:198.18.0.1", false],
    // Teredo 2001::/32 - the last 32 bits carry the XOR-obfuscated client v4:
    // f5ff:fffe unobfuscates to 10.0.0.1; f7f7:f7f7 to 8.8.8.8
    ["2001:0::e6e7:f5ff:fffe", false], ["2001:0::d05c:f7f7:f7f7", true],
    // documentation / benchmarking / ORCHIDv2 / site-local - all unroutable
    ["2001:db8::ffff", false], ["2001:2::1", false], ["2001:20::1", false],
    ["3fff::1", false], ["3fff:fff0::1", true], ["fec0::1", false],
  ])("v6 %s → %s", (ip, ok) => expect(isPublicIp(ip)).toBe(ok));
});

describe("publicOnlyLookup - the socket-level vetting", () => {
  const call = (
    lookup: ReturnType<typeof publicOnlyLookup>,
    host: string,
    opts: { all?: boolean } = {},
  ) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((res) =>
      lookup(host, opts, (err, address, family) => res({ err, address, family })));

  it("hands back only public addresses, filtering a mixed answer", async () => {
    const lookup = publicOnlyLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
    const r = await call(lookup, "mix.example");
    expect(r.err).toBeNull();
    expect(r.address).toBe("8.8.8.8");
    expect(r.family).toBe(4);
  });

  it("returns the full vetted set when the socket asks for all", async () => {
    const lookup = publicOnlyLookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
    const r = await call(lookup, "mix.example", { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });

  it("fails closed when the answer flips to all-private (rebinding)", async () => {
    let flip = false;
    const lookup = publicOnlyLookup(async () =>
      flip ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
    expect((await call(lookup, "flip.example")).err).toBeNull();
    flip = true; // the second resolution - the one the socket actually uses - goes private
    const r = await call(lookup, "flip.example");
    expect(r.err?.message).toMatch(/private\/local/);
  });

  it("vetoes literal private IPs and propagates resolver errors", async () => {
    const lookup = publicOnlyLookup(async () => [{ address: "8.8.8.8", family: 4 }]);
    expect((await call(lookup, "10.1.2.3")).err?.message).toMatch(/private\/local/);
    expect((await call(lookup, "[::1]".slice(1, -1))).err?.message).toMatch(/private\/local/);

    const failing = publicOnlyLookup(async () => { throw new Error("ENOTFOUND"); });
    expect((await call(failing, "gone.example")).err?.message).toBe("ENOTFOUND");
  });
});

const pubLookup = async (h: string) => [{ address: "93.184.216.34", family: 4 }];
const html = `<html><head>
  <title>  Test Site  </title>
  <meta name="description" content="We make things.">
  <meta name="theme-color" content="#a1b2c3">
  <meta property="og:site_name" content="TestCo">
  <style>body { background: #112233; }</style>
  </head><body><h1>Hello there</h1><p style="color:#445566">copy</p></body></html>`;

const pageRes = (body: string, ctype = "text/html; charset=utf-8") =>
  new Response(body, { status: 200, headers: { "content-type": ctype } });

describe("fetchBrandContext", () => {
  it("rejects non-http(s) and localhost before fetching", async () => {
    const f = () => Promise.reject(new Error("must not fetch"));
    await expect(fetchBrandContext("file:///etc/passwd", { fetchImpl: f })).rejects.toThrow("http/https");
    await expect(fetchBrandContext("http://localhost:3150/x", { fetchImpl: f, lookup: pubLookup })).rejects.toThrow("blocked");
  });

  it("blocks hosts that resolve privately (SSRF guard)", async () => {
    const f = () => Promise.reject(new Error("must not fetch"));
    const lookup = async () => [{ address: "192.168.0.4", family: 4 }];
    await expect(fetchBrandContext("https://sneaky.example", { fetchImpl: f, lookup })).rejects.toThrow(/blocked|private/);
  });

  it("blocks literal-IP URLs without a lookup", async () => {
    const f = () => Promise.reject(new Error("must not fetch"));
    await expect(fetchBrandContext("http://169.254.169.254/latest/meta-data", { fetchImpl: f })).rejects.toThrow(/blocked|private/);
    await expect(fetchBrandContext("http://[::1]/", { fetchImpl: f })).rejects.toThrow(/blocked|private/);
  });

  it("extracts title/description/theme-color/hex colors/excerpt", async () => {
    const ctx = await fetchBrandContext("https://example.com", { fetchImpl: async () => pageRes(html), lookup: pubLookup });
    expect(ctx.title).toBe("Test Site");
    expect(ctx.description).toBe("We make things.");
    expect(ctx.siteName).toBe("TestCo");
    expect(ctx.themeColor).toBe("#a1b2c3");
    expect(ctx.colors).toContain("#a1b2c3");
    expect(ctx.colors).toContain("#112233");
    expect(ctx.excerpt).toContain("Hello there");
    expect(ctx.excerpt).not.toContain("background:");
  });

  it("follows a manual redirect to another public host", async () => {
    const hops: string[] = [];
    const f: NonNullable<BrandDeps["fetchImpl"]> = async (u) => {
      hops.push(u);
      return u.includes("final.example") ? pageRes(html)
        : new Response("", { status: 302, headers: { location: "https://final.example/landing" } });
    };
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const ctx = await fetchBrandContext("https://start.example", { fetchImpl: f, lookup });
    expect(ctx.title).toBe("Test Site");
    expect(ctx.url).toBe("https://final.example/landing");
    expect(hops).toHaveLength(2);
  });

  it("refuses a redirect that lands on a private host", async () => {
    const f = async (u: string) =>
      u.includes("start") ? new Response("", { status: 302, headers: { location: "http://10.0.0.9/" } }) : pageRes(html);
    const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await expect(fetchBrandContext("https://start.example", { fetchImpl: f, lookup })).rejects.toThrow(/blocked|private/);
  });

  it("rejects non-HTML and oversized bodies", async () => {
    const lookup = pubLookup;
    await expect(fetchBrandContext("https://x.example", { fetchImpl: async () => pageRes("{}", "application/json"), lookup }))
      .rejects.toThrow(/not an HTML/);
    const big = new Response("x".repeat(1_100_000), { status: 200, headers: { "content-type": "text/html" } });
    await expect(fetchBrandContext("https://big.example", { fetchImpl: async () => big, lookup }))
      .rejects.toThrow(/too large/);
  });

  it("a blocked og:image never kills the context", async () => {
    const withOg = html.replace("</head>", '<meta property="og:image" content="http://10.1.2.3/track.png"></head>');
    const f = async () => pageRes(withOg);
    const ctx = await fetchBrandContext("https://example.com", { fetchImpl: f, lookup: pubLookup });
    expect(ctx.title).toBe("Test Site");
    expect(ctx.ogImage).toBeUndefined();
  });

  it("saves an allowed og:image under generated/brand/<uuid>.<ext-from-type>", async () => {
    const mocked = vi.mocked(saveBytes);
    mocked.mockClear();
    const withOg = html.replace("</head>", '<meta property="og:image" content="https://cdn.example.com/card"></head>');
    const f: NonNullable<BrandDeps["fetchImpl"]> = async (u) =>
      String(u).includes("card")
        ? new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), { status: 200, headers: { "content-type": "image/jpeg" } })
        : pageRes(withOg);
    const ctx = await fetchBrandContext("https://example.com", { fetchImpl: f, lookup: pubLookup });
    expect(ctx.ogImage).toMatch(/^\/files\/generated\/brand\/[0-9a-f-]{36}\.jpg$/);
    expect(mocked).toHaveBeenCalledWith(expect.stringMatching(/^generated\/brand\/[0-9a-f-]{36}\.jpg$/), expect.any(Buffer));
  });

  it("rejects og:image types outside png/jpeg/webp", async () => {
    const mocked = vi.mocked(saveBytes);
    mocked.mockClear();
    for (const ct of ["image/gif", "image/svg+xml", "text/plain"]) {
      const withOg = html.replace("</head>", '<meta property="og:image" content="https://cdn.example.com/x"></head>');
      const f: NonNullable<BrandDeps["fetchImpl"]> = async (u) =>
        String(u).includes("cdn.example")
          ? new Response("X", { status: 200, headers: { "content-type": ct } })
          : pageRes(withOg);
      const ctx = await fetchBrandContext("https://example.com", { fetchImpl: f, lookup: pubLookup });
      expect(ctx.ogImage, ct).toBeUndefined();
    }
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe("extractBrand", () => {
  it("handles pages with none of the tags", () => {
    const ctx = extractBrand("<html><body><p>just words</p></body></html>", "https://x.example");
    expect(ctx.title).toBeUndefined();
    expect(ctx.excerpt).toBe("just words");
  });
});
