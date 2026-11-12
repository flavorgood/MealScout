import type { Express } from "express";
import { and, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import Stripe from "stripe";

import { db } from "../db";
import {
  executeHostPayout,
  type HostPayoutStore,
} from "../hostPayoutExecutionService";
import { isAdmin, isAuthenticated } from "../unifiedAuth";
import {
  hostEarningsLedger,
  hostPayoutRequests,
  hosts,
  users,
} from "@shared/schema";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const VALID_STATUSES = [
  "all",
  "pending",
  "approved",
  "processing",
  "paid",
  "rejected",
  "cancelled",
] as const;

const parsePayoutFilters = (req: any) => {
  const statusFilterRaw = String(req?.query?.status || "all")
    .trim()
    .toLowerCase();
  const statusFilter = VALID_STATUSES.includes(statusFilterRaw as any)
    ? statusFilterRaw
    : "all";
  const searchTerm = String(req?.query?.q || "").trim();
  const fromDateRaw = String(req?.query?.from || "").trim();
  const toDateRaw = String(req?.query?.to || "").trim();
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromDateRaw)
    ? new Date(`${fromDateRaw}T00:00:00.000Z`)
    : null;
  const toDateExclusive = /^\d{4}-\d{2}-\d{2}$/.test(toDateRaw)
    ? new Date(new Date(`${toDateRaw}T00:00:00.000Z`).getTime() + 86400000)
    : null;

  const filters: any[] = [];
  if (statusFilter !== "all") {
    filters.push(eq(hostPayoutRequests.status, statusFilter));
  }
  if (searchTerm.length > 0) {
    const likePattern = `%${searchTerm}%`;
    filters.push(
      or(
        like(hosts.businessName, likePattern),
        like(users.email, likePattern),
        like(hosts.address, likePattern),
      ),
    );
  }
  if (fromDate) {
    filters.push(gte(hostPayoutRequests.createdAt, fromDate));
  }
  if (toDateExclusive) {
    filters.push(lt(hostPayoutRequests.createdAt, toDateExclusive));
  }

  return {
    statusFilter,
    searchTerm,
    fromDateRaw,
    toDateRaw,
    whereClause:
      filters.length > 0 ? and(...(filters as [any, ...any[]])) : undefined,
  };
};

const sanitizeCSV = (value: any): string => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/^[=+@-]/.test(str)) {
    return `"'${str.replace(/"/g, '""')}"`;
  }
  return `"${str.replace(/"/g, '""')}"`;
};

