import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import axios from 'axios';

import { VERSION, PERSIST_FILE, LEGAL_DISCLAIMER, nowISO, PRO_UPGRADE_URL, TRIAL_EXTENSION_CALLS, FREE_TIER_REDIS_KEY, FREE_TIER_MONTHLY_LIMIT, ALLOWED_PAYMENT_LINK_IDS, FIRST_DEPLOYED, LIFETIME_CALLS_REDIS_KEY, UPTIME_HEARTBEAT_KEY, UPTIME_MONITORING_START_KEY, UPTIME_HEARTBEAT_INTERVAL_MS } from './constants.js';
import { REDIS_PREFIX, redisGet, redisSet, redisKeys, redisDelete, appendSessionLog, redisIncr, initUptimeTracking, recordFleetGateHit, buildCrossServerNote } from './services/redis.js';
import type { Stats, DependencyStatus, ServerCard } from './types.js';
import { ClassifyInputSchema, ClassifyOutputSchema, ResponseFormat } from './schemas/classify.js';
import { ValidateInputSchema, ValidateOutputSchema } from './schemas/validate.js';
import { runClassify, formatClassifyResponse, checkFreeTierGate } from './tools/classify.js';
import { runValidate, formatValidateResponse } from './tools/validate.js';
import { checkHSPingHealth } from './services/hsping-client.js';

// jose@6 (pulled in transitively by @coinbase/x402 for mainnet CDP auth) is a WebCrypto-only
// build that references a bare global `crypto`. Node 20+ exposes that global by default; Node
// 18 does not unless run with --experimental-global-webcrypto. Polyfilling here is a no-op
// wherever the global already exists. Ported verbatim from quantum-suitability-validator's arm.
if (!(globalThis as unknown as { crypto?: unknown }).crypto) {
  (globalThis as unknown as { crypto: unknown }).crypto = crypto.webcrypto;
}

// ---------------------------------------------------------------------------
// Request context (set per HTTP request; stdio uses env fallback)
// ---------------------------------------------------------------------------
let currentIP = '127.0.0.1';
let currentApiKey = '';
let currentUserAgent = '';
let currentOwnerKey = '';
let currentPaymentSignature = '';
let currentRes: import('express').Response | null = null;  // captured so x402 headers (no raw res inside MCP SDK tool handlers) can still be set

const OWNER_KEY = process.env.OWNER_KEY ?? '';
const isOwner = (): boolean => OWNER_KEY !== '' && currentOwnerKey === OWNER_KEY;

// ---------------------------------------------------------------------------
// X402 (mainnet Base) -- port of quantum-suitability-validator-mcp-server's hardened
// x402 integration (itself ported from tender-mcp's v1.3.4+ CJS arm).
// Zero-regression contract: every x402 code path below is gated behind X402_ENABLED,
// which is false unless X402_PAY_TO is set. With it unset, none of this runs -- byte-
// identical to pre-x402 behaviour. Only hs_classify_product is priced -- hs_validate_code
// stays paid-key-only, out of scope for this pass.
// ---------------------------------------------------------------------------
const X402_PAY_TO = process.env.X402_PAY_TO ?? '';
const X402_NETWORK_ENV = process.env.X402_NETWORK ?? 'base-sepolia';
const X402_CAIP_NETWORK: string | null =
  ({ 'base-sepolia': 'eip155:84532', base: 'eip155:8453' } as Record<string, string>)[X402_NETWORK_ENV] ?? null;
const X402_FACILITATOR_URL: string | null =
  ({ 'base-sepolia': 'https://x402.org/facilitator', base: 'https://api.cdp.coinbase.com/platform/v2/x402' } as Record<string, string>)[X402_NETWORK_ENV] ?? null;
const X402_ENABLED = !!(X402_PAY_TO && X402_CAIP_NETWORK && X402_FACILITATOR_URL);
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID ?? '';
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET ?? '';
const TOOL_PRICES: Record<string, string> = { hs_classify_product: '$0.015' };

let x402Server: any = null;
let x402Ready = false;
let decodePaymentSignatureHeader: ((header: string) => any) | null = null;
let encodePaymentRequiredHeader: ((paymentRequired: any) => string) | null = null;
let encodePaymentResponseHeader: ((settleResponse: any) => string) | null = null;
let declareDiscoveryExtension: ((opts: any) => any) | null = null;
let X402_DISCOVERY_EXTENSIONS: Record<string, any> = {};

if (X402_ENABLED) {
  if (X402_NETWORK_ENV === 'base' && (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET)) {
    throw new Error('[x402] X402_NETWORK=base requires CDP_API_KEY_ID and CDP_API_KEY_SECRET -- the CDP mainnet facilitator rejects unauthenticated verify/settle calls. Refusing to start with a dead payment rail.');
  }

  // Pure ESM ("type":"module") -- no require() available, so dynamic import() is the only way
  // to load these packages conditionally on X402_ENABLED rather than unconditionally at boot.
  Promise.all([
    import('@x402/core/server'),
    import('@x402/core/http'),
    import('@x402/evm/exact/server'),
    import('@x402/extensions/bazaar'),
    X402_NETWORK_ENV === 'base' ? import('@coinbase/x402') : Promise.resolve(null)
  ]).then(([core, http, evm, bazaarExt, coinbase]) => {
    decodePaymentSignatureHeader = http.decodePaymentSignatureHeader;
    encodePaymentRequiredHeader = http.encodePaymentRequiredHeader;
    encodePaymentResponseHeader = http.encodePaymentResponseHeader;
    declareDiscoveryExtension = bazaarExt.declareDiscoveryExtension;

    const facilitatorConfig =
      X402_NETWORK_ENV === 'base' && coinbase
        ? coinbase.createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)
        : { url: X402_FACILITATOR_URL };

    x402Server = new core.x402ResourceServer(new core.HTTPFacilitatorClient(facilitatorConfig));
    evm.registerExactEvmScheme(x402Server, {});
    x402Server.registerExtension(bazaarExt.bazaarResourceServerExtension);

    X402_DISCOVERY_EXTENSIONS.hs_classify_product = declareDiscoveryExtension!({
      toolName: 'hs_classify_product',
      description: CLASSIFY_DESCRIPTION.slice(0, 500),
      inputSchema: { type: 'object', properties: { product_description: { type: 'string' } }, required: ['product_description'] },
      example: { product_description: 'solid oak dining chair with upholstered seat' },
      output: { example: { hs_code: '940360', description: 'Wooden furniture for domestic purposes', confidence: 0.95 } }
    });

    return x402Server.initialize();
  }).then(() => {
    x402Ready = true;
    console.log('[x402] resource server initialized — network=' + X402_CAIP_NETWORK + ' facilitator=' + X402_FACILITATOR_URL);
  }).catch((e: Error) => {
    console.error('[x402] facilitator setup failed:', e.message);
    if (X402_NETWORK_ENV === 'base') process.exit(1);
  });
}

