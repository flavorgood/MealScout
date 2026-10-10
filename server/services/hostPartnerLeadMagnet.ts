import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { emailService } from "../emailService";
import {
  hostPartnerLeads,
  hostPartnerLeadSequenceSends,
  hostPartnerEmailClaims,
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
  return db.transaction(async (tx: any) => {
    // Serialize this service's lookup and insert for one normalized address.
    // Historical duplicate rows remain intact; an existing row wins by ID.
    await tx.execute(sql`select pg_advisory_xact_lock(842192, hashtext(${email}))`);
    const existing = await tx
      .select()
      .from(hostPartnerLeads)
      .where(sql`lower(btrim(${hostPartnerLeads.email})) = ${email}`)
      .orderBy(hostPartnerLeads.id)
      .limit(1)
      .then((rows: any[]) => rows[0] || null);

    if (existing) {
      const [updated] = await tx
        .update(hostPartnerLeads)
        .set({
          email,
          firstName: params.firstName || existing.firstName || null,
          phone: params.phone || existing.phone || null,
          businessName: params.businessName || existing.businessName,
          address: params.address || existing.address || null,
          city: params.city || existing.city || null,
          state: params.state || existing.state || null,
          locationType: params.locationType || existing.locationType || "other",
          parkingSpots: params.parkingSpots ?? existing.parkingSpots ?? null,
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

    const [created] = await tx
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
  });
}

export async function claimHostPartnerEmailStep(
  email: string,
  leadId: string,
  step: number,
) {
  const [claimed] = await db
    .insert(hostPartnerEmailClaims)
    .values({
      emailNormalized: email,
      sequence: SEQUENCE,
      step,
      leadId,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ emailNormalized: hostPartnerEmailClaims.emailNormalized });
  if (claimed) return { won: true as const, status: "pending" as const };

  const [previous] = await db
    .select({ status: hostPartnerEmailClaims.status })
    .from(hostPartnerEmailClaims)
    .where(
      and(
        eq(hostPartnerEmailClaims.emailNormalized, email),
        eq(hostPartnerEmailClaims.sequence, SEQUENCE),
        eq(hostPartnerEmailClaims.step, step),
      ),
    )
    .limit(1);
  return { won: false as const, status: previous?.status ?? "pending" };
}

export async function acceptHostPartnerEmailStep(
  email: string,
  leadId: string,
  step: number,
  metadata: Record<string, unknown>,
) {
  await db.transaction(async (tx: any) => {
    const [accepted] = await tx
      .update(hostPartnerEmailClaims)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(
        and(
          eq(hostPartnerEmailClaims.emailNormalized, email),
          eq(hostPartnerEmailClaims.sequence, SEQUENCE),
          eq(hostPartnerEmailClaims.step, step),
          eq(hostPartnerEmailClaims.status, "pending"),
          eq(hostPartnerEmailClaims.leadId, leadId),
        ),
      )
      .returning({ status: hostPartnerEmailClaims.status });
    if (!accepted) throw new Error("Host partner email claim changed before acceptance.");
    // The drip sequence reads the accepted Step 1 claim. Keep the legacy send
    // ledger consistent in the same transaction for every sequence step.
    await tx
      .insert(hostPartnerLeadSequenceSends)
      .values({ leadId, sequence: SEQUENCE, step, metadata })
      .onConflictDoNothing();
  });
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
    // A committed claim fences concurrent requests before provider I/O.
    // Pending also fences ambiguous provider results from automatic retries.
    const email = String(lead.email || params.email).trim().toLowerCase();
    const claim = await claimHostPartnerEmailStep(email, leadId, 1);
    if (!claim.won) {
      return { ok: true as const, leadId, emailed: claim.status === "accepted" };
    }

    const emailed = await sendStep1Email(lead);
    if (emailed) {
      await acceptHostPartnerEmailStep(email, leadId, 1, { kind: "lead", leadId });
    }
    return { ok: true as const, leadId, emailed };
  } catch {
    // No automatic send/retry when provider or prior-send evidence is uncertain.
    // Do not log email addresses, form values, or provider error payloads here.
    console.error("[host-partner] Request saved; email confirmation unavailable.");
    return { ok: true as const, leadId, emailed: false };
  }
}
