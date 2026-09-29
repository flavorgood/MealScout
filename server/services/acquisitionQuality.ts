import { parseAcquisitionQualityReport } from "../../shared/acquisitionQuality";
import { readOriginRequestTraffic } from "./originRequestTraffic";

/** Stored request evidence only. Profile errors never create entry/action facts. */
export const ACQUISITION_QUALITY_SQL = `
WITH rows AS (
  SELECT id, created_at,
    coalesce(nullif(metadata->>'anonymousJourneyId',''),nullif(anonymous_actor_id,''),nullif(session_id,'')) AS journey,
    CASE WHEN metadata#>>'{trafficQuality,basis}'='server_observed_request_signals'
      AND ((metadata#>>'{trafficQuality,version}'='1'
        AND metadata#>>'{trafficQuality,classification}' IN ('browser_candidate','automation_signal','qa_signal','unclassified'))
        OR (metadata#>>'{trafficQuality,version}'='2'
        AND metadata#>>'{trafficQuality,classification}' IN ('browser_candidate','discovery_crawler','infrastructure_monitor','automation_signal','qa_signal','unclassified')))
      THEN metadata#>>'{trafficQuality,classification}'
      WHEN coalesce(metadata,'{}'::jsonb) ? 'trafficQuality' THEN 'unclassified' ELSE 'legacy_unclassified' END AS classification,
    CASE WHEN metadata->>'evidenceKind'='client_reported_profile_quality'
      OR event_type IN ('public_profile_page_error','public_profile_not_found_viewed','missing_menu_viewed','missing_schedule_viewed','failed_profile_image') THEN 'quality'
      WHEN event_type='profile_view' OR metadata->>'discoveryStage'='entry'
        OR (surface='public_discovery' AND metadata->>'discoveryEventType'='discovery_page_view')
        OR (surface='discovery_observatory' AND metadata->>'stage'='entry') THEN 'entry'
      WHEN event_type IN ('profile_action','conversion_intent') OR metadata->>'discoveryStage'='action'
        OR (surface='discovery_observatory' AND metadata->>'stage'='action' AND coalesce(metadata->>'discoverySource','') <> 'internal_search') THEN 'action'
      ELSE 'other' END AS kind,
    CASE WHEN lower(coalesce(metadata->>'discoverySource',metadata->>'source','')) IN ('google','google_maps','bing') THEN 'search_labeled'
      WHEN lower(coalesce(metadata->>'discoverySource',metadata->>'source','')) IN ('chatgpt','openai','perplexity','claude') THEN 'ai_labeled'
      WHEN lower(coalesce(metadata->>'discoverySource',metadata->>'source','')) IN ('facebook','instagram') THEN 'social_labeled'
      WHEN lower(coalesce(metadata->>'discoverySource',metadata->>'source','')) IN ('','unknown','direct') THEN 'direct_or_unknown'
      ELSE 'other_labeled' END AS source
  FROM public.request_logs
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    AND surface IN ('public_profile','public_discovery','discovery_observatory')
), groups AS (
  SELECT classification,
    count(*) FILTER(WHERE kind='entry')::int AS "entryEvents",
    count(*) FILTER(WHERE kind='action')::int AS "actionEvents",
    count(*) FILTER(WHERE kind='quality')::int AS "qualityReports",
    count(*) FILTER(WHERE kind='other')::int AS "otherRecords"
  FROM rows GROUP BY classification
), entries AS (
  SELECT DISTINCT ON (e.journey) e.journey,e.source,e.created_at
  FROM rows e WHERE e.kind='entry' AND e.classification='browser_candidate' AND e.journey IS NOT NULL
    -- All retained events on the same discovery surfaces can exclude a journey.
    -- This preserves existing identity precedence and raw-log retention.
    AND NOT EXISTS(
      SELECT 1 FROM public.request_logs bad
      WHERE bad.surface IN ('public_profile','public_discovery','discovery_observatory')
        AND coalesce(nullif(bad.metadata->>'anonymousJourneyId',''),nullif(bad.anonymous_actor_id,''),nullif(bad.session_id,''))=e.journey
        AND bad.metadata#>>'{trafficQuality,basis}'='server_observed_request_signals'
        AND ((bad.metadata#>>'{trafficQuality,version}'='1'
          AND bad.metadata#>>'{trafficQuality,classification}' IN ('automation_signal','qa_signal'))
          OR (bad.metadata#>>'{trafficQuality,version}'='2'
          AND bad.metadata#>>'{trafficQuality,classification}' IN ('automation_signal','qa_signal','discovery_crawler','infrastructure_monitor')))
    )
  ORDER BY e.journey,e.created_at,e.id
), candidates AS (
  SELECT e.*,EXISTS(SELECT 1 FROM rows a WHERE a.journey=e.journey AND a.kind='action'
    AND a.classification='browser_candidate' AND a.created_at >= e.created_at) AS acted FROM entries e
), sources AS (
  SELECT source,count(*)::int AS journeys,count(*) FILTER(WHERE acted)::int AS "journeysWithAction"
  FROM candidates GROUP BY source
), classified AS (
  SELECT count(*)::int AS total FROM rows WHERE kind IN ('entry','action') AND classification <> 'legacy_unclassified'
)
SELECT jsonb_build_object(
  'recordedRows',(SELECT count(*) FROM rows),
  'entryEvents',(SELECT count(*) FROM rows WHERE kind='entry'),
  'actionEvents',(SELECT count(*) FROM rows WHERE kind='action'),
  'profileQualityReports',(SELECT count(*) FROM rows WHERE kind='quality'),
  'otherRecords',(SELECT count(*) FROM rows WHERE kind='other'),
  'classifiedAcquisitionEvents',(SELECT total FROM classified),
  'candidateJourneys',CASE WHEN (SELECT total FROM classified)>0 THEN (SELECT count(*) FROM candidates) ELSE NULL END,
  'candidateJourneysWithAction',CASE WHEN (SELECT total FROM classified)>0 THEN (SELECT count(*) FROM candidates WHERE acted) ELSE NULL END,
  'quality',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY classification) FROM groups g),'[]'::jsonb),
  'sources',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY source) FROM sources s),'[]'::jsonb),
  'verifiedPeople',NULL,'searchImpressions',NULL,'searchClicks',NULL,'verifiedCustomerOutcomes',NULL
) AS report;
`;
export type AcquisitionQueryClient = { query: (text: string, values?: any[]) => Promise<any>; release: () => void };
export async function readAcquisitionQuality(
  client: AcquisitionQueryClient,
  hours: 6 | 24 | 48,
  now = new Date(),
  options: { includeOriginRequests?: boolean } = {},
) {
  if (![6,24,48].includes(hours) || !Number.isFinite(now.getTime())) throw new Error("Invalid report window.");
  const from = new Date(now.getTime() - hours * 3600000).toISOString(), toExclusive = now.toISOString();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await client.query(ACQUISITION_QUALITY_SQL, [from,toExclusive]);
    const originRequests = options.includeOriginRequests
      ? await readOriginRequestTraffic(client, from, toExclusive)
      : null;
    const report = parseAcquisitionQualityReport({ ...result.rows?.[0]?.report, originRequests, version:1, product:"mealscout", hours, from, toExclusive, coverage:"available_retained_records_not_guaranteed_complete" });
    await client.query("COMMIT");
    return report;
  } catch(error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
}