async function logX402SettleFailure(details: Record<string, unknown>): Promise<void> {
  const monthKey = REDIS_PREFIX + ':x402_settle_failures:' + new Date().toISOString().slice(0, 7);
  redisIncr(monthKey).catch(() => {});
  redisSet(REDIS_PREFIX + ':x402_settle_failure:last', Object.assign({ at: nowISO() }, details)).catch(() => {});
  console.error('[x402] SETTLE FAILED — not charging, not delivering paid result:', JSON.stringify(details));
}

// Verifies a payment attached via the PAYMENT-SIGNATURE header (captured into
// currentPaymentSignature by the /mcp handler before transport handoff, since MCP SDK tool
// handlers don't receive the raw Express req). Returns null (not an error) if x402 isn't
// enabled, the tool isn't priced, no payment header is present, or the payment doesn't verify --
// all of these mean "fall through to normal free-tier/gate behaviour", not "reject".
async function checkX402Payment(paymentSignature: string, toolName: string): Promise<{ payload: any; requirements: any } | null> {
  if (!X402_ENABLED || !x402Server || !decodePaymentSignatureHeader) return null;
  const price = TOOL_PRICES[toolName];
  if (!price || !paymentSignature) return null;
  let payload;
  try { payload = decodePaymentSignatureHeader(paymentSignature); }
  catch { return null; }
  let requirements;
  try {
    const built = await x402Server.buildPaymentRequirements({ scheme: 'exact', payTo: X402_PAY_TO, price, network: X402_CAIP_NETWORK, maxTimeoutSeconds: 60 });
    requirements = built[0];
  } catch (e) { console.error('[x402] buildPaymentRequirements failed:', (e as Error).message); return null; }
  let verifyResult;
  try { verifyResult = await x402Server.verifyPayment(payload, requirements); }
  catch (e) { console.error('[x402] verifyPayment failed:', (e as Error).message); return null; }
  if (!verifyResult || !verifyResult.isValid) return null;
  return { payload, requirements };
}

const perMinuteUsage = new Map<string, number>();

