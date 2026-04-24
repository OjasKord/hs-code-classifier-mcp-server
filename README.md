# HS Code Classifier MCP Server

Classify product descriptions to official HS codes and validate supplier-provided codes before customs submissions. Uses official government tariff schedules (USITC, Singapore Customs, CBSA, Australia Border Force) via HSPing API with AI-assisted classification reasoning.

## Tools

### `hs_classify_product` (free tier: 10 calls/month)
Convert a product description to the correct HS code before filling any customs declaration, shipping manifest, or duty calculation.

### `hs_validate_code` (Pro tier)
Validate a supplier-provided HS code before approving any shipment or purchase order. Detects mismatches, outdated codes, and misclassification risks using official tariff data and AI analysis.

## Usage

### HTTP (hosted -- no install required)
```
https://hs-code-classifier-mcp-production.up.railway.app
```

### npm (Claude Desktop / stdio)
```bash
npx hs-code-classifier-mcp
```

Configure in `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hs-code-classifier": {
      "command": "npx",
      "args": ["hs-code-classifier-mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "HSPING_API_KEY": "your-hsping-key",
        "API_KEY": "your-pro-key-from-kordagencies.com"
      }
    }
  }
}
```

## Pricing

| Tier | Price | classify_product | validate_code |
|------|-------|-----------------|---------------|
| Free | $0 | 10 calls/month, top result only | Not available |
| Pro | $49/month | Unlimited, all matches with confidence ranking | Unlimited |
| Enterprise | $199/month | Volume + SLA | Volume + SLA |

Get a Pro key: [kordagencies.com](https://kordagencies.com)

## Supported Countries

US (USITC), SG (Singapore Customs), CA (CBSA), AU (Australia Border Force), and others via HSPing API.

## Legal

Results sourced from official government tariff schedules via HSPing API. For informational purposes only -- not legal or customs advice. Full terms: kordagencies.com/terms.html
