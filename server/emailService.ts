import {
  TransactionalEmailsApi,
  TransactionalEmailsApiApiKeys,
} from "@getbrevo/brevo";
import crypto from "crypto";
import type { User, Restaurant } from "@shared/schema";
import {
  areAutomatedMarketingEmailsEnabled,
  describeMarketingEmailWindow,
  describeAutomatedMarketingEmailFlag,
  isWithinMarketingEmailWindow,
} from "./utils/marketingEmailWindow";

// Initialize Brevo with API key validation
const transactionalEmailsApi = new TransactionalEmailsApi();

type EmailAttemptStatus = "sent" | "failed" | "skipped";
type EmailAttempt = {
  id: string;
  createdAt: string;
  to: string;
  subject: string;
  category: "account" | "general" | "marketing";
  status: EmailAttemptStatus;
  skipReason?:
    | "mode_filtered"
    | "mode_disabled"
    | "marketing_disabled"
    | "provider_not_configured"
    | "outside_marketing_window";
  error?: string;
  providerStatusCode?: number;
  providerErrorCode?: string;
  provider: "brevo";
  fromEmail: string;
  mode: string;
};

class EmailDeliveryAudit {
  private attempts: EmailAttempt[] = [];
  private maxItems = 200;

  add(attempt: EmailAttempt) {
    this.attempts.unshift(attempt);
    if (this.attempts.length > this.maxItems) {
      this.attempts.length = this.maxItems;
    }
  }

  list(limit = 50): EmailAttempt[] {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.attempts.slice(0, safeLimit);
  }

  latest(): EmailAttempt | null {
    return this.attempts[0] || null;
  }
}

export const emailDeliveryAudit = new EmailDeliveryAudit();

// Check if Brevo is properly configured
export const isEmailConfigured = (): boolean => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn(
      "BREVO_API_KEY environment variable is not set. Email functionality will be disabled.",
    );
    return false;
  }

  try {
    transactionalEmailsApi.setApiKey(
      TransactionalEmailsApiApiKeys.apiKey,
      apiKey,
    );
    return true;
  } catch (error) {
    console.error("Failed to configure Brevo:", error);
    return false;
  }
};

export const getEmailConfigSummary = () => {
  const mode = process.env.EMAIL_NOTIFICATIONS_MODE || "all";
  const missing: string[] = [];
  if (!process.env.BREVO_API_KEY) missing.push("BREVO_API_KEY");
  if (!process.env.EMAIL_FROM && !process.env.ADMIN_EMAIL) {
    missing.push("EMAIL_FROM (or ADMIN_EMAIL)");
  }
  if (!process.env.PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");

  const configured = isEmailConfigured();
  const disabled = ["off", "disabled", "none"].includes(String(mode).toLowerCase());
  return {
    configured,
    provider: "brevo" as const,
    mode,
    disabled,
    automatedMarketingEmailsEnabled: areAutomatedMarketingEmailsEnabled(),
    missing,
    fromEmail: EMAIL_CONFIG.fromEmail,
    fromName: EMAIL_CONFIG.fromName,
    adminEmail: EMAIL_CONFIG.adminEmail,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:5000",
  };
};

// Email configuration
const EMAIL_CONFIG = {
  fromEmail:
    process.env.EMAIL_FROM ||
    process.env.ADMIN_EMAIL ||
    "info.mealscout@gmail.com",
  fromName: process.env.EMAIL_FROM_NAME || "MealScout",
  adminEmail:
    process.env.ADMIN_EMAIL ||
    process.env.EMAIL_FROM ||
    "info.mealscout@gmail.com", // Admin notifications will be sent here
};

// Base email interface
interface BaseEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  category?: "account" | "general" | "marketing";
  attachments?: Array<{
    content: string;
    name: string;
  }>;
}

interface ParkingPassCompletionReminderParams {
  email: string;
  businessName?: string;
  address?: string;
}

interface BookingConfirmationParams {
  to: string;
  hostName: string;
  startDate: string;
  endDate: string;
  slotSummary?: string;
  totalCents: number;
}

interface ProfileActivitySummaryEmailData {
  weekStart: string;
  weekEnd: string;
  stopsCovered: number;
  liveLocationActivations: number;
  manualScheduleUsage: number;
  parkingReportsCompleted: number;
  period?: "week" | "month";
}

// Email templates
class EmailTemplates {
  public static getUserTypeDisplay(userType?: string | null): string {
    const labels: Record<string, string> = {
      customer: "Customer",
      restaurant_owner: "Restaurant Owner",
      food_truck: "Food Truck",
      caterer: "Caterer",
      private_chef: "Private Chef",
      host: "Parking Pass Host",
      event_coordinator: "Event Organizer",
      supplier: "Supplier",
      staff: "Staff",
      admin: "Admin",
      duper_admin: "Duperrr Admin",
      super_admin: "Super Admin",
    };
    return labels[String(userType || "").trim()] || "Customer";
  }