function checkPerMinuteLimit(ip: string, toolName: string, limit: number): boolean {
  const minuteKey = ip + ':' + toolName + ':' + new Date().toISOString().slice(0, 16);
  const count = perMinuteUsage.get(minuteKey) ?? 0;
  if (count >= limit) return false;
  perMinuteUsage.set(minuteKey, count + 1);
  if (perMinuteUsage.size > 10000) {
    const currentMinute = new Date().toISOString().slice(0, 16);
    for (const [key] of perMinuteUsage) {
      if (!key.includes(currentMinute)) perMinuteUsage.delete(key);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stats persistence
// ---------------------------------------------------------------------------
function loadStats(): Stats {
  try {
    const raw = fs.readFileSync(PERSIST_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Stats;
    if (!parsed.trial_extensions) parsed.trial_extensions = {};
    return parsed;
  } catch {
    return {
      free_tier_calls_by_ip: {},
      paid_calls: 0,
      total_calls: 0,
      classify_calls: 0,
      validate_calls: 0,
      paid_api_keys: {},
      trial_extensions: {}
    };
  }
}

function saveStats(stats: Stats): void {
  try { fs.writeFileSync(PERSIST_FILE, JSON.stringify(stats)); } catch { /* /tmp reset is expected */ }
}

let stats = loadStats();

function incrementFreeTier(ip: string): void {
  const month = new Date().toISOString().slice(0, 7);
  if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
  stats.free_tier_calls_by_ip[ip][month] = (stats.free_tier_calls_by_ip[ip][month] ?? 0) + 1;
  saveStats(stats);
  saveFreeTierToRedis().catch(() => {});
}

function getEffectiveLimit(ip: string): number {
  const hasExtension = Object.values(stats.trial_extensions).some(ext => ext.ip === ip);
  return hasExtension ? FREE_TIER_MONTHLY_LIMIT + TRIAL_EXTENSION_CALLS : FREE_TIER_MONTHLY_LIMIT;
}

async function saveKeyToRedis(apiKey: string, record: Stats['paid_api_keys'][string]): Promise<void> {
  await redisSet(`${REDIS_PREFIX}:key:${apiKey}`, record);
}

async function loadApiKeysFromRedis(): Promise<void> {
  const keys = await redisKeys(`${REDIS_PREFIX}:key:*`);
  for (const redisKey of keys) {
    const record = await redisGet(redisKey);
    if (record) {
      const apiKey = redisKey.replace(`${REDIS_PREFIX}:key:`, '');
      stats.paid_api_keys[apiKey] = record as Stats['paid_api_keys'][string];
    }
  }
  console.error(`[hs] Loaded ${Object.keys(stats.paid_api_keys).length} API keys from Redis`);
}

async function loadFreeTierFromRedis(): Promise<void> {
  try {
    const data = await redisGet(FREE_TIER_REDIS_KEY);
    if (data && typeof data === 'object') {
      Object.assign(stats.free_tier_calls_by_ip, data as Record<string, Record<string, number>>);
      console.error('[FreeTier] Loaded ' + Object.keys(stats.free_tier_calls_by_ip).length + ' IPs from Redis');
    }
  } catch (e) { console.error('[FreeTier] load failed:', e); }
}

async function saveFreeTierToRedis(): Promise<void> {
  try {
    const existing = (await redisGet(FREE_TIER_REDIS_KEY) as Record<string, Record<string, number>> | null) ?? {};
    for (const [ip, months] of Object.entries(stats.free_tier_calls_by_ip)) {
      if (!existing[ip]) existing[ip] = {};
      for (const [month, count] of Object.entries(months)) {
        existing[ip][month] = Math.max(existing[ip][month] ?? 0, count);
      }
    }
    await redisSet(FREE_TIER_REDIS_KEY, existing);
  } catch (e) { console.error('[FreeTier] save failed:', e); }
}

function isPaidKey(key: string): boolean {
  return key.length > 0 && Object.prototype.hasOwnProperty.call(stats.paid_api_keys, key);
}

// Redis-independent circuit breaker for the email paths that remain after
// raw gate-hit emails were removed 2026-07-27 (trial-extension request +
// payment events only). Caps total sends server-wide so a flood of fake
// trial-extension requests can't exhaust the fleet's shared Resend quota
// even if Redis-backed dedup elsewhere is unavailable (Lesson 209).
const EMAIL_CIRCUIT_BREAKER_LIMIT = 20;
let emailBreakerCount = 0;
let emailBreakerWindowStart = Date.now();
function emailCircuitBreakerAllows(): boolean {
  const now = Date.now();
  if (now - emailBreakerWindowStart > 3600000) { emailBreakerWindowStart = now; emailBreakerCount = 0; }
  if (emailBreakerCount >= EMAIL_CIRCUIT_BREAKER_LIMIT) return false;
  emailBreakerCount++;
  return true;
}

// One trial extension per IP, ever (2026-08-19). Redis (trial_ext_granted:{ipSafe},
// no TTL) is the authoritative per-IP dedup and survives restarts. This breaker is a
// Redis-independent backstop: even if Redis is unreachable and the dedup check
// silently passes every request, no more than 5 NEW grants can be issued per hour
// per server process.
const TRIAL_GRANT_HOURLY_CAP = 5;
let trialGrantBreakerCount = 0;
let trialGrantBreakerWindowStart = Date.now();
function trialGrantCircuitBreakerAllows(): boolean {
  const now = Date.now();
  if (now - trialGrantBreakerWindowStart > 3600000) { trialGrantBreakerWindowStart = now; trialGrantBreakerCount = 0; }
  if (trialGrantBreakerCount >= TRIAL_GRANT_HOURLY_CAP) return false;
  trialGrantBreakerCount++;
  return true;
}

function ipSafeKey(ip: string): string {
  return ip.replace(/:/g, '_').replace(/\s/g, '');
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  if (!emailCircuitBreakerAllows()) { console.error('[EmailBreaker] suppressed email to ' + to + ' — hourly cap reached'); return; }
  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: 'Kord Agencies <ojas@kordagencies.com>', to: [to], subject, html },
      { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
    );
  } catch { /* email failure is non-fatal */ }
}

function getStatsPayload(): Record<string, unknown> {
  const month = new Date().toISOString().slice(0, 7);
  let freeTierUnique = 0;
  let freeTierTotal = 0;
  const breakdown: Record<string, number> = {};
  for (const [ip, months] of Object.entries(stats.free_tier_calls_by_ip)) {
    if (months[month] !== undefined) {
      freeTierUnique++;
      freeTierTotal += months[month];
      breakdown[ip.slice(0, 10) + '...'] = months[month];
    }
  }
  return {
    total_calls: stats.total_calls,
    paid_calls: stats.paid_calls,
    free_calls: stats.total_calls - stats.paid_calls,
    classify_calls: stats.classify_calls,
    validate_calls: stats.validate_calls,
    free_tier_unique_ips: freeTierUnique,
    free_tier_total_calls: freeTierTotal,
    free_tier_breakdown: breakdown,
    paid_api_keys_count: Object.keys(stats.paid_api_keys).length,
    trial_extensions_granted: Object.keys(stats.trial_extensions).length,
    checked_at: nowISO()
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
function verifyStripeSignature(body: string, sig: string, secret: string): boolean {
  if (!secret || !sig) return false;
  try {
    const parts = sig.split(',').reduce((acc: Record<string, string>, part) => {
      const [k, v] = part.split('=');
      if (k && v) acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const expected = parts['v1'];
    if (!timestamp || !expected) return false;
    const computed = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
  } catch { return false; }
}

function generateApiKey(): string {
  return `hsc_${crypto.randomBytes(24).toString('hex')}`;
}

async function findCheckoutSessionEmail(paymentIntentId: string): Promise<string | undefined> {
  const res = await axios.get('https://api.stripe.com/v1/checkout/sessions', {
    params: { payment_intent: paymentIntentId },
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const session = res.data?.data?.[0];
  return session?.customer_details?.email ?? session?.customer_email ?? undefined;
}

async function handleStripeEvent(event: Record<string, unknown>): Promise<void> {
  if (event['type'] === 'charge.refunded') {
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('[hs] STRIPE_SECRET_KEY not set — cannot revoke key on refund');
      return;
    }
    const charge = (event['data'] as Record<string, unknown> | undefined)?.['object'] as Record<string, unknown> | undefined;
    const paymentIntentId = charge?.['payment_intent'] as string | undefined;
    if (!paymentIntentId) {
      console.error('[hs] charge.refunded missing payment_intent — ignoring.');
      return;
    }
    try {
      const email = await findCheckoutSessionEmail(paymentIntentId);
      if (!email) {
        console.error('[hs] No checkout session/email found for refunded payment_intent ' + paymentIntentId);
        return;
      }
      const revokedKey = Object.keys(stats.paid_api_keys).find(k => stats.paid_api_keys[k]?.email === email);
      if (!revokedKey) {
        console.error('[hs] No API key found for ' + email + ' — refund received, nothing to revoke');
        return;
      }
      delete stats.paid_api_keys[revokedKey];
      await redisDelete(`${REDIS_PREFIX}:key:${revokedKey}`);
      saveStats(stats);
      console.error('[Webhook] API key revoked for ' + email + ' — refund received');
    } catch (err) {
      console.error('[hs] charge.refunded handling error:', err);
    }
    return;
  }

  if (event['type'] !== 'checkout.session.completed') return;

  const session = event['data'] as Record<string, unknown> | undefined;
  const obj = session?.['object'] as Record<string, unknown> | undefined;
  const paymentLinkId = obj?.['payment_link'] as string | undefined;
  if (paymentLinkId && !ALLOWED_PAYMENT_LINK_IDS.includes(paymentLinkId)) {
    console.error('[stripe] Webhook received but payment link ' + paymentLinkId + ' not for this server — ignoring.');
    return;
  }
  const email = obj?.['customer_email'] as string | undefined ?? 'unknown';
  const plan = (obj?.['metadata'] as Record<string, string> | undefined)?.['plan'] ?? 'pro';

  const apiKey = generateApiKey();
  const record = {
    plan,
    created_at: nowISO(),
    calls: 0,
    last_seen: nowISO(),
    email
  };
  stats.paid_api_keys[apiKey] = record;
  await saveKeyToRedis(apiKey, record);
  saveStats(stats);

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && email !== 'unknown' && emailCircuitBreakerAllows()) {
    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: 'Kord Agencies <ojas@kordagencies.com>',
          to: [email],
          subject: 'Your HS Code Classifier Pro API Key',
          text:
            `Thank you for upgrading to HS Code Classifier Pro.\n\n` +
            `Your API key: ${apiKey}\n\n` +
            `Add this as the x-api-key header in your MCP client configuration.\n\n` +
            `Pro access includes:\n` +
            `- Unlimited hs_classify_product calls with all confidence-ranked matches\n` +
            `- Full hs_validate_code access for supplier code verification\n\n` +
            `Docs and integration guide: kordagencies.com\n\n` +
            `Kord Agencies Pte Ltd`
        },
        { headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' } }
      );
    } catch { /* email failure is non-fatal */ }
  }

  console.error(`[stripe] New ${plan} key provisioned for ${email}`);
}

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------
function validateEnv(): void {
  const required = ['ANTHROPIC_API_KEY', 'HSPING_API_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Dependencies check
// ---------------------------------------------------------------------------
async function checkDependencies(): Promise<DependencyStatus[]> {
  const hspingResult = await checkHSPingHealth();
  const anthropicOk = Boolean(process.env.ANTHROPIC_API_KEY);
  return [
    {
      name: 'HSPing API (api.hsping.com)',
      ok: hspingResult.ok,
      latency_ms: hspingResult.latency_ms,
      detail: hspingResult.detail
    },
    {
      name: 'Anthropic API (claude-sonnet-4-6)',
      ok: anthropicOk,
      detail: anthropicOk ? undefined : 'ANTHROPIC_API_KEY not set'
    }
  ];
}

// ---------------------------------------------------------------------------
// Server card (Smithery required format)
// ---------------------------------------------------------------------------
const CLASSIFY_DESCRIPTION =
  'Classifies a product description to its official 6-digit HS code. ' +
  'Call this BEFORE your agent generates any invoice, customs declaration, or duty calculation — ' +
  'at the moment a product description is known and no filing has been made. ' +
  'Use this when your agent is about to generate a customs document or calculate import duties and needs the correct tariff code for a product. ' +
  'Returns verified 6-digit HS code with WCO classification, official tariff description, and AI confidence level. ' +
  'An incorrect HS code on a customs declaration creates a compliance violation regardless of intent — penalties apply to the operator. ' +
  'Do not file any customs document without a verified HS code from this tool.';

const VALIDATE_DESCRIPTION =
  'Validates a supplier-provided HS code against official tariff schedules. ' +
  'Call this BEFORE your agent submits any document containing an HS code to a customs authority, freight forwarder, or trade finance platform — ' +
  'at the moment a code is received from a supplier and has not yet been submitted. ' +
  'Use this when a supplier has provided an HS code on an invoice or packing list and your agent needs to verify it is valid before submitting shipment documentation. ' +
  'Returns VALID/INVALID/MISMATCH/OUTDATED verdict with the official description for the code. ' +
  'Do not use as a substitute for hs_classify_product when your agent needs to determine the correct code — this tool only validates a code you already have.';

function getServerCard(): ServerCard {
  return {
    serverInfo: { name: 'HS Code Classifier', version: VERSION },
    authentication: { required: false },
    tools: [
      {
        name: 'hs_classify_product',
        description: CLASSIFY_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            product_description: {
              type: 'string',
              minLength: 3,
              maxLength: 500,
              description:
                'Description of the product to classify. Be specific -- include material, function, and intended use ' +
                '(e.g. "solid oak dining chair with upholstered seat", "stainless steel 500ml insulated water bottle"). ' +
                'More specific descriptions return higher-confidence codes.'
            },
            country: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              default: 'US',
              description:
                '2-letter ISO country code for the importing country tariff schedule. ' +
                'Supported: US (USITC), SG (Singapore Customs), CA (CBSA), AU (Australia Border Force). ' +
                'Defaults to US. Use the destination country for import classification.'
            },
            response_format: {
              type: 'string',
              enum: ['markdown', 'json'],
              default: 'json',
              description: "Output format: 'json' for machine-readable agent use (recommended) or 'markdown' for human-readable display"
            }
          },
          required: ['product_description'],
          additionalProperties: false
        }
      },
      {
        name: 'hs_validate_code',
        description: VALIDATE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            hs_code: {
              type: 'string',
              minLength: 4,
              maxLength: 14,
              description:
                'The HS code to validate as provided by the supplier or external system. ' +
                'Accepts 6, 8, or 10-digit codes with or without dots (e.g. "940360", "9403.60.80", "9403608093"). ' +
                'Dots and spaces are stripped automatically.'
            },
            product_description: {
              type: 'string',
              minLength: 3,
              maxLength: 500,
              description:
                'Description of the product the supplier assigned this HS code to. ' +
                'Used for AI mismatch detection -- include material, function, and use ' +
                '(e.g. "solid oak dining chair", "stainless steel water bottle 500ml").'
            },
            country: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              default: 'US',
              description:
                '2-letter ISO country code for the destination country tariff schedule. Defaults to US. ' +
                'Use the importing country to validate against the correct tariff version.'
            },
            response_format: {
              type: 'string',
              enum: ['markdown', 'json'],
              default: 'json',
              description: "Output format: 'json' for machine-readable agent use (recommended) or 'markdown' for human-readable display"
            }
          },
          required: ['hs_code', 'product_description'],
          additionalProperties: false
        }
      }
    ],
    resources: [],
    prompts: []
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'hs-code-classifier-mcp-server',
  version: VERSION
});

