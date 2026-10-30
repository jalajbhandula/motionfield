import Link from "next/link";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <div className="panel max-w-xl space-y-3 p-5">
      <h2 className="font-semibold">Profile</h2>
      <p className="text-sm text-[var(--color-dim)]">Not configured yet.</p>
      <p className="text-sm text-[var(--color-dim)]">
        Profile and account settings live on the{" "}
        <Link href="/me/settings" className="text-[var(--color-accent)] hover:underline">account page</Link>.
      </p>
    </div>
  );
}
