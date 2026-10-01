// Present fixed owner guidance, never raw source bodies, URLs or exception text.
export function officialSourceHoldMessage(hold: string): string {
  if (hold === "MISSING_OFFICIAL_SOURCE") return "Add and approve an official public website in your profile, then check it again.";
  if (/OWNER|ADAPTER/.test(hold)) return "Sign in as the current profile owner before preparing source updates.";
  if (/EXPIRED|STALE|SOURCE_SET_CHANGED|SOURCE_REMOVED/.test(hold)) return "Your profile or saved evidence changed. Refresh and prepare a new source draft.";
  if (/UNAVAILABLE|REDIRECT/.test(hold)) return "An official source could not be read publicly. Check that the page is public and current, then try again.";
  if (/CONFLICT/.test(hold)) return "Official sources disagree. Resolve the conflicting details on those pages, then check again.";
  if (/MENU|menus/.test(hold)) return "Menu details need verified current prices and effective dates before they can be included.";
  if (/SCHEDULE|DATED|schedules|EVENT/.test(hold)) return "Events need verified dates, timezone and public attendance before they can be included.";
  if (/VISIBILITY|PUBLIC_ACCESS|FIELD_NOT_PUBLIC/.test(hold)) return "Review your profile's contact visibility before using these source details.";
  if (/NO_SUPPORTED|UNSUPPORTED|MALFORMED/.test(hold)) return "This source has no supported verified facts. Use an official public page with explicit details, then check again.";
  return "Some source content needs further verification. Check your official public pages before preparing a new draft.";
}
