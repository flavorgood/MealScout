import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { Loader2, ArrowLeft, Building2, MapPin, UserRound, ClipboardList } from "lucide-react";

const locationTypeOptions = [
  { value: "office", label: "Office / Corporate" },
  { value: "bar", label: "Bar" },
  { value: "brewery", label: "Brewery" },
  { value: "campus", label: "Campus" },
  { value: "event", label: "Event Space" },
  { value: "other", label: "Other" },
];

async function geocodeAddress(address: string) {
  if (!address) return null;
  const response = await fetch(
    `/api/location/search?q=${encodeURIComponent(
      address,
    )}&limit=1`,
  );
  if (!response.ok) return null;
  const data = (await response.json()) as Array<{ lat: string; lon: string }>;
  if (!data.length) return null;
  return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
}

function HostSignup() {
  const { isAuthenticated, authState, isError: authError, refetch } = useAuth();
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(true);
  const [retryingAuth, setRetryingAuth] = useState(false);
  const draftLoaded = useRef(false);

  const HOST_SIGNUP_DRAFT_KEY = "mealscout:host-signup-draft";

  // Form State
  const [businessName, setBusinessName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [locationType, setLocationType] = useState("");
  const [description, setDescription] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Pending or failed session discovery is not evidence that the user is a guest.
    if (authState === "loading") return;
    if (authState === "guest") {
      setLocation("/customer-signup?role=host");
      return;
    }
    if (!isAuthenticated || draftLoaded.current) return;
    draftLoaded.current = true;

    // Restore once; a later authentication refresh must not overwrite typed fields.
    try {
      const stored = window.localStorage.getItem(HOST_SIGNUP_DRAFT_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<{
          businessName: string;
          address: string;
          city: string;
          state: string;
          contactName: string;
          contactEmail: string;
          contactPhone: string;
          locationType: string;
          description: string;
        }>;
        if (parsed.businessName) setBusinessName(parsed.businessName);
        if (parsed.address) setAddress(parsed.address);
        if (parsed.city) setCity(parsed.city);
        if (parsed.state) setState(parsed.state);
        if (parsed.contactName) setContactName(parsed.contactName);
        if (parsed.contactEmail) setContactEmail(parsed.contactEmail);
        if (parsed.contactPhone) setContactPhone(parsed.contactPhone);
        if (parsed.locationType) setLocationType(parsed.locationType);
        if (parsed.description) setDescription(parsed.description);
      }
    } catch {
      // ignore parse/storage errors
    }
    setIsLoading(false);
  }, [authState, isAuthenticated, setLocation]);

  // Persist host signup draft so hosts can resume later
  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    try {
      const payload = {
        businessName,
        address,
        city,
        state,
        contactName,
        contactEmail,
        contactPhone,
        locationType,
        description,
      };
      window.localStorage.setItem(
        HOST_SIGNUP_DRAFT_KEY,
        JSON.stringify(payload)
      );
    } catch {
      // ignore storage errors
    }
  }, [
    isLoading,
    isAuthenticated,
    businessName,
    address,
    city,
    state,
    contactName,
    contactEmail,
    contactPhone,
    locationType,
    description,
  ]);

  const validate = () => {
    const validationErrors: Record<string, string> = {};

    if (!businessName.trim())
      validationErrors.businessName = "Business name is required";
    if (!address.trim()) validationErrors.address = "Address is required";
    if (!city.trim()) validationErrors.city = "City is required";
    if (!state.trim()) validationErrors.state = "State is required";
    if (!contactName.trim())
      validationErrors.contactName = "Contact name is required";
    if (!contactEmail.trim())
      validationErrors.contactEmail = "Contact email is required";
    if (contactPhone.replace(/\D/g, "").length < 10)
      validationErrors.contactPhone = contactPhone.trim()
        ? "Enter a valid 10-digit phone number, including area code"
        : "Contact phone is required";
    if (!locationType) validationErrors.locationType = "Select a location type";

    setErrors(validationErrors);
    return Object.keys(validationErrors).length === 0;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAuthenticated || authState !== "authenticated") return;
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const fullAddress = [address, city, state]
        .map((value) => value.trim())
        .filter(Boolean)
        .join(", ");
      const coords = await geocodeAddress(fullAddress).catch(() => null);

      const response = await fetch("/api/hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          address,
          city,
          state,
          contactName,
          contactEmail,
          contactPhone,
          locationType,
          description,
          latitude: coords?.lat,
          longitude: coords?.lng,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Failed to create host profile");
      }

      setLocation("/host/dashboard");
      try {
        window.localStorage.removeItem(HOST_SIGNUP_DRAFT_KEY);
      } catch {
        // ignore
      }
    } catch (error: any) {
      setErrors({ submit: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (authState === "loading" && authError) {
    return (
      <main className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center px-4">
        <div role="alert" className="max-w-md rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] p-6 space-y-4">
          <h1 className="text-xl font-bold">We could not confirm your session</h1>
          <p>Your host setup has not been submitted. Retry the session check to continue.</p>
          <Button
            type="button"
            disabled={retryingAuth}
            onClick={async () => {
              setRetryingAuth(true);
              try { await refetch(); } catch { /* Keep the retry state visible. */ }
              finally { setRetryingAuth(false); }
            }}
          >
            {retryingAuth ? "Checking session..." : "Retry session check"}
          </Button>
        </div>
      </main>
    );
  }

  if (isLoading || authState === "loading") {
    return (
      <div role="status" className="min-h-screen bg-[var(--bg-layered)] flex items-center justify-center">
        <div className="inline-flex items-center gap-3 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3 shadow-clean">
          <Loader2 className="h-5 w-5 animate-spin text-[color:var(--action-primary)]" />
          <span className="text-sm font-medium text-[color:var(--text-secondary)]">Loading host signup</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Redirect only after the authentication owner confirms a guest session.
    return null;
  }

  return (
    <div className="min-h-screen bg-[var(--bg-layered)] relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[-8rem] right-[-8rem] h-[24rem] w-[24rem] rounded-full bg-[color:var(--action-primary)]/15 blur-3xl" />
        <div className="absolute bottom-[-10rem] left-[-7rem] h-[24rem] w-[24rem] rounded-full bg-[color:var(--accent)]/20 blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 py-8">
        <a
          href="/"
          className="mb-4 inline-flex items-center gap-2 text-xs font-semibold text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to app
        </a>

        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <section className="rounded-3xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)]/90 backdrop-blur p-6 shadow-clean-lg h-fit">
            <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[color:var(--action-primary)]/30 bg-[color:var(--action-primary)]/15">
              <Building2 className="h-6 w-6 text-[color:var(--action-primary)]" />
            </span>
            <h1 className="text-3xl font-black tracking-tight text-[color:var(--text-primary)] mb-3">
              Create Host Profile
            </h1>
            <p className="text-sm leading-relaxed text-[color:var(--text-secondary)] mb-5">
              Tell us about your location to make it discoverable on MealScout and start publishing truck opportunities.
            </p>
            <div className="space-y-3">
              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                <span className="font-semibold text-[color:var(--text-primary)]">Step 1:</span> Business and location details
              </div>
              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                <span className="font-semibold text-[color:var(--text-primary)]">Step 2:</span> Contact and operations context
              </div>
              <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-xs text-[color:var(--text-secondary)]">
                <span className="font-semibold text-[color:var(--text-primary)]">Step 3:</span> Submit and publish host presence
              </div>
            </div>
          </section>

          <form
            onSubmit={handleSubmit}
            className="rounded-3xl border border-[color:var(--border-subtle)] bg-[var(--bg-card)]/95 backdrop-blur p-6 shadow-clean-lg space-y-6"
          >
            {errors.submit && (
              <div className="rounded-xl border border-[color:var(--status-error)]/40 bg-[color:var(--status-error)]/10 px-4 py-3 text-sm text-[color:var(--status-error)]">
                {errors.submit}
              </div>
            )}

            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-[color:var(--action-primary)]" />
                <h2 className="text-base font-bold text-[color:var(--text-primary)]">Business Details</h2>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="businessName" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">Business Name</Label>
                <Input
                  id="businessName"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="e.g. Tech Park Plaza"
                  className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                />
                {errors.businessName && <p className="text-xs text-[color:var(--status-error)]">{errors.businessName}</p>}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="address" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">Address</Label>
                <Input
                  id="address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="123 Main St"
                  className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                />
                {errors.address && <p className="text-xs text-[color:var(--status-error)]">{errors.address}</p>}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="city" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">City</Label>
                  <Input
                    id="city"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="e.g. Austin"
                    className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                  />
                  {errors.city && <p className="text-xs text-[color:var(--status-error)]">{errors.city}</p>}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="state" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">State</Label>
                  <Input
                    id="state"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    placeholder="e.g. TX"
                    className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                  />
                  {errors.state && <p className="text-xs text-[color:var(--status-error)]">{errors.state}</p>}
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="locationType" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">Location Type</Label>
                <select
                  id="locationType"
                  value={locationType}
                  onChange={(e) => setLocationType(e.target.value)}
                  className="h-11 rounded-xl border border-[color:var(--border-subtle)] bg-[var(--field-bg)] px-3 text-sm text-[color:var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--action-primary)]"
                >
                  <option value="">Select a type...</option>
                  {locationTypeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {errors.locationType && <p className="text-xs text-[color:var(--status-error)]">{errors.locationType}</p>}
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center gap-2">
                <UserRound className="h-4 w-4 text-[color:var(--action-primary)]" />
                <h2 className="text-base font-bold text-[color:var(--text-primary)]">Contact Information</h2>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="contactName" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">Contact Name</Label>
                <Input
                  id="contactName"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Jane Doe"
                  className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                />
                {errors.contactName && <p className="text-xs text-[color:var(--status-error)]">{errors.contactName}</p>}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="contactEmail" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">Email</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="jane@example.com"
                    className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                  />
                  {errors.contactEmail && <p className="text-xs text-[color:var(--status-error)]">{errors.contactEmail}</p>}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="contactPhone" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">
                    Phone <span className="text-[color:var(--status-error)]">*</span>
                  </Label>
                  <Input
                    id="contactPhone"
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="(555) 123-4567"
                    className="h-11 rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                  />
                  {errors.contactPhone && <p className="text-xs text-[color:var(--status-error)]">{errors.contactPhone}</p>}
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-[color:var(--action-primary)]" />
                <h2 className="text-base font-bold text-[color:var(--text-primary)]">Additional Details</h2>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description" className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--text-secondary)]">Description / Notes</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Tell trucks about parking, power availability, loading zones, or site rules..."
                  className="min-h-[120px] rounded-xl border-[color:var(--border-subtle)] bg-[var(--field-bg)]"
                />
              </div>
            </section>

            <Button
              type="submit"
              className="w-full h-11 rounded-xl action-primary hover:bg-[color:var(--action-hover)] font-semibold"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating Profile...
                </span>
              ) : (
                "Create Host Profile"
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default HostSignup;
