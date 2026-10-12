export type RoleAcquisitionGuide = {
  path: string;
  title: string;
  description: string;
  headline: string;
  intro: string;
  sections: { title: string; paragraphs: string[] }[];
  examples: { title: string; copy: string }[];
  questions: { question: string; answer: string }[];
  listingLink: { label: string; href: string };
  relatedLinks: { label: string; href: string }[];
};

// Evergreen guidance, shared by the visible app and its crawler HTML. Inventory
// remains on the live board: these examples do not invent locations or slots.
export const roleAcquisitionGuides: Record<"truck" | "hosts", RoleAcquisitionGuide> = {
  truck: {
    path: "/for-food-trucks",
    title: "Food Truck Parking & Booking: Find Host Locations | MealScout",
    description: "Find published food truck parking locations, compare dates, service windows and prices, and keep your truck menu and schedule visible on MealScout.",
    headline: "Find food truck parking and plan your next service day.",
    intro: "A useful food truck spot needs more than an address. Compare where you can park, when you can serve, what the listing costs and whether the space fits your operation. MealScout connects its public Parking Pass listings with the profile, menu and schedule your customers use to find you.",
    sections: [
      {
        title: "Find parking that fits your truck and service window",
        paragraphs: [
          "Start with the live Parking Pass board. Open a published host location and check the exact date, service window, available spots and listed prices. Browse before creating an account; use the listing details rather than assuming every address is available every day.",
          "Compare vehicle access, arrival and cleanup needs with the host's published information. Power, water and other facilities are not automatically included. Confirm a requirement that is not stated before planning service around it.",
        ],
      },
      {
        title: "Compare a single service day with recurring dates",
        paragraphs: [
          "One open date is not evidence of a whole open week. If a listing offers weekly or monthly choices, inspect the dates and service windows you are actually choosing. A recurring plan still needs to fit the host calendar and your truck's route.",
          "Review the amount and any displayed charges before proceeding. A selected date, a contact attempt or a payment redirect is not by itself a confirmed booking. Use the booking status returned by the flow; if it remains pending, check that status before starting another request.",
        ],
      },
      {
        title: "Help diners find the truck where it is actually serving",
        paragraphs: [
          "Create a truck profile, or claim the existing listing that belongs to your business. Keep your menu, public schedule and location details current in the owner workspace so a diner can understand what you serve and where to look for you.",
          "Use an accurate service schedule rather than leaving yesterday's stop on the profile. Profile tools do not require a card or become a monthly bill. Separate paid bookings, orders, deliveries and other transactions may carry charges shown before payment.",
        ],
      },
    ],
    examples: [
      { title: "Planning example: a weekday lunch stop", copy: "You need a place for a lunch service, not an overnight base. Compare the published date and service window, the approach for your vehicle, the spot details and the price. Only choose a location whose actual listing fits that plan; this example is not an offer at a named site." },
      { title: "Planning example: two recurring service days", copy: "You want to return on two days each week. Check each proposed date on the host calendar and keep the rest of your public route accurate. Do not treat a weekly price option as a promise that every day or spot is available." },
    ],
    questions: [
      { question: "Where can I find food truck parking to book?", answer: "Open Parking Pass to see the current published host listings. Review the location, exact date, service window, spots and prices before continuing. If the board does not show a suitable listing, MealScout is not promising an available space in that area." },
      { question: "Can I browse host locations before signing up?", answer: "Yes. Public Parking Pass listings can be browsed first. Keeping account work, contacting a business and restricted actions use the normal sign-in and verification flow; owning or managing a business still requires the appropriate authority." },
      { question: "Does choosing a date reserve a parking spot?", answer: "No. Choosing a date or slot is preparation. Check the booking status after the booking flow rather than assuming a button click or a payment redirect means the reservation is confirmed." },
      { question: "What should I check before bringing my truck?", answer: "Check the published service window, vehicle access, spot details, price and site instructions. Confirm facilities or requirements that the listing does not state. Plan arrival and cleanup around the host's actual terms." },
      { question: "Should I create a profile or claim one?", answer: "Create a profile when your truck is not listed. If the existing profile belongs to your business, use the claim path rather than creating a duplicate. Once you have owner access, keep the menu, schedule and location details current." },
    ],
    listingLink: { label: "Browse current Parking Pass listings", href: "/parking-pass" },
    relatedLinks: [
      { label: "Create a new truck profile", href: "/restaurant-signup?businessType=food_truck&intent=create&source=for-food-trucks" },
      { label: "Claim your existing truck", href: "/claim-business?businessType=food_truck&claim=1&intent=claim&source=for-food-trucks" },
      { label: "See the host location guide", href: "/for-hosts" },
    ],
  },
  hosts: {
    path: "/for-hosts",
    title: "Host Food Trucks: Parking, Availability & Site Planning | MealScout",
    description: "Plan a food truck host location with clear dates, service windows, capacity, prices and site information. Explore published Parking Pass listings on MealScout.",
    headline: "Make your parking space clear for food trucks.",
    intro: "A truck needs to know whether your space fits its vehicle and service day. A useful host listing explains the address, access, dates, service windows, spot capacity and price before anyone makes a booking decision. Start with what your site can genuinely support.",
    sections: [
      {
        title: "Describe the space a food truck would actually use",
        paragraphs: [
          "Offices, retail sites, warehouses, churches, campuses and community lots can begin a host profile or partnership request. Having parking does not automatically make a site ready: confirm that you can offer the space and the access and hours a truck needs.",
          "Make the arrival route, usable area, service window and site instructions clear. State only the facilities you actually provide. Do not imply that electricity, water, seating or customer demand is included when it has not been established.",
        ],
      },
      {
        title: "Set availability and capacity you can keep current",
        paragraphs: [
          "Use the location's calendar, service windows, spot count and blackout dates to describe when the space can be used. Start with a schedule you can support; review dates again when your site's hours or other uses change.",
          "A weekly or monthly offering needs the same care as a single date. A recurring price is not a guarantee of bookings or income. Trucks need clear dates and site details, and you need to review the actual booking status in the host workspace.",
        ],
      },
      {
        title: "Make the next step clear for visiting trucks",
        paragraphs: [
          "Before publishing, review the location details, prices and any displayed transaction charges. Distinguish a published listing from a confirmed booking: a page view, contact attempt or date selection does not mean a truck has a reservation.",
          "Use the public Parking Pass board to see how current host listings present dates, service windows, spots and prices. Create your own host profile or use the partnership request for a non-food business with parking space. Neither route is a promise of approval, payout timing or a particular booking volume.",
        ],
      },
    ],
    examples: [
      { title: "Planning example: a lunchtime service window", copy: "Your site has space during a lunch period. Describe which part of the property a truck can use, when it can arrive and leave, and what access or cleanup instructions apply. Publish only the dates and capacity you can actually offer; this is a planning example, not a listed location." },
      { title: "Planning example: a repeat community service day", copy: "You would like a regular food truck day. Start with a repeatable window and keep the calendar accurate around other site uses. Review requests and booking statuses instead of assuming that publishing a recurring schedule guarantees demand." },
    ],
    questions: [
      { question: "Can a non-food business host food trucks?", answer: "Offices, retail sites, warehouses, churches, campuses and similar locations can start a host profile or partnership request. Confirm that you can offer suitable space and access before publishing. A request is not automatic approval or a guarantee of bookings." },
      { question: "What information should a host listing include?", answer: "Give trucks a clear location, arrival and access instructions, available dates, service windows, usable spot capacity and listed price. State any site rules and only the facilities you actually provide; do not leave a truck to infer utilities or vehicle fit." },
      { question: "How do I plan recurring food truck days?", answer: "Choose dates and service windows you can support, set the capacity and keep blackout dates current. Review each published date and the resulting booking status. Weekly or monthly options do not guarantee a booked calendar or a particular income." },
      { question: "Where can I see real host listing examples?", answer: "Use the live Parking Pass board to inspect currently published host locations, dates, service windows, spots and prices. Availability changes; those listings are examples of the current marketplace, not a promise that every area has a suitable opening." },
      { question: "When should I treat a truck as booked?", answer: "Check the actual booking status in the host workspace. Listing views, contact attempts and selected dates are not confirmation. Review the displayed charges and the applicable listing terms rather than assuming payment, cancellation or refund outcomes." },
    ],
    listingLink: { label: "See current published host listings", href: "/parking-pass" },
    relatedLinks: [
      { label: "Create a host profile", href: "/customer-signup?role=host" },
      { label: "Request a host location partnership", href: "/host-location-partner" },
      { label: "Read the food truck parking guide", href: "/for-food-trucks" },
    ],
  },
};
