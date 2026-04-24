export interface HSPingResult {
  hscode: string;
  wco: string | null;
  description_en: string;
  country: string;
  source: string;
  version: string;
  last_updated: string;
  direction: string;
}

export interface HSPingResponse {
  query: string;
  query_type: number;
  country: string | null;
  count: number;
  results: HSPingResult[];
}

export interface Stats {
  free_tier_calls_by_ip: Record<string, Record<string, number>>;
  paid_calls: number;
  total_calls: number;
  classify_calls: number;
  validate_calls: number;
  paid_api_keys: Record<string, {
    plan: string;
    created_at: string;
    calls: number;
    last_seen: string;
    email?: string;
  }>;
}

export interface TierResult {
  allowed: boolean;
  remaining: number;
  paid: boolean;
}

export interface ClassifyOutput {
  verdict: 'CLASSIFIED' | 'AMBIGUOUS' | 'NOT_FOUND';
  agent_action: string;
  hs_code: string;
  wco_6digit: string | null;
  description: string;
  country: string;
  source: string;
  version: string;
  last_updated: string;
  direction: string;
  confidence_level: 'HIGH' | 'MEDIUM' | 'LOW';
  classification_reasoning: string;
  all_matches?: HSPingResult[];
  total_matches: number;
  checked_at: string;
  analysis_type: string;
  _upgrade_notice?: string;
  _notice?: string;
  _disclaimer: string;
}

export interface ValidateOutput {
  verdict: 'VALID' | 'INVALID' | 'MISMATCH' | 'OUTDATED';
  agent_action: string;
  hs_code_checked: string;
  product_match_score: number;
  mismatch_reason?: string;
  correct_code_suggestion?: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  source: string;
  version: string;
  country: string;
  checked_at: string;
  analysis_type: string;
  _disclaimer: string;
}

export interface DependencyStatus {
  name: string;
  ok: boolean;
  latency_ms?: number;
  detail?: string;
}

export interface ServerCardTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerCard {
  serverInfo: { name: string; version: string };
  authentication: { required: boolean };
  tools: ServerCardTool[];
  resources: unknown[];
  prompts: unknown[];
}
