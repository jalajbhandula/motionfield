/**
 * Media-path safety: /files/* refs and the storage resolver must refuse
 * traversal - raw "..", "..\\", percent-encoded "%2e" (any depth), backslashes
 * and NULs. Safe refs keep working.
 */
import { describe, expect, it } from "vitest";
import path from "path";
import { unsafePathChars, validateMediaParams } from "@/lib/generation/comfy";
import { filePathFor } from "@/lib/storage";
import type { ParamField } from "@/lib/catalog/types";

const wf = { params: [{ name: "image_url", type: "image" } as ParamField] };

describe("comfy media-path validation", () => {
  it("rejects traversal: ../, ..\\, %2e variants", () => {
    for (const bad of [
      "/files/../outside.png",
      "/files/../../etc/passwd",
      "/files/uploads/../../secret.png",
      "/files/..\\windows.png",
      "/files/%2e%2e/escape.png",
      "/files/%2E%2e/escape.png",
      "/files/%252e%252e/double-encoded.png",
      "/files/uploads/..\\..\\w.png",
      "/files/a%00.png",
    ]) {
      expect(() => validateMediaParams(wf, { image_url: bad }), bad).toThrow(/traversal|invalid media param/);
      expect(unsafePathChars(bad), bad).toBe(true);
    }
  });

  it("accepts ordinary /files/ refs and http(s) URLs", () => {
    for (const ok of [
      "/files/uploads/1234.png",
      "/files/generated/a-b_c d.mp4",
      "https://example.com/in.png?x=1",
      "http://127.0.0.1:8188/view?filename=out.png",
    ]) {
      expect(() => validateMediaParams(wf, { image_url: ok }), ok).not.toThrow();
    }
  });

  it("rejects bare filenames and other schemes", () => {
    for (const bad of ["evil.safetensors", "ftp://x/f.png", "file:///etc/passwd"]) {
      expect(() => validateMediaParams(wf, { image_url: bad }), bad).toThrow(/invalid media param/);
    }
  });
});

describe("filePathFor confinement", () => {
  const root = path.join(process.cwd(), "public", "files");

  it("resolves /files/* under public/files", () => {
    expect(filePathFor("/files/generated/x.png")).toBe(path.join(root, "generated", "x.png"));
    expect(filePathFor("/files/a/b/c.png")).toBe(path.join(root, "a", "b", "c.png"));
  });

  it("returns null for traversal and non-/files paths", () => {
    for (const bad of [
      "/files/../secret",
      "/files/..\\secret",
      "/files/%2e%2e/secret",
      "/files/uploads/../../escape",
      "/files/",
      "https://example.com/x.png",
      "/etc/passwd",
      "files/x.png",
    ]) {
      expect(filePathFor(bad), bad).toBeNull();
    }
    // anything it does return is confined under public/files
    const p = filePathFor("/files/x/y.png");
    expect(p).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path.sep}`));
  });
});