export function registerHostPayoutAdminRoutes(app: Express) {
  app.get(
    "/api/admin/host-payout-requests",
    isAuthenticated,
    isAdmin,
    async (req, res) => {
      try {
        const pageRaw = Number((req as any)?.query?.page ?? 1);
        const pageSizeRaw = Number((req as any)?.query?.pageSize ?? 20);
        const page = Number.isFinite(pageRaw)
          ? Math.max(1, Math.floor(pageRaw))
          : 1;
        const pageSize = Number.isFinite(pageSizeRaw)
          ? Math.min(100, Math.max(1, Math.floor(pageSizeRaw)))
          : 20;

        const {
          statusFilter,
          searchTerm,
          fromDateRaw,
          toDateRaw,
          whereClause,
        } = parsePayoutFilters(req);

        const [totalsRow] = await db
          .select({
            pending: sql<number>`coalesce(sum(case when ${hostPayoutRequests.status} = 'pending' then 1 else 0 end), 0)`,
            approved: sql<number>`coalesce(sum(case when ${hostPayoutRequests.status} = 'approved' then 1 else 0 end), 0)`,
            processing: sql<number>`coalesce(sum(case when ${hostPayoutRequests.status} = 'processing' then 1 else 0 end), 0)`,
            paid: sql<number>`coalesce(sum(case when ${hostPayoutRequests.status} = 'paid' then 1 else 0 end), 0)`,
            rejected: sql<number>`coalesce(sum(case when ${hostPayoutRequests.status} = 'rejected' then 1 else 0 end), 0)`,
          })
          .from(hostPayoutRequests);

        const countQuery = db
          .select({ count: sql<number>`count(*)` })
          .from(hostPayoutRequests)
          .leftJoin(hosts, eq(hostPayoutRequests.hostId, hosts.id))
          .leftJoin(users, eq(hostPayoutRequests.userId, users.id));

        if (whereClause) {
          countQuery.where(whereClause as any);
        }

        const [countRow] = await countQuery;
        const filteredTotal = Number(countRow?.count || 0);

        const rowsQuery = db
          .select({
            id: hostPayoutRequests.id,
            hostId: hostPayoutRequests.hostId,
            userId: hostPayoutRequests.userId,
            amountCents: hostPayoutRequests.amountCents,
            status: hostPayoutRequests.status,
            notes: hostPayoutRequests.notes,
            reviewedByUserId: hostPayoutRequests.reviewedByUserId,
            reviewedByEmail: sql<string>`(select u.email from users u where u.id = ${hostPayoutRequests.reviewedByUserId} limit 1)`,
            reviewedAt: hostPayoutRequests.reviewedAt,
            paidAt: hostPayoutRequests.paidAt,
            createdAt: hostPayoutRequests.createdAt,
            updatedAt: hostPayoutRequests.updatedAt,
            hostBusinessName: hosts.businessName,
            hostAddress: hosts.address,
            hostCity: hosts.city,
            hostState: hosts.state,
            requesterEmail: users.email,
          })
          .from(hostPayoutRequests)
          .leftJoin(hosts, eq(hostPayoutRequests.hostId, hosts.id))
          .leftJoin(users, eq(hostPayoutRequests.userId, users.id))
          .orderBy(desc(hostPayoutRequests.createdAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        if (whereClause) {
          rowsQuery.where(whereClause as any);
        }

        const rows = await rowsQuery;

        res.json({
          ok: true,
          totals: {
            pending: Number(totalsRow?.pending || 0),
            approved: Number(totalsRow?.approved || 0),
            processing: Number(totalsRow?.processing || 0),
            paid: Number(totalsRow?.paid || 0),
            rejected: Number(totalsRow?.rejected || 0),
          },
          rows,
          pagination: {
            page,
            pageSize,
            total: filteredTotal,
            totalPages: Math.max(1, Math.ceil(filteredTotal / pageSize)),
            hasNext: page * pageSize < filteredTotal,
            hasPrev: page > 1,
          },
          filters: {
            status: statusFilter,
            q: searchTerm,
            from: fromDateRaw,
            to: toDateRaw,
          },
        });
      } catch (error: any) {
        console.error("Failed to load host payout requests:", error);
        res.status(500).json({
          ok: false,
          message: error?.message || "Failed to load host payout requests",
        });
      }
    },
  );

  app.patch(
    "/api/admin/host-payout-requests/:requestId",
    isAuthenticated,
    isAdmin,
    async (req: any, res) => {
      try {
        const requestId = String(req.params.requestId || "").trim();
        const nextStatus = String(req.body?.status || "")
          .trim()
          .toLowerCase();
        const notes =
          typeof req.body?.notes === "string" && req.body.notes.trim()
            ? req.body.notes.trim()
            : null;

        if (!requestId) {
          return res.status(400).json({ message: "Request ID is required" });
        }

        if (
          !["approved", "rejected", "paid", "cancelled"].includes(nextStatus)
        ) {
          return res.status(400).json({
            message:
              "Status must be one of: approved, rejected, paid, cancelled",
          });
        }

        const [existing] = await db
          .select()
          .from(hostPayoutRequests)
          .where(eq(hostPayoutRequests.id, requestId))
          .limit(1);

        if (!existing) {
          return res.status(404).json({ message: "Payout request not found" });
        }

        if (existing.status === "paid") {
          return res.status(400).json({
            message: "Paid requests cannot be modified",
          });
        }

        // A processing payout's money may already be moving and its
        // outcome is unknown. Its state cannot change — including
        // rejection — until a mark-paid retry reconciles it. (Mirrors the
        // affiliate payout rule: restoring availability on top of a sent
        // or possibly-sent transfer pays the host twice.)
        if (existing.status === "processing" && nextStatus !== "paid") {
          return res.status(409).json({
            message:
              "Payout is being processed — it cannot change state until the payment outcome is known; retry mark-paid to reconcile it",
          });
        }

        if (nextStatus === "approved" && existing.status !== "pending") {
          return res.status(400).json({
            message: "Only pending requests can be approved",
          });
        }

        if (
          nextStatus === "paid" &&
          !["approved", "processing"].includes(String(existing.status || ""))
        ) {
          return res.status(400).json({
            message:
              "Only approved requests can be marked paid (a processing payout is retried with the same action)",
          });
        }

        if (
          nextStatus === "rejected" &&
          !["pending", "approved"].includes(String(existing.status || ""))
        ) {
          return res.status(400).json({
            message: "Only pending or approved requests can be rejected",
          });
        }

        if (
          nextStatus === "cancelled" &&
          !["pending", "approved"].includes(String(existing.status || ""))
        ) {
          return res.status(400).json({
            message: "Only pending or approved requests can be cancelled",
          });
        }

        if (nextStatus === "paid") {
          // Money movement goes through the hardened execution path
          // (hostPayoutExecutionService): atomic claim into "processing",
          // idempotent Stripe transfer, finalize + ledger in one
          // transaction only after the transfer succeeds. A failed or
          // never-attempted transfer can no longer leave the request
          // marked paid.
          const [hostRow] = await db
            .select({
              stripeConnectAccountId: hosts.stripeConnectAccountId,
              stripePayoutsEnabled: hosts.stripePayoutsEnabled,
            })
            .from(hosts)
            .where(eq(hosts.id, existing.hostId))
            .limit(1);

          const store: HostPayoutStore = {
            claimProcessing: async (input) => {
              const claimNow = new Date();
              const [claimed] = await db
                .update(hostPayoutRequests)
                .set({
                  status: "processing",
                  notes: input.notes,
                  reviewedByUserId: input.adminUserId || null,
                  reviewedAt: claimNow,
                  updatedAt: claimNow,
                })
                .where(
                  and(
                    eq(hostPayoutRequests.id, input.requestId),
                    eq(hostPayoutRequests.status, "approved"),
                  ),
                )
                .returning();
              return claimed ?? null;
            },
            finalizePaid: async (input) => {
              return await db.transaction(async (tx: any) => {
                const [row] = await tx
                  .update(hostPayoutRequests)
                  .set({
                    status: "paid",
                    paidAt: input.paidAt,
                    notes: input.notes,
                    reviewedByUserId: input.adminUserId || null,
                    reviewedAt: input.paidAt,
                    updatedAt: input.paidAt,
                  })
                  .where(
                    and(
                      eq(hostPayoutRequests.id, input.requestId),
                      eq(hostPayoutRequests.status, "processing"),
                    ),
                  )
                  .returning();
                if (!row) return null;
                await tx.insert(hostEarningsLedger).values({
                  hostId: input.hostId,
                  bookingId: null,
                  stripePaymentIntentId: input.transferId,
                  entryType: "payout",
                  sourceType: "host_payout_request",
                  amountCents: -Math.abs(Number(input.amountCents || 0)),
                  description: input.description,
                  createdAt: input.paidAt,
                });
                return row;
              });
            },
          };

          const transferClient = stripe
            ? {
                createTransfer: async (
                  transferRequest: {
                    amountCents: number;
                    destination: string;
                    description: string;
                    metadata: Record<string, string>;
                  },
                  idempotencyKey: string,
                ) =>
                  stripe.transfers.create(
                    {
                      amount: transferRequest.amountCents,
                      currency: "usd",
                      destination: transferRequest.destination,
                      description: transferRequest.description,
                      metadata: transferRequest.metadata,
                    },
                    { idempotencyKey },
                  ),
                findTransferByPayoutRequestId: async (requestId: string) => {
                  // The pinned Stripe SDK types expose no transfers.search,
                  // so reconcile by paging the transfer list and matching
                  // the payoutRequestId metadata every host-payout transfer
                  // carries. This runs only on a processing retry (rare,
                  // admin-initiated). The scan returns null ONLY at genuine
                  // exhaustion (Stripe reports no more pages); hitting the
                  // page cap first throws, and the execution refuses
                  // rather than treating a truncated scan as proof that
                  // no transfer exists.
                  let startingAfter: string | undefined;
                  for (let page = 0; page < 200; page++) {
                    const list = await stripe.transfers.list({
                      limit: 100,
                      ...(startingAfter
                        ? { starting_after: startingAfter }
                        : {}),
                    });
                    const found = list.data.find(
                      (t) => t.metadata?.payoutRequestId === requestId,
                    );
                    if (found) return { id: found.id };
                    if (!list.has_more || list.data.length === 0) return null;
                    startingAfter = list.data[list.data.length - 1].id;
                  }
                  throw new Error(
                    "payout reconciliation scan incomplete: transfer list not exhausted within the page cap",
                  );
                },
              }
            : null;

          const result = await executeHostPayout(store, transferClient, {
            request: existing,
            destination: {
              stripeConnectAccountId: hostRow?.stripeConnectAccountId ?? null,
              stripePayoutsEnabled: hostRow?.stripePayoutsEnabled ?? null,
            },
            stripeConfigured: Boolean(stripe),
            adminUserId: String((req as any).user?.id || ""),
            notes: notes ?? existing.notes ?? null,
            manualPayoutConfirmed:
              (req.body as any)?.manualPayoutConfirmed === true,
          });

          if (result.outcome === "claim_conflict") {
            return res.status(409).json({
              ok: false,
              message:
                "Payout state changed before payment could start — reload and retry",
            });
          }
          if (result.outcome === "transfer_failed") {
            console.error(
              `[host-payout] Stripe transfer failed for request ${existing.id}:`,
              result.message,
            );
            return res.status(502).json({
              ok: false,
              message: `Stripe transfer failed: ${result.message} — the payout stays in processing and no payment was recorded; retry mark-paid to reconcile before taking any other action`,
            });
          }
          if (result.outcome === "stripe_unconfigured") {
            return res.status(503).json({
              ok: false,
              message: "Stripe is not configured on this server",
            });
          }
          if (result.outcome === "manual_confirmation_required") {
            return res.status(422).json({
              ok: false,
              message:
                "This host has no Stripe payout destination on file, so marking paid records an out-of-band manual payout. Resend with manualPayoutConfirmed: true only if the host has actually been paid outside Stripe.",
            });
          }
          if (result.outcome === "finalize_conflict") {
            return res.status(409).json({
              ok: false,
              message: result.transferId
                ? `Stripe transfer ${result.transferId} was sent for this payout, but the payout row changed state before it could be marked paid — reconcile it manually in Stripe`
                : "Payout row changed state before it could be marked paid — reload and reconcile it manually",
            });
          }
          if (result.outcome === "invalid_amount") {
            return res.status(400).json({
              ok: false,
              message: "Payout amount is invalid",
            });
          }

          const { getHostEarningsSummary } =
            await import("../hostEarningsService");
          const paidSummary = await getHostEarningsSummary(existing.hostId);
          return res.json({
            ok: true,
            request: result.request,
            summary: paidSummary,
          });
        }

        const now = new Date();
        const [updated] = await db
          .update(hostPayoutRequests)
          .set({
            status: nextStatus,
            notes: notes ?? existing.notes ?? null,
            reviewedByUserId: req.user?.id || null,
            reviewedAt: now,
            paidAt: existing.paidAt,
            updatedAt: now,
          })
          .where(eq(hostPayoutRequests.id, requestId))
          .returning();

        const { getHostEarningsSummary } =
          await import("../hostEarningsService");
        const summary = await getHostEarningsSummary(existing.hostId);

        res.json({ ok: true, request: updated, summary });
      } catch (error: any) {
        console.error("Failed to update host payout request:", error);
        res.status(500).json({
          ok: false,
          message: error?.message || "Failed to update host payout request",
        });
      }
    },
  );

  app.get(
    "/api/admin/host-payout-requests/export.csv",
    isAuthenticated,
    isAdmin,
    async (req, res) => {
      try {
        const { statusFilter, whereClause } = parsePayoutFilters(req);

        const rowsQuery = db
          .select({
            id: hostPayoutRequests.id,
            hostId: hostPayoutRequests.hostId,
            amountCents: hostPayoutRequests.amountCents,
            status: hostPayoutRequests.status,
            notes: hostPayoutRequests.notes,
            reviewedByUserId: hostPayoutRequests.reviewedByUserId,
            reviewedByEmail: sql<string>`(select u.email from users u where u.id = ${hostPayoutRequests.reviewedByUserId} limit 1)`,
            reviewedAt: hostPayoutRequests.reviewedAt,
            paidAt: hostPayoutRequests.paidAt,
            createdAt: hostPayoutRequests.createdAt,
            updatedAt: hostPayoutRequests.updatedAt,
            hostBusinessName: hosts.businessName,
            hostAddress: hosts.address,
            hostCity: hosts.city,
            hostState: hosts.state,
            requesterEmail: users.email,
          })
          .from(hostPayoutRequests)
          .leftJoin(hosts, eq(hostPayoutRequests.hostId, hosts.id))
          .leftJoin(users, eq(hostPayoutRequests.userId, users.id))
          .orderBy(desc(hostPayoutRequests.createdAt));

        if (whereClause) {
          rowsQuery.where(whereClause as any);
        }

        const rows = await rowsQuery;
        const header =
          "Request ID,Host ID,Host Name,Requester Email,Amount USD,Status,Requested At,Reviewed At,Reviewed By,Paid At,Address,Notes\n";

        const csvRows = rows
          .map((row: (typeof rows)[number]) => {
            const amountUsd = (Number(row.amountCents || 0) / 100).toFixed(2);
            const address = [row.hostAddress, row.hostCity, row.hostState]
              .filter(Boolean)
              .join(", ");

            return [
              sanitizeCSV(row.id),
              sanitizeCSV(row.hostId),
              sanitizeCSV(row.hostBusinessName || ""),
              sanitizeCSV(row.requesterEmail || ""),
              sanitizeCSV(amountUsd),
              sanitizeCSV(row.status || ""),
              sanitizeCSV(
                row.createdAt ? new Date(row.createdAt).toISOString() : "",
              ),
              sanitizeCSV(
                row.reviewedAt ? new Date(row.reviewedAt).toISOString() : "",
              ),
              sanitizeCSV(row.reviewedByEmail || row.reviewedByUserId || ""),
              sanitizeCSV(row.paidAt ? new Date(row.paidAt).toISOString() : ""),
              sanitizeCSV(address),
              sanitizeCSV(row.notes || ""),
            ].join(",");
          })
          .join("\n");

        const dateStamp = new Date().toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="host-payout-requests-${encodeURIComponent(statusFilter)}-${dateStamp}.csv"`,
        );
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.send(header + csvRows);
      } catch (error: any) {
        console.error("Failed to export host payout requests:", error);
        res.status(500).json({
          ok: false,
          message: error?.message || "Failed to export host payout requests",
        });
      }
    },
  );
}
