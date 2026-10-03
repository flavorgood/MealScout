import { z } from "zod";
import { and, eq, gt, ilike } from "drizzle-orm";
import { db } from "../db";
import { emailService } from "../emailService";
import {
  hostPartnerLeads,
  hostPartnerLeadSequenceSends,
} from "@shared/schema";

const SEQUENCE = "host_partner_v1";

function publicBaseUrl(): string {
  return String(process.env.PUBLIC_BASE_URL || "https://www.mealscout.us").replace(
    /\/+$/,
    "",
  );
}

function envEnabled(name: string, fallback = true): boolean {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "true";
}

export const requestHostPartnerLeadSchema = z.object({
  email: z.string().email(),
  firstName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  businessName: z.string().trim().min(2).max(140),
  address: z.string().trim().max(240).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(40).optional(),
  locationType: z.string().trim().min(2).max(40),
  parkingSpots: z.number().int().min(1).max(2000).optional(),
  dailyFootTraffic: z.number().int().min(0).max(100000).optional(),
  notes: z.string().trim().max(1000).optional(),
  source: z.string().trim().max(80).optional(),
});

export async function upsertHostPartnerLead(params: {
  email: string;
  firstName?: string | null;
  phone?: string | null;
  businessName: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  locationType: string;
  parkingSpots?: number | null;
  dailyFootTraffic?: number | null;
  notes?: string | null;
  source?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const email = String(params.email || "").trim().toLowerCase();
  const existing = await db
    .select()
    .from(hostPartnerLeads)
    .where(ilike(hostPartnerLeads.email, email))
    .limit(1)
    .then((rows: any[]) => rows[0] || null);

  if (existing) {
    const [updated] = await db
      .update(hostPartnerLeads)
      .set({
        firstName: params.firstName || existing.firstName || null,
        phone: params.phone || existing.phone || null,
        businessName: params.businessName || existing.businessName,
        address: params.address || existing.address || null,
        city: params.city || existing.city || null,
        state: params.state || existing.state || null,
        locationType: params.locationType || existing.locationType || "other",
        parkingSpots:
          params.parkingSpots ?? existing.parkingSpots ?? null,
        dailyFootTraffic:
          params.dailyFootTraffic ?? existing.dailyFootTraffic ?? null,
        notes: params.notes || existing.notes || null,
        source: params.source || existing.source || "host_location_partner",
        ip: params.ip || existing.ip || null,
        userAgent: params.userAgent || existing.userAgent || null,
        updatedAt: new Date(),
      } as any)
      .where(eq(hostPartnerLeads.id, existing.id))
      .returning();
    return updated || existing;
  }

  const [created] = await db
    .insert(hostPartnerLeads)
    .values({
      email,
      firstName: params.firstName || null,
      phone: params.phone || null,
      businessName: params.businessName,
      address: params.address || null,
      city: params.city || null,
      state: params.state || null,
      locationType: params.locationType || "other",
      parkingSpots: params.parkingSpots ?? null,
      dailyFootTraffic: params.dailyFootTraffic ?? null,
      notes: params.notes || null,
      source: params.source || "host_location_partner",
      status: "new",
      ip: params.ip || null,
      userAgent: params.userAgent || null,
      updatedAt: new Date(),
    } as any)
    .returning();

  return created;
}

async function markSent(leadId: string, step: number, metadata?: any) {
  await db
    .insert(hostPartnerLeadSequenceSends)
    .values({
      leadId,
      sequence: SEQUENCE,
      step,
      metadata: metadata ?? null,
    } as any)
    .onConflictDoNothing();
}

async function sentRecently(leadId: string, step: number, cutoff: Date) {
  const rows = await db
    .select({ id: hostPartnerLeadSequenceSends.id })
    .from(hostPartnerLeadSequenceSends)
    .where(
      and(
        eq(hostPartnerLeadSequenceSends.leadId, leadId),
        eq(hostPartnerLeadSequenceSends.sequence, SEQUENCE),
        eq(hostPartnerLeadSequenceSends.step, step),
        gt(hostPartnerLeadSequenceSends.sentAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function sendStep1Email(lead: any): Promise<boolean> {
  const base = publicBaseUrl();
  const firstName = String(lead?.firstName || "there");
  const hostSignupUrl = `${base}/customer-signup?role=host`;
  const forHostsUrl = `${base}/for-hosts`;
  const subject = "Your location can host food trucks on MealScout";
  const html = `
  <!DOCTYPE html>
  <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
      <div style="max-width: 640px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px 0;">Hi ${firstName} — thanks for your interest</h2>
        <p style="margin: 0 0 12px 0;">
          Your business looks like a strong fit for hosting food trucks.
        </p>
        <p style="margin: 0 0 12px 0;">
          Next step: create your host profile and list your address.
        </p>
        <p style="margin: 0 0 12px 0;">
          <a href="${hostSignupUrl}">${hostSignupUrl}</a>
        </p>
        <p style="margin: 0;">
          More details: <a href="${forHostsUrl}">${forHostsUrl}</a>
        </p>
      </div>
    </body>
  </html>`;
  const text = `Hi ${firstName}, thanks for your interest in hosting food trucks. Create your host profile: ${hostSignupUrl}`;
  return emailService.sendBasicEmail(
    String(lead.email || ""),
    subject,
    html,
    text,
    "account",
  );
}

export async function handleHostPartnerLeadRequest(params: {
  email: string;
  firstName?: string | null;
  phone?: string | null;
  businessName: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  locationType: string;
  parkingSpots?: number | null;
  dailyFootTraffic?: number | null;
  notes?: string | null;
  source?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  if (!envEnabled("HOST_PARTNER_LEADS_ENABLED", true)) {
    return { ok: false as const, code: "disabled" as const };
  }

  // Persistence failures must still reject the request. Only subsequent email
  // confirmation failures may return a saved receipt with emailed:false.
  const lead = await upsertHostPartnerLead(params);
  if (!lead || typeof lead.id !== "string" || !lead.id.trim()) {
    throw new Error("Host partner request did not return a saved reference.");
  }
  const leadId = lead.id;
  try {
    const cooldownMinutesRaw = Number(
      process.env.HOST_PARTNER_EMAIL_COOLDOWN_MINUTES ?? 30,
    );
    const cooldownMinutes = Number.isFinite(cooldownMinutesRaw)
      ? Math.max(1, Math.min(Math.floor(cooldownMinutesRaw), 24 * 60))
      : 30;
    const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000);
    const shouldSkip = await sentRecently(leadId, 1, cutoff);
    if (shouldSkip) {
      return { ok: true as const, leadId, emailed: true };
    }

    const emailed = await sendStep1Email(lead);
    if (emailed) {
      await markSent(leadId, 1, { kind: "lead", leadId });
    }
    return { ok: true as const, leadId, emailed };
  } catch {
    // No automatic send/retry when provider or prior-send evidence is uncertain.
    // Do not log email addresses, form values, or provider error payloads here.
    console.error("[host-partner] Request saved; email confirmation unavailable.");
    return { ok: true as const, leadId, emailed: false };
  }
}
