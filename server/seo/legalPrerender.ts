import type { Express, Request, Response, NextFunction } from "express";

import { buildJsonLdScript } from "./jsonLdScript";
import { shouldServePrerender } from "./botDetection";

/**
 * Crawler prerender for the Terms of Service page.
 *
 * /terms-of-service is a client-rendered page, so crawlers and link
 * preview fetchers that do not run the app received the generic SPA
 * shell — the homepage title and no legal text at all (the static
 * Privacy Policy page has its own full-text route; Terms had none).
 * Bot requests now receive this static document, whose wording is the
 * Terms page's own text (client/src/pages/terms-of-service.tsx,
 * including its SEOHead title and description). Human visitors keep
 * getting the app exactly as before — non-bot requests fall through.
 * Keep TERMS_OF_SERVICE_BLOCKS in step with the page when it changes.
 */

type LegalBlock = { tag: "h2" | "h3" | "p" | "li"; text: string };

const TERMS_OF_SERVICE_TITLE = "Terms of Service - MealScout | User Agreement";
const TERMS_OF_SERVICE_DESCRIPTION =
  "Read MealScout's Terms of Service. Understand the rules, regulations, and user agreement for using our food deals platform. Last updated January 2025.";

const TERMS_OF_SERVICE_BLOCKS: LegalBlock[] = [
  { tag: "h2", text: "1. Acceptance of Terms" },
  { tag: "p", text: "By accessing and using MealScout (\"Service\"), you accept and agree to be bound by the terms and provision of this agreement (\"Terms\"). If you do not agree to these Terms, please do not use our Service. These Terms apply to all visitors, users, and others who access or use the Service." },
  { tag: "p", text: "MealScout is operated by MealScout (\"Company,\" \"we,\" \"us,\" or \"our\"). By using our Service, you agree to these Terms and our Privacy Policy." },
  { tag: "h2", text: "2. Description of Service" },
  { tag: "p", text: "MealScout is a hyper-local meal deals discovery platform that connects restaurants, bars, and food trucks with nearby customers through location-based services and real-time deal notifications. Our Service provides:" },
  { tag: "li", text: "Deal creation and management tools for businesses" },
  { tag: "li", text: "Location-based deal discovery for customers" },
  { tag: "li", text: "Real-time GPS tracking for food trucks" },
  { tag: "li", text: "Business verification and authentication services" },
  { tag: "li", text: "User review and rating systems" },
  { tag: "li", text: "Complete business profiles under a non-expiring free trial" },
  { tag: "li", text: "Analytics and reporting for business users" },
  { tag: "p", text: "Business profile access is provided under a free trial that does not expire, require a payment card, convert to a paid plan, or create a monthly subscription charge." },
  { tag: "h2", text: "3. Profile Access and Free Trial" },
  { tag: "p", text: "Business users receive the complete MealScout profile product under a free trial. The trial has no expiration date, no card requirement, no automatic conversion, and no monthly profile subscription." },
  { tag: "h3", text: "Profile Access:" },
  { tag: "li", text: "- Complete profile tools are included" },
  { tag: "li", text: "- No monthly or quarterly profile charge" },
  { tag: "li", text: "- No card is required for the free trial" },
  { tag: "p", text: "No Auto-Renewal: The profile free trial does not renew into a paid plan and does not generate a recurring profile charge." },
  { tag: "p", text: "Separate Paid Actions: Orders, deliveries, bookings, and other paid transactions may carry their own clearly disclosed charges. Those charges do not unlock or restrict profile access." },
  { tag: "p", text: "Refunds: Refund terms for a paid transaction are shown in the applicable order or booking flow." },
  { tag: "h2", text: "4. User Conduct" },
  { tag: "p", text: "You agree to use MealScout only for lawful purposes and in accordance with these Terms. You agree not to use the Service:" },
  { tag: "li", text: "To violate any applicable laws, regulations, or third-party rights" },
  { tag: "li", text: "To post false, misleading, or fraudulent deals or business information" },
  { tag: "li", text: "To impersonate another person or entity or misrepresent your affiliation" },
  { tag: "li", text: "To interfere with or disrupt the Service or servers connected to the Service" },
  { tag: "li", text: "To attempt to gain unauthorized access to any part of the Service" },
  { tag: "li", text: "To harvest or collect information about other users without their consent" },
  { tag: "li", text: "To post content that is defamatory, obscene, or violates intellectual property rights" },
  { tag: "li", text: "To use automated systems or software to extract data from the Service" },
  { tag: "p", text: "We reserve the right to suspend or terminate accounts that violate these conduct rules." },
  { tag: "h2", text: "5. Location Services" },
  { tag: "p", text: "MealScout uses location services to provide relevant deals and track food truck locations. By using our Service, you consent to:" },
  { tag: "li", text: "Collection of your device's location data when using the app" },
  { tag: "li", text: "Real-time location sharing for food truck operators during business hours" },
  { tag: "li", text: "Storage of location history to improve service recommendations" },
  { tag: "li", text: "Sharing of general location data (city/region) with restaurant partners" },
  { tag: "p", text: "You can disable location services in your device settings, but this may limit the functionality of our Service. Location data is handled in accordance with our Privacy Policy." },
  { tag: "h2", text: "6. Business Verification" },
  { tag: "p", text: "Business users must provide accurate information and may be required to verify their business through:" },
  { tag: "li", text: "Valid business license or permit documentation" },
  { tag: "li", text: "Tax identification numbers or business registration documents" },
  { tag: "li", text: "Proof of business address and operation" },
  { tag: "li", text: "Food service permits and health department certifications (where applicable)" },
  { tag: "li", text: "Identity verification for authorized business representatives" },
  { tag: "p", text: "We reserve the right to suspend accounts pending verification and may request additional documentation at any time. Providing false information may result in immediate account termination." },
  { tag: "p", text: "Compliance responsibility: Hosts, food trucks, restaurants, and bars are solely responsible for obtaining and maintaining all required local, state, and federal licenses, permits, inspections, health approvals, zoning approvals, and insurance coverage. MealScout does not verify legal compliance beyond the documents we request, does not provide legal or compliance advice, and is not responsible for your operations." },
  { tag: "h2", text: "7. Payment Terms" },
  { tag: "p", text: "All payments are processed securely through Stripe, Inc. By providing payment information, you represent that you are authorized to use the payment method and authorize us to charge your payment method." },
  { tag: "h3", text: "Payment Processing:" },
  { tag: "li", text: "- All payments are processed in USD" },
  { tag: "li", text: "- Profile access does not create a recurring charge" },
  { tag: "li", text: "- Transaction charges are shown before payment" },
  { tag: "li", text: "- A failed transaction payment does not remove profile access" },
  { tag: "li", text: "- You are responsible for any taxes or fees imposed by your jurisdiction" },
  { tag: "p", text: "Billing Disputes: Contact us within 30 days of any billing dispute. We will investigate and resolve disputes in good faith." },
  { tag: "p", text: "Transaction Price Changes: Charges for separate paid actions may change, but the applicable amount must be shown before the user confirms that transaction." },
  { tag: "h2", text: "8. Termination" },
  { tag: "p", text: "Either party may terminate this agreement at any time. You may cancel your account through the Service settings or by contacting us. We may suspend or terminate your account immediately if:" },
  { tag: "li", text: "You violate these Terms or our policies" },
  { tag: "li", text: "Your account is inactive for an extended period" },
  { tag: "li", text: "We reasonably believe your account poses a security risk" },
  { tag: "li", text: "Required by law or legal process" },
  { tag: "li", text: "Payment failure after reasonable notice and opportunity to cure" },
  { tag: "p", text: "Upon termination, your right to use the Service will cease immediately. We may delete your account data after a reasonable period, subject to legal requirements and our Privacy Policy." },
  { tag: "h2", text: "9. Limitation of Liability" },
  { tag: "p", text: "THE SERVICE IS PROVIDED \"AS IS\" WITHOUT WARRANTIES OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT." },
  { tag: "p", text: "IN NO EVENT SHALL MEALSCOUT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, OR BUSINESS INTERRUPTION, ARISING FROM YOUR USE OF THE SERVICE." },
  { tag: "p", text: "MealScout is a marketplace platform only. Hosts and trucks contract directly with each other and are fully responsible for their own operations, staffing, safety, food handling, permits, insurance, taxes, and legal compliance. MealScout is not a party to any on-site arrangement and assumes no liability for performance, accidents, injuries, property damage, regulatory violations, or disputes." },
  { tag: "p", text: "OUR TOTAL LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM THE SERVICE SHALL NOT EXCEED THE AMOUNT YOU PAID TO US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM." },
  { tag: "p", text: "Important: MealScout is a platform that connects businesses and customers. We are not responsible for the quality, safety, or accuracy of deals, food, or services provided by third-party businesses." },
  { tag: "h2", text: "10. Governing Law and Disputes" },
  { tag: "p", text: "These Terms are governed by the laws of the United States without regard to conflict of law principles. Any disputes arising from these Terms or the Service will be resolved through binding arbitration, except that either party may seek injunctive relief in court." },
  { tag: "p", text: "If any provision of these Terms is found unenforceable, the remaining provisions will remain in full force and effect." },
  { tag: "h2", text: "11. Changes to Terms" },
  { tag: "p", text: "We may update these Terms from time to time. We will notify you of material changes by posting the updated Terms on our Service and updating the \"Last updated\" date. Your continued use of the Service after changes constitutes acceptance of the new Terms." },
  { tag: "h2", text: "12. Contact Information" },
  { tag: "p", text: "For questions about these Terms, please contact us at:" },
  { tag: "p", text: "Email: support@mealscout.us" },
  { tag: "p", text: "Phone: (985) 662-6247" },
  { tag: "h3", text: "Legal Notice" },
  { tag: "p", text: "These Terms of Service are effective as of the date listed above. Please review them carefully and contact us if you have any questions." },
];

