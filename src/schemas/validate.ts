import { z } from 'zod';
import { ResponseFormat } from './classify.js';

export { ResponseFormat };

export const ValidateInputSchema = z.object({
  hs_code: z.string()
    .min(4, 'HS code must be at least 4 digits')
    .max(14, 'HS code must not exceed 14 characters')
    .describe(
      'The HS code to validate as provided by the supplier or external system. ' +
      'Accepts 6, 8, or 10-digit codes with or without dots (e.g. "940360", "9403.60.80", "9403608093"). ' +
      'Dots and spaces are stripped automatically.'
    ),
  product_description: z.string()
    .min(3, 'Product description must be at least 3 characters')
    .max(500, 'Product description must not exceed 500 characters')
    .describe(
      'Description of the product the supplier assigned this HS code to. ' +
      'Used for AI mismatch detection -- include material, function, and use ' +
      '(e.g. "solid oak dining chair", "stainless steel water bottle 500ml").'
    ),
  country: z.string()
    .length(2, 'Must be ISO 3166-1 alpha-2 country code (e.g. US, SG, CA, AU)')
    .default('US')
    .describe(
      '2-letter ISO country code for the destination country tariff schedule. Defaults to US. ' +
      'Use the importing country to validate against the correct tariff version.'
    ),
  response_format: z.nativeEnum(ResponseFormat)
    .default(ResponseFormat.JSON)
    .describe("Output format: 'json' for machine-readable agent use (recommended) or 'markdown' for human-readable display")
}).strict();

export type ValidateInput = z.infer<typeof ValidateInputSchema>;

export const ValidateOutputSchema = z.object({
  verdict: z.enum(['VALID', 'INVALID', 'MISMATCH', 'OUTDATED']),
  agent_action: z.string(),
  hs_code_checked: z.string(),
  product_match_score: z.number(),
  mismatch_reason: z.string().optional(),
  correct_code_suggestion: z.string().optional(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  source: z.string(),
  source_url: z.string(),
  version: z.string(),
  country: z.string(),
  checked_at: z.string(),
  analysis_type: z.string(),
  hold_reason: z.string().optional(),
  retry_after: z.number().nullable().optional(),
  escalation_path: z.string().nullable().optional(),
  token_count: z.number().optional(),
  _disclaimer: z.string()
});
