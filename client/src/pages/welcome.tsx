import React from "react";
import { Link } from "wouter";
import { SEOHead } from "@/components/seo-head";
import { WELCOME_CONTENT } from "@shared/welcomeContent";

export default function Welcome() {
  return (
    <>
      <SEOHead
        title={WELCOME_CONTENT.title}
        description={WELCOME_CONTENT.description}
        canonicalUrl="/"
      />

      <main
        className="relative min-h-[100dvh] w-full overflow-hidden bg-[#120805] text-white"
        data-testid="welcome-landing"
      >
        <h1 className="sr-only">{WELCOME_CONTENT.title}</h1>
        <p className="sr-only">{WELCOME_CONTENT.description}</p>
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage:
              "url('/atmospheric/mealscout-welcome-map-night.png')",
          }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(180deg,rgba(24,10,5,0.12)_0%,rgba(24,10,5,0.31)_46%,rgba(15,6,3,0.58)_100%)]"
        />

        <section className="relative z-10 flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10 text-center">
          <div className="flex w-full max-w-[18rem] flex-col gap-3">
            <Link
              href="/customer-signup"
              className="inline-flex h-12 items-center justify-center rounded-full bg-[#ff5a2f] px-6 text-[15px] font-black text-[#1a0d08] shadow-[0_0_26px_rgba(255,90,47,0.34)] transition hover:bg-[#ff7448] active:scale-[0.98]"
            >
              Sign up
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-full border border-orange-200/22 bg-[#1a0d08]/45 px-6 text-[15px] font-black text-orange-50 backdrop-blur-md transition hover:bg-[#2a1208]/60 active:scale-[0.98]"
            >
              Log in
            </Link>
          </div>

          <Link
            href="/scout"
            className="mt-7 inline-flex rounded-full border border-orange-300/22 bg-[#1a0d08]/32 px-5 py-2 text-[13px] font-black uppercase tracking-[0.24em] text-orange-100/95 shadow-[0_0_24px_rgba(255,90,47,0.18)] backdrop-blur-md transition hover:bg-[#2a1208]/60 focus:outline-none focus:ring-2 focus:ring-orange-200/70 focus:ring-offset-2 focus:ring-offset-[#120805] active:scale-[0.98]"
          >
            Follow The Flavor
          </Link>
        </section>
      </main>
    </>
  );
}
