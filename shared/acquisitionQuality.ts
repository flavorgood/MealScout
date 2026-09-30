import { z } from "zod";

export const QUALITY_CLASSES = ["browser_candidate", "discovery_crawler", "infrastructure_monitor", "automation_signal", "qa_signal", "unclassified", "legacy_unclassified"] as const;
export const SOURCE_GROUPS = ["search_labeled", "ai_labeled", "social_labeled", "direct_or_unknown", "other_labeled"] as const;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const originRequestTrafficSchema = z.object({
  totalRequests: count,
  infrastructureMonitorRequests: count,
  discoveryCrawlerRequests: count,
  automationRequests: count,
  browserShapedRequests: count,
  unclassifiedRequests: count,
  errorRequests: count,
  coverage: z.literal("retained_origin_requests_not_edge_pageviews"),
});
export type OriginRequestTraffic = z.infer<typeof originRequestTrafficSchema>;
const schema = z.object({
  version: z.literal(1), product: z.literal("mealscout"),
  hours: z.union([z.literal(6), z.literal(24), z.literal(48)]),
  from: z.string().datetime(), toExclusive: z.string().datetime(),
  recordedRows: count, entryEvents: count, actionEvents: count, profileQualityReports: count, otherRecords: count,
  classifiedAcquisitionEvents: count, candidateJourneys: count.nullable(), candidateJourneysWithAction: count.nullable(),
  quality: z.array(z.object({ classification: z.enum(QUALITY_CLASSES), entryEvents: count, actionEvents: count, qualityReports: count, otherRecords: count })).max(QUALITY_CLASSES.length),
  sources: z.array(z.object({ source: z.enum(SOURCE_GROUPS), journeys: count, journeysWithAction: count })).max(SOURCE_GROUPS.length),
  originRequests: originRequestTrafficSchema.nullable().optional().default(null),
  verifiedPeople: z.null(), searchImpressions: z.null(), searchClicks: z.null(), verifiedCustomerOutcomes: z.null(),
  coverage: z.literal("available_retained_records_not_guaranteed_complete"),
});
export type AcquisitionQualityReport = z.infer<typeof schema>;
export function parseAcquisitionHours(value: unknown): 6 | 24 | 48 {
  if (value === undefined) return 24;
  if (value !== "6" && value !== "24" && value !== "48") throw new Error("Choose a 6, 24, or 48 hour window.");
  return Number(value) as 6 | 24 | 48;
}
export function parseAcquisitionQualityReport(value: unknown): AcquisitionQualityReport {
  const r = schema.parse(value);
  const duration = Date.parse(r.toExclusive) - Date.parse(r.from);
  if (duration !== r.hours * 3600000) throw new Error("Report window mismatch.");
  if (new Set(r.quality.map(q => q.classification)).size !== r.quality.length || new Set(r.sources.map(s => s.source)).size !== r.sources.length) throw new Error("Duplicate aggregate groups.");
  for (const [field, total] of [["entryEvents", r.entryEvents], ["actionEvents", r.actionEvents], ["qualityReports", r.profileQualityReports], ["otherRecords", r.otherRecords]] as const) {
    if (r.quality.reduce((sum, row) => sum + row[field], 0) !== total) throw new Error("Aggregate counts do not reconcile.");
  }
  if (r.recordedRows !== r.entryEvents + r.actionEvents + r.profileQualityReports + r.otherRecords) throw new Error("Aggregate counts do not reconcile.");
  const classified = r.quality.filter(q => q.classification !== "unclassified" && q.classification !== "legacy_unclassified").reduce((sum, q) => sum + q.entryEvents + q.actionEvents, 0);
  if (classified !== r.classifiedAcquisitionEvents) throw new Error("Classification counts do not reconcile.");
  if ((classified === 0) !== (r.candidateJourneys === null) || (classified === 0) !== (r.candidateJourneysWithAction === null)) throw new Error("Missing evidence must remain unavailable.");
  if (r.sources.reduce((sum, s) => sum + s.journeys, 0) !== (r.candidateJourneys ?? 0) || r.sources.reduce((sum, s) => sum + s.journeysWithAction, 0) !== (r.candidateJourneysWithAction ?? 0)) throw new Error("Source counts do not reconcile.");
  if (r.sources.some(s => s.journeysWithAction > s.journeys)) throw new Error("Action counts exceed journeys.");
  const browserEntries = r.quality.find(q => q.classification === "browser_candidate")?.entryEvents ?? 0;
  if ((r.candidateJourneys ?? 0) > browserEntries) throw new Error("Candidate journeys exceed browser-shaped entry events.");
  if (r.originRequests) {
    const o = r.originRequests;
    if (o.totalRequests !== o.infrastructureMonitorRequests + o.discoveryCrawlerRequests + o.automationRequests + o.browserShapedRequests + o.unclassifiedRequests || o.errorRequests > o.totalRequests) throw new Error("Origin request counts do not reconcile.");
  }
  return r;
}
