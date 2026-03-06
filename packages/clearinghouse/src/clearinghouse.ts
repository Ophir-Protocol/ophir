import { OphirError, OphirErrorCode } from '@ophirai/protocol';
import { PoDOracle } from './pod-oracle.js';
import { NettingEngine } from './netting-engine.js';
import type {
  ClearinghouseConfig,
  CompletedAgreement,
  MarginAssessment,
  NettingResult,
  AgentExposure,
  DefaultResult,
} from './types.js';

const DEFAULT_CONFIG: ClearinghouseConfig = {
  netting_interval_ms: 60_000,
  min_margin_rate: 0.05,
  max_exposure_per_agent: 1_000_000,
  insurance_fund_bps: 10,
};

export class ClearinghouseManager {
  private readonly config: ClearinghouseConfig;
  private readonly podOracle: PoDOracle;
  private readonly nettingEngine: NettingEngine;
  private readonly agentAgreements = new Map<string, CompletedAgreement[]>();
  private readonly marginDeposits = new Map<string, number>();
  private nettingInterval: ReturnType<typeof setInterval> | null = null;
  private totalVolumeNetted = 0;
  private insuranceFund = 0;

  constructor(config: Partial<ClearinghouseConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.podOracle = new PoDOracle();
    this.nettingEngine = new NettingEngine();
  }

  assessMargin(
    agreement: { agreement_id: string; buyer_id: string; seller_id: string },
    amount: number,
    buyerAgreements?: CompletedAgreement[],
    sellerAgreements?: CompletedAgreement[],
  ): MarginAssessment {
    if (amount <= 0) {
      throw new OphirError(
        OphirErrorCode.MARGIN_ASSESSMENT_FAILED,
        `Assessment amount must be positive, got ${amount}`,
        { agreementId: agreement.agreement_id, amount },
      );
    }
    if (!agreement.buyer_id || !agreement.seller_id) {
      throw new OphirError(
        OphirErrorCode.MARGIN_ASSESSMENT_FAILED,
        'Both buyer_id and seller_id are required for margin assessment',
        { agreementId: agreement.agreement_id },
      );
    }

    const buyerHistory = buyerAgreements ?? this.agentAgreements.get(agreement.buyer_id) ?? [];
    const sellerHistory = sellerAgreements ?? this.agentAgreements.get(agreement.seller_id) ?? [];

    const buyerPod = this.podOracle.computeScore(agreement.buyer_id, buyerHistory);
    const sellerPod = this.podOracle.computeScore(agreement.seller_id, sellerHistory);
    const margin = this.podOracle.getMarginRequirement(buyerPod, sellerPod, amount);

    return {
      agreement_id: agreement.agreement_id,
      buyer_id: agreement.buyer_id,
      seller_id: agreement.seller_id,
      buyer_pod: buyerPod,
      seller_pod: sellerPod,
      required_margin_rate: margin.combined_margin_rate,
      required_deposit: margin.required_deposit,
      full_deposit: margin.full_deposit,
      savings: margin.savings,
    };
  }

  registerObligation(agreementId: string, fromAgent: string, toAgent: string, amount: number): void {
    if (this.checkCircuitBreaker(fromAgent)) {
      throw new OphirError(
        OphirErrorCode.CIRCUIT_BREAKER_TRIGGERED,
        `Agent ${fromAgent} has exceeded the maximum exposure limit of ${this.config.max_exposure_per_agent}`,
        { agentId: fromAgent, maxExposure: this.config.max_exposure_per_agent },
      );
    }

    this.nettingEngine.addObligation({
      id: agreementId,
      from_agent: fromAgent,
      to_agent: toAgent,
      amount,
      agreement_id: agreementId,
      created_at: new Date().toISOString(),
    });
  }

  recordCompletion(agentId: string, agreement: CompletedAgreement): void {
    if (!agentId) {
      throw new OphirError(
        OphirErrorCode.POD_SCORE_INSUFFICIENT,
        'Agent ID is required for recording completion',
      );
    }

    const agreements = this.agentAgreements.get(agentId) ?? [];
    agreements.push(agreement);
    this.agentAgreements.set(agentId, agreements);
    this.podOracle.computeScore(agentId, agreements);
  }

