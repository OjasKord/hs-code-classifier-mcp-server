import { queryHSPing, AxiosError } from '../services/hsping-client.js';
import { classifyWithAI } from '../services/claude-client.js';
import { notifyGateHit } from '../services/gate-notify.js';
import type { ClassifyInput } from '../schemas/classify.js';
import { ResponseFormat } from '../schemas/classify.js';
import type { ClassifyOutput, Stats } from '../types.js';
import { nowISO, LEGAL_DISCLAIMER, FREE_TIER_MONTHLY_LIMIT, FREE_TIER_WARNING_THRESHOLD, PRO_UPGRADE_URL, ENTERPRISE_UPGRADE_URL } from '../constants.js';

function buildMarkdown(out: ClassifyOutput): string {
  const lines: string[] = [
    `## HS Code Classification`,
    `**Verdict:** ${out.verdict}`,
    `**HS Code:** ${out.hs_code}`,
    out.wco_6digit ? `**WCO 6-digit:** ${out.wco_6digit}` : '',
    `**Description:** ${out.description}`,
    `**Country:** ${out.country}`,
    `**Source:** ${out.source} (v${out.version}, updated ${out.last_updated})`,
    `**Direction:** ${out.direction}`,
    `**Confidence:** ${out.confidence_level}`,
    `**AI Reasoning:** ${out.classification_reasoning}`,
    `**Total Matches Found:** ${out.total_matches}`,
    `**Agent Action:** ${out.agent_action}`,
    `**Checked At:** ${out.checked_at}`
  ].filter(Boolean);

  if (out._upgrade_notice) lines.push(`\n> **Upgrade:** ${out._upgrade_notice}`);
  if (out._notice) lines.push(`\n> **Notice:** ${out._notice}`);
  lines.push(`\n---\n*${out._disclaimer}*`);
  return lines.join('\n');
}

export function checkFreeTierGate(ip: string, isPaid: boolean, stats: Stats): Record<string, unknown> | null {
  if (isPaid) return null;
  const month = new Date().toISOString().slice(0, 7);
  const ipMap = stats.free_tier_calls_by_ip[ip] ?? {};
  const used = ipMap[month] ?? 0;

  if (used >= FREE_TIER_MONTHLY_LIMIT) {
    notifyGateHit('HS Code Classifier', ip, 'classify', used, PRO_UPGRADE_URL);
    return {
      error: 'Free tier limit reached',
      likely_cause: `This IP has used all ${FREE_TIER_MONTHLY_LIMIT} free classify calls for this month`,
      agent_action:
        `An incorrect HS code on a customs declaration creates a compliance violation regardless of intent — stopping here leaves your filing unverified. Free tier limit of ${FREE_TIER_MONTHLY_LIMIT} calls/month reached. To continue: (1) Trial extension — 10 free calls, no payment required: POST /trial-extension with {"name":"...","email":"...","use_case":"..."}. (2) Pro — 500 calls: ${PRO_UPGRADE_URL}. (3) Enterprise: ${ENTERPRISE_UPGRADE_URL}.`,
      trial_extension: {
        endpoint: '/trial-extension',
        method: 'POST',
        body: { name: 'string', email: 'string', use_case: 'string' }
      },
      upgrade_url: PRO_UPGRADE_URL,
      category: 'rate_limit',
      retryable: false,
      retry_after_ms: null,
      fallback_tool: null,
      trace_id: Math.random().toString(36).slice(2, 10)
    };
  }
  return null;
}

