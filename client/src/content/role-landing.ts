import type { LucideIcon } from "lucide-react";
import { roleAcquisitionGuides, type RoleAcquisitionGuide } from "@shared/roleAcquisitionContent";
import {
  Truck,
  Radar,
  Calendar,
  MapPin,
  Bolt,
  Sparkles,
  Store,
  Building2,
  PartyPopper,
  Users,
  Utensils,
} from "lucide-react";

type Cta = { label: string; href: string };

export type RoleLandingContent = {
  seo: {
    title: string;
    description: string;
    keywords?: string;
    canonicalPath: string;
    noIndex?: boolean;
  };
  badge: string;
  headline: string;
  subhead: string;
  guide?: RoleAcquisitionGuide;
  primaryCta: Cta;
  secondaryCta?: Cta;
  bullets: string[];
  map: {
    kicker: string;
    title: string;
    badge?: string;
    hint?: string;
  };
  stats: { label: string; value: string }[];
  valueProps: { icon: LucideIcon; text: string }[];
  steps: { icon: LucideIcon; title: string; copy: string }[];
  reasons: { title: string; items: string[] };
  starter: { kicker: string; title: string; copy: string; bullets: string[] };
  disclosure?: string;
  finalCta: { title: string; copy: string; primary: Cta; secondary?: Cta };
};

