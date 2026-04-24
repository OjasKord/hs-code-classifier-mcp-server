import { queryHSPing, AxiosError } from '../services/hsping-client.js';
import { validateWithAI } from '../services/claude-client.js';
import type { ValidateInput } from '../schemas/validate.js';
import { ResponseFormat } from '../schemas/validate.js';
import type { ValidateOutput } from '../types.js';
import { nowISO, LEGAL_DISCLAIMER } from '../constants.js';

function normalizeHsCode(code: string): string {
  return code.replace(/[\s.]/g, '');
}

function buildMarkdown(out: ValidateOutput): string {
  const lines: string[] = [
    `## HS Code Validation`,
    `**Verdict:** ${out.verdict}`,
    `**HS Code Checked:** ${out.hs_code_checked}`,
    `**Product Match Score:** ${(out.product_match_score * 100).toFixed(0)}%`,
    `**Risk Level:** ${out.risk_level}`,
    out.mismatch_reason ? `**Mismatch Reason:** ${out.mismatch_reason}` : '',
    out.correct_code_suggestion ? `**Suggested Correct Code:** ${out.correct_code_suggestion}` : '',
    `**Country:** ${out.country}`,
    `**Source:** ${out.source} (v${out.version})`,
    `**Agent Action:** ${out.agent_action}`,
    `**Checked At:** ${out.checked_at}`
  ].filter(Boolean);
  lines.push(`\n---\n*${out._disclaimer}*`);
  return lines.join('\n');
}

export async function runValidate(
  params: ValidateInput
): Promise<{ output: ValidateOutput | null; error?: { error: string; likely_cause: string; agent_action: string } }> {
  const normalizedCode = normalizeHsCode(params.hs_code);

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
          agent_action: 'Retry validation once after 30 seconds. If error persists, check status at kordagencies.com.'
        }
      };
    }
    return {
      output: null,
      error: {
        error: err instanceof Error ? err.message : String(err),
        likely_cause: 'Unexpected error querying tariff database',
        agent_action: 'Retry once. If error persists, contact support at ojas@kordagencies.com.'
      }
    };
  }

  const aiResult = await validateWithAI(
    normalizedCode,
    params.product_description,
    params.country,
    hspingData.results
  );

  const sourceResult = hspingData.results[0];
  const out: ValidateOutput = {
    verdict: aiResult.verdict,
    agent_action: aiResult.agent_action,
    hs_code_checked: normalizedCode,
    product_match_score: aiResult.product_match_score,
    ...(aiResult.mismatch_reason ? { mismatch_reason: aiResult.mismatch_reason } : {}),
    ...(aiResult.correct_code_suggestion ? { correct_code_suggestion: aiResult.correct_code_suggestion } : {}),
    risk_level: aiResult.risk_level,
    source: sourceResult
      ? sourceResult.source
      : 'HSPing API (api.hsping.com) -- no direct match found for product',
    version: sourceResult ? sourceResult.version : 'N/A',
    country: params.country,
    checked_at: nowISO(),
    analysis_type: 'AI-powered mismatch detection -- NOT a simple database lookup',
    _disclaimer: LEGAL_DISCLAIMER
  };

  return { output: out };
}

export function formatValidateResponse(out: ValidateOutput, format: ResponseFormat): string {
  if (format === ResponseFormat.MARKDOWN) return buildMarkdown(out);
  return JSON.stringify(out, null, 2);
}