  public static getBaseTemplate(title: string, content: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            background-color: #f8f9fa;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }
        .header {
            background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
            color: white;
            padding: 30px 40px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: bold;
        }
        .header .tagline {
            margin: 8px 0 0 0;
            font-size: 16px;
            opacity: 0.9;
        }
        .content {
            padding: 40px;
        }
        .content h2 {
            color: #ff6b35;
            font-size: 24px;
            margin: 0 0 20px 0;
        }
        .content p {
            margin: 0 0 16px 0;
            font-size: 16px;
            line-height: 1.6;
        }
        .highlight-box {
            background-color: #fff8f5;
            border-left: 4px solid #ff6b35;
            padding: 20px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .features {
            margin: 30px 0;
        }
        .feature {
            display: flex;
            align-items: flex-start;
            margin-bottom: 16px;
            padding: 12px 0;
        }
        .feature-icon {
            background-color: #ff6b35;
            color: white;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            margin-right: 16px;
            flex-shrink: 0;
        }
        .feature-text {
            flex: 1;
        }
        .feature-title {
            font-weight: 600;
            color: #333;
            margin-bottom: 4px;
        }
        .feature-desc {
            color: #666;
            font-size: 14px;
        }
        .cta-button {
            display: inline-block;
            background: linear-gradient(135deg, #ff6b35 0%, #f7931e 100%);
            color: white;
            padding: 14px 32px;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            margin: 20px 0;
            text-align: center;
        }
        .footer {
            background-color: #f8f9fa;
            padding: 30px 40px;
            text-align: center;
            border-top: 1px solid #e9ecef;
        }
        .footer p {
            margin: 0;
            font-size: 14px;
            color: #666;
        }
        .footer .social-links {
            margin: 20px 0 10px 0;
        }
        .footer .social-links a {
            color: #ff6b35;
            text-decoration: none;
            margin: 0 8px;
            font-size: 14px;
        }
        @media (max-width: 600px) {
            .container {
                margin: 0;
                border-radius: 0;
            }
            .header, .content, .footer {
                padding: 20px;
            }
            .header h1 {
                font-size: 24px;
            }
            .content h2 {
                font-size: 20px;
            }
            .feature {
                flex-direction: column;
                align-items: flex-start;
            }
            .feature-icon {
                margin-bottom: 8px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🍽️ MealScout</h1>
            <div class="tagline">Discover Amazing Food Deals</div>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <div class="social-links">
                <a href="#" target="_blank">Facebook</a>
                <a href="#" target="_blank">Instagram</a>
                <a href="#" target="_blank">Twitter</a>
            </div>
            <p>© 2025 MealScout. All rights reserved.</p>
            <p>This email was sent to you because you signed up for MealScout.</p>
        </div>
    </div>
</body>
</html>`;
  }

  static getVerificationBlock(verifyUrl: string): {
    html: string;
    text: string;
  } {
    return {
      html: `
        <div class="highlight-box">
          <strong>Verify your email</strong><br>
          Please confirm your email to activate your account.
          <p style="margin: 16px 0;">
            <a href="${verifyUrl}" style="background: #f97316; color: #fff; text-decoration: none; padding: 12px 16px; border-radius: 8px; display: inline-block;">
              Verify Email
            </a>
          </p>
          <p style="word-break: break-all; color: #f97316;">${verifyUrl}</p>
        </div>
      `,
      text: `Verify your email to activate your account: ${verifyUrl}`,
    };
  }

  static getCustomerWelcomeTemplate(user: User, verifyUrl?: string): {
    html: string;
    text: string;
  } {
    const verification = verifyUrl
      ? this.getVerificationBlock(verifyUrl)
      : null;
    const content = `
      <h2>Welcome to Your Food Adventure! 🎉</h2>
      <p>Hey ${user.firstName || "Food Explorer"}!</p>
      ${verification ? verification.html : ""}
      <p>Welcome to MealScout – your personal guide to discovering incredible food deals around you! We're thrilled to have you join our community of savvy food lovers.</p>

      <div class="highlight-box">
        <strong>🎯 What makes MealScout special?</strong><br>
        We connect you with exclusive deals from local restaurants, food trucks, and cafes that you won't find anywhere else!
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">🔥</div>
          <div class="feature-text">
            <div class="feature-title">Exclusive Deals</div>
            <div class="feature-desc">Access restaurant deals up to 50% off your favorite meals</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">📍</div>
          <div class="feature-text">
            <div class="feature-title">Location-Based Discovery</div>
            <div class="feature-desc">Find amazing food deals right in your neighborhood</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">🚚</div>
          <div class="feature-text">
            <div class="feature-title">Food Truck Tracker</div>
            <div class="feature-desc">Never miss your favorite food truck with real-time location updates</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">⭐</div>
          <div class="feature-text">
            <div class="feature-title">Personalized Recommendations</div>
            <div class="feature-desc">Discover new restaurants based on your preferences and reviews</div>
          </div>
        </div>
      </div>

      <p><strong>Ready to start saving?</strong> Open the MealScout app and start exploring delicious deals in your area. Your taste buds (and wallet) will thank you!</p>

      <p>Happy eating!<br>
      The MealScout Team 🍽️</p>
    `;

    const html = this.getBaseTemplate("Welcome to MealScout!", content);
    const text = `Welcome to MealScout, ${user.firstName || "Food Explorer"}!
${verification ? `\n${verification.text}\n` : ""}

We're thrilled to have you join our community of savvy food lovers. MealScout connects you with exclusive deals from local restaurants, food trucks, and cafes.

What you can expect:
• Exclusive deals up to 50% off your favorite meals
• Location-based discovery of nearby food deals
• Real-time food truck tracking
• Personalized restaurant recommendations

Ready to start saving? Open the MealScout app and start exploring delicious deals in your area.

Happy eating!
The MealScout Team

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getRestaurantOwnerWelcomeTemplate(user: User, verifyUrl?: string): {
    html: string;
    text: string;
  } {
    const verification = verifyUrl
      ? this.getVerificationBlock(verifyUrl)
      : null;
    const content = `
      <h2>Welcome to MealScout Business! 🚀</h2>
      <p>Hello ${user.firstName || "Business Owner"}!</p>
      ${verification ? verification.html : ""}
      <p>Congratulations on joining MealScout! You're now part of a powerful platform that connects local restaurants with hungry customers looking for amazing deals.</p>

      <div class="highlight-box">
        <strong>🎯 Grow Your Business with MealScout</strong><br>
        Our platform helps you attract new customers, fill empty tables during slow hours, and boost your revenue with strategic deal campaigns.
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">📈</div>
          <div class="feature-text">
            <div class="feature-title">Increase Revenue</div>
            <div class="feature-desc">Create targeted deals to drive sales during slow periods and attract new customers</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">🎯</div>
          <div class="feature-text">
            <div class="feature-title">Smart Deal Management</div>
            <div class="feature-desc">Set time limits, usage limits, and track performance with detailed analytics</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">👥</div>
          <div class="feature-text">
            <div class="feature-title">Customer Discovery</div>
            <div class="feature-desc">Reach food lovers in your area who are actively looking for great deals</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">📊</div>
          <div class="feature-text">
            <div class="feature-title">Performance Analytics</div>
            <div class="feature-desc">Track deal performance, customer engagement, and ROI with detailed insights</div>
          </div>
        </div>
      </div>

      <p><strong>Next Steps:</strong></p>
      <p>1. Complete your restaurant profile with photos and details<br>
      2. Create your first deal to attract customers<br>
      3. Monitor performance and optimize your campaigns</p>

      <p>Our support team is here to help you succeed. If you have any questions, don't hesitate to reach out!</p>

      <p>Here's to your business growth!<br>
      The MealScout Business Team 💼</p>
    `;

    const html = this.getBaseTemplate(
      "Welcome to MealScout Business!",
      content,
    );
    const text = `Welcome to MealScout Business, ${user.firstName || "Business Owner"}!
${verification ? `\n${verification.text}\n` : ""}

Congratulations on joining MealScout! You're now part of a powerful platform that connects local restaurants with hungry customers.

What MealScout Business offers:
• Increase revenue with strategic deal campaigns
• Smart deal management with limits and analytics
• Reach customers actively looking for deals
• Performance analytics and insights

Next Steps:
1. Complete your restaurant profile with photos and details
2. Create your first deal to attract customers
3. Monitor performance and optimize your campaigns

Our support team is here to help you succeed!

Here's to your business growth!
The MealScout Business Team

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getAdminWelcomeTemplate(
    user: User,
    verifyUrl?: string,
  ): { html: string; text: string } {
    const verification = verifyUrl
      ? this.getVerificationBlock(verifyUrl)
      : null;
    const content = `
      <h2>Admin Access Granted 🔐</h2>
      <p>Hello ${user.firstName || "Admin"}!</p>
      ${verification ? verification.html : ""}
      <p>Your MealScout admin account has been created successfully. You now have access to the administrative dashboard and all management features.</p>

      <div class="highlight-box">
        <strong>🛠️ Admin Capabilities</strong><br>
        Monitor platform activity, manage users and restaurants, review verification requests, and oversee system operations.
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">👥</div>
          <div class="feature-text">
            <div class="feature-title">User Management</div>
            <div class="feature-desc">Manage customer and restaurant owner accounts</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">🏪</div>
          <div class="feature-text">
            <div class="feature-title">Restaurant Oversight</div>
            <div class="feature-desc">Review verification requests and manage restaurant listings</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">📊</div>
          <div class="feature-text">
            <div class="feature-title">Platform Analytics</div>
            <div class="feature-desc">Monitor platform performance, user engagement, and system health</div>
          </div>
        </div>
      </div>

      <p>Access your admin dashboard to get started with platform management.</p>

      <p>Best regards,<br>
      The MealScout Development Team ⚙️</p>
    `;

    const html = this.getBaseTemplate("MealScout Admin Access", content);
    const text = `MealScout Admin Access Granted

${verification ? `${verification.text}\n` : ""}

Hello ${user.firstName || "Admin"}!

Your MealScout admin account has been created successfully. You now have access to the administrative dashboard and all management features.

Admin Capabilities:
• User management for customers and restaurant owners
• Restaurant oversight and verification requests
• Platform analytics and system monitoring

Access your admin dashboard to get started.

Best regards,
The MealScout Development Team

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getAdminNotificationTemplate(
    user: User,
    restaurant?: Restaurant,
  ): { html: string; text: string } {
    const userTypeDisplay = EmailTemplates.getUserTypeDisplay(user.userType);

    let locationInfo = "";
    if (restaurant) {
      locationInfo = `
        <strong>Restaurant Details:</strong><br>
        Name: ${restaurant.name}<br>
        Address: ${restaurant.address}<br>
        Phone: ${restaurant.phone || "Not provided"}<br>
        Business Type: ${restaurant.businessType}<br>
        Cuisine: ${restaurant.cuisineType || "Not specified"}<br>
        ${restaurant.isFoodTruck ? "Food Truck: Yes" : ""}
      `;
    }

    const content = `
      <h2>New User Registration Alert 🔔</h2>
      <p>A new user has joined MealScout!</p>

      <div class="highlight-box">
        <strong>User Information:</strong><br>
        Name: ${user.firstName || ""} ${user.lastName || ""}<br>
        Email: ${user.email}<br>
        Phone: ${user.phone || "Not provided"}<br>
        User Type: ${userTypeDisplay}<br>
        Registration Date: ${new Date().toLocaleDateString()}<br>
        ${locationInfo}
      </div>

      <p>This notification was generated automatically by the MealScout system.</p>
    `;

    const html = this.getBaseTemplate(
      "New User Registration - MealScout Admin",
      content,
    );
    const text = `New User Registration Alert

A new user has joined MealScout!

User Information:
Name: ${user.firstName || ""} ${user.lastName || ""}
Email: ${user.email}
User Type: ${userTypeDisplay}
Registration Date: ${new Date().toLocaleDateString()}

${
  restaurant
    ? `Restaurant Details:
Name: ${restaurant.name}
Address: ${restaurant.address}
Phone: ${restaurant.phone || "Not provided"}
Business Type: ${restaurant.businessType}
Cuisine: ${restaurant.cuisineType || "Not specified"}
${restaurant.isFoodTruck ? "Food Truck: Yes" : ""}`
    : ""
}

This notification was generated automatically by the MealScout system.

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getAdminSignupNotificationTemplate(
    user: User,
    context?: { signupMethod?: string; restaurant?: Restaurant },
  ): { html: string; text: string } {
    const userTypeDisplay = EmailTemplates.getUserTypeDisplay(user.userType);
    const signupMethod = context?.signupMethod || "Email";

    let restaurantInfo = "";
    if (context?.restaurant) {
      restaurantInfo = `
        <div class="feature">
          <div class="feature-icon">🏪</div>
          <div class="feature-text">
            <div class="feature-title">Restaurant Information</div>
            <div class="feature-desc">
              <strong>Name:</strong> ${context.restaurant.name}<br>
              <strong>Address:</strong> ${context.restaurant.address}<br>
              <strong>Phone:</strong> ${context.restaurant.phone || "Not provided"}<br>
              <strong>Business Type:</strong> ${context.restaurant.businessType}<br>
              <strong>Cuisine Type:</strong> ${context.restaurant.cuisineType || "Not specified"}<br>
              ${context.restaurant.isFoodTruck ? "<strong>Food Truck:</strong> Yes<br>" : ""}
              <strong>Verified:</strong> ${context.restaurant.isVerified ? "Yes" : "Pending"}
            </div>
          </div>
        </div>
      `;
    }

    const content = `
      <h2>New MealScout Signup 🎉</h2>
      <p>A new user has registered for MealScout and requires admin attention.</p>

      <div class="highlight-box">
        <strong>📋 User Summary</strong><br>
        <strong>Name:</strong> ${user.firstName || ""} ${user.lastName || ""}<br>
        <strong>Email:</strong> ${user.email}<br>
        <strong>Phone:</strong> ${user.phone || "Not provided"}<br>
        <strong>User Type:</strong> ${userTypeDisplay}<br>
        <strong>Signup Method:</strong> ${signupMethod}<br>
        <strong>Registration Date:</strong> ${new Date().toLocaleDateString()}
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">👤</div>
          <div class="feature-text">
            <div class="feature-title">Account Details</div>
            <div class="feature-desc">
              <strong>User ID:</strong> ${user.id || "Pending"}<br>
              <strong>Account Status:</strong> Active<br>
              <strong>Email Verified:</strong> ${user.emailVerified ? "Yes" : "Pending"}
            </div>
          </div>
        </div>
        ${restaurantInfo}
      </div>

      ${
        user.userType === "restaurant_owner"
          ? `
        <div class="highlight-box" style="border-left-color: #f7931e;">
          <strong>⚠️ Action Required</strong><br>
          This restaurant owner account may require verification review before full platform access is granted.
        </div>
      `
          : ""
      }

      <p>You can manage this user account through the MealScout admin dashboard.</p>

      <p>For questions or support, contact our development team.<br>
      <strong>MealScout Admin System</strong> 🛠️</p>
    `;

    const html = this.getBaseTemplate("New MealScout Signup", content);
    const text = `New MealScout Signup

A new user has registered for MealScout:

User Information:
Name: ${user.firstName || ""} ${user.lastName || ""}
Email: ${user.email}
Phone: ${user.phone || "Not provided"}
User Type: ${userTypeDisplay}
Signup Method: ${signupMethod}
Registration Date: ${new Date().toLocaleDateString()}
User ID: ${user.id || "Pending"}
Account Status: Active
Email Verified: ${user.emailVerified ? "Yes" : "Pending"}

${
  context?.restaurant
    ? `Restaurant Details:
Name: ${context.restaurant.name}
Address: ${context.restaurant.address}
Phone: ${context.restaurant.phone || "Not provided"}
Business Type: ${context.restaurant.businessType}
Cuisine Type: ${context.restaurant.cuisineType || "Not specified"}
${context.restaurant.isFoodTruck ? "Food Truck: Yes" : ""}
Verified: ${context.restaurant.isVerified ? "Yes" : "Pending"}`
    : ""
}

${user.userType === "restaurant_owner" ? "ACTION REQUIRED: This restaurant owner account may require verification review." : ""}

You can manage this user account through the MealScout admin dashboard.

MealScout Admin System

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getPasswordResetTemplate(
    user: User,
    resetUrl: string,
  ): { html: string; text: string } {
    const content = `
      <h2>Reset Your MealScout Password 🔐</h2>
      <p>Hello ${user.firstName || "MealScout User"}!</p>
      <p>We received a request to reset the password for your MealScout account. If you made this request, click the button below to create a new password.</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" class="cta-button" style="display: inline-block;">Reset My Password</a>
      </div>

      <div class="highlight-box">
        <strong>🛡️ Security Information</strong><br>
        • This password reset link is valid for <strong>1 hour</strong><br>
        • The link can only be used once<br>
        • If you didn't request this reset, you can safely ignore this email<br>
        • Your current password will remain unchanged until you create a new one
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">⚠️</div>
          <div class="feature-text">
            <div class="feature-title">Didn't Request This?</div>
            <div class="feature-desc">If you didn't request a password reset, please ignore this email. Your account remains secure.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">🔒</div>
          <div class="feature-text">
            <div class="feature-title">Keep Your Account Secure</div>
            <div class="feature-desc">Choose a strong password with at least 8 characters, including numbers and special characters.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">❓</div>
          <div class="feature-text">
            <div class="feature-title">Need Help?</div>
            <div class="feature-desc">If you're having trouble accessing your account, contact our support team at info.mealscout@gmail.com</div>
          </div>
        </div>
      </div>

      <p><strong>Can't click the button?</strong> Copy and paste this link into your browser:<br>
      <span style="word-break: break-all; color: #ff6b35; font-size: 14px;">${resetUrl}</span></p>

      <p>Best regards,<br>
      The MealScout Security Team 🔐</p>
    `;

    const html = this.getBaseTemplate("Reset Your MealScout Password", content);
    const text = `Reset Your MealScout Password

Hello ${user.firstName || "MealScout User"}!

We received a request to reset the password for your MealScout account. If you made this request, use the link below to create a new password.

Reset Link: ${resetUrl}

Security Information:
• This password reset link is valid for 1 hour
• The link can only be used once
• If you didn't request this reset, you can safely ignore this email
• Your current password will remain unchanged until you create a new one

Didn't Request This?
If you didn't request a password reset, please ignore this email. Your account remains secure.

Keep Your Account Secure:
Choose a strong password with at least 8 characters, including numbers and special characters.

Need Help?
If you're having trouble accessing your account, contact our support team at info.mealscout@gmail.com

Best regards,
The MealScout Security Team

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getAccountSetupTemplate(
    user: User,
    setupUrl: string,
    createdByName?: string,
  ): { html: string; text: string } {
    const greeting = user.firstName || user.email?.split("@")[0] || "there";
    const createdByText = createdByName ? ` by ${createdByName}` : "";

    const content = `
      <h2>Welcome to MealScout! 🎉</h2>
      <p>Hello ${greeting}!</p>
      <p>Your MealScout account has been created${createdByText}. Let's get you set up! Click the button below to complete your profile:</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${setupUrl}" class="cta-button" style="display: inline-block;">Complete My Profile</a>
      </div>

      <div class="highlight-box">
        <strong>📝 What's Next?</strong><br>
        • Create your password (minimum 8 characters)<br>
        • Upload a profile picture (optional)<br>
        • Start exploring exclusive food deals in your area!
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">🎟️</div>
          <div class="feature-text">
            <div class="feature-title">Exclusive Deals</div>
            <div class="feature-desc">Access special offers from local restaurants and food trucks.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">⭐</div>
          <div class="feature-text">
            <div class="feature-title">Save Favorites</div>
            <div class="feature-desc">Keep track of your favorite spots and never miss a deal.</div>
          </div>
        </div>
        <div class="feature">
          <div class="feature-icon">🗺️</div>
          <div class="feature-text">
            <div class="feature-title">Find Food Trucks</div>
            <div class="feature-desc">Discover where your favorite food trucks are parked today.</div>
          </div>
        </div>
      </div>

      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #666;">
          <strong>⏰ This setup link expires in 7 days</strong> for your security.
          If you need a new link, contact our support team at info.mealscout@gmail.com
        </p>
      </div>

      <p><strong>Can't click the button?</strong> Copy and paste this link into your browser:<br>
      <span style="word-break: break-all; color: #ff6b35; font-size: 14px;">${setupUrl}</span></p>

      <p>Looking forward to helping you discover amazing food!<br>
      The MealScout Team 🍔🌮🍕</p>
    `;

    const html = this.getBaseTemplate("Welcome to MealScout!", content);
    const text = `Welcome to MealScout!

Hello ${greeting}!

Your MealScout account has been created${createdByText}. Let's get you set up!

Complete your profile here: ${setupUrl}

What's Next:
• Create your password (minimum 8 characters)
• Upload a profile picture (optional)
• Start exploring exclusive food deals in your area!

Why You'll Love MealScout:
🎟️ Exclusive Deals - Access special offers from local restaurants and food trucks
⭐ Save Favorites - Keep track of your favorite spots and never miss a deal
🗺️ Find Food Trucks - Discover where your favorite food trucks are parked today

⏰ This setup link expires in 7 days for your security. If you need a new link, contact our support team at info.mealscout@gmail.com

Can't click the link? Copy and paste this into your browser:
${setupUrl}

Looking forward to helping you discover amazing food!
The MealScout Team

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }

  static getBugReportTemplate(data: {
    userEmail?: string;
    userName?: string;
    userAgent: string;
    currentUrl: string;
    timestamp: string;
    screenshotUrl?: string;
  }): { html: string; text: string } {
    const userName = data.userName || "Anonymous User";
    const userEmail = data.userEmail || "Not logged in";

    const content = `
      <h2>🐛 Bug Report Received</h2>
      <p>A bug report has been submitted from the MealScout beta application.</p>

      <div class="highlight-box">
        <strong>📋 Report Details</strong><br>
        <strong>Submitted by:</strong> ${userName}<br>
        <strong>Email:</strong> ${userEmail}<br>
        <strong>Timestamp:</strong> ${data.timestamp}<br>
        <strong>Page URL:</strong> ${data.currentUrl}
      </div>

      <div class="features">
        <div class="feature">
          <div class="feature-icon">🌐</div>
          <div class="feature-text">
            <div class="feature-title">Browser Information</div>
            <div class="feature-desc">${data.userAgent}</div>
          </div>
        </div>
        ${
          data.screenshotUrl
            ? `
        <div class="feature">
          <div class="feature-icon">📸</div>
          <div class="feature-text">
            <div class="feature-title">Screenshot Captured</div>
            <div class="feature-desc">A screenshot has been attached to this report showing the page state when the bug was reported.</div>
          </div>
        </div>
        `
            : ""
        }
      </div>

      ${
        data.screenshotUrl
          ? `
      <div class="highlight-box" style="border-left-color: #10b981;">
        <strong>📎 Screenshot Attached</strong><br>
        A screenshot of the page has been attached to this email as "bug-report-screenshot.png"
      </div>
      `
          : ""
      }

      <p>This report was automatically generated by the MealScout beta bug reporting system.</p>

      <p>Best regards,<br>
      MealScout Beta Bug Reporting System 🔧</p>
    `;

    const html = this.getBaseTemplate("Bug Report - MealScout Beta", content);
    const text = `Bug Report - MealScout Beta

A bug report has been submitted from the MealScout beta application.

Report Details:
Submitted by: ${userName}
Email: ${userEmail}
Timestamp: ${data.timestamp}
Page URL: ${data.currentUrl}

Browser Information:
${data.userAgent}

${data.screenshotUrl ? "Screenshot: Attached to this email" : "No screenshot attached"}

This report was automatically generated by the MealScout beta bug reporting system.

Best regards,
MealScout Beta Bug Reporting System

© 2025 MealScout. All rights reserved.`;

    return { html, text };
  }
}

// Email service class
export class EmailService {
  private static instance: EmailService;
  private isConfigured: boolean;

  private constructor() {
    this.isConfigured = isEmailConfigured();
  }

  static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }

  private async sendEmail(params: BaseEmailParams): Promise<boolean> {
    const notificationMode = process.env.EMAIL_NOTIFICATIONS_MODE || "all";
    const disabled = ["off", "disabled", "none"].includes(
      String(notificationMode).toLowerCase(),
    );
    if (disabled) {
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: params.category || "general",
        status: "skipped",
        skipReason: "mode_disabled",
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return false;
    }
    if (notificationMode === "account_only" && params.category !== "account") {
      console.warn(
        `Email skipped for ${params.to}: ${params.subject} (category: ${params.category || "general"})`,
      );
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: params.category || "general",
        status: "skipped",
        skipReason: "mode_filtered",
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return false;
    }
    if (
      (params.category || "general") === "marketing" &&
      !areAutomatedMarketingEmailsEnabled()
    ) {
      console.log(
        `Marketing email skipped for ${params.to}: ${params.subject} (${describeAutomatedMarketingEmailFlag()} set)`,
      );
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: "marketing",
        status: "skipped",
        skipReason: "marketing_disabled",
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return false;
    }
    if (
      (params.category || "general") === "marketing" &&
      !isWithinMarketingEmailWindow()
    ) {
      console.log(
        `Email skipped for ${params.to}: ${params.subject} (outside marketing window ${describeMarketingEmailWindow()})`,
      );
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: "marketing",
        status: "skipped",
        skipReason: "outside_marketing_window",
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return false;
    }

    // If env vars were updated after boot, re-check config on demand.
    if (!this.isConfigured) {
      this.isConfigured = isEmailConfigured();
    }

    if (!this.isConfigured) {
      console.warn(
        `Email not sent to ${params.to}: provider not configured (missing BREVO_API_KEY).`,
      );
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: params.category || "general",
        status: "skipped",
        skipReason: "provider_not_configured",
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return false;
    }

    try {
      const emailData: any = {
        to: [
          {
            email: params.to,
          },
        ],
        sender: {
          email: EMAIL_CONFIG.fromEmail,
          name: EMAIL_CONFIG.fromName,
        },
        subject: params.subject,
        htmlContent: params.html,
        textContent: params.text,
      };

      // Add attachments if provided
      if (params.attachments && params.attachments.length > 0) {
        emailData.attachment = params.attachments;
      }

      await transactionalEmailsApi.sendTransacEmail(emailData);

      console.log(`Email sent successfully to ${params.to}: ${params.subject}`);
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: params.category || "general",
        status: "sent",
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return true;
    } catch (error) {
      console.error(`Failed to send email to ${params.to}:`, error);
      const anyError: any = error as any;
      const providerStatusCode =
        typeof anyError?.status === "number"
          ? anyError.status
          : typeof anyError?.response?.status === "number"
            ? anyError.response.status
            : typeof anyError?.response?.res?.statusCode === "number"
              ? anyError.response.res.statusCode
              : undefined;
      const providerErrorCode =
        typeof anyError?.code === "string"
          ? anyError.code
          : typeof anyError?.response?.body?.code === "string"
            ? anyError.response.body.code
            : undefined;
      const errorMessage = (() => {
        try {
          if (!error) return "Unknown error";
          if (typeof anyError?.message === "string" && anyError.message.trim()) {
            return anyError.message.trim();
          }
          return JSON.stringify(anyError);
        } catch {
          return String(error);
        }
      })();
      emailDeliveryAudit.add({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        to: params.to,
        subject: params.subject,
        category: params.category || "general",
        status: "failed",
        error: errorMessage,
        providerStatusCode,
        providerErrorCode,
        provider: "brevo",
        fromEmail: EMAIL_CONFIG.fromEmail,
        mode: notificationMode,
      });
      return false;
    }
  }

  async sendBasicEmail(
    to: string,
    subject: string,
    html: string,
    text?: string,
    category?: "account" | "general" | "marketing",
  ): Promise<boolean> {
    return this.sendEmail({ to, subject, html, text, category });
  }

  async sendBookingConfirmationEmail(
    params: BookingConfirmationParams,
  ): Promise<boolean> {
    const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:5000";
    const scheduleUrl = `${baseUrl.replace(/\/+$/, "")}/parking-pass?setup=schedule`;
    const dateLabel =
      params.startDate === params.endDate
        ? params.startDate
        : `${params.startDate} - ${params.endDate}`;
    const slotLine = params.slotSummary
      ? `<p><strong>Slots:</strong> ${params.slotSummary}</p>`
      : "";
    const content = `
      <h2>Parking Pass booking confirmed</h2>
      <p>Your booking at <strong>${params.hostName}</strong> is confirmed.</p>
      <p><strong>Dates:</strong> ${dateLabel}</p>
      ${slotLine}
      <p><strong>Total:</strong> $${(params.totalCents / 100).toFixed(2)}</p>
      <p style="margin: 18px 0;">
        <a href="${scheduleUrl}" class="cta-button">View schedule</a>
      </p>
      <p>If the button doesnâ€™t work, paste this link into your browser:</p>
      <p style="word-break: break-all; color: #f97316;">${scheduleUrl}</p>
    `;

    const html = EmailTemplates.getBaseTemplate(
      "Parking Pass confirmed",
      content,
    );
    const text = `Your Parking Pass booking is confirmed at ${params.hostName} for ${dateLabel}. Total: $${(params.totalCents / 100).toFixed(2)}. View schedule: ${scheduleUrl}`;
    return this.sendEmail({
      to: params.to,
      subject: "Your Parking Pass booking is confirmed",
      html,
      text,
      category: "general",
    });
  }

  async sendHostBookingNotification(params: {
    to: string;
    hostName: string;
    truckName: string;
    startDate: string;
    endDate: string;
    slotSummary?: string;
    totalCents: number;
  }): Promise<boolean> {
    const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:5000";
    const dashboardUrl = `${baseUrl.replace(/\/+$/, "")}/host/dashboard`;
    const dateLabel =
      params.startDate === params.endDate
        ? params.startDate
        : `${params.startDate} \u2013 ${params.endDate}`;
    const slotLine = params.slotSummary
      ? `<p><strong>Slots:</strong> ${params.slotSummary}</p>`
      : "";
    const content = `
      <h2>New booking at ${params.hostName}</h2>
      <p><strong>${params.truckName}</strong> has booked a spot at your location.</p>
      <p><strong>Dates:</strong> ${dateLabel}</p>
      ${slotLine}
      <p><strong>Booking total:</strong> $${(params.totalCents / 100).toFixed(2)}</p>
      <p style="margin: 18px 0;">
        <a href="${dashboardUrl}" class="cta-button">View Host Dashboard</a>
      </p>
      <p>If the button doesn't work, paste this link into your browser:</p>
      <p style="word-break: break-all; color: #f97316;">${dashboardUrl}</p>
    `;
    const html = EmailTemplates.getBaseTemplate(
      `New booking: ${params.truckName}`,
      content,
    );
    const text = `${params.truckName} has booked a spot at ${params.hostName} for ${dateLabel}. Total: $${(params.totalCents / 100).toFixed(2)}. View your dashboard: ${dashboardUrl}`;
    return this.sendEmail({
      to: params.to,
      subject: `\uD83D\uDE9A New booking: ${params.truckName} at ${params.hostName}`,
      html,
      text,
      category: "general",
    });
  }

  async sendParkingPassCompletionReminder(
    params: ParkingPassCompletionReminderParams,
  ): Promise<boolean> {
    const baseUrl = process.env.PUBLIC_BASE_URL || "http://localhost:5000";
    const manageUrl = `${baseUrl.replace(/\/+$/, "")}/parking-pass?setup=host`;
    const locationLabel = params.businessName || "your location";
    const addressLine = params.address
      ? `<p><strong>Address:</strong> ${params.address}</p>`
      : "";
    const content = `
      <h2>Finish your Parking Pass pricing</h2>
      <p>Your parking pass for <strong>${locationLabel}</strong> isn’t complete yet.</p>
      ${addressLine}
      <p>Add at least one slot price (breakfast, lunch, or dinner) so trucks can book your spots.</p>
      <p style="margin: 18px 0;">
        <a href="${manageUrl}" class="cta-button">Complete Parking Pass</a>
      </p>
      <p>If the button doesn’t work, paste this link into your browser:</p>
      <p style="word-break: break-all; color: #f97316;">${manageUrl}</p>
    `;

    const html = EmailTemplates.getBaseTemplate(
      "Complete your Parking Pass",
      content,
    );
    const text = `Finish your Parking Pass pricing for ${locationLabel}. Manage here: ${manageUrl}`;
    return this.sendEmail({
      to: params.email,
      subject: "Finish your Parking Pass pricing",
      html,
      text,
      category: "general",
    });
  }

  async sendEmailVerificationEmail(
    user: User,
    verifyUrl: string,
  ): Promise<boolean> {
    const subject = "Verify your MealScout email";
    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
        <h2 style="margin-bottom: 8px;">Verify your email</h2>
        <p>Thanks for joining MealScout. Please verify your email to activate your account.</p>
        <p style="margin: 16px 0;">
          <a href="${verifyUrl}" style="background: #f97316; color: #fff; text-decoration: none; padding: 12px 16px; border-radius: 8px; display: inline-block;">
            Verify Email
          </a>
        </p>
        <p>If the button does not work, paste this link into your browser:</p>
        <p style="word-break: break-all; color: #f97316;">${verifyUrl}</p>
      </div>
    `;
    const text = `Verify your MealScout email: ${verifyUrl}`;
    return this.sendEmail({
      to: user.email || "",
      subject,
      html,
      text,
      category: "account",
    });
  }

  // Send welcome email based on user type
  async sendWelcomeEmail(user: User, verifyUrl?: string): Promise<boolean> {
    let template: { html: string; text: string };
    let subject: string;

    switch (user.userType) {
      case "customer":
        template = EmailTemplates.getCustomerWelcomeTemplate(user, verifyUrl);
        subject =
          "Welcome to MealScout - Start Discovering Amazing Food Deals! 🍽️";
        break;
      case "restaurant_owner":
        template = EmailTemplates.getRestaurantOwnerWelcomeTemplate(
          user,
          verifyUrl,
        );
        subject = "Welcome to MealScout Business - Grow Your Restaurant! 🚀";
        break;
      case "admin":
        template = EmailTemplates.getAdminWelcomeTemplate(user, verifyUrl);
        subject = "MealScout Admin Access Granted 🔐";
        break;
      default:
        console.warn(`Unknown user type: ${user.userType}`);
        return false;
    }

    return await this.sendEmail({
      to: user.email!,
      subject,
      html: template.html,
      text: template.text,
      category: "account",
    });
  }

  // Send admin notification when new user signs up
  async sendAdminNotification(
    user: User,
    restaurant?: Restaurant,
  ): Promise<boolean> {
    if (!this.isRecentSignupForAdminAlert(user)) {
      console.log("[email] Skipping admin new-user notification for existing account", {
        userId: user.id,
        email: user.email,
        createdAt: user.createdAt,
      });
      return false;
    }

    const template = EmailTemplates.getAdminNotificationTemplate(
      user,
      restaurant,
    );

    return await this.sendEmail({
      to: EMAIL_CONFIG.adminEmail,
      subject: `New ${EmailTemplates.getUserTypeDisplay(user.userType)} Registration - ${user.firstName || ""} ${user.lastName || ""}`,
      html: template.html,
      text: template.text,
    });
  }

  // Send admin signup notification with enhanced details
  async sendAdminSignupNotification(
    user: User,
    context?: { signupMethod?: string; restaurant?: Restaurant },
  ): Promise<boolean> {
    if (!this.isRecentSignupForAdminAlert(user)) {
      console.log("[email] Skipping admin signup notification for existing account", {
        userId: user.id,
        email: user.email,
        signupMethod: context?.signupMethod,
        createdAt: user.createdAt,
      });
      return false;
    }

    const template = EmailTemplates.getAdminSignupNotificationTemplate(
      user,
      context,
    );

    return await this.sendEmail({
      to: EMAIL_CONFIG.adminEmail,
      subject: `New MealScout Signup - ${user.firstName || ""} ${user.lastName || ""} (${EmailTemplates.getUserTypeDisplay(user.userType)})`,
      html: template.html,
      text: template.text,
    });
  }

  private isRecentSignupForAdminAlert(user: User): boolean {
    const createdAt = user.createdAt ? new Date(user.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return false;
    }

    const accountAgeMs = Date.now() - createdAt.getTime();
    return accountAgeMs >= 0 && accountAgeMs <= 20 * 60 * 1000;
  }

  // Send password reset email
  async sendPasswordResetEmail(user: User, resetUrl: string): Promise<boolean> {
    const template = EmailTemplates.getPasswordResetTemplate(user, resetUrl);

    return await this.sendEmail({
      to: user.email!,
      subject: "Reset your MealScout password 🔐",
      html: template.html,
      text: template.text,
      category: "account",
    });
  }

  // Send account setup email for new users
  async sendAccountSetupEmail(
    user: User,
    setupUrl: string,
    createdByName?: string,
  ): Promise<boolean> {
    const template = EmailTemplates.getAccountSetupTemplate(
      user,
      setupUrl,
      createdByName,
    );

    return await this.sendEmail({
      to: user.email!,
      subject: "Welcome to MealScout! Complete your profile 🎉",
      html: template.html,
      text: template.text,
      category: "account",
    });
  }

  // Send bug report email
  async sendBugReport(data: {
    userEmail?: string;
    userName?: string;
    userAgent: string;
    currentUrl: string;
    timestamp: string;
    screenshotUrl?: string;
  }): Promise<boolean> {
    const template = EmailTemplates.getBugReportTemplate(data);

    const emailParams: BaseEmailParams = {
      to: EMAIL_CONFIG.adminEmail,
      subject: `🐛 Bug Report - ${data.currentUrl.substring(0, 50)}`,
      html: template.html,
      text: template.text,
    };

    // If screenshot is provided, extract base64 data and add as attachment
    if (data.screenshotUrl) {
      // Extract base64 data from data URL (format: data:image/png;base64,XXXXX)
      const base64Match = data.screenshotUrl.match(
        /^data:image\/\w+;base64,(.+)$/,
      );
      if (base64Match && base64Match[1]) {
        emailParams.attachments = [
          {
            content: base64Match[1],
            name: "bug-report-screenshot.png",
          },
        ];
      }
    }

    return await this.sendEmail(emailParams);
  }

  // Send interest notification to host
  async sendInterestNotification(
    hostEmail: string,
    hostName: string,
    truckName: string,
    eventDate: string,
  ): Promise<boolean> {
    const title = `New Interest from ${truckName}!`;
    const content = `
      <p>Hi ${hostName},</p>
      <p>Good news! <strong>${truckName}</strong> is interested in your event on <strong>${eventDate}</strong>.</p>
      <p>Log in to your Host Dashboard to view their profile and manage your event.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="https://mealscout.io/host/dashboard" style="background-color: #e11d48; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Dashboard</a>
      </div>
    `;

    const html = EmailTemplates.getBaseTemplate(title, content);
    const text = `Hi ${hostName}, ${truckName} is interested in your event on ${eventDate}. Log in to view details: https://mealscout.io/host/dashboard`;

    return await this.sendEmail({
      to: hostEmail,
      subject: `🚚 New Interest: ${truckName} wants to join your event!`,
      html,
      text,
    });
  }

  // Send status update notification to truck
  async sendInterestStatusUpdate(
    truckEmail: string,
    truckName: string,
    hostName: string,
    eventDate: string,
    status: "accepted" | "declined",
  ): Promise<boolean> {
    const isAccepted = status === "accepted";
    const title = isAccepted
      ? `You're In! ${hostName} Accepted Your Request`
      : `Update on your request for ${hostName}`;

    const content = isAccepted
      ? `
        <p>Hi ${truckName},</p>
        <p>Great news! <strong>${hostName}</strong> has accepted your request to join their event on <strong>${eventDate}</strong>.</p>
        <p>Please contact the host directly if you need to coordinate arrival details.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://mealscout.io/truck/discovery" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Event</a>
        </div>
      `
      : `
        <p>Hi ${truckName},</p>
        <p>Thank you for your interest in the event at <strong>${hostName}</strong> on <strong>${eventDate}</strong>.</p>
        <p>The host has declined your request at this time. Don't worry, there are plenty of other locations looking for great food trucks!</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="https://mealscout.io/truck/discovery" style="background-color: #e11d48; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Find More Events</a>
        </div>
      `;

    const html = EmailTemplates.getBaseTemplate(title, content);
    const text = isAccepted
      ? `Hi ${truckName}, ${hostName} has accepted your request for ${eventDate}!`
      : `Hi ${truckName}, ${hostName} has declined your request for ${eventDate}.`;

    return await this.sendEmail({
      to: truckEmail,
      subject: isAccepted
        ? `🎉 You're In! ${hostName} Accepted Your Request`
        : `Update on your request for ${hostName}`,
      html,
      text,
    });
  }

  // Send weekly digest to host
  async sendWeeklyDigest(
    hostEmail: string,
    data: {
      hostName: string;
      weekStart: string;
      weekEnd: string;
      events: { name: string; date: string; accepted: number; max: number }[];
      pendingCount: number;
      capacityAlerts: {
        eventName: string;
        date: string;
        accepted: number;
        max: number;
      }[];
    },
  ): Promise<boolean> {
    const title = `Your MealScout Week at a Glance`;

    let eventsHtml = "";
    if (data.events.length > 0) {
      eventsHtml = `
        <h3 style="color: #1e293b; margin-top: 20px;">📅 Upcoming Events</h3>
        <ul style="padding-left: 0; list-style: none;">
          ${data.events
            .map(
              (e) => `
            <li style="margin-bottom: 12px; padding: 12px; background-color: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0;">
              <div style="font-weight: bold; color: #0f172a;">${e.date} - ${e.name}</div>
              <div style="font-size: 14px; color: #64748b; margin-top: 4px;">
                Capacity: ${e.accepted} / ${e.max} trucks
              </div>
            </li>
          `,
            )
            .join("")}
        </ul>
      `;
    }

    let alertsHtml = "";
    if (data.capacityAlerts.length > 0) {
      alertsHtml = `
        <div style="margin-top: 20px; padding: 16px; background-color: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px;">
          <h3 style="color: #92400e; margin-top: 0; font-size: 16px;">⚠️ Capacity Alerts</h3>
          <p style="color: #b45309; font-size: 14px; margin-bottom: 8px;">The following events are at or over capacity:</p>
          <ul style="padding-left: 20px; margin-bottom: 0; color: #92400e;">
            ${data.capacityAlerts.map((a) => `<li>${a.date}: ${a.eventName} (${a.accepted}/${a.max})</li>`).join("")}
          </ul>
        </div>
      `;
    }

    const content = `
      <p>Hi ${data.hostName},</p>
      <p>Here is your summary for the week of <strong>${data.weekStart}</strong> to <strong>${data.weekEnd}</strong>.</p>

      ${
        data.pendingCount > 0
          ? `
        <div style="margin: 20px 0; padding: 16px; background-color: #eff6ff; border-radius: 6px; border-left: 4px solid #3b82f6;">
          <div style="font-size: 18px; font-weight: bold; color: #1e40af;">${data.pendingCount} Pending Interest${data.pendingCount !== 1 ? "s" : ""}</div>
          <div style="color: #1e3a8a;">Trucks are waiting for your response.</div>
        </div>
      `
          : ""
      }

      ${alertsHtml}
      ${eventsHtml}

      <div style="text-align: center; margin: 30px 0;">
        <a href="https://mealscout.io/host/dashboard" style="background-color: #e11d48; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Go to Dashboard</a>
      </div>

      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px;">
        This is an informational summary. Actions available in your dashboard.
      </p>
    `;

    const html = EmailTemplates.getBaseTemplate(title, content);
    const text = `Hi ${data.hostName}, here is your weekly summary. You have ${data.pendingCount} pending interests. Log in to view details: https://mealscout.io/host/dashboard`;

    return await this.sendEmail({
      to: hostEmail,
      subject: title,
      html,
      text,
    });
  }

  async sendProfileActivitySummaryEmail(
    to: string,
    operatorName: string,
    data: ProfileActivitySummaryEmailData,
  ): Promise<boolean> {
    if (!this.isConfigured) {
      console.warn(
        "Email service not configured. Skipping profile activity summary email.",
      );
      return false;
    }

    const periodLabel = data.period === "month" ? "Monthly" : "Weekly";

    const start = new Date(data.weekStart);
    const end = new Date(data.weekEnd);
    const weekStartLabel = Number.isNaN(start.getTime())
      ? data.weekStart
      : start.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
    const weekEndLabel = Number.isNaN(end.getTime())
      ? data.weekEnd
      : end.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });

    const title = `Your MealScout Profile ${periodLabel} Summary (${weekStartLabel} - ${weekEndLabel})`;
    const content = `
      <p>Hi ${operatorName},</p>
      <p>Here is your profile activity summary for <strong>${weekStartLabel}</strong> to <strong>${weekEndLabel}</strong>.</p>

      <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 18px 0;">
        <div style="padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc;">
          <div style="font-size: 12px; color: #64748b;">Stops Covered</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a;">${data.stopsCovered}</div>
        </div>
        <div style="padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc;">
          <div style="font-size: 12px; color: #64748b;">Live Location Activations</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a;">${data.liveLocationActivations}</div>
        </div>
        <div style="padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc;">
          <div style="font-size: 12px; color: #64748b;">Manual Schedule Usage</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a;">${data.manualScheduleUsage}</div>
        </div>
        <div style="padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #f8fafc;">
          <div style="font-size: 12px; color: #64748b;">Parking Reports Completed</div>
          <div style="font-size: 20px; font-weight: 700; color: #0f172a;">${data.parkingReportsCompleted}</div>
        </div>
      </div>

      <div style="text-align: center; margin: 26px 0;">
        <a href="https://www.mealscout.us/restaurant-owner-dashboard" style="background-color: #ea580c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 700;">Open Profile Dashboard</a>
      </div>

      <p style="font-size: 12px; color: #64748b; margin-top: 24px;">
        This summary highlights operator activity only and does not guarantee revenue outcomes.
      </p>
    `;

    const html = EmailTemplates.getBaseTemplate(title, content);
    const text = `Hi ${operatorName}, ${periodLabel.toLowerCase()} profile activity summary (${weekStartLabel} - ${weekEndLabel}): stops covered ${data.stopsCovered}, live location activations ${data.liveLocationActivations}, manual schedule usage ${data.manualScheduleUsage}, parking reports completed ${data.parkingReportsCompleted}. Open: https://www.mealscout.us/restaurant-owner-dashboard`;

    return await this.sendEmail({
      to,
      subject: title,
      html,
      text,
    });
  }

  // Utility method to check if email service is available
  isAvailable(): boolean {
    if (!this.isConfigured) {
      this.isConfigured = isEmailConfigured();
    }
    return this.isConfigured;
  }

  /**
   * Send notification to a truck owner when a series they're interested in gets cancelled
   * @param truckEmail - Email of the truck owner
   * @param truckName - Name of the food truck
   * @param seriesName - Name of the event series
   * @param affectedDates - Array of date strings for cancelled occurrences
   */
  async sendSeriesCancellationNotification(
    truckEmail: string,
    truckName: string,
    seriesName: string,
    affectedDates: string[],
  ): Promise<boolean> {
    if (!this.isConfigured) {
      console.warn(
        "Email service not configured. Skipping series cancellation notification.",
      );
      return false;
    }

    const dateList =
      affectedDates.length <= 5
        ? affectedDates.map((d) => `<li>${d}</li>`).join("")
        : `<li>${affectedDates[0]}</li><li>${affectedDates[1]}</li><li>${affectedDates[2]}</li><li>... and ${affectedDates.length - 3} more dates</li>`;

    const title = `Event Series Cancelled: ${seriesName}`;
    const content = `
      <p>Hi ${truckName} Team,</p>

      <p>We wanted to let you know that the event series <strong>"${seriesName}"</strong> has been cancelled by the host.</p>

      <div style="margin: 20px 0; padding: 16px; background-color: #fef2f2; border-radius: 6px; border-left: 4px solid #ef4444;">
        <div style="font-size: 18px; font-weight: bold; color: #991b1b;">Series Cancelled</div>
        <div style="color: #7f1d1d; margin-top: 8px;">The following dates are affected:</div>
        <ul style="color: #7f1d1d; margin: 10px 0;">
          ${dateList}
        </ul>
      </div>

      <p>If you had marked interest or accepted any of these events, they have been automatically removed from your schedule.</p>

      <p>We appreciate your understanding and look forward to connecting you with other great hosting opportunities!</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="https://mealscout.io/truck/dashboard" style="background-color: #e11d48; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Available Events</a>
      </div>

      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px;">
        Questions? Reply to this email or contact support@mealscout.io
      </p>
    `;

    const html = EmailTemplates.getBaseTemplate(title, content);
    const text = `Hi ${truckName} Team,

The event series "${seriesName}" has been cancelled by the host.

Affected dates:
${affectedDates.join("\n")}

If you had marked interest or accepted any of these events, they have been removed from your schedule.

View other available events: https://mealscout.io/truck/dashboard`;

    return await this.sendEmail({
      to: truckEmail,
      subject: title,
      html,
      text,
    });
  }

  /**
   * Send daily VAC monitoring digest to admin.
   * Lists trucks pending manual review with their score, signals, and signup time.
   */
  async sendVacPendingDigest(params: {
    pendingCount: number;
    entries: Array<{
      restaurantId: string;
      restaurantName: string;
      ownerEmail: string;
      vacScoreDisplay: string;
      signals: string;
      createdAt: string;
      rowStatus?: string;
    }>;
  }): Promise<boolean> {
    const { pendingCount, entries } = params;
    const subject = `[MealScout] VAC Review Queue: ${pendingCount} truck${pendingCount === 1 ? "" : "s"} pending manual verification`;
    const rows = entries
      .map(
        (e) =>
          `<tr style="border-bottom:1px solid #eee">
            <td style="padding:8px 12px">${e.restaurantName}</td>
            <td style="padding:8px 12px">${e.ownerEmail}</td>
            <td style="padding:8px 12px;text-align:center"><strong>${e.vacScoreDisplay}</strong></td>
            <td style="padding:8px 12px;font-size:12px;color:#555">${e.signals}</td>
            <td style="padding:8px 12px;font-size:12px;color:#888">${e.createdAt}</td>
            <td style="padding:8px 12px;font-size:12px;color:#888">${e.rowStatus || "operational"}</td>
          </tr>`,
      )
      .join("");
    const appUrl = process.env.VITE_APP_URL || process.env.PUBLIC_BASE_URL || "https://mealscout.us";
    const html = `
      <div style="font-family:sans-serif;max-width:800px;margin:0 auto">
        <h2 style="color:#1a1a1a">VAC Manual Review Queue &#8212; ${new Date().toLocaleDateString()}</h2>
        <p style="color:#555">${pendingCount} truck${pendingCount === 1 ? "" : "s"} scored below the auto-verify threshold and require manual review.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px 12px;text-align:left">Truck Name</th>
              <th style="padding:8px 12px;text-align:left">Owner Email</th>
              <th style="padding:8px 12px;text-align:center">VAC Score</th>
              <th style="padding:8px 12px;text-align:left">Signals</th>
              <th style="padding:8px 12px;text-align:left">Signed Up</th>
              <th style="padding:8px 12px;text-align:left">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:24px">
          <a href="${appUrl}/admin/verifications" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Review in Admin Dashboard</a>
        </p>
        <p style="color:#999;font-size:12px;margin-top:16px">This digest is sent daily at 9 AM when there are pending manual reviews.</p>
      </div>`;
    const text = `VAC Manual Review Queue - ${new Date().toLocaleDateString()}\n\n${pendingCount} truck(s) pending manual verification:\n\n${entries.map((e) => `- ${e.restaurantName} (${e.ownerEmail}) | Score: ${e.vacScoreDisplay} | ${e.signals} | Signed up: ${e.createdAt} | Status: ${e.rowStatus || "operational"}`).join("\n")}\n\nReview at: ${appUrl}/admin/verifications`;
    return await this.sendEmail({
      to: EMAIL_CONFIG.adminEmail,
      subject,
      html,
      text,
    });
  }
}

export function renderAdminSignupEmail(
  user: User,
  context?: { signupMethod?: string; restaurant?: Restaurant },
): { html: string; text: string } {
  return EmailTemplates.getAdminSignupNotificationTemplate(user, context);
}

export function renderPasswordResetEmail(
  user: User,
  resetUrl: string,
): { html: string; text: string } {
  return EmailTemplates.getPasswordResetTemplate(user, resetUrl);
}

// Export singleton instance
export const emailService = EmailService.getInstance();