export const roleLandingContent = {
  truck: {
    seo: {
      title: roleAcquisitionGuides.truck.title,
      description: roleAcquisitionGuides.truck.description,
      keywords: "list food truck, food truck booking platform, food truck host locations, book food truck spots, food truck scheduling, local food truck discovery",
      canonicalPath: "/for-food-trucks",
    },
    badge: "MealScout for Trucks",
    headline: roleAcquisitionGuides.truck.headline,
    subhead: roleAcquisitionGuides.truck.intro,
    guide: roleAcquisitionGuides.truck,
    primaryCta: {
      label: "Create a new truck profile",
      href: "/restaurant-signup?businessType=food_truck&intent=create&source=for-food-trucks",
    },
    secondaryCta: {
      label: "Claim an existing truck",
      href: "/claim-business?businessType=food_truck&claim=1&intent=claim&source=for-food-trucks",
    },
    bullets: ["Complete profile", "No card required", "No monthly bill"],
    map: {
      kicker: "Owner workspace",
      title: "Menu + schedule + location",
      badge: "Profile tools",
      hint: "Keep details current",
    },
    stats: [
      { label: "Menu", value: "Publish" },
      { label: "Schedule", value: "Share" },
    ],
    valueProps: [
      {
        icon: MapPin,
        text: "Share where your truck is serving",
      },
      {
        icon: Bolt,
        text: "Keep your menu, schedule, and profile together",
      },
      {
        icon: Sparkles,
        text: "Complete profile tools with no monthly bill",
      },
    ],
    steps: [
      {
        icon: Truck,
        title: "Create your truck profile",
        copy: "Add your business details, menu, photos, and service area.",
      },
      {
        icon: Radar,
        title: "Compare host locations",
        copy: "Browse current Parking Pass dates, service windows, spot details and listed prices.",
      },
      {
        icon: Calendar,
        title: "Keep your route visible",
        copy: "Publish a current menu, service schedule and location from your owner workspace.",
      },
    ],
    reasons: {
      title: "A profile built for a moving business",
      items: [
        "Create a new truck profile or claim a listing already in MealScout.",
        "Update menus, schedules, and live location from the owner workspace.",
        "Keep your public details current as your route changes.",
        "Review a host's actual dates and site details before choosing a service day.",
      ],
    },
    starter: {
      kicker: "Start now",
      title: "Free to join",
      copy: "Build your complete profile today. The free trial does not expire or become a monthly bill.",
      bullets: [
        "No card required",
        "All profile tools included",
        "No monthly subscription",
      ],
    },
    disclosure:
      "Separate paid orders, deliveries, bookings, and other transactions may carry charges. The exact charge is shown before payment.",
    finalCta: {
      title: "Ready to put your truck on MealScout?",
      copy: "Start a new profile, or claim the truck listing that is already yours.",
      primary: {
        label: "Create a new truck profile",
        href: "/restaurant-signup?businessType=food_truck&intent=create&source=for-food-trucks",
      },
      secondary: {
        label: "Claim an existing truck",
        href: "/claim-business?businessType=food_truck&claim=1&intent=claim&source=for-food-trucks",
      },
    },
  },
  restaurants: {
    seo: {
      title: "List Your Restaurant | Local Discovery & Specials | MealScout",
      description:
        "Get your restaurant discovered by locals. Publish specials, build your profile, and drive repeat visits — free to join on MealScout.",
      keywords: "list restaurant online, restaurant local discovery, restaurant specials near me, local restaurant marketing, restaurant listing platform",
      canonicalPath: "/for-restaurants",
    },
    badge: "MealScout for Restaurants",
    headline: "Be the spot locals can actually find.",
    subhead:
      "Turn your profile into a mini website, publish specials, and stay visible in local search without extra noise.",
    primaryCta: {
      label: "List my restaurant",
      href: "/customer-signup?role=business&businessType=restaurant",
    },
    secondaryCta: { label: "Sign in", href: "/login" },
    bullets: ["Local visibility", "Profile = mini website", "Stay in control"],
    map: {
      kicker: "Local presence",
      title: "Discovery + specials",
      badge: "Live listings",
      hint: "Always local",
    },
    stats: [
      { label: "Profile views", value: "--" },
      { label: "Specials live", value: "--" },
    ],
    valueProps: [
      {
        icon: Store,
        text: "Your profile acts like a local landing page",
      },
      {
        icon: Sparkles,
        text: "Publish specials and stay visible in search",
      },
      {
        icon: Bolt,
        text: "Complete profile access with no monthly bill",
      },
    ],
    steps: [
      {
        icon: Store,
        title: "Build your profile",
        copy: "Show menu highlights, photos, and the vibe locals love.",
      },
      {
        icon: Radar,
        title: "Get discovered",
        copy: "Show up in local search, maps, and recommendations.",
      },
      {
        icon: Calendar,
        title: "Stay active",
        copy: "Post specials and keep your info up to date.",
      },
    ],
    reasons: {
      title: "Why restaurants stay on MealScout",
      items: [
        "You own your presence and pricing.",
        "No confusing tiers or hidden boosts.",
        "Locals find you faster when you stay active.",
        "Everything stays local and community-driven.",
      ],
    },
    starter: {
      kicker: "Start now",
      title: "Free to join",
      copy: "Build your complete profile today. The free trial does not expire or become a monthly bill.",
      bullets: [
        "No card required",
        "All profile tools included",
        "No monthly subscription",
      ],
    },
    finalCta: {
      title: "Ready to show up locally?",
      copy: "Create your profile and start getting discovered by real locals.",
      primary: {
        label: "List my restaurant",
        href: "/customer-signup?role=business&businessType=restaurant",
      },
      secondary: { label: "Already have an account?", href: "/login" },
    },
  },
  bars: {
    seo: {
      title: "List Your Bar | Local Specials & Nightlife Discovery | MealScout",
      description:
        "Get your bar discovered by locals. Publish happy hour specials, stay visible in local search, and drive repeat visits on MealScout.",
      keywords: "list bar online, bar specials near me, happy hour discovery, local nightlife listings, bar marketing platform",
      canonicalPath: "/for-bars",
    },
    badge: "MealScout for Bars",
    headline: "Own your local nightlife presence.",
    subhead:
      "Your bar deserves more than random social reach. Use MealScout to stay visible where locals are looking.",
    primaryCta: {
      label: "List my bar",
      href: "/customer-signup?role=business&businessType=bar",
    },
    secondaryCta: { label: "Sign in", href: "/login" },
    bullets: ["Local visibility", "Specials that stand out", "Built for repeat visits"],
    map: {
      kicker: "Local presence",
      title: "Nightlife discovery",
      badge: "Live listings",
      hint: "Local picks",
    },
    stats: [
      { label: "Profile views", value: "--" },
      { label: "Specials live", value: "--" },
    ],
    valueProps: [
      {
        icon: Sparkles,
        text: "Stay visible to locals nearby",
      },
      {
        icon: Store,
        text: "Your profile works like a local website",
      },
      {
        icon: Bolt,
        text: "Complete profile access with no monthly bill",
      },
    ],
    steps: [
      {
        icon: Store,
        title: "Build your bar profile",
        copy: "Photos, specials, hours, and what makes you different.",
      },
      {
        icon: Radar,
        title: "Get discovered",
        copy: "Show up when locals search for nightlife nearby.",
      },
      {
        icon: Calendar,
        title: "Stay active",
        copy: "Post specials and keep the energy visible.",
      },
    ],
    reasons: {
      title: "Why bars stay on MealScout",
      items: [
        "Locals can find you without digging.",
        "Your specials are visible when it matters.",
        "No confusing marketing tools or tiers.",
        "Everything stays local and community-driven.",
      ],
    },
    starter: {
      kicker: "Start now",
      title: "Free to join",
      copy: "Build your complete profile today. The free trial does not expire or become a monthly bill.",
      bullets: [
        "No card required",
        "All profile tools included",
        "No monthly subscription",
      ],
    },
    finalCta: {
      title: "Ready to own your local presence?",
      copy: "Set up your bar profile and start showing up locally.",
      primary: {
        label: "List my bar",
        href: "/customer-signup?role=business&businessType=bar",
      },
      secondary: { label: "Already have an account?", href: "/login" },
    },
  },
  diners: {
    seo: {
      title: "Find Food Near Me | Local Restaurants, Bars & Food Trucks | MealScout",
      description:
        "Find local restaurants, bars, and food trucks near you. Discover specials, deals, and community recommendations on MealScout.",
      keywords: "find food near me, local restaurants near me, food trucks near me, nearby bars and restaurants, local food discovery",
      canonicalPath: "/scout",
    },
    badge: "MealScout for Diners",
    headline: "Find what's actually local.",
    subhead:
      "Discover food trucks, restaurants, and bars nearby--built by locals, updated by locals.",
    primaryCta: { label: "Find Food", href: "/search" },
    secondaryCta: {
      label: "Create account",
      href: "/customer-signup?role=diner",
    },
    bullets: ["Local discovery", "Community recommendations", "Share to earn"],
    map: {
      kicker: "Local map",
      title: "Nearby spots + specials",
      badge: "Live discovery",
      hint: "Local favorites",
    },
    stats: [
      { label: "Nearby spots", value: "--" },
      { label: "Specials live", value: "--" },
    ],
    valueProps: [
      {
        icon: MapPin,
        text: "Find what's open and nearby",
      },
      {
        icon: Users,
        text: "Recommendations come from locals",
      },
      {
        icon: Sparkles,
        text: "Share links and earn credit",
      },
    ],
    steps: [
      {
        icon: MapPin,
        title: "Search nearby",
        copy: "Use the map or search by city, address, or cuisine.",
      },
      {
        icon: Utensils,
        title: "Discover specials",
        copy: "See what's live now and what locals recommend.",
      },
      {
        icon: Users,
        title: "Share what you love",
        copy: "Share any link and stay credited automatically.",
      },
    ],
    reasons: {
      title: "Why locals use MealScout",
      items: [
        "No clutter -- just real local options.",
        "Recommendations are community-led.",
        "Everything updates in real time.",
        "Your shares always stay yours.",
      ],
    },
    starter: {
      kicker: "Start now",
      title: "Free to explore",
      copy: "Search local spots and specials instantly.",
      bullets: [
        "No account required to browse",
        "Save favorites when you join",
        "Always local, always current",
      ],
    },
    finalCta: {
      title: "Ready to find your next spot?",
      copy: "Search locally and support the businesses around you.",
      primary: { label: "Find Food", href: "/search" },
      secondary: { label: "Create account", href: "/customer-signup?role=diner" },
    },
  },
  hosts: {
    seo: {
      title: roleAcquisitionGuides.hosts.title,
      description: roleAcquisitionGuides.hosts.description,
      keywords: "host food truck location, food truck parking spot, bookable truck spots, food truck host platform, list parking for food trucks",
      canonicalPath: "/for-hosts",
    },
    badge: "MealScout for Hosts",
    headline: roleAcquisitionGuides.hosts.headline,
    subhead: roleAcquisitionGuides.hosts.intro,
    guide: roleAcquisitionGuides.hosts,
    primaryCta: { label: "List my location", href: "/customer-signup?role=host" },
    secondaryCta: { label: "Sign in", href: "/login" },
    bullets: ["Describe your space", "Control availability", "Review booking status"],
    map: {
      kicker: "Location control",
      title: "Dates + capacity + site details",
      badge: "Host controls",
      hint: "Live listings are on Parking Pass",
    },
    stats: [
      { label: "Locations listed", value: "--" },
      { label: "Slots live", value: "--" },
    ],
    valueProps: [
      {
        icon: Building2,
        text: "One parking pass per address",
      },
      {
        icon: Calendar,
        text: "Set slots and blackout dates per location",
      },
      {
        icon: Sparkles,
        text: "Review pricing alongside the location's availability",
      },
    ],
    steps: [
      {
        icon: MapPin,
        title: "Add your address",
        copy: "Each address becomes its own parking pass location.",
      },
      {
        icon: Calendar,
        title: "Set slots",
        copy: "Choose availability and spot count per location.",
      },
      {
        icon: Truck,
        title: "Review booking status",
        copy: "Use your host workspace to review the actual booking status, not just page views or selected dates.",
      },
    ],
    reasons: {
      title: "Why hosts use MealScout",
      items: [
        "Published dates and site details give trucks a clearer decision.",
        "Control availability per address.",
        "Trucks see rules and slots up front.",
        "Everything stays local and simple.",
      ],
    },
    starter: {
      kicker: "Start now",
      title: "List your first address",
      copy: "Set up your host profile and review the location details before publishing availability.",
      bullets: [
        "Free to join",
        "Control slots and availability",
        "No host fees from MealScout",
      ],
    },
    finalCta: {
      title: "Ready to list your location?",
      copy: "Create your host profile and start accepting bookings.",
      primary: { label: "List my location", href: "/customer-signup?role=host" },
      secondary: { label: "Already have an account?", href: "/login" },
    },
  },
  events: {
    seo: {
      title: "Food Truck Events & Open Calls | Event Coordinator Tools | MealScout",
      description:
        "Create and manage food truck events and open calls. Post your event, set truck capacity, and coordinate vendors — all in one place on MealScout.",
      keywords: "food truck event coordinator, food truck open call, local food events platform, truck event management, food festival vendor booking",
      canonicalPath: "/for-events",
    },
    badge: "MealScout for Events",
    headline: "Run events without the chaos.",
    subhead:
      "Own the event flow, keep trucks informed, and stay organized with one dashboard.",
    primaryCta: {
      label: "Create an event",
      href: "/customer-signup?role=event_coordinator",
    },
    secondaryCta: { label: "Sign in", href: "/login" },
    bullets: ["Events are separate", "Coordinator-controlled", "Local first"],
    map: {
      kicker: "Event flow",
      title: "Coordinators + trucks",
      badge: "Event listings",
      hint: "Local events",
    },
    stats: [
      { label: "Events live", value: "--" },
      { label: "Trucks booked", value: "--" },
    ],
    valueProps: [
      {
        icon: PartyPopper,
        text: "Create and manage events in one place",
      },
      {
        icon: Truck,
        text: "Trucks can contact you directly",
      },
      {
        icon: Bolt,
        text: "Keep it local, keep it simple",
      },
    ],
    steps: [
      {
        icon: PartyPopper,
        title: "Create your event",
        copy: "Set the details and keep everything clear upfront.",
      },
      {
        icon: Radar,
        title: "Get discovered",
        copy: "Trucks find your event in local search.",
      },
      {
        icon: Calendar,
        title: "Book trucks",
        copy: "Coordinate directly and stay on schedule.",
      },
    ],
    reasons: {
      title: "Why coordinators use MealScout",
      items: [
        "Events stay separate from parking pass.",
        "Clear communication with trucks.",
        "Local visibility without extra tools.",
        "Everything stays organized in one place.",
      ],
    },
    starter: {
      kicker: "Start now",
      title: "Create your first event",
      copy: "Build the listing and invite local trucks.",
      bullets: [
        "Free to join",
        "Coordinator-controlled flow",
        "Local discovery built in",
      ],
    },
    finalCta: {
      title: "Ready to run a clean event?",
      copy: "Create the listing and let trucks reach you directly.",
      primary: {
        label: "Create an event",
        href: "/customer-signup?role=event_coordinator",
      },
      secondary: { label: "Already have an account?", href: "/login" },
    },
  },
} satisfies Record<string, RoleLandingContent>;

