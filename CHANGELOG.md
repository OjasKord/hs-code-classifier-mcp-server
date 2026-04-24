# Changelog

## [1.0.0] - 2026-04-24

### Added
- Initial release
- `hs_classify_product` tool: classify product descriptions to official HS codes using government tariff schedules (USITC, Singapore Customs, CBSA, Australia Border Force) via HSPing API with AI-assisted reasoning
- `hs_validate_code` tool: validate supplier-provided HS codes against official schedules with AI mismatch detection (paid tier)
- Free tier: 10 classify calls/month per IP, no API key required
- Pro tier: full result set with confidence ranking on classify + full validate access
- Both stdio and HTTP (Streamable) transports
- /health, /deps, /stats, /webhook/stripe endpoints
- Free tier quota tracking by IP with 80% warning and conversion hook
- Stripe webhook integration for paid key provisioning
