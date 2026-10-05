import { useState } from "react";
import { readSavedBusinessDomain, verifySelfManagedDomain, type DomainVerification } from "@shared/domainLinking";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function OwnerDomainLinking({ restaurantId, savedDomain, onVerified }: {
  restaurantId: string;
  savedDomain: unknown;
  onVerified: () => void;
}) {
  const [verification, setVerification] = useState<DomainVerification | null>(() => readSavedBusinessDomain(savedDomain, restaurantId));
  const [domain, setDomain] = useState(() => verification?.hostname || "");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  async function verify() {
    setChecking(true);
    setError("");
    try {
      const result = await verifySelfManagedDomain(restaurantId, domain, async (path, body) => (await apiRequest("POST", path, body)).json());
      setVerification(result);
      onVerified();
    } catch {
      setError("Connection could not be checked. Enter a business hostname you own and try again.");
    } finally { setChecking(false); }
  }
  return (
    <Card id="custom-domain" className="border-[color:var(--border-subtle)] bg-[var(--bg-surface)] shadow-clean">
      <CardHeader>
        <CardTitle className="text-xl">Link and manage your domain for free</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-stone-600">
          Keep your domain in your own registrar account. DIY domain linking,
          management and verification are free and use the same profile tools.
          Optional $250 help pays for our team to move the domain and check the setup.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-stone-600">
          <li>Choose a hostname you own for this business, such as food.example.com, and run the connection check below.</li>
          <li>Use the expected CNAME target returned by the check when updating that hostname at your DNS provider.</li>
          <li>Run the check again after DNS updates. Confirm HTTPS and the correct business profile when you open the domain.</li>
        </ol>
        <p className="text-sm text-stone-600">
          Verification saves the link for this business in your account. Checking a
          new hostname replaces the account&apos;s saved domain link. MealScout does
          not change your registrar or DNS records for you.
        </p>
        <div className="space-y-2">
          <Label htmlFor="business-domain-hostname">Business hostname</Label>
          <Input id="business-domain-hostname" value={domain} disabled={checking} maxLength={255} placeholder="food.example.com"
            autoCapitalize="none" autoComplete="off" spellCheck={false}
            onChange={event => { setDomain(event.target.value); setVerification(null); setError(""); }} />
        </div>
        <Button type="button" disabled={checking || !domain.trim()} onClick={() => void verify()}>
          {checking ? "Checking connection..." : "Verify connection"}
        </Button>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
        {verification ? (
          <div aria-live="polite" className="space-y-2 rounded-xl border p-3 text-sm text-stone-700">
            <p>Saved DNS result: <strong>{verification.status}</strong></p>
            <p>Expected CNAME target: <code className="break-all">{verification.expectedTarget}</code></p>
            {verification.diagnostics ? <p>{verification.diagnostics}</p> : null}
            <p>DNS matching is a connection check. Confirm the domain&apos;s HTTPS and profile before using it with customers.</p>
            {verification.status === "verified" ? (
              <a className="font-semibold underline" href={"https://" + verification.hostname + "/"} target="_blank" rel="noreferrer">Open your domain</a>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