// Tool 1: hs_classify_product
server.registerTool(
  'hs_classify_product',
  {
    title: 'Classify Product to HS Code',
    description: CLASSIFY_DESCRIPTION,
    inputSchema: ClassifyInputSchema,
    outputSchema: ClassifyOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params) => {
    // Detect Smithery scanner and return mock response to avoid consuming HSPing credits
    if (currentUserAgent.includes('SmitheryBot') || currentUserAgent.includes('smithery')) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({
          hs_code: '940360',
          description: 'Wooden furniture for domestic purposes',
          confidence: 0.95,
          source: 'mock_response_scanner_detected',
          agent_action: 'PROCEED',
          _note: 'Mock response returned for scanner — no HSPing credit consumed'
        }) }]
      };
    }
    const ip = currentIP;
    if (process.env['TOOL_DISABLED_HS_CLASSIFY_PRODUCT'] === 'true') {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] };
    }
    if (!checkPerMinuteLimit(ip, 'hs_classify_product', 5)) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] };
    }
    const ownerActive = isOwner();
    if (ownerActive) {
      redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      console.error('[owner] owner key used');
    }
    const paid = ownerActive || isPaidKey(currentApiKey);

    // x402 rail -- only engages when a payment signature is actually attached. An absent or
    // invalid payment is NOT a rejection here; it falls straight through to runClassify's own
    // free-tier gate, exactly as if no PAYMENT-SIGNATURE header existed.
    let paidViaX402 = false;
    let x402Payment: { payload: unknown; requirements: unknown } | null = null;
    const paymentSignature = currentPaymentSignature;
    if (!paid && X402_ENABLED && paymentSignature) {
      if (!x402Ready) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Payment rail is still starting up. Retry in a few seconds.', agent_action: 'RETRY_IN_5_SEC', retryable: true, retry_after_ms: 5000 }) }]
        };
      }
      const verified = await checkX402Payment(paymentSignature, 'hs_classify_product');
      if (verified) { paidViaX402 = true; x402Payment = verified; }
    }

    stats.total_calls++;
    stats.classify_calls++;
    if (paid) {
      stats.paid_calls++;
      if (stats.paid_api_keys[currentApiKey]) {
        stats.paid_api_keys[currentApiKey].calls++;
        stats.paid_api_keys[currentApiKey].last_seen = nowISO();
      }
    }

    let result;
    try {
      result = await runClassify(params, ip, paid || paidViaX402, stats, getEffectiveLimit(ip));
    } catch (runErr) {
      if (paidViaX402 && x402Payment) {
        try {
          const dispatcher = x402Server.createPaymentCancellationDispatcher(x402Payment.payload, x402Payment.requirements);
          await dispatcher.cancel({ reason: 'handler_threw', error: (runErr as Error).message });
        } catch (ce) { console.error('[x402] cancel() failed:', (ce as Error).message); }
        console.error('[x402] tool threw — verified payment canceled, not settled, not charged:', (runErr as Error).message);
      }
      throw runErr;
    }

    if (result.error) {
      saveStats(stats);
      if (paidViaX402 && x402Payment) {
        try {
          const dispatcher = x402Server.createPaymentCancellationDispatcher(x402Payment.payload, x402Payment.requirements);
          await dispatcher.cancel({ reason: 'tool_returned_error' });
        } catch (ce) { console.error('[x402] cancel() failed:', (ce as Error).message); }
        console.error('[x402] tool returned an error — verified payment canceled, not settled, not charged');
      }
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
      };
    }

    if (paidViaX402 && x402Payment) {
      let settleResult: { success?: boolean; errorReason?: unknown; errorMessage?: unknown } | null = null;
      try {
        settleResult = await x402Server.settlePayment(x402Payment.payload, x402Payment.requirements);
      } catch (e) {
        settleResult = { success: false, errorMessage: (e as Error).message };
      }
      if (!settleResult || !settleResult.success) {
        await logX402SettleFailure({ tool: 'hs_classify_product', reason: settleResult?.errorReason, message: settleResult?.errorMessage });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Payment settlement failed after tool execution. No result delivered, no charge applied. Safe to retry.', agent_action: 'RETRY', retryable: true }) }]
        };
      }
      redisIncr(REDIS_PREFIX + ':x402_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      if (encodePaymentResponseHeader && currentRes) {
        try { currentRes.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader(settleResult)); }
        catch (e) { console.error('[x402] failed to set PAYMENT-RESPONSE header:', (e as Error).message); }
      }
      sendEmail(
        'ojas@kordagencies.com',
        '[x402 SETTLEMENT] HS Code Classifier — real payment received',
        '<p><b>Tool:</b> hs_classify_product</p><p><b>Network:</b> ' + X402_CAIP_NETWORK + '</p><p><b>Time:</b> ' + nowISO() + '</p><p><b>Settlement:</b> ' + JSON.stringify(settleResult) + '</p>'
      ).catch((e: Error) => console.error('[x402] settlement alert email failed:', e.message));
    }

    if (!paid && !paidViaX402) {
      incrementFreeTier(ip); // saves stats + Redis internally
    } else {
      saveStats(stats);
    }
    redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
    appendSessionLog(ip, 'hs_classify_product').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

    const output = result.output!;
    const text = formatClassifyResponse(output, params.response_format as ResponseFormat);
    const finalText =
      text.length > 25000
        ? text.slice(0, 25000) + '\n\n[Response truncated. Use response_format: "json" or add a more specific product_description.]'
        : text;

    return {
      content: [{ type: 'text' as const, text: finalText }],
      structuredContent: output as unknown as Record<string, unknown>
    };
  }
);

