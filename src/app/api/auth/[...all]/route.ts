import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";
import type { NextRequest } from "next/server";

async function handler(req: NextRequest) {
  const auth = await getAuth();
  return auth.handler(req);
}

export const GET = handler;
export const POST = handler;
