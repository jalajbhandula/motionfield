import { Suspense } from "react";
import { connection } from "next/server";
import { configuredSocialProviders } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  // Read provider env at request time - the rendered buttons must reflect this
  // deployment's configured providers, not whatever was set at build time.
  await connection();
  const providers = configuredSocialProviders();
  return (
    <Suspense>
      <LoginForm providers={providers} />
    </Suspense>
  );
}
