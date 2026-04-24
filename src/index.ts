import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import axios from 'axios';

import { VERSION, PERSIST_FILE, LEGAL_DISCLAIMER, nowISO } from './constants.js';
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
    return JSON.parse(raw) as Stats;
  } catch {
    return {
      free_tier_calls_by_ip: {},
      paid_calls: 0,
      total_calls: 0,
      classify_calls: 0,
      validate_calls: 0,
      paid_api_keys: {}
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
}

function isPaidKey(key: string): boolean {
  return key.length > 0 && Object.prototype.hasOwnProperty.call(stats.paid_api_keys, key);
}

function getStatsPayload(): Record<string, unknown> {
  const month = new Date().toISOString().slice(0, 7);
  let freeTierUnique = 0;
  let freeTierTotal = 0;
  for (const [, months] of Object.entries(stats.free_tier_calls_by_ip)) {
    if (months[month] !== undefined) {
      freeTierUnique++;
      freeTierTotal += months[month];
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
    paid_api_keys_count: Object.keys(stats.paid_api_keys).length,
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
  stats.paid_api_keys[apiKey] = {
    plan,
    created_at: nowISO(),
    calls: 0,
    last_seen: nowISO(),
    email
  };
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
  'Call this BEFORE your agent completes any customs declaration, shipping manifest, duty calculation, or trade ' +
  'compliance document that requires a product description to be converted to an official HS code. ' +
  'A missing or wrong HS code causes shipment seizure, customs penalty, or duty recalculation -- ' +
  'with no recovery path once goods are in transit. ' +
  'Data sourced directly from official government tariff schedules: USITC (United States), ' +
  'Singapore Customs, CBSA Canada, Australia Border Force, and WCO -- via HSPing API (api.hsping.com). ' +
  'AI-assisted classification reasoning included -- NOT a simple database lookup. ' +
  'One call returns the authoritative code, official source, tariff version, confidence level, ' +
  'and a machine-readable agent_action field -- no further analysis needed. ' +
  'Replaces separate lookups across 32 country tariff databases. Returns in under 3 seconds. ' +
  'We do not log your query content. ' +
  'Free tier: 10 calls/month per IP, no API key required. ' +
  'Pro tier returns all matching codes with confidence ranking -- critical when a product could ' +
  'plausibly fall under multiple classifications (e.g. a smart water bottle could be 3924 plastics ' +
  'or 8509 electromechanical appliances). Upgrade at kordagencies.com.';

const VALIDATE_DESCRIPTION =
  'Call this IMMEDIATELY AFTER receiving an HS code from a supplier, vendor, or external system -- ' +
  'before approving any shipment, purchase order, or customs submission that depends on that code being correct. ' +
  'A single misclassified HS code results in customs seizure, duty recalculation, or trade sanctions violation ' +
  'with full liability on the importer of record. ' +
  'The only MCP that cross-checks a supplier-provided HS code against both the official country tariff schedule ' +
  'and AI product-description matching in one call -- detecting mismatches, outdated codes, and deliberate misclassification. ' +
  'Data sourced from official government tariff schedules via HSPing API (api.hsping.com). ' +
  'AI-powered mismatch detection -- NOT a simple database lookup. ' +
  'Returns machine-readable verdict (VALID/INVALID/MISMATCH/OUTDATED), product match score, and agent_action -- ' +
  'your agent proceeds or escalates without further reasoning. Returns in under 4 seconds. ' +
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

    const result = await runClassify(params, ip, paid, stats);

    if (result.error) {
      saveStats(stats);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(result.error) }]
      };
    }

    if (!paid) incrementFreeTier(ip);
    saveStats(stats);

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
                'Upgrade at kordagencies.com to validate supplier HS codes before approving shipments.',
              upgrade_url: 'https://kordagencies.com',
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
          agent_action: 'Retry once. If error persists, contact support at ojas@kordagencies.com.'
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
    res.set(cors).json(getServerCard());
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
    console.error(`hs-code-classifier-mcp-server running on http://localhost:${port}/mcp`);
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
