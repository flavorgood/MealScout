import { Request, Response, NextFunction } from 'express';

// Allow TradeScout crawler and common browsers; block obvious scrapers.
// Public HTML pages must stay readable by link-preview fetchers and uptime
// monitors: many of them fetch with generic library user agents (or a named
// bot agent), and answering them 403 made shared links render no preview and
// made healthy pages look down. The signature ban below therefore only stops
// non-GET/HEAD requests; page reads are public by design, and the data APIs
// keep their own auth and rate limiting (API routes skip this middleware).
const allowedBots = ['TradeScout', 'tradescout'];
const allowedBrowsers = ['Chrome', 'Firefox', 'Safari', 'Edge', 'OPR', 'Brave'];
const bannedSignatures = ['curl', 'python', 'wget', 'httpclient', 'libwww', 'scrapy', 'postman'];
const knownSearchOrLlmBots =
  /(googlebot|google-inspectiontool|bingbot|bingpreview|adidxbot|duckduckbot|applebot|yandex|baiduspider|facebookexternalhit|facebot|facebookbot|meta-externalagent|meta-externalfetcher|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegrambot|pinterest|embedly|skypeuripreview|gptbot|oai-searchbot|chatgpt-user|claudebot|anthropic-ai|perplexitybot|bytespider|ccbot|cohere-ai)/i;
const knownPreviewOrMonitorAgents =
  /(uptimerobot|pingdom|statuscake|site24x7|uptime-kuma|uptimekuma|hetrixtools|betterstack|checkly|freshping|downnotifier|healthchecks|cronitor|montastic|gtmetrix)/i;

const isSeoCriticalPath = (path: string) => {
  const value = String(path || "").toLowerCase();
  const indexNowKey = String(process.env.INDEXNOW_KEY || "")
    .trim()
    .toLowerCase();
  const indexNowKeyPath = indexNowKey ? `/${indexNowKey}.txt` : "";
  return (
    value === "/robots.txt" ||
    value === "/llms.txt" ||
    value === "/ai.txt" ||
    (indexNowKeyPath && value === indexNowKeyPath) ||
    value === "/sitemap.xml" ||
    /^\/sitemap[\w-]*\.xml$/.test(value)
  );
};

export function antiScrape(req: Request, res: Response, next: NextFunction) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();

  if (isSeoCriticalPath(req.path || req.url || "")) return next();

  // Always allow API routes that require auth
  if (req.path.startsWith('/api/')) return next();

  // Allow known browser UAs
  const isBrowser = allowedBrowsers.some((b) => ua.includes(b.toLowerCase()));

  // Allow TradeScout crawler explicitly
  const isTradeScout = allowedBots.some((b) => ua.includes(b.toLowerCase()));
  const isKnownCrawler = knownSearchOrLlmBots.test(ua);
  const isKnownPreviewOrMonitor = knownPreviewOrMonitorAgents.test(ua);

  if (isTradeScout || isKnownCrawler || isKnownPreviewOrMonitor) return next();

  // Block obvious scraper signatures — but never for plain page reads
  // (GET/HEAD). Link previews and uptime checks are page reads, whatever
  // library user agent they arrive with; writes and other methods carrying
  // a scraper signature are still refused.
  const isBanned = bannedSignatures.some((b) => ua.includes(b));
  const isPageRead = req.method === 'GET' || req.method === 'HEAD';

  if (isBanned && !isBrowser && !isPageRead) {
    return res.status(403).send('Scraping is not permitted.');
  }

  // Allow indexing for legitimate browsers and bots; do not set noindex
  // Keep middleware as a guard without blocking search engines
  return next();
}
