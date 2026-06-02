# Changelog

## [1.0.9] - 2026-06-02

### Fixed
- fix: IP extraction fixed for Cloudflare proxy headers — free tier gate now enforces correctly

## [1.0.5] - 2026-04-28

### Changed
- Upgrade URLs updated to prepaid bundle payment links (500 calls, never expire)
- Free tier limit messages updated: "Get 500 calls for $40 at [URL] -- calls never expire"
- PRO_UPGRADE_URL and ENTERPRISE_UPGRADE_URL constants added to constants.ts

## [1.0.4] - 2026-04-27

### Added
- `token_count` field on all tool responses — lets orchestrator budget ledgers track token cost per call
- `/ready` endpoint — returns 200 when `ANTHROPIC_API_KEY` and `HSPING_API_KEY` are present, 503 otherwise
- Phase 4 enhanced error objects: `category`, `retryable`, `retry_after_ms`, `fallback_tool`, `trace_id` on all error paths in classify and validate tools

## [1.0.3] - 2026-04-26

### Improved
- hs_classify_product and hs_validate_code descriptions rewritten with TCO framework: irresistibility opening, $10k-$100k per-incident consequence, exact data source hostnames (api.hsping.com), prepaid bundle pricing last
- LEGAL NOTICE and full terms added to both tool descriptions

## [1.0.2] - 2026-04-26
### Changed
- VERSION constant unified to 1.0.2 across constants.ts, package.json, and server.json (were out of sync)
- Added `source_url` field to ClassifyOutput and ValidateOutput response objects (mandatory per Section 7.7)

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
