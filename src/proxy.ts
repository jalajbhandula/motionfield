import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic auth gate - checks only for the session cookie.
 * Real enforcement happens server-side in each route/page via auth.api.getSession.
 */
/* Access rule: tool/studio surfaces stay OPEN for viewing (the tool renders,
   auth is demanded at action time by the API).
   Only account/user-data views stay gated at the edge. */
const PROTECTED_PREFIXES = [
  "/history",
  "/projects",
  "/assets",
  "/settings",
  "/characters",
  "/onboarding",
  "/credits",
  "/teams",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const needsAuth =
    PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (!needsAuth) return NextResponse.next();

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|files|icon.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|webm|ico|txt|xml)$).*)",
  ],
};