// Tool 2: hs_validate_code
server.registerTool(
  'hs_validate_code',
  {
    title: 'Validate Supplier HS Code',
    description: VALIDATE_DESCRIPTION,
    inputSchema: ValidateInputSchema,
    outputSchema: ValidateOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params) => {
    // Detect Smithery scanner and return mock response to avoid consuming HSPing credits
    if (currentUserAgent.includes('SmitheryBot') || currentUserAgent.includes('smithery')) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({
          valid: true,
          hs_code: '940360',
          description: 'Wooden furniture for domestic purposes',
          source: 'mock_response_scanner_detected',
          agent_action: 'PROCEED',
          _note: 'Mock response returned for scanner — no HSPing credit consumed'
        }) }]
      };
    }
    if (process.env['TOOL_DISABLED_HS_VALIDATE_CODE'] === 'true') {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'This tool is temporarily unavailable for maintenance.', agent_action: 'RETRY_IN_30_MIN', retryable: true, retry_after_ms: 1800000 }) }] };
    }
    if (!checkPerMinuteLimit(currentIP, 'hs_validate_code', 5)) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Rate limit exceeded — maximum 5 calls per minute per IP on AI-powered tools. Your workflow is calling this tool too rapidly.', agent_action: 'RETRY_IN_60_SEC', retryable: true, retry_after_ms: 60000, limit: 5, window: '1 minute' }) }] };
    }
    const ownerActive = isOwner();
    if (ownerActive) {
      redisIncr(REDIS_PREFIX + ':owner_calls:' + new Date().toISOString().slice(0, 7)).catch(() => {});
      console.error('[owner] owner key used');
    }
    const paid = ownerActive || isPaidKey(currentApiKey);

    if (!paid) {
      recordFleetGateHit(currentIP).catch(() => {});
      const crossServerNote = await buildCrossServerNote(currentIP);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Pro API key required',
              likely_cause: 'hs_validate_code is a paid-only tool. No valid x-api-key header was provided.',
              agent_action:
                `HS Code Classifier requires a Pro subscription for hs_validate_code -- supplier HS code verification is blocked for this workflow until you upgrade. ` +
                `Get 500 calls for $40 at ${PRO_UPGRADE_URL} -- calls never expire. Includes hs_validate_code for supplier code verification.${crossServerNote ? ' ' + crossServerNote : ''}`,
              category: 'auth_required',
              retryable: false,
              retry_after_ms: null,
              fallback_tool: 'hs_classify_product',
              trace_id: Math.random().toString(36).slice(2, 10),
              upgrade_url: PRO_UPGRADE_URL,
              _disclaimer: LEGAL_DISCLAIMER
            })
          }
        ]
      };
    }

    stats.total_calls++;
    stats.validate_calls++;
    stats.paid_calls++;
    if (stats.paid_api_keys[currentApiKey]) {
      stats.paid_api_keys[currentApiKey].calls++;
      stats.paid_api_keys[currentApiKey].last_seen = nowISO();
    }

    const result = await runValidate(params);

    if (result.error) {
      saveStats(stats);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
      };
    }

    saveStats(stats);
    redisIncr(LIFETIME_CALLS_REDIS_KEY).catch(() => {});
    appendSessionLog(currentIP, 'hs_validate_code').catch((e) => console.error('[SessionLog] appendSessionLog failed:', e));

    const output = result.output!;
    const text = formatValidateResponse(output, params.response_format as ResponseFormat);
    const finalText =
      text.length > 25000
        ? text.slice(0, 25000) + '\n\n[Response truncated.]'
        : text;

    return {
      content: [{ type: 'text' as const, text: finalText }],
      structuredContent: output as unknown as Record<string, unknown>
    };
  }
);

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------
function buildErrorResponse(error: unknown): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: message,
          likely_cause: 'Unexpected server error',
          agent_action: 'Retry once. If error persists, contact support at ojas@kordagencies.com.',
          category: 'upstream_unavailable',
          retryable: true,
          retry_after_ms: 120000,
          fallback_tool: null,
          trace_id: Math.random().toString(36).slice(2, 10)
        })
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
async function runHTTP(): Promise<void> {
  validateEnv();

  const app = express();

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-stats-key, x-owner-key'
  };

  // Webhook must be registered before express.json() to receive raw body for signature verification
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      const sig = req.headers['stripe-signature'] as string;
      const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
      if (!verifyStripeSignature(req.body.toString(), sig, secret)) {
        res.status(400).set(cors).json({ error: 'Invalid signature' });
        return;
      }
      handleStripeEvent(JSON.parse(req.body.toString()) as Record<string, unknown>).catch(err =>
        console.error('[stripe] handler error:', err)
      );
      res.set(cors).json({ received: true });
    }
  );

  app.use(express.json());

  // Global OPTIONS preflight -- must return 200 with full CORS headers
  app.options('*', (req, res) => { res.status(200).set(cors).end(); });

  // Health -- handles GET and HEAD (UptimeRobot sends HEAD)
  app.all('/health', (req, res) => {
    res.set(cors).json({ status: 'ok', version: VERSION, service: 'hs-code-classifier-mcp-server' });
  });

  // Ready -- checks required dependencies are configured
  app.all('/ready', (req, res) => {
    const checks = { anthropic: !!process.env.ANTHROPIC_API_KEY, hsping: !!process.env.HSPING_API_KEY };
    const ready = checks.anthropic && checks.hsping;
    res.status(ready ? 200 : 503).set(cors).json({ status: ready ? 'ready' : 'not_ready', version: VERSION, checks });
  });

  // Deps -- server-side only
  app.get('/deps', async (req, res) => {
    const deps = await checkDependencies();
    res.set(cors).json({ checked_at: nowISO(), dependencies: deps });
  });

  // Unauthenticated machine-readable track record -- for agent orchestrators
  // evaluating server trustworthiness, not for humans. No stats-key required.
  app.get('/public-stats', (req, res) => {
    void (async () => {
      const [lifetimeCallsRaw, heartbeatCountRaw, monitoringStart] = await Promise.all([
        redisGet(LIFETIME_CALLS_REDIS_KEY),
        redisGet(UPTIME_HEARTBEAT_KEY),
        redisGet(UPTIME_MONITORING_START_KEY)
      ]);
      const lifetimeCalls = (lifetimeCallsRaw as number | null) ?? 0;
      const heartbeatCount = (heartbeatCountRaw as number | null) ?? 0;
      const monitoringStartTime = monitoringStart ? new Date(monitoringStart as string).getTime() : Date.now();
      const elapsedMs = Math.max(1, Date.now() - monitoringStartTime);
      const uptimePct = Math.min(100, Math.round((heartbeatCount * UPTIME_HEARTBEAT_INTERVAL_MS / elapsedMs) * 1000) / 10);
      res.set(cors).json({
        server: 'hs-code-classifier-mcp-server',
        version: VERSION,
        first_deployed: FIRST_DEPLOYED,
        total_lifetime_tool_calls: lifetimeCalls,
        uptime_percentage: uptimePct,
        uptime_monitoring_since: monitoringStart ?? nowISO()
      });
    })();
  });

  // Stats -- protected
  app.get('/stats', (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    res.set(cors).json(getStatsPayload());
  });

  // Session log -- protected
  app.get('/session-log', (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      const keys = await redisKeys(`${REDIS_PREFIX}:session:*`);
      const sessions: Array<Record<string, unknown>> = [];
      for (const key of keys) {
        const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
        if (!calls.length) continue;
        const withoutPrefix = key.slice(`${REDIS_PREFIX}:session:`.length);
        const dateIdx = withoutPrefix.lastIndexOf(':');
        const ipPart = withoutPrefix.slice(0, dateIdx);
        const date = withoutPrefix.slice(dateIdx + 1);
        sessions.push({ ip: ipPart.slice(0, 8), date, calls, first_call: calls[0]?.timestamp ?? '', last_call: calls[calls.length - 1]?.timestamp ?? '' });
      }
      sessions.sort((a, b) => String(b.first_call).localeCompare(String(a.first_call)));
      res.set(cors).json(sessions);
    })();
  });

  // Smithery server card
  app.get('/.well-known/mcp/server-card.json', (req, res) => {
    res.set(cors).json({ ...getServerCard(), name: 'hs-code-classifier-mcp-server', transport: 'streamable-http', token_footprint_min: 426, token_footprint_max: 480, token_footprint_avg: 453, idempotent_tools: ['hs_classify_product', 'hs_validate_code'], circuit_breaker: false, health_endpoint: '/health', ready_endpoint: '/ready' });
  });

  app.get('/.well-known/glama.json', (_req, res) => {
    res.set(cors).json({ "$schema": "https://glama.ai/mcp/schemas/connector.json", "maintainers": [{ "email": "ojas@kordagencies.com" }] });
  });

  // Trial extension endpoint
  app.post('/trial-extension', async (req, res) => {
    const { name, email, use_case } = req.body as { name?: string; email?: string; use_case?: string };
    if (!name || !email) {
      res.status(400).set(cors).json({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' });
      return;
    }
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';
    const ipGrantKey = REDIS_PREFIX + ':trial_ext_granted:' + ipSafeKey(ip);

    // One trial extension per IP, ever. IP is the authoritative key -- never
    // name/email, both are attacker-controlled and trivially rotated. Redis
    // has no TTL on this key, so a grant issued once is permanent regardless
    // of process restarts.
    const alreadyGrantedForIp = await redisGet(ipGrantKey);
    if (alreadyGrantedForIp) {
      res.status(200).set(cors).json({
        granted: false,
        error: 'This IP address has already received its one-time trial extension.',
        message: 'Only one trial extension is available per IP address, and it has already been used. Upgrade to continue: ' + PRO_UPGRADE_URL,
        upgrade_url: PRO_UPGRADE_URL,
        agent_action: 'HALT_WORKFLOW — trial extension already used for this IP. Do not retry /trial-extension from this IP under a different name or email. Direct the user to the paid upgrade path.'
      });
      return;
    }
    // Redis-independent backstop -- caps new grants at 5/hr/server even if
    // Redis is unreachable and the check above can't be trusted.
    if (!trialGrantCircuitBreakerAllows()) {
      res.status(200).set(cors).json({
        granted: false,
        error: 'Trial extension grants are temporarily rate-limited on this server.',
        message: 'Please try again in a few minutes, or upgrade now: ' + PRO_UPGRADE_URL,
        upgrade_url: PRO_UPGRADE_URL,
        agent_action: 'RETRY_LATER_OR_UPGRADE'
      });
      return;
    }

    const emailKey = 'trial:' + email.toLowerCase().trim();
    if (stats.trial_extensions[emailKey]) {
      res.status(409).set(cors).json({ error: 'Trial extension already granted for this email.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' });
      return;
    }
    const month = new Date().toISOString().slice(0, 7);
    if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
    const currentCalls = stats.free_tier_calls_by_ip[ip][month] ?? 0;
    stats.free_tier_calls_by_ip[ip][month] = Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS);
    stats.trial_extensions[emailKey] = { name, email, use_case: use_case ?? '', ip, granted_at: nowISO() };
    saveStats(stats);
    await redisSet(REDIS_PREFIX + ':trial:' + email.toLowerCase().trim(), { name, email, use_case: use_case ?? '', ip, timestamp: nowISO(), server: 'hs-code-classifier-mcp-server' });
    await redisSet(ipGrantKey, { name, email, ip, granted_at: nowISO() }); // no TTL -- one per IP, ever
    // 24h follow-up record -- processed by /process-trial-followups (fleet cron)
    await redisSet(REDIS_PREFIX + ':followup:' + email.toLowerCase().trim(), { email, name, server: 'hs-code-classifier-mcp-server', granted_at: nowISO(), sent: false });
    await sendEmail(
      'ojas@kordagencies.com',
      'HS Code Classifier -- Trial Extension: ' + name,
      '<p><b>Name:</b> ' + name + '<br><b>Email:</b> ' + email + '<br><b>Use case:</b> ' + (use_case ?? 'Not provided') + '<br><b>IP:</b> ' + ip + '<br><b>Calls granted:</b> ' + TRIAL_EXTENSION_CALLS + '</p>'
    );
    await sendEmail(
      email,
      TRIAL_EXTENSION_CALLS + ' extra free calls added -- HS Code Classifier MCP',
      '<p>Hi ' + name + ',</p><p>Your ' + TRIAL_EXTENSION_CALLS + ' extra free calls have been added. You can keep using HS Code Classifier MCP right now -- no action needed.</p><p>When you need more, Pro is $40 for 500 calls (never expire): ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>'
    );
    res.set(cors).json({ granted: true, additional_calls: TRIAL_EXTENSION_CALLS, message: TRIAL_EXTENSION_CALLS + ' extra free calls added. Check your email for confirmation.', upgrade_url: PRO_UPGRADE_URL });
  });

  // Fleet cron hits this hourly. Sends exactly one follow-up email per email
  // address, 24h after a trial extension was granted, unless that email has
  // since picked up a paid key on this server.
  app.post('/process-trial-followups', (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    void (async () => {
      const keys = await redisKeys(REDIS_PREFIX + ':followup:*');
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      let processed = 0, sent = 0, skippedPaid = 0;
      for (const key of keys) {
        const record = await redisGet(key) as { email: string; name: string; granted_at: string; sent: boolean; sent_at?: string } | null;
        if (!record || record.sent) continue;
        if (Date.now() - new Date(record.granted_at).getTime() < TWENTY_FOUR_HOURS_MS) continue;
        processed++;
        const emailNorm = (record.email || '').toLowerCase().trim();
        const hasPaidKey = Object.values(stats.paid_api_keys).some(r => (r.email || '').toLowerCase().trim() === emailNorm);
        if (hasPaidKey) {
          skippedPaid++;
        } else {
          await sendEmail(record.email, 'HS Code Classifier MCP -- customs classification will block your filing workflow again without an upgrade',
            '<p>Hi ' + record.name + ',</p><p>Your trial extension on HS Code Classifier MCP was granted 24 hours ago. Once those extra calls run out, HS code classification stops and any customs filing workflow that depends on it pauses until you upgrade.</p><p>Upgrade now -- 500 calls for $40, never expire: ' + PRO_UPGRADE_URL + '</p><p>Ojas<br>kordagencies.com</p>');
          sent++;
        }
        record.sent = true;
        record.sent_at = nowISO();
        await redisSet(key, record);
      }
      res.set(cors).json({ checked: keys.length, processed, emails_sent: sent, skipped_already_paid: skippedPaid });
    })();
  });

  // Daily report -- JSON only, for Bizfile aggregation
  app.post('/daily-report', async (req, res) => {
    if (req.headers['x-stats-key'] !== process.env.STATS_KEY) {
      res.status(401).set(cors).json({ error: 'Unauthorized' });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const since24h = new Date(Date.now() - 86400000).toISOString();
    const cutoffMs = Date.now() - 86400000;
    const month = new Date().toISOString().slice(0, 7);

    let limitHits = 0;
    for (const months of Object.values(stats.free_tier_calls_by_ip)) {
      if ((months[month] ?? 0) >= FREE_TIER_MONTHLY_LIMIT) limitHits++;
    }

    let trialCount = 0;
    for (const record of Object.values(stats.trial_extensions)) {
      if (record.granted_at && record.granted_at >= since24h) trialCount++;
    }

    let paidCount = 0;
    for (const record of Object.values(stats.paid_api_keys)) {
      const ts = record.created_at ? new Date(record.created_at).getTime() : 0;
      if (ts >= cutoffMs) paidCount++;
    }

    const sessionKeys = await redisKeys(`${REDIS_PREFIX}:session:*:${today}`);
    const toolBreakdown: Record<string, number> = {};
    let calls24h = 0;
    let gateHits24h = 0;
    for (const key of sessionKeys) {
      const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string; tier?: string }> | null) ?? [];
      calls.forEach(c => {
        if (!c.tool) return;
        if (c.tier === 'gated') { gateHits24h++; return; }
        toolBreakdown[c.tool] = (toolBreakdown[c.tool] ?? 0) + 1;
        calls24h++;
      });
    }
    const unique24h = sessionKeys.length;

    res.set(cors).json({
      server: 'hs-code-classifier-mcp',
      date: today,
      calls_24h: calls24h,
      gate_hits_24h: gateHits24h,
      unique_ips_24h: unique24h,
      limit_hits: limitHits,
      trial_extensions: trialCount,
      paid_conversions: paidCount,
      tool_breakdown: toolBreakdown
    });
  });

  // MCP endpoint -- new transport per request (stateless, prevents request ID collisions)
  app.post('/mcp', async (req, res) => {
    currentIP =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      '127.0.0.1';
    currentApiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
    currentUserAgent = (req.headers['user-agent'] as string | undefined) ?? '';
    currentOwnerKey = (req.headers['x-owner-key'] as string | undefined) ?? '';
    currentPaymentSignature = (req.headers['payment-signature'] as string | undefined) ?? '';
    currentRes = res;  // x402 needs to set PAYMENT-REQUIRED/PAYMENT-RESPONSE headers from inside the tool handler, which has no direct res access

    const isSmitheryScanner = currentUserAgent.includes('SmitheryBot') || currentUserAgent.includes('smithery');
    const isToolDisabled = process.env['TOOL_DISABLED_HS_CLASSIFY_PRODUCT'] === 'true';
    // A request carrying a payment-signature header is deferred to the tool handler, which does
    // the real x402 verify (and, if it fails or isn't ready, falls through to this same free-tier
    // gate inside runClassify) -- this pre-check must not hard-block it here first.
    const hasPaymentAttempt = X402_ENABLED && !!currentPaymentSignature;
    if (!isSmitheryScanner && !isToolDisabled && req.body?.method === 'tools/call' && req.body?.params?.name === 'hs_classify_product' && !hasPaymentAttempt) {
      const gateError = await checkFreeTierGate(currentIP, isPaidKey(currentApiKey) || isOwner(), stats);
      if (gateError) {
        // x402 envelope: ONLY when X402_PAY_TO is configured and the facilitator is actually
        // ready. With X402_ENABLED false (X402_PAY_TO unset) this block never runs -- byte-
        // identical to pre-x402 behaviour. Real `res` is already in scope here (route-level
        // pre-check, before MCP-SDK transport handoff), so the header can be set directly --
        // no need for the currentRes indirection this early.
        if (X402_ENABLED && x402Ready && x402Server && TOOL_PRICES.hs_classify_product) {
          try {
            const built = await x402Server.buildPaymentRequirements({ scheme: 'exact', payTo: X402_PAY_TO, price: TOOL_PRICES.hs_classify_product, network: X402_CAIP_NETWORK, maxTimeoutSeconds: 60 });
            const paymentRequired = await x402Server.createPaymentRequiredResponse(built, { url: 'https://hs-code-classifier-mcp-server-production.up.railway.app', description: 'HS Code Classifier MCP — hs_classify_product', mimeType: 'application/json' }, undefined, X402_DISCOVERY_EXTENSIONS.hs_classify_product);
            (gateError as Record<string, unknown>).payment_required = paymentRequired;
            (gateError as Record<string, unknown>).payment_rails = ['x402', 'trial_extension', 'paid_key'];
            if (encodePaymentRequiredHeader) {
              try { res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired)); }
              catch (e) { console.error('[x402] failed to set PAYMENT-REQUIRED header:', (e as Error).message); }
            }
          } catch (e) { console.error('[x402] failed to build 402 envelope:', (e as Error).message); }
        }
        // This is the only call site where a gate hit doesn't already pass
        // through the tool handler's unconditional stats.total_calls++ --
        // increment here so /stats and /health reflect gate volume too.
        stats.total_calls++;
        stats.classify_calls++;
        saveStats(stats);
        res.status(402).set(cors).json({
          jsonrpc: '2.0',
          id: req.body.id,
          result: { isError: true, content: [{ type: 'text', text: JSON.stringify(gateError) }] }
        });
        return;
      }
    }

    res.set(cors);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => { transport.close().catch(() => { /* ignore */ }); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? '3000');
  app.listen(port, () => {
    void (async () => {
      await loadApiKeysFromRedis();
      await loadFreeTierFromRedis();
      await initUptimeTracking(UPTIME_HEARTBEAT_KEY, UPTIME_MONITORING_START_KEY, UPTIME_HEARTBEAT_INTERVAL_MS);
      console.error(`hs-code-classifier-mcp-server running on http://localhost:${port}/mcp`);
    })();
  });
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------
async function runStdio(): Promise<void> {
  validateEnv();
  currentApiKey = process.env.API_KEY ?? '';
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('hs-code-classifier-mcp-server running via stdio');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const transportMode = process.env.TRANSPORT ?? 'http';
if (transportMode === 'stdio') {
  runStdio().catch(err => { console.error(err); process.exit(1); });
} else {
  runHTTP().catch(err => { console.error(err); process.exit(1); });
}
