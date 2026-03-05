import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIG } from '@ophirai/protocol';
import type { RFQParams, QuoteParams, SLARequirement } from '@ophirai/protocol';
import { SellerAgent, signMessage, generateKeyPair } from '@ophirai/sdk';
import type { SellerAgentConfig } from '@ophirai/sdk';

const SERVICE = {
  category: 'code_review',
  description: 'Automated code review with security and quality analysis',
  base_price: '0.001',
  currency: 'USDC',
  unit: 'line',
};

const THOROUGHNESS_MULTIPLIERS: Record<string, { multiplier: number; accuracy: number }> = {
  basic: { multiplier: 0.7, accuracy: 85 },
  standard: { multiplier: 1.0, accuracy: 90 },
  thorough: { multiplier: 1.5, accuracy: 94 },
  security: { multiplier: 2.0, accuracy: 96 },
};

/** Create a code review seller agent with thoroughness-based pricing tiers. */
export function createCodeReviewAgent(config?: { port?: number }): SellerAgent {
  const keypair = generateKeyPair();
  const port = config?.port ?? 3003;

  const agentConfig: SellerAgentConfig = {
    keypair,
    endpoint: `http://localhost:${port}`,
    services: [SERVICE],
    pricingStrategy: { type: 'fixed' },
  };

  const agent = new SellerAgent(agentConfig);

  agent.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
    if (rfq.service.category !== 'code_review') {
      console.log(`[code-review] Ignoring RFQ ${rfq.rfq_id} — category mismatch`);
      return null;
    }

    console.log(`[code-review] Received RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id}`);

    let basePrice = parseFloat(SERVICE.base_price);
    let accuracyTarget = 90;

    // Thoroughness level
    const thoroughness = rfq.service.requirements?.thoroughness as string | undefined;
    if (thoroughness) {
      const tier = THOROUGHNESS_MULTIPLIERS[thoroughness.toLowerCase()];
      if (tier) {
        basePrice *= tier.multiplier;
        accuracyTarget = tier.accuracy;
        console.log(`[code-review] Thoroughness "${thoroughness}" → ${tier.multiplier}x, accuracy ${tier.accuracy}%`);
      }
    }

    const volumeDiscounts = [
      { min_units: 1000, price_per_unit: (basePrice * 0.85).toFixed(6) },
      { min_units: 10000, price_per_unit: (basePrice * 0.75).toFixed(6) },
    ];

    const sla: SLARequirement = {
      metrics: [
        { name: 'accuracy_pct', target: accuracyTarget, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 5000, comparison: 'lte' },
      ],
      dispute_resolution: { method: 'lockstep_verification', timeout_hours: 24 },
    };

    const unsigned = {
      quote_id: uuidv4(),
      rfq_id: rfq.rfq_id,
      seller: {
        agent_id: agent.getAgentId(),
        endpoint: agent.getEndpoint(),
      },
      pricing: {
        price_per_unit: basePrice.toFixed(6),
        currency: 'USDC',
        unit: 'line',
        pricing_model: 'fixed' as const,
        volume_discounts: volumeDiscounts,
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, keypair.secretKey);
    const quote: QuoteParams = { ...unsigned, signature };

    console.log(`[code-review] Quoting ${basePrice.toFixed(6)} USDC/line for RFQ ${rfq.rfq_id}`);
    return quote;
  });

  return agent;
}
