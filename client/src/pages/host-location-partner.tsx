import { FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SEOHead } from "@/components/seo-head";
import { submitHostPartnerRequest, type HostPartnerReceipt } from "@/lib/hostPartnerSubmission";

const locationTypes = [
  { value: "office", label: "Office / Corporate" },
  { value: "retail", label: "Retail / Shopping Center" },
  { value: "church", label: "Church / Community" },
  { value: "warehouse", label: "Warehouse / Industrial" },
  { value: "school", label: "School / Campus" },
  { value: "other", label: "Other" },
];

export default function HostLocationPartnerPage() {
  const [form, setForm] = useState({
    firstName: "",
    email: "",
    phone: "",
    businessName: "",
    address: "",
    city: "",
    state: "",
    locationType: "other",
    parkingSpots: "",
    dailyFootTraffic: "",
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<HostPartnerReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    // State updates alone do not guard two submits in the same browser turn.
    if (pending.current || receipt) return;
    const controller = new AbortController();
    pending.current = controller;
    setIsSubmitting(true);
    setError(null);
    try {
      const payload = {
        firstName: form.firstName.trim() || undefined,
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        businessName: form.businessName.trim(),
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        state: form.state.trim() || undefined,
        locationType: form.locationType,
        parkingSpots: form.parkingSpots
          ? Number(form.parkingSpots)
          : undefined,
        dailyFootTraffic: form.dailyFootTraffic
          ? Number(form.dailyFootTraffic)
          : undefined,
        notes: form.notes.trim() || undefined,
        source: "host_location_partner_page",
      };
      const saved = await submitHostPartnerRequest(payload, { signal: controller.signal });
      if (pending.current === controller) setReceipt(saved);
    } catch (submitError: unknown) {
      if (pending.current === controller) {
        setError(submitError instanceof Error ? submitError.message : "Unable to confirm your request right now.");
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[var(--bg-layered)] px-4 py-10">
      <SEOHead
        title="Host Food Trucks at Your Business | MealScout"
        description="Non-food businesses with parking space can host food trucks and earn recurring monthly booking revenue with MealScout."
        canonicalUrl="https://www.mealscout.us/host-location-partner"
        schemaData={{
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          name: "MealScout Host Location Partner",
          url: "https://www.mealscout.us/host-location-partner",
          description:
            "Apply to host food trucks at your parking location and receive recurring booking demand.",
          areaServed: "United States",
          potentialAction: {
            "@type": "ApplyAction",
            target: "https://www.mealscout.us/host-location-partner",
          },
        }}
      />

      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-3 rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-6 shadow-clean">
          <h1 className="text-3xl font-black text-[color:var(--text-primary)]">
            Turn Parking Space Into Monthly Revenue
          </h1>
          <p className="text-sm text-[color:var(--text-secondary)]">
            Own a business location with available parking? MealScout helps you
            host food trucks and open paid booking slots without running a food
            business.
          </p>
          <div className="text-xs text-[color:var(--text-muted)]">
            Best fit: offices, retail centers, warehouses, churches, campuses,
            and community lots.
          </div>
        </div>

        <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-6 shadow-clean">
          {receipt ? (
            <div className="space-y-3" role="status" data-testid="host-partner-receipt">
              <h2 className="text-xl font-bold text-[color:var(--text-primary)]">
                Request received
              </h2>
              <p className="text-sm text-[color:var(--text-secondary)]">
                {receipt.emailed
                  ? "Your request is saved and next steps have been submitted for email delivery. You can also complete setup now by creating your host profile."
                  : "Your request is saved, but email delivery was not confirmed. Continue setup below; you do not need to submit this request again."}
              </p>
              <p className="break-all text-xs text-[color:var(--text-muted)]">Request reference: {receipt.leadId}</p>
              <div className="flex flex-wrap gap-3">
                <Link href="/customer-signup?role=host">
                  <Button>Create Host Profile</Button>
                </Link>
                <Link href="/for-hosts">
                  <Button variant="outline">Learn More</Button>
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" aria-busy={isSubmitting}>
              {error ? (
                <div role="alert" className="rounded-lg border border-[color:var(--status-error)]/40 bg-[color:var(--status-error)]/10 px-3 py-2 text-sm text-[color:var(--status-error)]">
                  {error}
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="firstName">First Name</Label>
                  <Input id="firstName" value={form.firstName} onChange={(e) => setForm((prev) => ({ ...prev, firstName: e.target.value }))} placeholder="Your name" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="email">Email *</Label>
                  <Input id="email" type="email" required value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} placeholder="you@business.com" />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} placeholder="(555) 555-5555" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="businessName">Business Name *</Label>
                  <Input id="businessName" required value={form.businessName} onChange={(e) => setForm((prev) => ({ ...prev, businessName: e.target.value }))} placeholder="Business or property name" />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="address">Address</Label>
                  <Input id="address" value={form.address} onChange={(e) => setForm((prev) => ({ ...prev, address: e.target.value }))} placeholder="Street address" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="locationType">Location Type *</Label>
                  <select id="locationType" required value={form.locationType} onChange={(e) => setForm((prev) => ({ ...prev, locationType: e.target.value }))} className="h-10 rounded-md border border-[color:var(--border-subtle)] bg-[var(--field-bg)] px-3 text-sm">
                    {locationTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-4">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="city">City</Label>
                  <Input id="city" value={form.city} onChange={(e) => setForm((prev) => ({ ...prev, city: e.target.value }))} placeholder="City" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="state">State</Label>
                  <Input id="state" value={form.state} onChange={(e) => setForm((prev) => ({ ...prev, state: e.target.value }))} placeholder="State" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="parkingSpots">Parking Spots</Label>
                  <Input id="parkingSpots" type="number" min={1} value={form.parkingSpots} onChange={(e) => setForm((prev) => ({ ...prev, parkingSpots: e.target.value }))} placeholder="20" />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="dailyFootTraffic">Estimated Daily Foot Traffic</Label>
                <Input id="dailyFootTraffic" type="number" min={0} value={form.dailyFootTraffic} onChange={(e) => setForm((prev) => ({ ...prev, dailyFootTraffic: e.target.value }))} placeholder="150" />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" value={form.notes} onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Best days/times to host trucks, lot restrictions, etc." />
              </div>

              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Submitting..." : "Request Host Partnership"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
