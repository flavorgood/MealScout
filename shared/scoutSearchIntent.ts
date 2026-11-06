export const SCOUT_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  taco: ["taco", "tacos", "mexican", "tex-mex", "taqueria", "burrito", "quesadilla"],
  tacos: ["taco", "tacos", "mexican", "tex-mex", "taqueria", "burrito", "quesadilla"],
  burger: ["burger", "burgers", "hamburger", "cheeseburger"],
  burgers: ["burger", "burgers", "hamburger", "cheeseburger"],
  pizza: ["pizza", "pizzeria", "italian"],
  sushi: ["sushi", "japanese", "sashimi", "roll"],
  bbq: ["bbq", "barbecue", "brisket", "smoked"],
  barbecue: ["bbq", "barbecue", "brisket", "smoked"],
  wings: ["wing", "wings", "chicken"],
  vegan: ["vegan", "plant-based", "vegetarian"],
};

const SCOUT_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "around",
  "find",
  "for",
  "i",
  "in",
  "me",
  "my",
  "near",
  "nearby",
  "please",
  "show",
  "the",
  "want",
]);

/**
 * Accent-fold a search string: lowercase it and strip diacritical marks so
 * accented and unaccented spellings compare equal ("açaí" -> "acai",
 * "Crème Brûlée" -> "creme brulee"). This is the one shared normalization
 * for search matching: apply it to the query AND to the stored text being
 * matched, on every search endpoint. It mirrors the client search page's
 * normalizeSearchText (client/src/pages/search.tsx). SQL callers that
 * cannot run this function fold the stored side with the translate() map
 * in server/routes/publicSearchRoutes.ts, which is the same rule projected
 * onto the Latin letter ranges.
 */
export function foldScoutSearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function tokenizeScoutSearchIntent(query: string): string[] {
  return foldScoutSearchText(query)
    .trim()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 1 && !SCOUT_SEARCH_STOP_WORDS.has(token),
    );
}

export function expandScoutSearchTerms(query: string): string[] {
  return Array.from(
    new Set(
      tokenizeScoutSearchIntent(query).flatMap(
        (token) => SCOUT_SEARCH_ALIASES[token] ?? [token],
      ),
    ),
  );
}

export type ScoutSearchCandidate = {
  name?: string | null;
  cuisineType?: string | null;
  description?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
};

const normalizeSearchText = (value: unknown): string =>
  foldScoutSearchText(value)
    .trim()
    .replace(/\s+/g, " ");

/**
 * Rank an exact business-name intent ahead of broad token and cuisine matches.
 *
 * Aggregate search intentionally expands terms (for example, tacos -> mexican),
 * but those aliases must not bury the business whose name the person typed.
 */
export function scoutSearchRelevanceScore(
  candidate: ScoutSearchCandidate,
  query: string,
): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const name = normalizeSearchText(candidate.name);
  const fields = [
    candidate.cuisineType,
    candidate.description,
    candidate.address,
    candidate.city,
    candidate.state,
  ].map(normalizeSearchText);

  let score = 0;
  if (name === normalizedQuery) score += 1_000_000;
  else if (name.startsWith(normalizedQuery)) score += 800_000;
  else if (name.includes(normalizedQuery)) score += 600_000;

  const intentTokens = tokenizeScoutSearchIntent(normalizedQuery);
  for (const token of intentTokens) {
    if (name === token) score += 20_000;
    else if (name.startsWith(token)) score += 12_000;
    else if (name.includes(token)) score += 8_000;

    for (const field of fields) {
      if (field.includes(token)) score += 500;
    }
  }

  const expandedOnlyTerms = expandScoutSearchTerms(normalizedQuery).filter(
    (term) => !intentTokens.includes(term),
  );
  for (const term of expandedOnlyTerms) {
    if (name.includes(term)) score += 250;
    if (fields.some((field) => field.includes(term))) score += 50;
  }

  return score;
}
