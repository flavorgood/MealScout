import { SEOHead } from "@/components/seo-head";
import { BackHeader } from "@/components/back-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import {
  BadgeDollarSign,
  Camera,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Image,
  Link as LinkIcon,
  Megaphone,
  Sparkles,
  Store,
  Truck,
  Utensils,
  type LucideIcon,
} from "lucide-react";

const audience =
  "For restaurants, food trucks, bakeries, caterers, meal prep sellers, pop-ups, farmers market vendors, and online food brands.";

const standardProfileIncludes = [
  "Business profile",
  "Menu or product listings",
  "Photos and categories",
  "Hours, location, and schedule fields",
  "Profile link",
  "Local discovery",
  "Customer action paths where available",
  "Marketing and affiliate tools where available",
  "AI-prepared updates with owner approval",
  "Free DIY domain linking, management, and verification",
];

const doneForYouIncludes = [
  "Manual help from our team",
  "Done-for-you domain move and setup checks",
  "Profile link and setup guidance",
  "Larger profile work scoped to your business",
  "Private review before approved changes",
];

const manualHelpOptions = [
  {
    price: 250,
    name: "Core setup help",
    description: "Done-for-you domain move and checks that the setup works.",
  },
  {
    price: 1000,
    name: "Larger business help",
    description: "More manual onboarding or refresh work for a larger business.",
  },
  {
    price: 2500,
    name: "Full presence refresh",
    description: "Our primary full-presence service, including socials and logos.",
  },
];

const customBuildExamples = [
  "Large menus",
  "Multiple locations",
  "Food trucks with rotating schedules",
  "Online food sellers",
  "Retail food catalogs",
  "Catering menus",
  "Heavy photo cleanup",
  "Brand package work",
  "Ongoing profile support",
];

const websiteLimitations = [
  "Often outdated",
  "Menu changes are hard to keep current",
  "Hours and locations get missed",
  "Food photos are buried",
  "Mobile ordering paths are unclear",
  "Specials are not easy to promote",
  "Tools are usually separate",
];

const mealscoutProfileAdvantages = [
  "Complete self-managed food profile",
  "Done-for-you setup available",
  "Menu and item organization",
  "Photos and food categories",
  "Hours, locations, and schedule support",
  "Specials and featured items",
  "Customer action links",
  "Local food discovery",
  "Profile link for social media",
  "Custom domain support",
  "Marketing and affiliate tools where available",
  "Use any free or paid AI you already have",
];

const squareOneSupport = [
  "Logo cleanup or direction",
  "Food-friendly brand colors",
  "Menu wording",
  "Short restaurant or vendor description",
  "Featured item copy",
  "Social-ready profile language",
  "Photo guidance",
  "Launch polish",
];

const profileFeatureTiles: Array<{ label: string; icon: LucideIcon }> = [
  { label: "Menu", icon: ClipboardList },
  { label: "Photos", icon: Camera },
  { label: "Schedule", icon: Truck },
  { label: "Action links", icon: ExternalLink },
];

