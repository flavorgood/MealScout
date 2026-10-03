/** Shared, conservative request-signal patterns. These never verify a person or bot identity.
 * Keep the expressions compatible with JavaScript and PostgreSQL ARE regexes.
 */
export const HEALTH_REQUEST_PATH_PATTERN = "^/(api/)?health(/|$)";
export const MONITOR_USER_AGENT_PATTERN = String.raw`(uptimerobot|better uptime|betterstack|pingdom|statuscake|site24x7|healthchecks\.io)`;
export const AUTOMATION_USER_AGENT_PATTERN = "(headless|playwright|puppeteer|selenium|curl/|wget/|python-requests|httpx|node-fetch|undici|postman|sway-runtime-proof|mealscout.*(proof|qa|smoke))";
export const CRAWLER_USER_AGENT_PATTERN = "(googlebot|bingbot|oai-searchbot|chatgpt-user|claudebot|claude-searchbot|claude-user|anthropic-ai|gptbot|perplexitybot|perplexity-user|ccbot|cohere-ai|facebookexternalhit|ahrefsbot|semrushbot|duckduckbot|applebot|bytespider|yandexbot)";
export const GENERIC_AUTOMATION_USER_AGENT_PATTERN = "(bot([^a-z]|$)|crawler|spider|google-inspectiontool)";
