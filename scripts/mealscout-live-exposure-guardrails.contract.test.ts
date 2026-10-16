import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const navigation = read("client/src/components/navigation.tsx");
const scout = read("client/src/pages/explore-preview-v2.tsx");
const quarantinedScout = read("client/src/pages/explore-preview.tsx");
const publicProfile = read("client/src/pages/public-profile.tsx");
const app = read("client/src/App.tsx");

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function sliceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert(startIndex >= 0, `Missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(endIndex >= 0, `Missing end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

const guestPrimary = sliceBetween(navigation, "guest: [", "customer: [");
const guestMore = sliceBetween(navigation, 'if (lane === "guest")', "} else if");

for (const redGuestLink of [
  'path: "/video"',
  'path: "/customer-signup"',
  'path: "/share-hub"',
]) {
  assert(
    !guestPrimary.includes(redGuestLink),
    `Guest primary nav must not promote red link ${redGuestLink}`,
  );
  assert(
    !guestMore.includes(redGuestLink),
    `Guest more nav must not promote red link ${redGuestLink}`,
  );
}

assert(
  guestPrimary.includes('path: "/scout"') &&
    guestPrimary.includes('path: "/menu-builder"') &&
    guestPrimary.includes('path: "/login"'),
  "Guest primary navigation must stay focused on Scout, Create menu, and Account.",
);
assert(
  guestMore.includes('path: "/favorites"'),
  "Guest saved items must remain available under More.",
);
assert(
  guestMore.includes('path: "/events"') &&
    guestMore.includes('path: "/deals"') &&
    guestMore.includes('path: "/claim-business"'),
  "Guest supporting discovery and business intake must remain available under More.",
);
assert(
  navigation.includes('path: "/restaurant-signup?businessType=food_truck"'),
  "Guest nav must preserve the food-truck signup intake lane.",
);

assert(
  quarantinedScout.includes("DEAD SURFACE") &&
    quarantinedScout.includes("explore-preview-v2.tsx (ScoutPageV2)"),
  "Legacy explore-preview.tsx must stay marked as quarantined/dead, not canonical.",
);

for (const blockedScoutExit of [
  "Local matches will include places, dishes, trucks, deals, and events.",
]) {
  assert(
    !scout.includes(blockedScoutExit),
    `Scout must not promote red exit: ${blockedScoutExit}`,
  );
}
assert(
  scout.includes("/scout — The canonical MealScout food discovery page.") &&
    scout.includes("Local food coverage is still growing") &&
    scout.includes("Explore the map or try another craving"),
  "Scout must keep honest limited-coverage copy visible.",
);
assert(
  scout.includes('window.location.href = `/login?redirect=${encodeURIComponent("/scout")}`;'),
  "Scout account action must send guests to login with a Scout redirect.",
);

assert(
  app.includes('<Route path="/map" component={RedirectToScout} />'),
  "The retired standalone map entry must stay contained by canonical Scout.",
);

for (const blockedProfileLink of [
  "Places to eat nearby",
  "Deals today",
  "Local food events",
  "Find similar spots nearby",
]) {
  assert(
    !publicProfile.includes(blockedProfileLink),
    `Public profile related discovery must not promote ${blockedProfileLink}.`,
  );
}
assert(
  publicProfile.includes("cta?.safe && cta?.href"),
  "Public profile CTA filtering must continue to require cta.safe.",
);
assert(
  publicProfile.includes("MealScout coverage is limited"),
  "Public profile must disclose limited coverage near related discovery.",
);

for (const requiredRoute of [
  '<Route path="/scout"',
  '<Route path="/restaurant-signup"',
  '<Route path="/claim-truck"',
  '<Route path="/map"',
]) {
  assert(app.includes(requiredRoute), `Required green/yellow route must remain present: ${requiredRoute}`);
}

console.log("mealscout-live-exposure-guardrails.contract: PASS");