const escapeHtml = (value: string) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderBlocks = (blocks: LegalBlock[]) => {
  const html: string[] = [];
  let listOpen = false;
  for (const block of blocks) {
    if (block.tag === "li") {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(block.text)}</li>`);
      continue;
    }
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
    html.push(`<${block.tag}>${escapeHtml(block.text)}</${block.tag}>`);
  }
  if (listOpen) html.push("</ul>");
  return html.join("\n    ");
};

const buildTermsOfServiceHtml = (canonicalBaseUrl: string) => {
  const canonical = `${canonicalBaseUrl}/terms-of-service`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: TERMS_OF_SERVICE_TITLE,
    url: canonical,
    description: TERMS_OF_SERVICE_DESCRIPTION,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(TERMS_OF_SERVICE_TITLE)}</title>
  <meta name="description" content="${escapeHtml(TERMS_OF_SERVICE_DESCRIPTION)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:title" content="${escapeHtml(TERMS_OF_SERVICE_TITLE)}">
  <meta property="og:description" content="${escapeHtml(TERMS_OF_SERVICE_DESCRIPTION)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1">
  ${buildJsonLdScript(schema)}
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; margin: 0; background: #fffaf2; color: #111827; }
    main { max-width: 840px; margin: 0 auto; padding: 28px 18px 44px; }
    h1 { font-size: 32px; margin: 0 0 14px; }
    h2 { font-size: 22px; margin: 26px 0 10px; }
    h3 { font-size: 17px; margin: 18px 0 8px; }
    p, li { line-height: 1.6; }
    p { margin: 0 0 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Terms of Service</h1>
    <p><strong>Last updated: January 13, 2025</strong></p>
    <p>Please read these Terms of Service carefully before using MealScout</p>
    ${renderBlocks(TERMS_OF_SERVICE_BLOCKS)}
    <p><a href="/privacy-policy">Privacy Policy</a> · <a href="/">MealScout home</a></p>
  </main>
</body>
</html>`;
};

export function registerLegalPrerenderRoutes(
  app: Express,
  canonicalBaseUrl: string,
) {
  app.get(
    "/terms-of-service",
    (req: Request, res: Response, next: NextFunction) => {
      if (!shouldServePrerender(req)) {
        return next();
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=1800");
      res.send(buildTermsOfServiceHtml(canonicalBaseUrl));
    },
  );
}
