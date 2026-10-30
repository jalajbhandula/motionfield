import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { configuredSocialProviders, SOCIAL_PROVIDERS } from "@/lib/auth";

const ENV_KEYS = SOCIAL_PROVIDERS.flatMap((p) => [p.envId, p.envSecret]);
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("configuredSocialProviders", () => {
  it("is empty when no provider env is set", () => {
    expect(configuredSocialProviders()).toEqual([]);
  });

  it("lists only providers with both client id and secret", () => {
    process.env.BETTER_AUTH_GITHUB_CLIENT_ID = "gid";
    expect(configuredSocialProviders()).toEqual([]);          // id without secret
    process.env.BETTER_AUTH_GITHUB_CLIENT_SECRET = "gsecret";
    expect(configuredSocialProviders()).toEqual(["github"]);
    process.env.BETTER_AUTH_GOOGLE_CLIENT_SECRET = "x";
    expect(configuredSocialProviders()).toEqual(["github"]);  // secret without id
    process.env.BETTER_AUTH_GOOGLE_CLIENT_ID = "y";
    expect(configuredSocialProviders()).toEqual(["google", "github"]);
  });
});
