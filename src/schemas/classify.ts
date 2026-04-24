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
