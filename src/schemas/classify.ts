import { z } from 'zod';

export enum ResponseFormat {
  MARKDOWN = 'markdown',
  JSON = 'json'
}

export const ClassifyInputSchema = z.object({
  product_description: z.string()
    .min(3, 'Product description must be at least 3 characters')
    .max(500, 'Product description must not exceed 500 characters')
    .describe(
      'Description of the product to classify. Be specific -- include material, function, and intended use ' +
      '(e.g. "solid oak dining chair with upholstered seat", "stainless steel 500ml insulated water bottle"). ' +
      'More specific descriptions return higher-confidence codes.'
    ),
  country: z.string()
    .length(2, 'Must be ISO 3166-1 alpha-2 country code (e.g. US, SG, CA, AU)')
    .default('US')
    .describe(
      '2-letter ISO country code for the importing country tariff schedule. ' +
      'Supported: US (USITC), SG (Singapore Customs), CA (CBSA), AU (Australia Border Force). ' +
      'Defaults to US. Use the destination country for import classification.'
    ),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.JSON)
    .describe("Output format: 'json' for machine-readable agent use (recommended) or 'markdown' for human-readable display")
}).strict();

export type ClassifyInput = z.infer<typeof ClassifyInputSchema>;

export const ClassifyOutputSchema = z.object({
  verdict: z.enum(['CLASSIFIED', 'AMBIGUOUS', 'NOT_FOUND']).describe('Machine-readable classification outcome'),
  agent_action: z.string().describe('Plain-language instruction for what the agent should do with this result'),
  hs_code: z.string().describe('Verified 6-digit HS code, or empty string if NOT_FOUND'),
  wco_6digit: z.string().nullable().describe('WCO 6-digit harmonised code, null if unavailable'),
  description: z.string(),
  country: z.string(),
  source: z.string(),
  source_url: z.string(),
  version: z.string(),
  last_updated: z.string(),
  direction: z.string(),
  confidence_level: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  classification_reasoning: z.string(),
  all_matches: z.array(z.unknown()).optional().describe('Present only for paid (Pro) calls -- full ranked match list'),
  total_matches: z.number(),
  checked_at: z.string(),
  analysis_type: z.string(),
  hold_reason: z.string().optional(),
  retry_after: z.number().nullable().optional(),
  escalation_path: z.string().nullable().optional(),
  _upgrade_notice: z.string().optional(),
  _notice: z.string().optional(),
  token_count: z.number().optional(),
  _disclaimer: z.string()
});
