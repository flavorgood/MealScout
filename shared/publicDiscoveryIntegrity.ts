const normalizeDiscoveryLabel = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Narrow, evidence-backed guard for names created by automated smoke and
 * discoverability tests. Keep this deliberately stricter than a generic
 * "test" substring check so legitimate names such as "Test Kitchen" remain
 * eligible for public discovery.
 */
export function isSyntheticPublicEntityName(value: unknown): boolean {
  const normalized = normalizeDiscoveryLabel(value);
  if (!normalized) return false;

  // Untouched auto-created profile shells: the platform creates a supplier
  // row with the literal business name "New Supplier" (and isActive: true)
  // the first time a signed-in user reaches the supplier area, before they
  // have named or described anything. Such a record has no city, products,
  // or real name, so it must never be advertised as a public entity. The
  // rule covers the platform's "New <entity type>" creation defaults as a
  // class, not one record: any entity still carrying its creation-default
  // name is by definition unfinished.
  if (
    /^new (?:supplier|restaurant|food truck|truck|business|vendor|host|location|caterer|store|shop|company)$/.test(
      normalized,
    )
  ) {
    return true;
  }

  const compact = normalized.replace(/\s+/g, "");
  if (/^(?:asdf)+$/.test(compact)) return true;
  if (/^discoverability flow(?: \d{10,}(?: \d+)*)?$/.test(normalized)) {
    return true;
  }
  if (/^test supplier(?: \d{10,}(?: [a-z0-9]+)*)?$/.test(normalized)) {
    return true;
  }
  // Production crawl logs contain timestamped test hosts and this exact
  // smoke fixture. Do not suppress arbitrary real host/location names.
  if (/^test host \d{10,}(?: [a-z0-9]+)*$/.test(normalized) ||
      /^smoke host site(?: \d{10,}(?: [a-z0-9]+)*)?$/.test(normalized)) {
    return true;
  }

  return /^test (?:truck|restaurant|business|vendor)(?:\s|$)/.test(normalized);
}

export function isPublicDiscoveryEligibleEntity(input: {
  name: unknown;
  isActive?: unknown;
}): boolean {
  return input.isActive !== false && !isSyntheticPublicEntityName(input.name);
}