  settleObligation(agreementId: string): void {
    this.nettingEngine.removeObligation(agreementId);
  }

  runNettingCycle(): NettingResult[] {
    const results = this.nettingEngine.runNetting();
    const feeFraction = this.config.insurance_fund_bps / 10_000;

    for (const result of results) {
      const nettedVolume = result.total_gross - result.total_net;
      const fee = nettedVolume * feeFraction;
      this.insuranceFund += fee;
      this.totalVolumeNetted += nettedVolume;
    }

    return results;
  }

  getAgentExposure(agentId: string): AgentExposure {
    const exposure = this.nettingEngine.getNetExposure(agentId);
    const marginHeld = this.marginDeposits.get(agentId) ?? 0;

    return {
      ...exposure,
      margin_held: marginHeld,
      available_capacity: this.config.max_exposure_per_agent - Math.abs(exposure.net_exposure),
    };
  }

  checkCircuitBreaker(agentId: string): boolean {
    const exposure = this.nettingEngine.getNetExposure(agentId);
    return Math.abs(exposure.net_exposure) > this.config.max_exposure_per_agent;
  }

  handleDefault(agentId: string, agreementId: string, amount: number): DefaultResult {
    if (amount <= 0) {
      throw new OphirError(
        OphirErrorCode.MARGIN_ASSESSMENT_FAILED,
        `Default amount must be positive, got ${amount}`,
        { agentId, agreementId, amount },
      );
    }

    const currentMargin = this.marginDeposits.get(agentId) ?? 0;
    const slashed = Math.min(currentMargin, amount);
    this.marginDeposits.set(agentId, currentMargin - slashed);

    const currentPod = this.podOracle.getScore(agentId);
    const oldScore = currentPod?.score ?? 0;
    const penaltyFactor = 0.8;

    const penalizedPod = this.podOracle.applyPenalty(agentId, penaltyFactor);
    const newMarginRate = penalizedPod?.margin_rate ?? 1.0;

    return {
      agent_id: agentId,
      agreement_id: agreementId,
      margin_slashed: slashed,
      pod_degradation: oldScore - oldScore * penaltyFactor,
      new_margin_rate: newMarginRate,
    };
  }

  depositMargin(agentId: string, amount: number): void {
    if (amount <= 0) {
      throw new OphirError(
        OphirErrorCode.MARGIN_ASSESSMENT_FAILED,
        `Deposit amount must be positive, got ${amount}`,
        { agentId, amount },
      );
    }

    const current = this.marginDeposits.get(agentId) ?? 0;
    this.marginDeposits.set(agentId, current + amount);
  }

  withdrawMargin(agentId: string, amount: number): number {
    if (amount <= 0) {
      throw new OphirError(
        OphirErrorCode.MARGIN_ASSESSMENT_FAILED,
        `Withdrawal amount must be positive, got ${amount}`,
        { agentId, amount },
      );
    }

    const held = this.marginDeposits.get(agentId) ?? 0;
    const exposure = this.nettingEngine.getNetExposure(agentId);
    const requiredMargin = Math.max(0, exposure.net_exposure) * this.config.min_margin_rate;
    const available = Math.max(0, held - requiredMargin);
    const withdrawn = Math.min(amount, available);
    this.marginDeposits.set(agentId, held - withdrawn);
    return withdrawn;
  }

  startPeriodicNetting(): void {
    if (this.nettingInterval) return;
    this.nettingInterval = setInterval(() => {
      this.runNettingCycle();
    }, this.config.netting_interval_ms);
  }

  stopPeriodicNetting(): void {
    if (this.nettingInterval) {
      clearInterval(this.nettingInterval);
      this.nettingInterval = null;
    }
  }

  getStats(): {
    total_agents: number;
    total_obligations: number;
    total_volume_netted: number;
    insurance_fund: number;
  } {
    const graph = this.nettingEngine.getObligationGraph();
    return {
      total_agents: graph.nodes.length,
      total_obligations: graph.edges.length,
      total_volume_netted: this.totalVolumeNetted,
      insurance_fund: this.insuranceFund,
    };
  }
}
