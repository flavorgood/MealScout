import React from "react";
import { Link } from "wouter";

type PublicOrderingTopBarProps = {
  secondaryHref?: string | null;
  secondaryLabel?: string;
};

export function PublicOrderingTopBar({
  secondaryHref,
  secondaryLabel = "Profile",
}: PublicOrderingTopBarProps) {
  return (
    <header
      data-public-ordering-nav="true"
      className="sticky top-0 z-40 border-b border-[color:var(--profile-border)] bg-[#fffaf4]/92 pt-[env(safe-area-inset-top)] backdrop-blur-xl"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-2 sm:py-3">
        <Link
          href="/"
          aria-label="MealScout home"
          className="inline-flex min-h-11 shrink-0 items-center text-base font-black tracking-tight text-[color:var(--profile-ink)]"
        >
          MealScout
        </Link>
        <nav aria-label="Ordering navigation" className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {secondaryHref ? (
            <Link
              href={secondaryHref}
              className="profile-action-secondary inline-flex min-h-11 max-w-full items-center justify-center break-words rounded-full px-3 py-2 text-center text-sm font-bold leading-snug"
            >
              {secondaryLabel}
            </Link>
          ) : null}
          <Link
            href="/scout"
            className="profile-action-primary inline-flex min-h-11 items-center rounded-full px-4 text-sm font-black"
          >
            Scout
          </Link>
        </nav>
      </div>
    </header>
  );
}
