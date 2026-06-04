import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import axios from 'axios';

import { VERSION, PERSIST_FILE, LEGAL_DISCLAIMER, nowISO, PRO_UPGRADE_URL, TRIAL_EXTENSION_CALLS, FREE_TIER_REDIS_KEY, FREE_TIER_MONTHLY_LIMIT } from './constants.js';
import { REDIS_PREFIX, redisGet, redisSet, redisKeys, appendSessionLog } from './services/redis.js';
import type { Stats, DependencyStatus, ServerCard } from './types.js';
import { ClassifyInputSchema, ResponseFormat } from './schemas/classify.js';
import { ValidateInputSchema } from './schemas/validate.js';
import { runClassify, formatClassifyResponse } from './tools/classify.js';
import { runValidate, formatValidateResponse } from './tools/validate.js';
import { checkHSPingHealth } from './services/hsping-client.js';

// ---------------------------------------------------------------------------
// Request context (set per HTTP request; stdio uses env fallback)
// ---------------------------------------------------------------------------
let currentIP = '127.0.0.1';
let currentApiKey = '';

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

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
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

async function handleStripeEvent(event: Record<string, unknown>): Promise<void> {
  if (event['type'] !== 'checkout.session.completed') return;

  const session = event['data'] as Record<string, unknown> | undefined;
  const obj = session?.['object'] as Record<string, unknown> | undefined;
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
  if (resendKey && email !== 'unknown') {
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
  'Call this at the moment your agent needs to determine the correct HS code for a product before generating an invoice, ' +
  'filing a customs declaration, or calculating import duties. ' +
  'Returns the 6-digit HS code, full classification path, confidence score, and applicable duty rates. ' +
  'An agent that uses an incorrect HS code on a customs declaration creates a compliance violation — ' +
  'penalties apply regardless of intent. ' +
  'AI-powered classification — NOT a simple keyword lookup. ' +
  'Returns agent_action PROCEED with the verified code or VERIFY_MANUALLY if confidence is below threshold. ' +
  'We do not log your query content. Free tier: 10 calls/month, no API key required.';

const VALIDATE_DESCRIPTION =
  'Call this before your agent submits any document containing an HS code to a customs authority, ' +
  'freight forwarder, or trade finance platform. ' +
  'Returns VALID or INVALID with the official description for the code. ' +
  'Do not use as a substitute for hs_classify_product when your agent needs to determine the correct code — ' +
  'this tool only validates a code you already have. ' +
  'We do not log your query content. Requires Pro API key from kordagencies.com.';

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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params) => {
    const ip = currentIP;
    const paid = isPaidKey(currentApiKey);

    stats.total_calls++;
    stats.classify_calls++;
    if (paid) {
      stats.paid_calls++;
      if (stats.paid_api_keys[currentApiKey]) {
        stats.paid_api_keys[currentApiKey].calls++;
        stats.paid_api_keys[currentApiKey].last_seen = nowISO();
      }
    }

    const result = await runClassify(params, ip, paid, stats, getEffectiveLimit(ip));

    if (result.error) {
      saveStats(stats);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
      };
    }

    if (!paid) {
      incrementFreeTier(ip); // saves stats + Redis internally
    } else {
      saveStats(stats);
    }
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  async (params) => {
    const paid = isPaidKey(currentApiKey);

    if (!paid) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Pro API key required',
              likely_cause: 'hs_validate_code is a paid-only tool. No valid x-api-key header was provided.',
              agent_action:
                'Inform user that hs_validate_code requires a Pro subscription. ' +
                `Get 500 calls for $40 at ${PRO_UPGRADE_URL} -- calls never expire. Includes hs_validate_code for supplier code verification.`,
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
  app.use(express.json());

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-stats-key'
  };

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

  // Stripe webhook
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

  // Smithery server card
  app.get('/.well-known/mcp/server-card.json', (req, res) => {
    res.set(cors).json({ ...getServerCard(), name: 'hs-code-classifier-mcp-server', transport: 'streamable-http', token_footprint_min: 426, token_footprint_max: 480, token_footprint_avg: 453, idempotent_tools: ['hs_classify_product', 'hs_validate_code'], circuit_breaker: false, health_endpoint: '/health', ready_endpoint: '/ready' });
  });

  // Trial extension endpoint
  app.post('/trial-extension', async (req, res) => {
    const { name, email, use_case } = req.body as { name?: string; email?: string; use_case?: string };
    if (!name || !email) {
      res.status(400).set(cors).json({ error: 'name and email are required', agent_action: 'PROVIDE_REQUIRED_FIELDS' });
      return;
    }
    const emailKey = 'trial:' + email.toLowerCase().trim();
    if (stats.trial_extensions[emailKey]) {
      res.status(409).set(cors).json({ error: 'Trial extension already granted for this email.', upgrade_url: PRO_UPGRADE_URL, agent_action: 'INFORM_USER_TRIAL_ALREADY_USED' });
      return;
    }
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';
    const month = new Date().toISOString().slice(0, 7);
    if (!stats.free_tier_calls_by_ip[ip]) stats.free_tier_calls_by_ip[ip] = {};
    const currentCalls = stats.free_tier_calls_by_ip[ip][month] ?? 0;
    stats.free_tier_calls_by_ip[ip][month] = Math.max(0, currentCalls - TRIAL_EXTENSION_CALLS);
    stats.trial_extensions[emailKey] = { name, email, use_case: use_case ?? '', ip, granted_at: nowISO() };
    saveStats(stats);
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
    for (const key of sessionKeys) {
      const calls = (await redisGet(key) as Array<{ tool: string; timestamp: string }> | null) ?? [];
      calls.forEach(c => { if (c.tool) { toolBreakdown[c.tool] = (toolBreakdown[c.tool] ?? 0) + 1; calls24h++; } });
    }
    const unique24h = sessionKeys.length;

    res.set(cors).json({
      server: 'hs-code-classifier-mcp',
      date: today,
      calls_24h: calls24h,
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
