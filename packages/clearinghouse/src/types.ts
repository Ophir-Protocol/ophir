import type { SLAMetricName } from '@ophirai/protocol';

export interface PoDScore {
  agent_id: string;
  score: number;          // 0.0 to 1.0
  margin_rate: number;    // 0.05 to 1.0
  confidence: number;     // 0.0 to 1.0
  sample_size: number;
  last_updated: string;
}

export interface CompletedAgreement {
  agreement_id: string;
  buyer_id: string;
  seller_id: string;
  metrics: MeasuredMetric[];
  completed_at: string;
  deposit_amount: number;
}

export interface MeasuredMetric {
  name: SLAMetricName | string;
  target: number;
  observed: number;
  comparison: 'gte' | 'lte' | 'eq' | 'between';
}

export interface MarginRequirement {
  buyer_margin_rate: number;
  seller_margin_rate: number;
  combined_margin_rate: number;
  required_deposit: number;
  full_deposit: number;
  savings: number;
}

export interface MarginAssessment {
  agreement_id: string;
  buyer_id: string;
  seller_id: string;
  buyer_pod: PoDScore;
  seller_pod: PoDScore;
  required_margin_rate: number;
  required_deposit: number;
  full_deposit: number;
  savings: number;
}

export interface RiskAssessment {
  agent_id: string;
  risk_tier: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  max_exposure: number;
  current_exposure: number;
  available_capacity: number;
}

export interface Obligation {
  id: string;
  from_agent: string;
  to_agent: string;
  amount: number;
  agreement_id: string;
  created_at: string;
}

export interface NettingResult {
  cycle_id: string;
  obligations_netted: string[];
  total_gross: number;
  total_net: number;
  compression_ratio: number;
  agents_involved: string[];
  timestamp: string;
}

export interface AgentExposure {
  agent_id: string;
  total_owed: number;
  total_owed_to: number;
  net_exposure: number;
  margin_held: number;
  available_capacity: number;
}

export interface ClearinghouseConfig {
  netting_interval_ms: number;
  min_margin_rate: number;
  max_exposure_per_agent: number;
  insurance_fund_bps: number;
}

export interface DefaultResult {
  agent_id: string;
  agreement_id: string;
  margin_slashed: number;
  pod_degradation: number;
  new_margin_rate: number;
}

export interface OnChainAgentState {
  agent_id: string;
  pod_score: number;
  net_exposure: number;
  total_margin_held: number;
  active_agreements: number;
  completed_agreements: number;
  total_volume: number;
  last_netting_slot: number;
  risk_tier: number;
}

export interface OnChainMasterVault {
  authority: string;
  total_deposits: number;
  total_margin_held: number;
  insurance_fund: number;
  netting_count: number;
  total_volume_netted: number;
}
