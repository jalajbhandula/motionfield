import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { saveCheckedUpload } from "@/lib/api/uploads";
import { filePathFor } from "@/lib/storage";

describe("safe uploads", () => {
  it("stores a spoofed client filename under the MIME-derived extension", async () => {
    // "evil.html" declared as image/png must land on disk as .png - it is
    // served from /files/ with an image type, never as HTML.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "evil.html", { type: "image/png" });
    const out = await saveCheckedUpload(file);
    try {
      expect(out.url).toMatch(/^\/files\/uploads\/[0-9a-f-]+\.png$/);
      const p = filePathFor(out.url);
      expect(p).not.toBeNull();
      expect((await fsp.readFile(p!)).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(out.bytes).toBe(7);
      expect(out.mime).toBe("image/png");
    } finally {
      const p = filePathFor(out.url);
      if (p) await fsp.unlink(p).catch(() => {});
    }
  });

  it("rejects an unsupported MIME with 415 and never writes the file", async () => {
    const file = new File(["<html><script>alert(1)</script>"], "page.png", { type: "text/html" });
    await expect(saveCheckedUpload(file)).rejects.toMatchObject({ status: 415 });
    const dir = filePathFor("/files/uploads/")!;
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    expect(names.every((n) => !n.endsWith(".html"))).toBe(true);
  });
});
