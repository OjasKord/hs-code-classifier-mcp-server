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
