# Changelog

## [1.0.29] - 2026-06-28
- fix: gate email dedup — notifyGateHit now async with hs:gate_email:{ip} Redis key, 1-hour TTL; retries suppressed
- fix: 402 gate response agent_action changed to HALT_WORKFLOW; retryable: false, retry_after_ms: null already present
- fix: trial_extension structured field already present; agent_action now actionable for agents

## [1.0.28] - 2026-06-28
- feat: owner key bypass (OWNER_KEY env var) — fleet owner bypasses free tier and paid-only gates

## [1.0.27] - 2026-06-26
- fix: trial extension requests now written to Redis (hs:trial:{email}) on grant -- permanent audit trail that survives redeploys; previously in-memory only

## [1.0.26] - 2026-06-25
- feat: calls_remaining field added to every successful tool response -- "unlimited" for paid keys (hs_validate_code is always paid-gated), numeric free-tier headroom for hs_classify_product
- feat: verdict_ttl field added to both tools (2592000s/30 days -- HS codes are stable)
- feat: data_source_status field added (full/degraded/partial). hs_classify_product now wraps the Anthropic ranking call in try/catch -- falls back to the top official HSPing match (confidence LOW, AMBIGUOUS verdict) and reports "partial" if AI ranking fails, since Anthropic is not the critical source for this tool (HSPing is). hs_validate_code's AI mismatch-detection call is intentionally left unwrapped -- no existing verdict in its fixed enum (VALID/INVALID/MISMATCH/OUTDATED) safely represents "could not verify", so a hard failure was kept rather than risking a silently wrong compliance verdict; always reports "full" when it returns at all.

## [1.0.25] - 2026-06-24
- feat: unauthenticated /public-stats endpoint -- first_deployed, lifetime tool calls, uptime %, version, for agent orchestrators evaluating server trustworthiness
- feat: /process-trial-followups endpoint + 24h follow-up record on trial-extension grant
- feat: gate responses now self-contained (server + workflow impact + upgrade path in one sentence) and detect cross-server operators via shared fleet Redis, with cross-server trial-extension note
- feat: outputSchema added to both tools via Zod (additive -- response format unchanged). Added isError:true to the 4 non-structured-content paths (kill-switch, rate-limit) and both SmitheryBot mock responses so the MCP SDK's output validation doesn't reject them now that outputSchema is enforced
- fix: tool descriptions falsely claimed hs_classify_product returns "applicable duty rates" -- no duty rate logic exists anywhere in the codebase. Also falsely claimed hs_validate_code returns only VALID/INVALID when the real verdict enum includes MISMATCH and OUTDATED. Fixed in index.ts, definitions.json, and smithery.yaml

## [1.0.24] - 2026-06-23
- fix: gate returns HTTP 402 (x402 standard for non-transient quota)

## [1.0.23] - 2026-06-20
- feat: email notification on free tier gate hit

## [1.0.22] - 2026-06-18
- feat: revoke API key on Stripe refund

## [1.0.21] - 2026-06-17
- feat: add required fields to all tool inputSchemas; add ToolRank CI gate

## [1.0.20] - 2026-06-17
- fix: Stripe webhook now validates payment_link ID — ignores events not belonging to this server
- fix: webhook route registered before express.json() — raw body now reaches signature verifier correctly

## [1.0.19] - 2026-06-16
- feat: ATO optimisation — purpose verb, usage context, required fields, ToolRank badge

## [1.0.18] - 2026-06-15
- feat: add hold_reason, retry_after, escalation_path to AMBIGUOUS (classify) and MISMATCH/OUTDATED (validate) responses

## [1.0.17] - 2026-06-15
- fix: detect SmitheryBot user-agent and return mock response to prevent HSPing credit consumption during scanner runs

## [1.0.16] - 2026-06-11
- fix: bump version past existing npm publish (1.0.15 already on registry)

## [1.0.15] - 2026-06-11
- feat: per-tool kill switch + per-minute rate limiting on AI tools

## [1.0.13] - 2026-06-08
- fix: BEFORE trigger language, consequence-first limit error

## [1.0.12] - 2026-06-05
- feat: Smithery optimisation - updated package.json description/keywords and smithery.yaml with system prompt

## [1.0.11] - 2026-06-04
- feat: /daily-report endpoint for consolidated daily summary

## [1.0.10] - 2026-06-04

### Added
- `src/services/redis.ts` — Upstash Redis helpers (redisGet, redisSet, redisExpire, redisKeys, appendSessionLog)
- Free tier Redis persistence: `loadFreeTierFromRedis` / `saveFreeTierToRedis` with Math.max merge
- API key Redis persistence: `saveKeyToRedis` / `loadApiKeysFromRedis` with prefix `hs` — first durable persistence for paid keys
- `appendSessionLog` with 24h TTL; `/session-log` endpoint (requires x-stats-key)
- `free_tier_breakdown` per-IP object on `/stats` response for current month
- `getEffectiveLimit(ip)` — returns `FREE_TIER_MONTHLY_LIMIT + TRIAL_EXTENSION_CALLS` if IP has a trial extension
- `FREE_TIER_REDIS_KEY = 'hs:free_tier_usage'` constant

### Changed
- `hs_classify_product` and `hs_validate_code` descriptions rewritten for orchestral agent runtime selection
- `runClassify` accepts optional `effectiveLimit` parameter; notice string now includes effective limit
- `VERSION` bumped to `1.0.10`

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
