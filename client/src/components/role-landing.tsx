import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SEOHead } from "@/components/seo-head";
import { CheckCircle } from "lucide-react";
import type { RoleLandingContent } from "@/content/role-landing";
import { useEffect } from "react";
import {
  FUNNEL_EVENTS,
  trackFunnelEvent,
  trackFunnelEventOncePerSession,
} from "@/utils/funnelTelemetry";

type RoleLandingPageProps = {
  content: RoleLandingContent;
  mapSlot?: React.ReactNode;
  discoverySlot?: React.ReactNode;
  theme?: "default" | "ember";
};

export default function RoleLandingPage({
  content,
  mapSlot,
  discoverySlot,
  theme = "default",
}: RoleLandingPageProps) {
  const canonicalUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${content.seo.canonicalPath}`
      : undefined;
  const isFoodTruckLanding = content.seo.canonicalPath === "/for-food-trucks";

  useEffect(() => {
    if (!isFoodTruckLanding) return;
    trackFunnelEventOncePerSession(
      FUNNEL_EVENTS.landingView,
      "for-food-trucks",
      {
        page: "for-food-trucks",
        businessType: "food_truck",
        intent: "acquisition",
        source: "for-food-trucks",
      },
    );
  }, [isFoodTruckLanding]);

  const trackCta = (href: string, placement: string) => {
    if (!isFoodTruckLanding) return;
    const target = new URL(href, "https://www.mealscout.us");
    trackFunnelEvent(FUNNEL_EVENTS.primaryCtaClick, {
      page: "for-food-trucks",
      businessType: "food_truck",
      intent: target.searchParams.get("intent") === "claim" ? "claim" : "create",
      source: "for-food-trucks",
      placement,
      destination: target.pathname,
    });
  };

  const themeStyles =
    theme === "ember"
      ? ({
          "--bg-base": "#1C1A18",
          "--bg-glow": "radial-gradient(circle at 18% 12%, rgba(242,138,46,0.18) 0%, rgba(28,26,24,0) 55%)",
          "--bg-glow-2": "radial-gradient(circle at 78% 68%, rgba(198,91,23,0.14) 0%, rgba(28,26,24,0) 50%)",
          "--ink": "#EDE6DC",
          "--ink-muted": "#C9BFB2",
          "--ink-soft": "#A89987",
          "--ink-dark": "#2A231E",
          "--ink-dark-muted": "#5B5147",
          "--card": "#F5EFE7",
          "--card-muted": "#EFE6DB",
          "--border": "#3A3026",
          "--border-soft": "#6B4A2A",
          "--accent": "#F28A2E",
          "--accent-strong": "#C65B17",
          "--accent-soft": "#6B4A2A",
          "--pill-bg": "#2A241F",
          "--pill-text": "#EBD9C6",
          "--pill-border": "#6B4A2A",
          "--cta-text": "#2A231E",
          "--cta-muted-text": "#EDE6DC",
          "--panel-dark-bg": "#2A241F",
          "--panel-dark-border": "#3A3026",
          "--panel-ink": "#EDE6DC",
          "--panel-muted": "#C9BFB2",
          "--map-bg":
            "linear-gradient(140deg, rgba(63,50,40,0.2), rgba(80,60,42,0.35) 50%, rgba(42,36,30,0.25))",
        } as React.CSSProperties)
      : ({
          "--bg-base": "#fff8ee",
          "--bg-glow": "radial-gradient(circle at 20% 0%, #ffe5c2 0%, #fff8ee 45%, #e9f1ff 100%)",
          "--bg-glow-2": "radial-gradient(circle at 78% 60%, rgba(125,211,252,0.18) 0%, rgba(255,248,238,0) 55%)",
          "--ink": "#121314",
          "--ink-muted": "#5b6470",
          "--ink-soft": "#7a8796",
          "--ink-dark": "#121314",
          "--ink-dark-muted": "#5b6470",
          "--card": "#ffffff",
          "--card-muted": "#f8fafc",
          "--border": "#e2e8f0",
          "--border-soft": "#fed7aa",
          "--accent": "#f97316",
          "--accent-strong": "#c2410c",
          "--accent-soft": "#fed7aa",
          "--pill-bg": "#ffffff",
          "--pill-text": "#c2410c",
          "--pill-border": "#fed7aa",
          "--cta-text": "#121314",
          "--cta-muted-text": "#ffffff",
          "--panel-dark-bg": "#121314",
          "--panel-dark-border": "#0f172a",
          "--panel-ink": "#FFF7ED",
          "--panel-muted": "#CBD5E1",
          "--map-bg":
            "linear-gradient(140deg, #f6efe1, #fff4e6 50%, #e6eeff)",
        } as React.CSSProperties);

  return (
    <div
      className="min-h-screen overflow-x-hidden px-4 py-12"
      style={
        {
          background:
            "var(--bg-glow), var(--bg-glow-2), var(--bg-base)",
          fontFamily:
            '"Space Grotesk", "IBM Plex Sans", "Segoe UI", sans-serif',
          ...themeStyles,
        } as React.CSSProperties
      }
    >
      <SEOHead
        title={content.seo.title}
        description={content.seo.description}
        keywords={content.seo.keywords}
        canonicalUrl={canonicalUrl}
        noIndex={content.seo.noIndex}
      />

      <div className="max-w-6xl mx-auto space-y-12">
        <section className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.25em]" style={{ backgroundColor: "var(--pill-bg)", borderColor: "var(--pill-border)", color: "var(--pill-text)" }}>
              {content.badge}
            </div>
            <h1 className="text-4xl sm:text-5xl font-black leading-tight text-[var(--ink)]">
              {content.headline}
            </h1>
            <p className="text-lg text-[var(--ink-muted)]">
              {content.subhead}
            </p>
            {content.guide && (
              <Link href={content.guide.listingLink.href} className="inline-flex min-h-11 items-center font-semibold text-[var(--accent-strong)] underline underline-offset-4">
                {content.guide.listingLink.label}
              </Link>
            )}
            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                asChild
                className="px-6 py-6 text-base text-[var(--cta-text)] bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] hover:opacity-90 active:translate-y-[1px]"
              >
                <Link
                  href={content.primaryCta.href}
                  onClick={() => trackCta(content.primaryCta.href, "hero_primary")}
                >
                  {content.primaryCta.label}
                </Link>
              </Button>
              {content.secondaryCta && (
                <Button
                  asChild
                  variant="outline"
                  className="px-6 py-6 text-base border-[var(--border-soft)] text-[var(--ink)] hover:bg-transparent active:translate-y-[1px]"
                >
                  <Link
                    href={content.secondaryCta.href}
                    onClick={() => trackCta(content.secondaryCta!.href, "hero_secondary")}
                  >
                    {content.secondaryCta.label}
                  </Link>
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-3 text-xs text-[var(--ink-soft)]">
              {content.bullets.map((bullet) => (
                <span key={bullet} className="inline-flex items-center gap-1">
                  <CheckCircle className="h-3 w-3 text-[var(--accent)]" />
                  {bullet}
                </span>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="absolute -top-8 -right-8 h-28 w-28 rounded-full blur-2xl" style={{ backgroundColor: "rgba(242,138,46,0.25)" }} />
            <div className="absolute -bottom-8 -left-8 h-28 w-28 rounded-full blur-2xl" style={{ backgroundColor: "rgba(198,91,23,0.18)" }} />
            <Card className="border shadow-clean-lg" style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}>
              <CardContent className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-[var(--ink-dark-muted)]">
                      {content.map.kicker}
                    </p>
                    <p className="text-lg font-semibold text-[var(--ink-dark)]">
                      {content.map.title}
                    </p>
                  </div>
                  {content.map.badge && (
                    <div className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold" style={{ backgroundColor: "var(--card-muted)", color: "var(--ink-dark-muted)" }}>
                      {content.map.badge}
                    </div>
                  )}
                </div>
                <div className="relative h-48 rounded-2xl overflow-hidden border" style={{ borderColor: "var(--border)", background: "var(--map-bg)" }}>
                  {mapSlot ?? (
                    <>
                      <div className="absolute left-6 top-8 h-4 w-4 rounded-full shadow-[0_0_0_8px_rgba(242,138,46,0.25)]" style={{ backgroundColor: "var(--accent)" }} />
                      <div className="absolute right-12 top-16 h-3 w-3 rounded-full shadow-[0_0_0_6px_rgba(42,35,30,0.2)]" style={{ backgroundColor: "var(--ink-dark)" }} />
                      <div className="absolute left-20 bottom-12 h-3 w-3 rounded-full shadow-[0_0_0_6px_rgba(198,91,23,0.2)]" style={{ backgroundColor: "var(--accent-strong)" }} />
                      <div className="absolute right-16 bottom-6 h-3 w-3 rounded-full shadow-[0_0_0_6px_rgba(242,138,46,0.2)]" style={{ backgroundColor: "var(--accent)" }} />
                      {content.map.hint && (
                        <div className="absolute left-6 bottom-6 rounded-full px-3 py-1 text-xs font-semibold shadow" style={{ backgroundColor: "var(--card)", color: "var(--ink-dark)" }}>
                          {content.map.hint}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {content.stats.map((stat) => (
                    <div
                      key={stat.label}
                      className="rounded-xl border px-4 py-3"
                      style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}
                    >
                      <p className="text-xs text-[var(--ink-dark-muted)]">
                        {stat.label}
                      </p>
                      <p className="text-xl font-semibold text-[var(--ink-dark)]">
                        {stat.value}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {content.guide && (
          <section className="space-y-8" aria-label="Practical planning guide">
            {content.guide.sections.map((section) => (
              <article key={section.title} className="space-y-3 rounded-2xl border p-6" style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}>
                <h2 className="text-2xl font-semibold text-[var(--ink-dark)]">{section.title}</h2>
                {section.paragraphs.map((paragraph) => <p key={paragraph} className="text-base leading-relaxed text-[var(--ink-dark-muted)]">{paragraph}</p>)}
              </article>
            ))}
            <div className="grid gap-5 md:grid-cols-2">
              {content.guide.examples.map((example) => (
                <article key={example.title} className="space-y-3 rounded-2xl border p-6" style={{ backgroundColor: "var(--card-muted)", borderColor: "var(--border)" }}>
                  <h2 className="text-xl font-semibold text-[var(--ink-dark)]">{example.title}</h2>
                  <p className="text-base leading-relaxed text-[var(--ink-dark-muted)]">{example.copy}</p>
                </article>
              ))}
            </div>
            <div className="space-y-4 rounded-2xl border p-6" style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}>
              <h2 className="text-2xl font-semibold text-[var(--ink-dark)]">Questions before you get started</h2>
              {content.guide.questions.map((item) => (
                <div key={item.question} className="space-y-2">
                  <h3 className="text-lg font-semibold text-[var(--ink-dark)]">{item.question}</h3>
                  <p className="text-base leading-relaxed text-[var(--ink-dark-muted)]">{item.answer}</p>
                </div>
              ))}
              <nav className="flex flex-wrap gap-x-6 gap-y-3 pt-2" aria-label="Listings and next steps">
                {[content.guide.listingLink, ...content.guide.relatedLinks].map((link) => (
                  <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center font-semibold text-[var(--accent-strong)] underline underline-offset-4">{link.label}</Link>
                ))}
              </nav>
            </div>
          </section>
        )}

        <section className="grid gap-4 rounded-3xl border p-6 text-sm shadow-clean-lg md:grid-cols-3" style={{ backgroundColor: "var(--card-muted)", borderColor: "var(--border)", color: "var(--ink-dark-muted)" }}>
          {content.valueProps.map((value) => (
            <div key={value.text} className="flex items-center gap-3">
              <value.icon className="h-5 w-5 text-[var(--accent)]" />
              {value.text}
            </div>
          ))}
        </section>

        <section className="grid gap-6 md:grid-cols-3">
          {content.steps.map((step) => (
            <Card key={step.title} className="border" style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}>
              <CardContent className="p-6 space-y-3">
                <step.icon className="h-6 w-6 text-[var(--accent)]" />
                <h3 className="text-lg font-semibold text-[var(--ink-dark)]">
                  {step.title}
                </h3>
                <p className="text-sm text-[var(--ink-dark-muted)]">
                  {step.copy}
                </p>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card className="border" style={{ backgroundColor: "var(--card)", borderColor: "var(--border)" }}>
            <CardContent className="p-6 space-y-4">
              <h3 className="text-xl font-semibold text-[var(--ink-dark)]">
                {content.reasons.title}
              </h3>
              <div className="grid gap-3 text-sm text-[var(--ink-dark-muted)]">
                {content.reasons.items.map((item) => (
                  <div key={item} className="flex items-start gap-3">
                    <CheckCircle className="h-5 w-5 text-[var(--accent)] mt-0.5" />
                    {item}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="border shadow-clean-lg" style={{ backgroundColor: "var(--panel-dark-bg)", borderColor: "var(--panel-dark-border)" }}>
            <CardContent className="p-6 space-y-3">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--panel-muted)]">
                {content.starter.kicker}
              </p>
              <h3 className="text-2xl font-semibold text-[var(--panel-ink)]">
                {content.starter.title}
              </h3>
              <p className="text-sm text-[var(--panel-muted)]">
                {content.starter.copy}
              </p>
              <ul className="text-sm text-[var(--panel-ink)] space-y-2">
                {content.starter.bullets.map((bullet) => (
                  <li key={bullet} className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-[var(--accent)]" />
                    {bullet}
                  </li>
                ))}
              </ul>
              {content.disclosure && (
                <p className="text-xs leading-relaxed text-[var(--panel-muted)]">
                  {content.disclosure}
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {discoverySlot && <section>{discoverySlot}</section>}

        <section className="rounded-3xl px-6 py-10 text-center shadow-clean-lg" style={{ backgroundColor: "var(--panel-dark-bg)" }}>
          <h2 className="text-3xl font-semibold text-[var(--panel-ink)]">
            {content.finalCta.title}
          </h2>
          <p className="mt-3 text-sm text-[var(--panel-muted)]">
            {content.finalCta.copy}
          </p>
          <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
            <Button
              asChild
              className="px-6 py-6 text-base text-[var(--cta-text)] bg-[linear-gradient(135deg,var(--accent),var(--accent-strong))] hover:opacity-90 active:translate-y-[1px]"
            >
              <Link
                href={content.finalCta.primary.href}
                onClick={() => trackCta(content.finalCta.primary.href, "final_primary")}
              >
                {content.finalCta.primary.label}
              </Link>
            </Button>
            {content.finalCta.secondary && (
              <Button
                asChild
                variant="outline"
                className="px-6 py-6 text-base text-[var(--cta-muted-text)] border-[var(--border-soft)] hover:text-[var(--cta-muted-text)] active:translate-y-[1px]"
              >
                <Link
                  href={content.finalCta.secondary.href}
                  onClick={() => trackCta(content.finalCta.secondary!.href, "final_secondary")}
                >
                  {content.finalCta.secondary.label}
                </Link>
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

