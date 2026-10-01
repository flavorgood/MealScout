export function sourceReviewReason(proposal: any, sourceUrls: unknown[]) {
  if (proposal.packet) return "owner_consent_required";
  if (!sourceUrls.length) return "missing_official_source";
  const holds: string[] = proposal.holds;
  if (holds.some(h => h.startsWith("SOURCE_UNAVAILABLE") || h === "UNSUPPORTED_OR_REDIRECTED_SOURCE")) return "source_unavailable_or_redirected";
  if (holds.some(h => h.startsWith("CONFLICT:"))) return "conflicting_public_facts";
  if (holds.some(h => /PRIVATE|RESTRICTED|ACCESS|TIMEZONE|DATE|ATTENDANCE|MENU_CONTENT_HOLD|SCHEDULE_CONTENT_HOLD/.test(h) && !h.endsWith("REQUIRE_SEPARATE_VERIFICATION"))) return "date_identity_or_public_access_verification";
  if (holds.some(h => /NO_CURRENT_COMPLETE|NO_VERIFIED|UNSUPPORTED|MALFORMED|NO_SUPPORTED/.test(h))) return "unsupported_or_incomplete_extraction";
  return "unclassified_receipt_hold";
}
