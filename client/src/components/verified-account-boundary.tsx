import type { ReactNode } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  buildProgressiveAccountPath, getProgressiveAccountGate, preserveProgressiveAuthContext,
  type ProgressiveAccountAction,
} from "@shared/progressiveOnboarding";

const prompts: Record<ProgressiveAccountAction, { title: string; description: string }> = {
  keep_draft: { title: "Keep your work", description: "Sign in and verify your email to keep this draft. Your design stays on this device." },
  contact: { title: "Continue to contact", description: "Sign in and verify your email first. Return here to review and send your message yourself." },
  restricted: { title: "Continue to this account page", description: "Sign in and verify your email to continue. Membership and business access requirements still apply." },
};

export function VerifiedAccountBoundary({ user, action = "restricted", destination, children }: {
  user: { emailVerified?: unknown } | null | undefined;
  action?: ProgressiveAccountAction;
  destination: string;
  children?: ReactNode;
}) {
  const gate = getProgressiveAccountGate(user);
  if (gate === "continue") return <>{children}</>;
  const authPath = buildProgressiveAccountPath(gate, action, destination);
  const prompt = prompts[action];
  const signup = preserveProgressiveAuthContext("/customer-signup", new URL(authPath, "https://mealscout.local").searchParams);
  return <main className="flex min-h-[70vh] items-center justify-center px-4 py-10">
    <section className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-6 text-center" aria-labelledby="account-action-title">
      <h1 id="account-action-title" className="text-2xl font-bold">{gate === "verify_email" ? "Verify your email to continue" : prompt.title}</h1>
      <p className="text-muted-foreground">{prompt.description}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild><Link href={authPath}>{gate === "verify_email" ? "Verify email" : "Sign in"}</Link></Button>
        {gate === "sign_in" && <Button asChild variant="outline"><Link href={signup}>Create an account</Link></Button>}
      </div>
    </section>
  </main>;
}
