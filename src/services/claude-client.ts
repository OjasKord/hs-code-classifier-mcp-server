import Anthropic from '@anthropic-ai/sdk';
import type { HSPingResult } from '../types.js';

function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY environment variable not set');
  return new Anthropic({ apiKey: key });
}

export async function classifyWithAI(
  productDescription: string,
  results: HSPingResult[],
  country: string
): Promise<{ confidence_level: 'HIGH' | 'MEDIUM' | 'LOW'; reasoning: string; best_match_index: number }> {
  const client = getClient();

  const resultsText = results
    .map((r, i) =>
      `${i + 1}. HS: ${r.hscode} | WCO: ${r.wco ?? 'N/A'} | ${r.description_en} | ${r.source} v${r.version}`
    )
    .join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system:
      'You are a customs classification expert. Analyze HS code matches against a product description and select the best match. ' +
      'Respond ONLY with valid JSON -- no markdown, no explanation outside the JSON.',
    messages: [
      {
        role: 'user',
        content:
          `Product: "${productDescription}"\nCountry: ${country}\n\nOfficial tariff results:\n${resultsText}\n\n` +
          'Select the best match and respond with JSON only:\n' +
          '{"best_match_index":0,"confidence_level":"HIGH|MEDIUM|LOW","reasoning":"One sentence explaining why this is the correct classification and any ambiguity."}'
      }
    ]
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      best_match_index?: number;
      confidence_level?: string;
      reasoning?: string;
    };
    const idx = Math.max(0, Math.min(results.length - 1, parsed.best_match_index ?? 0));
    const level = (['HIGH', 'MEDIUM', 'LOW'] as const).includes(parsed.confidence_level as 'HIGH' | 'MEDIUM' | 'LOW')
      ? (parsed.confidence_level as 'HIGH' | 'MEDIUM' | 'LOW')
      : 'MEDIUM';
    return {
      confidence_level: level,
      reasoning: parsed.reasoning ?? 'Classification based on official tariff schedule match.',
      best_match_index: idx
    };
  } catch {
    return { confidence_level: 'MEDIUM', reasoning: 'Classification based on official tariff schedule match.', best_match_index: 0 };
  }
}

export async function validateWithAI(
  hsCode: string,
  productDescription: string,
  country: string,
  results: HSPingResult[]
): Promise<{
  verdict: 'VALID' | 'INVALID' | 'MISMATCH' | 'OUTDATED';
  product_match_score: number;
  mismatch_reason?: string;
  correct_code_suggestion?: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  agent_action: string;
}> {
  const client = getClient();

  const resultsText =
    results.length > 0
      ? results
          .slice(0, 10)
          .map((r, i) => `${i + 1}. HS: ${r.hscode} | WCO: ${r.wco ?? 'N/A'} | ${r.description_en} | ${r.source} v${r.version}`)
          .join('\n')
      : 'No matching codes found in the official tariff schedule for this product description.';

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 640,
    system:
      'You are a customs compliance expert. Validate HS codes against product descriptions and official tariff schedules. ' +
      'Be precise about mismatches -- wrong classifications carry legal liability for the importer. ' +
      'Respond ONLY with valid JSON -- no markdown, no explanation outside the JSON.',
    messages: [
      {
        role: 'user',
        content:
          `HS code to validate: "${hsCode}"\nProduct: "${productDescription}"\nCountry: ${country}\n\n` +
          `Official tariff results for this product:\n${resultsText}\n\n` +
          'Determine if the HS code is correct. Consider: does the code appear in official results? ' +
          'Is the product description consistent with the code tariff description? Could this be a mismatch or outdated code?\n\n' +
          'Respond with JSON only (omit optional fields if not applicable):\n' +
          '{"verdict":"VALID|INVALID|MISMATCH|OUTDATED","product_match_score":0.0,' +
          '"mismatch_reason":"only if MISMATCH or INVALID","correct_code_suggestion":"HS code if better match exists",' +
          '"risk_level":"LOW|MEDIUM|HIGH","agent_action":"one clear instruction for the agent"}'
      }
    ]
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      verdict?: string;
      product_match_score?: number;
      mismatch_reason?: string;
      correct_code_suggestion?: string;
      risk_level?: string;
      agent_action?: string;
    };

    const verdicts = ['VALID', 'INVALID', 'MISMATCH', 'OUTDATED'] as const;
    const risks = ['LOW', 'MEDIUM', 'HIGH'] as const;

    return {
      verdict: verdicts.includes(parsed.verdict as 'VALID') ? (parsed.verdict as 'VALID' | 'INVALID' | 'MISMATCH' | 'OUTDATED') : 'INVALID',
      product_match_score: Math.min(1.0, Math.max(0.0, parsed.product_match_score ?? 0.0)),
      mismatch_reason: parsed.mismatch_reason,
      correct_code_suggestion: parsed.correct_code_suggestion,
      risk_level: risks.includes(parsed.risk_level as 'LOW') ? (parsed.risk_level as 'LOW' | 'MEDIUM' | 'HIGH') : 'HIGH',
      agent_action: parsed.agent_action ?? 'Escalate for manual customs review before approving this shipment.'
    };
  } catch {
    return {
      verdict: 'INVALID',
      product_match_score: 0.0,
      mismatch_reason: 'AI validation failed to parse HS code response',
      risk_level: 'HIGH',
      agent_action: 'Do not approve this shipment. Escalate for manual customs review.'
    };
  }
}
