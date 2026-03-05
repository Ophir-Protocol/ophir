import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIG } from '@ophir/protocol';
import type { RFQParams, QuoteParams, SLARequirement } from '@ophir/protocol';
import { SellerAgent, signMessage, generateKeyPair } from '@ophir/sdk';
import type { SellerAgentConfig } from '@ophir/sdk';

const SERVICE = {
  category: 'data_processing',
  description: 'High-throughput data processing and transformation',
  base_price: '0.10',
  currency: 'USDC',
  unit: 'MB',
};

const COMPLEXITY_MULTIPLIERS: Record<string, number> = {
  simple: 0.8,
  standard: 1.0,
  complex: 1.5,
  realtime: 2.0,
};

/** Create a data processing seller agent with complexity-based pricing. */
export function createDataProcessingAgent(config?: { port?: number }): SellerAgent {
  const keypair = generateKeyPair();
  const port = config?.port ?? 3002;

  const agentConfig: SellerAgentConfig = {
    keypair,
    endpoint: `http://localhost:${port}`,
    services: [SERVICE],
    pricingStrategy: { type: 'fixed' },
  };

  const agent = new SellerAgent(agentConfig);

  agent.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
    if (rfq.service.category !== 'data_processing') {
      console.log(`[data-processing] Ignoring RFQ ${rfq.rfq_id} — category mismatch`);
      return null;
    }

    console.log(`[data-processing] Received RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id}`);

    let basePrice = parseFloat(SERVICE.base_price);

    // Complexity multiplier
    const complexity = rfq.service.requirements?.complexity as string | undefined;
    if (complexity) {
      const multiplier = COMPLEXITY_MULTIPLIERS[complexity.toLowerCase()] ?? 1.0;
      basePrice *= multiplier;
      console.log(`[data-processing] Complexity "${complexity}" → multiplier ${multiplier}`);
    }

    const volumeDiscounts = [
      { min_units: 1000, price_per_unit: (basePrice * 0.85).toFixed(4) },
      { min_units: 10000, price_per_unit: (basePrice * 0.7).toFixed(4) },
    ];

    const sla: SLARequirement = {
      metrics: [
        { name: 'throughput_rpm', target: 500, comparison: 'gte' },
        { name: 'uptime_pct', target: 99.5, comparison: 'gte' },
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
        price_per_unit: basePrice.toFixed(4),
        currency: 'USDC',
        unit: 'MB',
        pricing_model: 'fixed' as const,
        volume_discounts: volumeDiscounts,
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, keypair.secretKey);
    const quote: QuoteParams = { ...unsigned, signature };

    console.log(`[data-processing] Quoting ${basePrice.toFixed(4)} USDC/MB for RFQ ${rfq.rfq_id}`);
    return quote;
  });

  return agent;
}
