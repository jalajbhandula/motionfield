import { Suspense } from "react";
import { connection } from "next/server";
import { configuredSocialProviders } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  await connection();
  const providers = configuredSocialProviders();
  return (
    <Suspense>
      <SignupForm providers={providers} />
    </Suspense>
  );
}
