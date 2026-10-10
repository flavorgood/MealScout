/**
 * Host Onboarding v1 - COPY LOCK
 * This file is the single source of truth for host onboarding user-facing text.
 * COPY MUST COME FROM this file.
 * DO NOT inline user-facing strings in components.
 * Changes here require product + legal review.
 */

export const HOST_ONBOARDING_COPY = {
  guestDraft: {
    title: "Design your food profile",
    description: "Start with your business details and see a private preview. You can edit before creating an account.",
    businessType: "Business type",
    businessTypes: { restaurant: "Restaurant", bar: "Bar", food_truck: "Food truck", caterer: "Caterer", private_chef: "Private chef" },
    name: "Business name",
    cuisine: "Food or cuisine",
    address: "Address",
    city: "City",
    state: "State",
    website: "Website or menu link",
    about: "About your business",
    previewTitle: "Private draft preview",
    namePlaceholder: "Your business name",
    aboutPlaceholder: "Describe your food, menu and what makes your business yours.",
    privacy: "This preview stays in this browser. It has not been published or sent to anyone.",
    keep: "Keep this draft",
    accountExplanation: "Create an account or sign in and verify your email to keep going. Your details will be here when you return.",
    accountTitle: "Keep your draft with an account",
    accountDescription: "Your design is saved in this browser. Verify your email, then review and submit your business details. Signing in does not publish your profile.",
    edit: "Back to my draft",
    storageErrorTitle: "Your draft could not be saved",
    storageErrorDescription: "Keep this page open and allow browser storage before continuing to an account.",
  },
  meta: {
    title: "Restaurant Sign Up - MealScout | Grow Your Business",
    description:
      "Join MealScout and reach more customers with targeted local deals. Restaurant owners can create promotional deals, attract new diners, and boost sales. Sign up for free today!",
    keywords:
      "restaurant signup, business registration, restaurant promotions, attract customers, boost restaurant sales, local marketing",
    canonicalUrl: "https://www.mealscout.us/restaurant-signup",
  },

  routePresentation: {
    restaurant: {
      metaTitle: "Restaurant Sign Up | MealScout",
      metaDescription:
        "Create your MealScout restaurant owner account, then publish your profile, menu, hours, and specials.",
      headerTitle: "MealScout for Restaurants",
      hero: {
        badge: "Restaurant owner account",
        title: "Set Up Your Restaurant",
        subtitle:
          "Create your owner login, then add the restaurant details local diners need to find and choose you.",
      },
      benefits: ["Local discovery", "Menus and specials", "Profile tools"],
      signupButton: "Create Restaurant Account",
      signupPending: "Creating Account...",
      loginButton: "Sign In to Restaurant Account",
      loginPending: "Signing In...",
    },
    foodTruck: {
      metaTitle: "Food Truck Sign Up | MealScout",
      metaDescription:
        "Create a MealScout food truck owner account, then publish or claim your truck profile, menu, schedule, and location.",
      headerTitle: "MealScout for Food Trucks",
      createHero: {
        badge: "Food truck owner account",
        title: "Create Your Food Truck Profile",
        subtitle:
          "Create your owner login, then add your truck, menu, schedule, and service details from one workspace.",
      },
      claimHero: {
        badge: "Food truck claim",
        title: "Create Your Account to Claim Your Truck",
        subtitle:
          "Your selected claim and truck details will stay with you through email verification or sign-in.",
      },
      benefits: ["Public truck profile", "Menu and schedule", "Live location tools"],
      signupButton: "Create Food Truck Account",
      signupPending: "Creating Account...",
      loginButton: "Sign In to Continue",
      loginPending: "Signing In...",
    },
  },

  unauth: {
    headerTitle: "MealScout for Businesses",
    hero: {
      badge: "Step 2 of 2 - Business account",
      title: "Set Up Your Restaurant or Food Truck",
      subtitle:
        "Connect your existing MealScout login, add your business details, and start reaching nearby diners who already use MealScout to find local deals.",
    },
    toggles: {
      signup: "Create Account",
      login: "Sign In",
    },
    oauth: {
      button: "Continue with Google",
    },
    divider: {
      or: "or",
    },
    signupCta: {
      buttonIdle: "Create Restaurant Account",
      buttonPending: "Creating Account...",
    },
    loginCta: {
      buttonIdle: "Sign In to Restaurant Account",
      buttonPending: "Signing In...",
    },
    forgotPassword: "Forgot your password?",
    finalCta: {
      title: "Ready to Get Started?",
      subtitle:
        "Join hundreds of restaurants already using MealScout to grow their business. Set up your first deal in minutes.",
      primaryButton: "Create Restaurant Account",
      secondaryButton: "Login to Existing Account",
    },
  },

  main: {
    backHeaderTitle: "Business Registration",
    authenticatedBanner: {
      title: "Signed in: add a business profile to this account",
      body: "You are creating an additional business profile on your existing account. No new account is created.",
      freeLine:
        "Complete profile: discovery, menus, schedules, deals, and profile tools are included.",
      paidLine:
        "The free trial has no expiration, requires no card, and never becomes a monthly bill.",
    },
    hero: {
      badge: "Business profile setup",
      prompt: "Choose your business type",
      restaurant: {
        label: "Restaurant",
        title: "Fill more tables with local diners",
        subtitle:
          "Promote your restaurant to nearby customers searching for a great meal right now.",
        description:
          "Ideal for dine-in, cafes, or quick-serve spots looking to boost traffic.",
      },
      foodTruck: {
        label: "Food Truck",
        title: "Grow your route and get discovered",
        subtitle:
          "Show up on the map, share your schedule, and connect with hungry fans on the go.",
        description:
          "Perfect for mobile kitchens that change locations throughout the week.",
      },
      bar: {
        label: "Bar",
        description:
          "Bars and nightlife venues can choose Restaurant and list deals too.",
      },
      action: "Continue as",
    },
  },

  benefits: {
    cards: {
      reachMore: {
        title: "Reach More Customers",
        body: "Target hungry customers within walking distance of your restaurant when they're actively looking for deals.",
        bullets: [
          "Hyper-local targeting",
          "Peak hunger times",
          "Mobile-first audience",
        ],
      },
      fillSlow: {
        title: "Fill Slow Periods",
        body: "Boost revenue during off-peak hours with targeted lunch and dinner deals that bring customers when you need them most.",
        bullets: [
          "Time-based targeting",
          "Flexible deal scheduling",
          "Revenue optimization",
        ],
      },
      trackPerformance: {
        title: "Track Performance",
        body: "Get detailed analytics on your deal performance and optimize your campaigns for maximum ROI and customer acquisition.",
        bullets: ["Real-time analytics", "Customer insights", "ROI tracking"],
      },
    },
    compact: {
      local: {
        title: "Hyper-Local Targeting",
        desc: "Reach workers and customers within a few blocks of your restaurant",
      },
      allDay: {
        title: "All-Day Service",
        desc: "Great deals throughout the day for busy customers",
      },
      track: {
        title: "Track Performance",
        desc: "See how your deals perform and optimize for better results",
      },
    },
  },

  pricing: {
    hero: {
      title: "Complete Profile Free Trial",
      coreLine:
        "Create your complete profile. The free trial does not expire or convert to a paid plan.",
      originalPrice: "",
      monthlyPrice: "No monthly bill",
      monthlySuffix: "",
      everythingIncludedTitle: "Everything included:",
      everythingIncludedBullets: [
        "Unlimited deals",
        "Edit deals anytime",
        "Performance analytics",
        "Customer targeting",
        "Real-time notifications",
        "Location-based promotion",
        "24/7 support",
        "No card required",
      ],
    },
    formCard: {
      title: "Complete Profile Setup",
      badge: "No card or monthly subscription required.",
      freeProfileLine:
        "Profiles stay active with discovery, menus, schedules, deals, and profile tools.",
      trialLine: "The free trial has no expiration date.",
      paidLine: "It never converts into a paid plan or monthly bill.",
      transactionDisclosure:
        "Separate paid orders, deliveries, bookings, or add-ons can have charges shown before payment.",
      originalPrice: "",
      monthlyPrice: "No monthly bill",
      monthlySuffix: "",
      unlimitedTitle: "Unlimited Deals",
      unlimitedBody: "Post as many deals as you want - no limits!",
      everythingIncludedTitle: "Everything included:",
      features: [
        "Unlimited active deals",
        "Random deal display in feeds",
        "Performance analytics",
        "Location-based promotion",
        "Real-time notifications",
        "No card required",
      ],
    },
  },

  promo: {
    helperText: "Enter a promo code if you have one...",
    betaNote: "Complete profile access does not require a promo code.",
  },

  terms: {
    labelPrefix: "I agree to the",
    termsText: "Terms of Service",
    andText: "and",
    privacyText: "Privacy Policy",
  },

  steps: {
    businessDetails: "Business Details",
    businessVerification: "Business Verification",
  },

  verification: {
    title: "Verify your business to unlock bookings",
    intro:
      "Your account is pending verification. Food-truck bookings stay locked until your business is verified, while your profile tools remain available during the free trial. Upload one or more documents below to start the review — most reviews complete within 1 business day.",
    pendingBanner:
      "Verification pending — parking pass bookings are locked until your business is approved.",
    claimRequiredNote:
      "Claims require verification. You can submit documents now to complete your request.",
    bullets: [
      "Filing documents (LLC/Corp/DBA articles or city license)",
      "EIN or tax registration documents",
      "Updated insurance or health department certificates",
    ],
    aiSetupTitle: "Next: finish with the AI you already use",
    aiSetupDescription:
      "Sign your favorite free or paid AI into MealScout, connect the social accounts you use, and let it prepare your profile, menus and prices, logos and photos, hours, schedules or events, deals, and matching social posts as one exact revision.",
    aiSetupSafety:
      "The AI can apply and publish only after the actual owner reviews and explicitly approves that exact revision in the AI chat or on MealScout. Manual setup tools remain available in the business workspace.",
    continueAiButton: "Continue to AI setup",
    whyVerify:
      "Verified businesses get a visible trust badge, priority placement on the map, and the ability to book parking pass spots.",
    backButton: "Back to Business Details",
    skipButton: "Skip — I'll verify later",
    submitIdle: "Submit for Review",
    submitPending: "Submitting...",
  },

  validation: {
    restaurant: {
      nameRequired: "Business name is required",
      addressRequired: "Address is required",
      phoneInvalid: "Valid phone number is required",
      businessTypeRequired: "Please select your business type",
      confirmNotFoodTruckRequired:
        "Confirm this is not a mobile food truck before continuing.",
      cuisineRequired: "Cuisine type is required",
      acceptTermsRequired: "You must accept the terms",
    },
    signup: {
      emailInvalid: "Valid email is required",
      firstNameRequired: "First name is required",
      lastNameRequired: "Last name is required",
      phoneInvalid: "Valid phone number is required",
      passwordTooShort:
        "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.",
      confirmPasswordRequired: "Please confirm your password",
      passwordsMismatch: "Passwords don't match",
    },
    login: {
      emailInvalid: "Valid email is required",
      passwordRequired: "Password is required",
    },
  },

  notifications: {
    signup: {
      successTitle: "Success!",
      successDescription: "Account created successfully!",
      errorTitle: "Signup Failed",
      errorDescription: "Failed to create account",
    },
    login: {
      successTitle: "Success!",
      successDescription: "Logged in successfully!",
      errorTitle: "Login Failed",
      errorDescription: "Invalid email or password",
    },
    restaurant: {
      successTitle: "Restaurant Registered!",
      successDescription:
        "Now let's verify your business to build trust with customers.",
      unauthorizedTitle: "Unauthorized",
      unauthorizedDescription: "You are logged out. Logging in again...",
      errorTitle: "Error",
      errorDescription: "Failed to register restaurant",
    },
    foodTruck: {
      successTitle: "Food Truck Profile Ready!",
      successDescription:
        "Your truck profile is linked to your owner account. Next, submit verification to build trust with customers.",
      unauthorizedTitle: "Sign In Required",
      unauthorizedDescription: "You are logged out. Sign in again to continue.",
      errorTitle: "Unable to Save Food Truck",
      errorDescription: "We couldn't save your food truck profile",
    },
    verification: {
      successTitle: "Verification Submitted!",
      successDescription:
        "Your documents have been submitted for review. You'll be notified of the decision.",
      errorTitle: "Submission Failed",
      errorDescription: "Failed to submit verification request",
      missingDocsTitle: "Documents Required",
      missingDocsDescription:
        "Please upload at least one business document for verification.",
      skippedTitle: "Verification Skipped",
      skippedDescription:
        "You can submit verification documents later from your dashboard.",
    },
    betaAccess: {
      title: "Profile Access Active!",
      description:
        "Your complete profile tools are active with no monthly charge.",
    },
  },

  forms: {
    signup: {
      firstNameLabel: "First Name",
      firstNamePlaceholder: "John",
      lastNameLabel: "Last Name",
      lastNamePlaceholder: "Doe",
      emailLabel: "Email",
      emailPlaceholder: "owner@example.com",
      phoneLabel: "Phone Number",
      phonePlaceholder: "(555) 123-4567",
      passwordLabel: "Password",
      passwordPlaceholder: "At least 8 characters with strong mix",
      confirmPasswordLabel: "Confirm Password",
      confirmPasswordPlaceholder: "Confirm your password",
    },
    login: {
      emailLabel: "Email",
      emailPlaceholder: "owner@example.com",
      passwordLabel: "Password",
      passwordPlaceholder: "Your password",
    },
    restaurant: {
      nameLabel: "Business Name",
      namePlaceholder: "Enter your business name",
      businessTypeLabel: "Business Type",
      businessTypePlaceholder: "Select your business type...",
      businessTypeHelp:
        "Food Truck is for mobile units. Restaurant/Bar is for fixed-location businesses.",
      stationaryConfirmLabel:
        "I confirm this is a fixed location (not a food truck).",
      stationaryWarning:
        "If this business moves locations, select Food Truck instead.",
      addressLabel: "Business Address",
      addressPlaceholder: "123 Main Street, Chicago, IL",
      cityLabel: "City",
      cityPlaceholder: "Chicago",
      stateLabel: "State",
      statePlaceholder: "IL",
      phoneLabel: "Phone",
      phonePlaceholder: "(555) 123-4567",
      claimTitle: "Claim an Existing Food Truck",
      claimDescription:
        "If your truck is already listed from a government registry, claim it and verify ownership.",
      claimSearchLabel: "Search by license ID or truck name",
      claimSearchPlaceholder: "Start typing your license ID or truck name",
      claimSearchButton: "Find My Truck",
      claimSelectButton: "Use This Truck",
      claimSelectedLabel: "Selected listing",
      claimClearButton: "Clear Selection",
      claimNoResults:
        "No matching registry listing was found. Use the missing-truck option or switch to creating a new profile.",
      claimSelectionRequiredTitle: "Select your truck first",
      claimSelectionRequiredDescription:
        "Choose the matching registry listing before submitting this claim.",
      claimCreateInstead:
        "This is a brand-new truck? Switch to the create-profile path.",
      claimMissingTitle: "Truck not in the registry",
      claimMissingDescription:
        "Review the details we prefilled, then submit to create the owner-linked profile for this missing listing.",
      claimRegistryCheckTitle: "Check the registry first",
      claimRegistryCheckDescription:
        "Wait for the registry search to finish before submitting this missing-truck profile.",
      claimRegistryMatchTitle: "Use the matching registry listing",
      claimRegistryMatchDescription:
        "A matching registry listing exists. Claim that listing instead of creating a duplicate profile.",
      claimMissingNoResults:
        "No registry match was found. You can continue with the prefilled missing-truck profile.",
      claimUnavailable:
        "That selected listing is no longer available to claim. Search again or contact MealScout support.",
      claimDisclaimer:
        "Claiming requires verification documents that match your license or insurance.",
      cuisineLabel: "Cuisine Type",
      cuisinePlaceholder: "Select cuisine type...",
      promoLabel: "Promo Code",
      promoOptionalSuffix: "(Optional)",
      websiteImportButton: "Fill in from website",
      websiteImportButtonPending: "Reading site...",
      websiteImportHelp:
        "We'll pull in your name, description, and social links so you don't have to retype them.",
      websiteImportLeadTitle: "Have a website? Autofill your business details",
      websiteImportLeadHelp:
        "Paste your website link and we'll pull in your name, address, phone, and social links. We'll add them to your profile right after you create your account.",
      websiteImportCapturedPrefix: "Captured from your site:",
      websiteImportCapturedSuffix:
        "We'll fill these into your profile after you sign up.",
    },
  },

  cta: {
    restaurantSubmit: {
      idle: "Create Free Profile",
      pending: "Creating...",
    },
  },
} as const;

export type HostOnboardingCopy = typeof HOST_ONBOARDING_COPY;
export type HostCopyKey =
  | "pricing.hero.originalPrice"
  | "pricing.hero.monthlyPrice"
  | "pricing.formCard.originalPrice"
  | "pricing.formCard.monthlyPrice"
  | "terms.labelPrefix"
  | "terms.termsText"
  | "terms.privacyText"
  | "validation.restaurant.nameRequired"
  | "validation.restaurant.addressRequired"
  | "validation.restaurant.phoneInvalid"
  | "validation.signup.emailInvalid"
  | "validation.signup.passwordTooShort"
  | "validation.login.emailInvalid"
  | "validation.login.passwordRequired"
  | "notifications.signup.successTitle"
  | "notifications.signup.errorTitle"
  | "notifications.restaurant.successTitle"
  | "notifications.verification.successTitle"
  | "notifications.verification.errorTitle";