function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-sm leading-relaxed text-stone-700">
          <CheckCircle2
            className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
            aria-hidden="true"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ProfileSetupPage() {
  const schemaData = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "MealScout Profile Setup",
    provider: {
      "@type": "Organization",
      name: "MealScout",
      url: "https://www.mealscout.us",
    },
    areaServed: "United States",
    serviceType: "Food business profile setup",
    description:
      "Free MealScout food profiles with owner-approved AI setup using any model, plus optional done-for-you help for restaurants, food trucks, vendors, caterers, meal prep sellers, and online food brands.",
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "Optional manual onboarding and refresh",
      itemListElement: manualHelpOptions.map((option) => ({
        "@type": "Offer",
        price: String(option.price),
        priceCurrency: "USD",
        itemOffered: {
          "@type": "Service",
          name: option.name,
          description: option.description,
        },
      })),
    },
  };

  return (
    <div className="min-h-screen bg-[#fff7ed] text-stone-950">
      <SEOHead
        title="MealScout Profile Setup - Free Food Profiles + Optional Setup Help"
        description="Create and customize a free MealScout food profile. Use your own AI for private drafts, with optional manual onboarding and refresh help from our team."
        keywords="MealScout profile setup, free restaurant profile, food truck profile, restaurant menu profile, food vendor profile, bakery profile, caterer profile, online food seller profile"
        canonicalUrl="https://www.mealscout.us/profile-setup"
        schemaData={schemaData}
      />

      <BackHeader
        title="MealScout Profile Setup"
        fallbackHref="/"
        icon={Store}
        className="border-b border-orange-200/70 bg-[#fff7ed]/95 shadow-clean"
      />

      <main>
        <section className="px-4 pb-12 pt-10 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:items-center">
            <div>
              <p className="mb-4 inline-flex rounded-full bg-orange-100 px-4 py-2 text-xs font-black uppercase tracking-[0.12em] text-orange-800 ring-1 ring-orange-200">
                Free profile + optional setup help
              </p>
              <h1 className="text-4xl font-black leading-tight text-stone-950 sm:text-5xl">
                Your food profile, built for hungry customers.
              </h1>
              <p className="mt-5 max-w-2xl text-lg font-semibold leading-relaxed text-stone-700">
                Create your complete MealScout Profile for free and use all
                included profile tools. Need help getting it ready? We can
                set it up, customize it, organize your menu, polish your photos,
                and connect your domain or ordering links.
              </p>
              <p className="mt-5 max-w-2xl text-base font-bold text-stone-800">
                {audience}
              </p>
              <div className="mt-6 flex max-w-2xl gap-3 rounded-2xl border border-orange-200 bg-white/80 p-4 shadow-clean">
                <Sparkles
                  className="mt-0.5 h-5 w-5 shrink-0 text-orange-700"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-black text-orange-950">
                    Use the AI you already have
                  </p>
                  <p className="mt-1 text-sm leading-6 text-stone-700">
                    Any free or paid AI can prepare your profile, menus and
                    prices, logos and images, hours, schedules or events, deals,
                    and matching social posts. Paste its MealScout JSON into
                    your existing editor, review the private previews, and approve
                    the exact revision before changes are applied.
                  </p>
                  <Button asChild variant="link" className="mt-2 h-auto px-0 font-bold text-orange-800">
                    <Link href="/owner-ai?src=onboarding">
                      Review AI-prepared content
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/restaurant-signup">
                  <Button className="h-12 rounded-full bg-orange-600 px-6 text-base font-black text-white hover:bg-orange-700">
                    Create Free Profile
                  </Button>
                </Link>
                <a href="mailto:support@mealscout.us?subject=MealScout%20Profile%20Setup%20Help">
                  <Button
                    variant="outline"
                    className="h-12 rounded-full border-orange-300 bg-white px-6 text-base font-black text-orange-800 hover:bg-orange-50"
                  >
                    Get Setup Help
                  </Button>
                </a>
              </div>
            </div>

            <div className="rounded-[2rem] bg-white p-6 shadow-[0_24px_70px_rgba(124,45,18,0.18)] ring-1 ring-orange-200">
              <div className="rounded-[1.5rem] bg-gradient-to-br from-orange-500 via-rose-500 to-amber-400 p-5 text-white">
                <Utensils className="h-9 w-9" aria-hidden="true" />
                <p className="mt-10 text-sm font-black uppercase tracking-[0.14em] text-white/80">
                  MealScout Profile
                </p>
                <h2 className="mt-2 text-3xl font-black leading-tight">
                  A restaurant website tells people you exist.
                </h2>
                <p className="mt-4 text-lg font-bold leading-relaxed text-white/90">
                  A MealScout Profile helps people decide what to eat.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-4 text-sm font-bold text-stone-700">
                {profileFeatureTiles.map(({ label, icon: IconComponent }) => {
                  return (
                    <div
                      key={label}
                      className="rounded-2xl bg-orange-50 p-4 ring-1 ring-orange-100"
                    >
                      <IconComponent
                        className="mb-3 h-5 w-5 text-orange-700"
                        aria-hidden="true"
                      />
                      {label}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white px-4 py-12 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="mb-8 max-w-3xl">
              <h2 className="text-3xl font-black text-stone-950">
                More useful than a stale restaurant website.
              </h2>
              <p className="mt-3 text-base font-semibold leading-relaxed text-stone-600">
                Traditional food websites can hide the exact details customers
                need on mobile. MealScout keeps the food decision close to the
                menu, photos, hours, schedules, specials, links, and local
                discovery.
              </p>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="border-stone-200 bg-stone-50 shadow-clean">
                <CardHeader>
                  <CardTitle className="text-xl font-black text-stone-900">
                    Traditional food website
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CheckList items={websiteLimitations} />
                </CardContent>
              </Card>
              <Card className="border-orange-200 bg-orange-50 shadow-clean">
                <CardHeader>
                  <CardTitle className="text-xl font-black text-orange-950">
                    MealScout Profile
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <CheckList items={mealscoutProfileAdvantages} />
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="px-4 py-12 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <div className="mb-8 max-w-3xl">
              <h2 className="text-3xl font-black text-stone-950">
                Choose the level of help you need.
              </h2>
              <p className="mt-3 text-base font-semibold leading-relaxed text-stone-600">
                DIY creation and customization stay free. Manual onboarding and
                refresh services pay for work by our team. Choose the help that
                fits your business, then confirm the exact scope before buying.
              </p>
              <p className="mt-3 text-sm font-bold text-stone-800">
                Optional setup help never unlocks or restricts profile tools.
              </p>
              <p className="mt-3 text-sm leading-6 text-stone-600">
                Domain linking, management and verification are free. The $250
                option covers our team moving your domain and checking the setup.
                You keep ownership of your domain. DIY and paid help use the same
                capabilities and scoring rules.
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <Card className="border-orange-200 bg-white shadow-clean">
                <CardHeader>
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                    <Store className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <CardTitle className="text-xl font-black">
                    Complete MealScout Profile
                  </CardTitle>
                  <p className="text-3xl font-black text-emerald-700">Free</p>
                  <p className="text-sm font-semibold text-stone-600">
                    Create and manage your own food profile.
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  <CheckList items={standardProfileIncludes} />
                  <Link href="/settings?tab=account#custom-domain" className="block text-sm font-bold text-emerald-700 underline">
                    DIY domain instructions and verification
                  </Link>
                  <Link href="/restaurant-signup">
                    <Button className="w-full rounded-full bg-emerald-600 font-black text-white hover:bg-emerald-700">
                      Create Free Profile
                    </Button>
                  </Link>
                </CardContent>
              </Card>

              <Card className="border-orange-300 bg-white shadow-[0_20px_50px_rgba(124,45,18,0.16)]">
                <CardHeader>
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-100 text-orange-700">
                    <BadgeDollarSign className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <CardTitle className="text-xl font-black">
                    Done-For-You Setup
                  </CardTitle>
                  <p className="text-3xl font-black text-orange-700">
                    Manual onboarding and refresh
                  </p>
                  <p className="text-sm font-semibold text-stone-600">
                    We help with the work you want done for you.
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  <dl className="space-y-4">
                    {manualHelpOptions.map((option) => (
                      <div key={option.price}>
                        <dt className="font-bold text-stone-950">
                          &#36;{option.price.toLocaleString("en-US")} · {option.name}
                        </dt>
                        <dd className="mt-1 text-sm leading-6 text-stone-600">
                          {option.description}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <CheckList items={doneForYouIncludes} />
                  <p className="text-sm leading-6 text-stone-600">
                    Exact service limits and refresh timing are confirmed with
                    you before purchase. Paid help uses the same profile tools
                    and owner review as DIY.
                  </p>
                  <a href="mailto:support@mealscout.us?subject=MealScout%20Done-For-You%20Profile%20Setup">
                    <Button className="w-full rounded-full bg-orange-600 font-black text-white hover:bg-orange-700">
                      Get Setup Help
                    </Button>
                  </a>
                </CardContent>
              </Card>

              <Card className="border-stone-200 bg-white shadow-clean">
                <CardHeader>
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-100 text-stone-700">
                    <ClipboardList className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <CardTitle className="text-xl font-black">
                    Custom Setup Service
                  </CardTitle>
                  <p className="text-3xl font-black text-stone-800">
                    Quoted when needed
                  </p>
                  <p className="text-sm font-semibold text-stone-600">
                    For larger or more complex profile setup work.
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  <CheckList items={customBuildExamples} />
                  <a href="mailto:support@mealscout.us?subject=MealScout%20Custom%20Profile%20Quote">
                    <Button
                      variant="outline"
                      className="w-full rounded-full border-stone-300 bg-white font-black text-stone-800 hover:bg-stone-50"
                    >
                      Request a Quote
                    </Button>
                  </a>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        <section className="bg-stone-950 px-4 py-12 text-white sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div>
              <p className="mb-3 inline-flex rounded-full bg-white/10 px-4 py-2 text-xs font-black uppercase tracking-[0.12em] text-orange-100 ring-1 ring-white/15">
                Optional brand polish
              </p>
              <h2 className="text-3xl font-black">Square One Brand Package</h2>
              <p className="mt-4 text-base font-semibold leading-relaxed text-white/72">
                Need your food profile to look sharper? Square One helps turn a
                rough food presence into something clean, appetizing, and ready
                to share.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {squareOneSupport.map((item) => (
                <div
                  key={item}
                  className="rounded-2xl bg-white/8 p-4 text-sm font-bold text-white/82 ring-1 ring-white/10"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white px-4 py-12 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-2">
            <Card className="border-orange-200 bg-orange-50 shadow-clean">
              <CardHeader>
                <Megaphone className="mb-3 h-6 w-6 text-orange-700" />
                <CardTitle className="text-xl font-black text-orange-950">
                  ScoutFitters-style offers may expand over time.
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm font-semibold leading-relaxed text-stone-700">
                  Eligible MealScout businesses may receive access to
                  ScoutFitters offers, vendor discounts, gear deals, packaging
                  discounts, equipment offers, and business-building perks as
                  the program expands.
                </p>
                <p className="mt-3 text-sm font-bold leading-relaxed text-stone-700">
                  Availability may vary by category, location, vendor, and
                  offer.
                </p>
              </CardContent>
            </Card>
            <Card className="border-stone-200 bg-stone-50 shadow-clean">
              <CardHeader>
                <Image className="mb-3 h-6 w-6 text-stone-700" />
                <CardTitle className="text-xl font-black text-stone-950">
                  Bring what you already have.
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm font-semibold leading-relaxed text-stone-700">
                  Menus, photos, social links, ordering links, a domain, a logo,
                  a rough description, or just a few notes are enough to start.
                  We organize the profile around what helps customers decide
                  what to eat.
                </p>
                <div className="mt-5 flex items-center gap-2 text-sm font-black text-orange-800">
                  <LinkIcon className="h-4 w-4" aria-hidden="true" />
                  Profile link, social sharing, and customer action paths stay
                  central.
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}
