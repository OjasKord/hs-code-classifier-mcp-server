export const VERSION = '1.0.29';
// Caching/staleness policy per tool, in seconds. HS codes are stable -- 30 days.
export const VERDICT_TTL = { hs_classify_product: 2592000, hs_validate_code: 2592000 } as const;
export const FIRST_DEPLOYED = '2026-04-24T03:49:31Z';
export const LIFETIME_CALLS_REDIS_KEY = 'hs:lifetime_calls';
export const UPTIME_HEARTBEAT_KEY = 'hs:uptime:heartbeat_count';
export const UPTIME_MONITORING_START_KEY = 'hs:uptime:monitoring_started';
export const UPTIME_HEARTBEAT_INTERVAL_MS = 60000;
export const FLEET_IP24_TTL_SECONDS = 30 * 24 * 60 * 60;
export const FLEET_CROSS_SERVER_THRESHOLD = 3;
export const PRO_UPGRADE_URL = 'https://buy.stripe.com/fZubJ06o58Dj3BG8Nyebu0v';
export const ENTERPRISE_UPGRADE_URL = 'https://buy.stripe.com/6oU3cu5k12eVegk3teebu0w';
export const ALLOWED_PAYMENT_LINK_IDS = ['plink_1TQzKrD6WvRe6sn3joY8o75q', 'plink_1TQzM4D6WvRe6sn355cMv035'];
export const CHARACTER_LIMIT = 25000;
export const HSPING_BASE_URL = 'https://api.hsping.com/api/v1/find';
export const FREE_TIER_MONTHLY_LIMIT = 10;
export const FREE_TIER_WARNING_THRESHOLD = 8;
export const TRIAL_EXTENSION_CALLS = 10;
export const PERSIST_FILE = '/tmp/hs_classifier_stats.json';
export const FREE_TIER_REDIS_KEY = 'hs:free_tier_usage';

export const LEGAL_DISCLAIMER =
  'Results sourced directly from official government tariff schedules via HSPing API (api.hsping.com). ' +
  'HS code classification is subject to customs authority interpretation and may vary by jurisdiction. ' +
  'Results are for informational purposes only and do not constitute legal, compliance, or customs advice. ' +
  'We do not log or store your query content. ' +
  'Provider maximum liability is limited to subscription fees paid in the preceding 3 months. ' +
  'Full terms: kordagencies.com/terms.html';

export function nowISO(): string {
  return new Date().toISOString();
}
