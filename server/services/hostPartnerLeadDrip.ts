import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import { emailService } from "../emailService";
import {
  acceptHostPartnerEmailStep,
  claimHostPartnerEmailStep,
} from "./hostPartnerLeadMagnet";
import {
  hostPartnerLeads,
  hostPartnerLeadSequenceSends,
  hostPartnerEmailClaims,
} from "@shared/schema";

const SEQUENCE = "host_partner_v1";

function envEnabled(name: string, fallback = true): boolean {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "true";
}

function publicBaseUrl(): string {
  return String(process.env.PUBLIC_BASE_URL || "https://www.mealscout.us").replace(
    /\/+$/,
    "",
  );
}

async function alreadySent(leadId: string, step: number): Promise<boolean> {
  const [row] = await db
    .select({ id: hostPartnerLeadSequenceSends.id })
    .from(hostPartnerLeadSequenceSends)
    .where(
      and(
        eq(hostPartnerLeadSequenceSends.leadId, leadId),
        eq(hostPartnerLeadSequenceSends.sequence, SEQUENCE),
        eq(hostPartnerLeadSequenceSends.step, step),
      ),
    )
    .limit(1);
  return Boolean(row?.id);
}

function subjectForStep(step: number): string {
  if (step === 2) return "How to turn parking space into monthly revenue";
  if (step === 3) return "Final step: list your location in MealScout";
  return "MealScout";
}

function htmlForStep(step: number, lead: any): string {
  const base = publicBaseUrl();
  const firstName = String(lead?.firstName || "there");
  const forHostsUrl = `${base}/for-hosts`;
  const hostSignupUrl = `${base}/customer-signup?role=host`;
  const parkingPassUrl = `${base}/parking-pass`;
  const businessName = String(lead?.businessName || "your business");

  const wrap = (body: string) => `<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
    <div style="max-width: 640px; margin: 0 auto; padding: 24px;">
      ${body}
      <p style="margin-top: 24px; color:#6b7280; font-size: 12px;">
        MealScout · Reply to unsubscribe
      </p>
    </div>
  </body>
</html>`;

  if (step === 2) {
    return wrap(`
      <h2 style="margin: 0 0 12px 0;">Hi ${firstName} — ${businessName} can monetize parking capacity</h2>
      <p style="margin: 0 0 12px 0;">
        Businesses use MealScout to host trucks during low-traffic windows and earn recurring monthly booking revenue.
      </p>
      <p style="margin: 0 0 12px 0;">
        See how hosting works: <a href="${forHostsUrl}">${forHostsUrl}</a>
      </p>
      <p style="margin: 0;">
        Ready to list your spot? <a href="${hostSignupUrl}">${hostSignupUrl}</a>
      </p>
    `);
  }

  return wrap(`
    <h2 style="margin: 0 0 12px 0;">${firstName}, keep your location available to trucks</h2>
    <p style="margin: 0 0 12px 0;">
      You’re one step away from publishing your host profile and opening bookable slots.
    </p>
    <p style="margin: 0 0 12px 0;">
      Create your host account: <a href="${hostSignupUrl}">${hostSignupUrl}</a>
    </p>
    <p style="margin: 0;">
      Preview active booking flow: <a href="${parkingPassUrl}">${parkingPassUrl}</a>
    </p>
  `);
}

export async function runHostPartnerLeadDripCron() {
  if (!envEnabled("HOST_PARTNER_DRIP_ENABLED", true)) {
    return { ok: true, sent: 0 };
  }

  const lookbackDaysRaw = Number(process.env.HOST_PARTNER_LOOKBACK_DAYS ?? 45);
  const lookbackDays = Number.isFinite(lookbackDaysRaw)
    ? Math.max(1, Math.min(Math.floor(lookbackDaysRaw), 180))
    : 45;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      lead: hostPartnerLeads,
      step1AcceptedAt: sql<Date | null>`(
        select c.accepted_at from host_partner_email_claims c
        where c.email_normalized = lower(btrim(${hostPartnerLeads.email}))
          and c.lead_id = ${hostPartnerLeads.id}
          and c.sequence = ${SEQUENCE}
          and c.step = 1
          and c.status = 'accepted'
      )`,
    })
    .from(hostPartnerLeads)
    .where(gte(hostPartnerLeads.createdAt, cutoff))
    .orderBy(desc(hostPartnerLeads.createdAt))
    .limit(300);

  const delayByStepDays: Record<number, number> = { 2: 1, 3: 4 };
  const MAX_SENDS_PER_RUN = 50;
  let sent = 0;
  let attempted = 0;

  for (const row of rows) {
    if (attempted >= MAX_SENDS_PER_RUN) break;
    const lead: any = row.lead;
    if (!lead?.id || !lead?.email) continue;
    const email = String(lead.email).trim().toLowerCase();
    const step1AcceptedAt = row.step1AcceptedAt ? new Date(row.step1AcceptedAt) : null;
    if (!step1AcceptedAt) continue;

    for (const step of [2, 3]) {
      if (attempted >= MAX_SENDS_PER_RUN) break;
      if (await alreadySent(String(lead.id), step)) continue;
      if (step === 3) {
        const [step2] = await db
          .select({ status: hostPartnerEmailClaims.status })
          .from(hostPartnerEmailClaims)
          .where(
            and(
              eq(hostPartnerEmailClaims.emailNormalized, email),
              eq(hostPartnerEmailClaims.sequence, SEQUENCE),
              eq(hostPartnerEmailClaims.step, 2),
              eq(hostPartnerEmailClaims.status, "accepted"),
            ),
          )
          .limit(1);
        if (!step2) continue;
      }
      const dueAt = new Date(
        step1AcceptedAt.getTime() + delayByStepDays[step] * 24 * 60 * 60 * 1000,
      );
      if (Date.now() < dueAt.getTime()) continue;

      const claim = await claimHostPartnerEmailStep(email, String(lead.id), step);
      if (!claim.won) break;
      attempted += 1;
      try {
        const accepted = await emailService.sendBasicEmail(
          email,
          subjectForStep(step),
          htmlForStep(step, lead),
          undefined,
          "marketing",
        );
        if (accepted) {
          await acceptHostPartnerEmailStep(email, String(lead.id), step, {
            kind: "lead",
            leadId: lead.id,
          });
          sent += 1;
        }
      } catch {
        // Provider or ledger outcome is uncertain. The pending claim fences
        // retries until an operator reconciles it against provider evidence.
        console.error("[host-partner] Follow-up email confirmation unavailable.");
      }
      break;
    }
  }

  return { ok: true, sent };
}

