import { useState, type FormEvent } from "react";
import { apiUrl } from "@/lib/api";
import { PROFILE_SALES_CUSTOMER_COPY } from "@shared/profileSalesAssistant";

type ProfileKind = "truck" | "host" | "vendor";

type QuoteLine = {
  offerId: string;
  name: string;
  priceCents: number | null;
  listedTerms: string | null;
};

type InquireResponse = {
  inquiryId: string;
  quote: { matched: boolean; lines: QuoteLine[]; pricesInvented: false };
  completion: {
    rail: string;
    existingPath: string | null;
    method: "POST" | null;
    executable: boolean;
    body: Record<string, unknown> | null;
    customerMessage: string;
    chargeCreatedHere: false;
    pricesInvented: false;
  };
  marketingOptIn: boolean;
};

const formatListedPrice = (cents: number | null, terms: string | null) => {
  if (terms) return terms;
  if (cents === null) return PROFILE_SALES_CUSTOMER_COPY.unpricedLabel;
  const dollars = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, "0");
  return `$${dollars}.${remainder}`;
};

export function ProfileSalesAssistant({
  profileKind,
  profileId,
  businessName,
}: {
  profileKind: ProfileKind;
  profileId: string;
  businessName: string;
}) {
  const copy = PROFILE_SALES_CUSTOMER_COPY;
  const [what, setWhat] = useState("");
  const [where, setWhere] = useState("");
  const [when, setWhen] = useState("");
  const [headcount, setHeadcount] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InquireResponse | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    setFollowUp(null);
    try {
      const response = await fetch(
        apiUrl(
          `/api/public/profile-sales-assistant/${profileKind}/${encodeURIComponent(profileId)}/inquire`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            what,
            where,
            when,
            headcount: headcount.trim() ? Number(headcount) : null,
            customerName,
            customerEmail,
            customerPhone,
            marketingOptIn,
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setResult(null);
        setError(String(payload?.message || copy.unavailable));
        return;
      }
      setResult(payload as InquireResponse);
    } catch {
      setError(copy.unavailable);
    } finally {
      setPending(false);
    }
  };

  const continueExisting = async () => {
    if (!result?.completion.executable || !result.completion.existingPath || !result.completion.body) {
      return;
    }
    setPending(true);
    setFollowUp(null);
    try {
      const response = await fetch(apiUrl(result.completion.existingPath), {
        method: result.completion.method || "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...result.completion.body,
          customerEmail: customerEmail || null,
          customerPhone: customerPhone || null,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFollowUp(String(payload?.message || copy.requestSaved));
        return;
      }
      setFollowUp(copy.listedPriceNote);
    } catch {
      setFollowUp(copy.requestSaved);
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      aria-label={copy.title}
      className="profile-surface rounded-[1.5rem] p-4 sm:p-5"
      data-profile-sales-assistant={profileKind}
    >
      <p className="profile-section-label">{businessName}</p>
      <h2 className="mt-1 text-xl font-semibold">{copy.title}</h2>
      <p className="mt-2 text-sm text-[color:var(--profile-muted)]">{copy.intro}</p>
      <form className="mt-4 grid gap-3" onSubmit={submit}>
        <label className="grid gap-1 text-sm">
          {copy.whatLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            value={what}
            onChange={(event) => setWhat(event.target.value)}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          {copy.whereLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            value={where}
            onChange={(event) => setWhere(event.target.value)}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          {copy.whenLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          {copy.headcountLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            inputMode="numeric"
            value={headcount}
            onChange={(event) => setHeadcount(event.target.value)}
          />
          <span className="text-xs text-[color:var(--profile-muted)]">{copy.headcountHint}</span>
        </label>
        <label className="grid gap-1 text-sm">
          {copy.nameLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            value={customerName}
            onChange={(event) => setCustomerName(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {copy.emailLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            type="email"
            value={customerEmail}
            onChange={(event) => setCustomerEmail(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {copy.phoneLabel}
          <input
            className="min-h-11 rounded-xl border border-black/20 bg-white px-3 text-black"
            value={customerPhone}
            onChange={(event) => setCustomerPhone(event.target.value)}
          />
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={marketingOptIn}
            onChange={(event) => setMarketingOptIn(event.target.checked)}
          />
          <span>{copy.marketingOptIn}</span>
        </label>
        <button
          type="submit"
          className="profile-action-primary min-h-11 rounded-xl px-4 text-sm font-bold"
          disabled={pending}
        >
          {copy.submit}
        </button>
      </form>
      {error ? (
        <p className="mt-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="mt-4 grid gap-2 text-sm">
          <p className="font-semibold">{copy.quoteHeading}</p>
          {result.quote.lines.length === 0 ? (
            <p>{copy.noMatch}</p>
          ) : (
            <ul className="grid gap-1">
              {result.quote.lines.map((line) => (
                <li key={line.offerId}>
                  {line.name}: {formatListedPrice(line.priceCents, line.listedTerms)}
                </li>
              ))}
            </ul>
          )}
          <p>{result.completion.customerMessage}</p>
          {result.completion.executable && result.completion.existingPath ? (
            <button
              type="button"
              className="profile-action-primary min-h-11 rounded-xl px-4 text-sm font-bold"
              onClick={continueExisting}
              disabled={pending}
            >
              {result.completion.customerMessage}
            </button>
          ) : null}
          {followUp ? <p>{followUp}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
