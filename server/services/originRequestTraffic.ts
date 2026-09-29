import { originRequestTrafficSchema } from "../../shared/acquisitionQuality";
import {
  HEALTH_REQUEST_PATH_PATTERN, MONITOR_USER_AGENT_PATTERN,
  AUTOMATION_USER_AGENT_PATTERN, CRAWLER_USER_AGENT_PATTERN,
  GENERIC_AUTOMATION_USER_AGENT_PATTERN,
} from "../../shared/discoveryTrafficPatterns";
import type { AcquisitionQueryClient } from "./acquisitionQuality";

/** Aggregate existing origin logs; never trust the legacy default actor_type='human'.
 * User-agent matches remain claimed signals, not verified crawler identities.
 * No raw IP, referrer, URL query, session, or user-agent leaves this query.
 */
export const ORIGIN_REQUEST_TRAFFIC_SQL = String.raw`
WITH observed AS (
  SELECT status_code,
    CASE
      WHEN lower(split_part(coalesce(path,''),'?',1)) ~ '${HEALTH_REQUEST_PATH_PATTERN}'
        OR coalesce(user_agent,'') ~* '${MONITOR_USER_AGENT_PATTERN}' THEN 'infrastructure_monitor'
      WHEN coalesce(user_agent,'') ~* '${AUTOMATION_USER_AGENT_PATTERN}' THEN 'automation_signal'
      WHEN coalesce(user_agent,'') ~* '${CRAWLER_USER_AGENT_PATTERN}' THEN 'discovery_crawler'
      WHEN coalesce(user_agent,'') ~* '${GENERIC_AUTOMATION_USER_AGENT_PATTERN}' THEN 'automation_signal'
      WHEN coalesce(user_agent,'') ~ '^Mozilla/5\.0' AND coalesce(user_agent,'') ~ '(AppleWebKit|Gecko/)' THEN 'browser_shaped'
      ELSE 'unclassified'
    END AS classification
  FROM public.request_logs
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    AND method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS')
    AND surface IN ('web','restaurant_profile','search','category','map','events')
)
SELECT jsonb_build_object(
  'totalRequests', count(*),
  'infrastructureMonitorRequests', count(*) FILTER (WHERE classification='infrastructure_monitor'),
  'discoveryCrawlerRequests', count(*) FILTER (WHERE classification='discovery_crawler'),
  'automationRequests', count(*) FILTER (WHERE classification='automation_signal'),
  'browserShapedRequests', count(*) FILTER (WHERE classification='browser_shaped'),
  'unclassifiedRequests', count(*) FILTER (WHERE classification='unclassified'),
  'errorRequests', count(*) FILTER (WHERE status_code >= 400),
  'coverage', 'retained_origin_requests_not_edge_pageviews'
) AS report FROM observed;
`;

export async function readOriginRequestTraffic(client: AcquisitionQueryClient, from: string, toExclusive: string) {
  const result = await client.query(ORIGIN_REQUEST_TRAFFIC_SQL, [from, toExclusive]);
  // Missing projection is unavailable, never an invented zero request count.
  const report = result.rows?.[0]?.report;
  return report == null ? null : originRequestTrafficSchema.parse(report);
}
