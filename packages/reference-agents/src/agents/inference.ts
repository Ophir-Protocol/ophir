import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIG } from '@ophir/protocol';
import type { RFQParams, QuoteParams, SLARequirement } from '@ophir/protocol';
import { SellerAgent, signMessage, generateKeyPair } from '@ophir/sdk';
import type { SellerAgentConfig } from '@ophir/sdk';

const SERVICE = {
  category: 'inference',
  description: 'GPU inference for image classification and vision models',
  base_price: '0.005',
  currency: 'USDC',
  unit: 'request',
};

const MODEL_MULTIPLIERS: Record<string, number> = {
  resnet: 1.0,
  vit: 1.2,
  clip: 1.5,
  diffusion: 2.0,
  llama: 1.8,
};

/** Create a GPU inference seller agent with model-based pricing and volume discounts. */
export function createInferenceAgent(config?: { port?: number }): SellerAgent {
  const keypair = generateKeyPair();
  const port = config?.port ?? 3001;

  const agentConfig: SellerAgentConfig = {
    keypair,
    endpoint: `http://localhost:${port}`,
    services: [SERVICE],
    pricingStrategy: { type: 'fixed' },
  };

  const agent = new SellerAgent(agentConfig);

  agent.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
    if (rfq.service.category !== 'inference') {
      console.log(`[inference] Ignoring RFQ ${rfq.rfq_id} — category mismatch`);
      return null;
    }

    console.log(`[inference] Received RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id}`);

    let basePrice = parseFloat(SERVICE.base_price);

    // Model family multiplier
    const modelFamily = rfq.service.requirements?.model_family as string | undefined;
    if (modelFamily) {
      const multiplier = MODEL_MULTIPLIERS[modelFamily.toLowerCase()] ?? 1.3;
      basePrice *= multiplier;
      console.log(`[inference] Model family "${modelFamily}" → multiplier ${multiplier}`);
    }

    // Volume discounts
    const volumeDiscounts = [
      { min_units: 1000, price_per_unit: (basePrice * 0.8).toFixed(6) },
      { min_units: 10000, price_per_unit: (basePrice * 0.6).toFixed(6) },
    ];

    const sla: SLARequirement = {
      metrics: [
        { name: 'p99_latency_ms', target: 500, comparison: 'lte' },
        { name: 'uptime_pct', target: 99.9, comparison: 'gte' },
        { name: 'accuracy_pct', target: 95, comparison: 'gte' },
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
        unit: 'request',
        pricing_model: 'fixed' as const,
        volume_discounts: volumeDiscounts,
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, keypair.secretKey);
    const quote: QuoteParams = { ...unsigned, signature };

    console.log(`[inference] Quoting ${basePrice.toFixed(6)} USDC/request for RFQ ${rfq.rfq_id}`);
    return quote;
  });

  return agent;
}