export async function runClassify(
  params: ClassifyInput,
  ip: string,
  isPaid: boolean,
  stats: Stats,
  effectiveLimit: number = FREE_TIER_MONTHLY_LIMIT
): Promise<{ output: ClassifyOutput | null; error?: Record<string, unknown> }> {
  const gateError = checkFreeTierGate(ip, isPaid, stats);
  if (gateError) {
    return { output: null, error: gateError };
  }

  const wordCount = params.product_description.trim().split(/\s+/).length;
  if (wordCount < 4) {
    return {
      output: null,
      error: {
        error: 'Product description too vague for reliable HS classification',
        likely_cause: `"${params.product_description}" has only ${wordCount} word${wordCount === 1 ? '' : 's'}. Descriptions under 4 words return incorrect or ambiguous HS codes from the tariff database.`,
        agent_action:
          'Expand the description to include material + function + intended use. ' +
          'Examples: "solid oak dining chair with upholstered seat" not "chair", ' +
          '"stainless steel 500ml insulated water bottle" not "bottle", ' +
          '"polypropylene injection moulding pellets for automotive parts" not "plastic pellets". ' +
          'Retry with the expanded description.',
        category: 'invalid_input',
        retryable: true,
        retry_after_ms: null,
        fallback_tool: null,
        trace_id: Math.random().toString(36).slice(2, 10)
      }
    };
  }

  let hspingData;
  try {
    hspingData = await queryHSPing(params.product_description, params.country);
  } catch (err) {
    if (err instanceof AxiosError) {
      return {
        output: null,
        error: {
          error: `HSPing API error: HTTP ${err.response?.status ?? 'timeout'}`,
          likely_cause: 'HSPing API is temporarily unavailable or HSPING_API_KEY is invalid',
          agent_action: 'Retry once after 30 seconds. If error persists, check service status at kordagencies.com.',
          category: 'upstream_unavailable',
          retryable: true,
          retry_after_ms: 30000,
          fallback_tool: 'hs_classify_product',
          trace_id: Math.random().toString(36).slice(2, 10)
        }
      };
    }
    return {
      output: null,
      error: {
        error: err instanceof Error ? err.message : String(err),
        likely_cause: 'Unexpected error querying tariff database',
        agent_action: 'Retry once. If error persists, contact support at ojas@kordagencies.com.',
        category: 'upstream_unavailable',
        retryable: true,
        retry_after_ms: 120000,
        fallback_tool: 'hs_classify_product',
        trace_id: Math.random().toString(36).slice(2, 10)
      }
    };
  }

  if (hspingData.count === 0 || hspingData.results.length === 0) {
    const out: ClassifyOutput = {
      verdict: 'NOT_FOUND',
      agent_action:
        'No official tariff code found for this product description in the selected country. ' +
        'Try a more specific description including material and function, or try a different country code.',
      hs_code: '',
      wco_6digit: null,
      description: 'No matching tariff entry found',
      country: params.country,
      source: 'HSPing API (api.hsping.com)',
      source_url: 'https://api.hsping.com',
      version: '',
      last_updated: '',
      direction: '',
      confidence_level: 'LOW',
      classification_reasoning:
        'No results returned from the official tariff schedule for this product description. ' +
        'Consider using more specific terminology matching official tariff language.',
      total_matches: 0,
      checked_at: nowISO(),
      analysis_type: 'AI-assisted classification -- NOT a simple database lookup',
      token_count: 0,
      _disclaimer: LEGAL_DISCLAIMER
    };
    out.token_count = Math.ceil(JSON.stringify(out).length / 4);
    return { output: out };
  }

  const allResults = hspingData.results;
  const aiResult = await classifyWithAI(params.product_description, allResults, params.country);
  const bestMatch = allResults[aiResult.best_match_index] ?? allResults[0];

  const month = new Date().toISOString().slice(0, 7);
  const used = ((stats.free_tier_calls_by_ip[ip] ?? {})[month] ?? 0) + 1;

  let upgradeNotice: string | undefined;
  if (!isPaid && allResults.length > 1) {
    upgradeNotice =
      `Pro tier shows ${allResults.length - 1} additional classification match${allResults.length - 1 > 1 ? 'es' : ''} for this product -- ` +
      `important when a product could fall under multiple codes. Get 500 calls for $40 at ${PRO_UPGRADE_URL} -- calls never expire.`;
  }

  let notice: string | undefined;
  if (!isPaid && FREE_TIER_MONTHLY_LIMIT - used <= FREE_TIER_MONTHLY_LIMIT - FREE_TIER_WARNING_THRESHOLD) {
    const remaining = Math.max(0, FREE_TIER_MONTHLY_LIMIT - used);
    if (remaining > 0) {
      notice = `Warning: ${remaining} free classify call${remaining !== 1 ? 's' : ''} remaining this month (limit: ${effectiveLimit}). Get 500 calls for $40 at ${PRO_UPGRADE_URL} -- calls never expire.`;
    }
  }

  const out: ClassifyOutput = {
    verdict: aiResult.confidence_level === 'LOW' ? 'AMBIGUOUS' : 'CLASSIFIED',
    agent_action:
      aiResult.confidence_level === 'HIGH'
        ? `Use HS code ${bestMatch.hscode} for ${params.country} customs documentation. Proceed with declaration.`
        : aiResult.confidence_level === 'MEDIUM'
        ? `Use HS code ${bestMatch.hscode} for ${params.country} customs documentation. Review AI reasoning before submitting high-value shipments.`
        : `Classification is ambiguous -- ${allResults.length} possible codes identified. Escalate to a licensed customs broker before submitting declaration.`,
    hs_code: bestMatch.hscode,
    wco_6digit: bestMatch.wco,
    description: bestMatch.description_en,
    country: bestMatch.country,
    source: bestMatch.source,
    source_url: 'https://api.hsping.com',
    version: bestMatch.version,
    last_updated: bestMatch.last_updated,
    direction: bestMatch.direction,
    confidence_level: aiResult.confidence_level,
    classification_reasoning: aiResult.reasoning,
    ...(isPaid ? { all_matches: allResults } : {}),
    total_matches: allResults.length,
    checked_at: nowISO(),
    analysis_type: 'AI-assisted classification -- NOT a simple database lookup',
    ...(upgradeNotice ? { _upgrade_notice: upgradeNotice } : {}),
    ...(notice ? { _notice: notice } : {}),
    token_count: 0,
    _disclaimer: LEGAL_DISCLAIMER
  };
  if (out.verdict === 'AMBIGUOUS') {
    out.hold_reason = allResults.length + ' possible HS codes identified for this product -- classification is ambiguous and customs authorities may assess differently';
    out.retry_after = null;
    out.escalation_path = 'Escalate to a licensed customs broker to determine the correct HS code before submitting customs declaration';
  }
  out.token_count = Math.ceil(JSON.stringify(out).length / 4);
  return { output: out };
}

export function formatClassifyResponse(out: ClassifyOutput, format: ResponseFormat): string {
  if (format === ResponseFormat.MARKDOWN) return buildMarkdown(out);
  return JSON.stringify(out, null, 2);
}
