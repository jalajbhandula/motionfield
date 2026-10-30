import { describe, it, expect } from "vitest";
import { safeNext } from "@/app/login/safe-next";

describe("safeNext", () => {
  it("keeps ordinary same-origin paths", () => {
    expect(safeNext("/a?b")).toBe("/a?b");
    expect(safeNext("/onboarding")).toBe("/onboarding");
    expect(safeNext("/projects/abc#frag")).toBe("/projects/abc#frag");
  });

  it("falls back on anything that can re-parse as cross-origin", () => {
    for (const raw of [
      "//e.com",        // protocol-relative
      "/\\e.com",       // backslash collapses to a slash → //e.com
      "/\t/e.com",      // tab is stripped by the URL parser → //e.com
      "/%09/e.com",     // decodes to a tab the browser strips on re-parse
      "https://e.com",  // absolute URL
      "",               // empty
    ]) {
      expect(safeNext(raw), JSON.stringify(raw)).toBe("/");
    }
  });

  it("honors the caller's fallback", () => {
    expect(safeNext("//e.com", "/onboarding")).toBe("/onboarding");
    expect(safeNext(null)).toBe("/");
    expect(safeNext(null, "/credits")).toBe("/credits");
  });
});
