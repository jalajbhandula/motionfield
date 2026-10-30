import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { getDb, schema } from "@/db";

/** Social sign-in providers - enabled only when both env vars are set. */
export const SOCIAL_PROVIDERS = [
  { id: "google", envId: "BETTER_AUTH_GOOGLE_CLIENT_ID", envSecret: "BETTER_AUTH_GOOGLE_CLIENT_SECRET" },
  { id: "apple", envId: "BETTER_AUTH_APPLE_CLIENT_ID", envSecret: "BETTER_AUTH_APPLE_CLIENT_SECRET" },
  { id: "microsoft", envId: "BETTER_AUTH_MICROSOFT_CLIENT_ID", envSecret: "BETTER_AUTH_MICROSOFT_CLIENT_SECRET" },
  { id: "github", envId: "BETTER_AUTH_GITHUB_CLIENT_ID", envSecret: "BETTER_AUTH_GITHUB_CLIENT_SECRET" },
] as const;

/** Provider ids whose OAuth env is configured - drives the login page buttons. */
export function configuredSocialProviders(): string[] {
  return SOCIAL_PROVIDERS.filter((p) => process.env[p.envId] && process.env[p.envSecret]).map((p) => p.id);
}

function social() {
  const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const p of SOCIAL_PROVIDERS) {
    const clientId = process.env[p.envId];
    const clientSecret = process.env[p.envSecret];
    if (clientId && clientSecret) socialProviders[p.id] = { clientId, clientSecret };
  }
  return socialProviders;
}

// betterAuth() returns Auth<TLiteralOptions>; the unparameterized ReturnType
// is Auth<BetterAuthOptions> which isn't assignable. Keep it opaque.
const g = globalThis as unknown as { __ofAuth?: any; __ofAuthPromise?: Promise<any> };

/** Lazily build the auth instance so the async db init stays out of module
 *  scope. The ??= in-flight promise dedupes concurrent first calls - without
 *  it each caller built its own betterAuth instance and the last writer won
 *  (sessions/rate-limit state split across instances). A failed build clears
 *  the promise so the next call retries. */
export async function getAuth(): Promise<any> {
  if (g.__ofAuth) return g.__ofAuth;
  g.__ofAuthPromise ??= buildAuth().catch((e) => {
    g.__ofAuthPromise = undefined;
    throw e;
  });
  return g.__ofAuthPromise;
}

/**
 * Reverse proxies we run ourselves, as IP/CIDR entries
 * (MOTIONFIELD_TRUSTED_PROXIES=10.0.0.0/8,192.0.2.10). Only then is the
 * X-Forwarded-For chain walked - right to left, trusted hops skipped - for the
 * rate-limit key. Empty (the default, direct connections): the header is not
 * consulted at all - Next fills `x-forwarded-for` from the socket only when the
 * client didn't send it, so a client-supplied value would otherwise win the
 * bucket key; ignoring the header keeps every unproxied client on one shared
 * key instead of a spoofable one. The limiter is never disabled this way -
 * better-auth falls back to a fixed "no-trusted-ip" bucket (or 127.0.0.1 in
 * dev/test), never null.
 */
function trustedProxies(): string[] {
  return (process.env.MOTIONFIELD_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extra origins allowed to POST to /api/auth/* beyond BETTER_AUTH_URL's own
 *  (MOTIONFIELD_TRUSTED_ORIGINS=http://127.0.0.1:3000,http://192.168.1.5:3000).
 *  Browsing by 127.0.0.1 or a LAN IP while BETTER_AUTH_URL says localhost is
 *  otherwise rejected 403 INVALID_ORIGIN - different host, different origin. */
function trustedOrigins(): string[] {
  return (process.env.MOTIONFIELD_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The `advanced.ipAddress` option buildAuth passes - exported so tests can
 *  drive better-auth's getIP with exactly the configured policy. */
export function ipAddressOptions(): { trustedProxies: string[] } | { ipAddressHeaders: string[] } {
  const proxies = trustedProxies();
  return proxies.length ? { trustedProxies: proxies } : { ipAddressHeaders: [] };
}

async function buildAuth(): Promise<any> {
  if (process.env.MOTIONFIELD_HOSTED === "1" && !process.env.BETTER_AUTH_SECRET)
    throw new Error("BETTER_AUTH_SECRET is required when MOTIONFIELD_HOSTED=1 - the dev fallback is not safe to ship");
  const db = await getDb();
  g.__ofAuth = betterAuth({
    appName: "MotionField",
    secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-me-in-production-0123456789",
    baseURL: process.env.BETTER_AUTH_URL,
    trustedOrigins: trustedOrigins(),
    database: drizzleAdapter(db, {
      provider: "pg",
      transaction: true,
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
    },
    socialProviders: social(),
    plugins: [
      // Profile provisioning is awaited: ensureProfile is race-safe (single
      // ON CONFLICT insert + FK-retry wrapper) so the sign-up response only
      // returns once the profile row exists. A provisioning failure is logged
      // but never fails sign-up - requireApiUser() re-ensures the profile on
      // the next authenticated request anyway.
      {
        id: "motionfield-profile",
        hooks: {
          after: [{
            matcher: (ctx) =>
              ctx.path === "/sign-up/email" ||
              (typeof ctx.path === "string" && ctx.path.startsWith("/callback/")),
            handler: createAuthMiddleware(async (ctx) => {
              const u = (ctx.context.newSession as
                | { user?: { id: string; email: string; name?: string | null } }
                | null)?.user;
              if (!u?.id) return;
              const { ensureProfile } = await import("@/lib/profiles");
              await ensureProfile(u.id, u.email, u.name)
                .catch((e) => console.error("ensureProfile failed", u.id, e));
            }),
          }],
        },
      },
      nextCookies(),
    ],
    advanced: {
      ipAddress: ipAddressOptions(),
    },
    rateLimit: {
      // Demo/mock dev servers drive the UI headlessly - page loads alone can
      // exhaust the 30/60 s window, and a 429 on get-session loops reloads.
      // Test-only kill switch alongside BETTER_AUTH_RATE_TEST; never in prod.
      enabled: !(process.env.NODE_ENV !== "production" && process.env.BETTER_AUTH_RATE_OFF === "1"),
      window: 60,
      max: 30,
      // Test bypass for the e2e suite: better-auth's built-in sign-up rule
      // (3 per 10 s) rejects the parallel-signup test; only ever set in tests.
      ...(process.env.NODE_ENV !== "production" && process.env.BETTER_AUTH_RATE_TEST === "1"
        ? { customRules: { "/sign-up/email": false, "/sign-in/email": false } }
        : {}),
    },
  });
  return g.__ofAuth;
}
