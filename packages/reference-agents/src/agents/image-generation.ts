import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIG } from '@ophirai/protocol';
import type { RFQParams, QuoteParams, SLARequirement } from '@ophirai/protocol';
import { SellerAgent, signMessage, generateKeyPair } from '@ophirai/sdk';
import type { SellerAgentConfig } from '@ophirai/sdk';

const SERVICE = {
  category: 'image_generation',
  description: 'AI image generation with multiple resolution tiers',
  base_price: '0.05',
  currency: 'USDC',
  unit: 'image',
};

const RESOLUTION_TIERS: Record<string, number> = {
  '256x256': 0.5,
  '512x512': 1.0,
  '1024x1024': 2.0,
  '2048x2048': 4.0,
};

/** Create an image generation seller agent with resolution-based pricing. */
export function createImageGenerationAgent(config?: { port?: number }): SellerAgent {
  const keypair = generateKeyPair();
  const port = config?.port ?? 3005;

  const agentConfig: SellerAgentConfig = {
    keypair,
    endpoint: `http://localhost:${port}`,
    services: [SERVICE],
    pricingStrategy: { type: 'fixed' },
  };

  const agent = new SellerAgent(agentConfig);

  agent.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
    if (rfq.service.category !== 'image_generation') {
      console.log(`[image-gen] Ignoring RFQ ${rfq.rfq_id} — category mismatch`);
      return null;
    }

    console.log(`[image-gen] Received RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id}`);

    let basePrice = parseFloat(SERVICE.base_price);

    // Resolution tier pricing
    const resolution = rfq.service.requirements?.resolution as string | undefined;
    if (resolution) {
      const multiplier = RESOLUTION_TIERS[resolution] ?? 1.0;
      basePrice *= multiplier;
      console.log(`[image-gen] Resolution "${resolution}" → multiplier ${multiplier}`);
    }

    const volumeDiscounts = [
      { min_units: 100, price_per_unit: (basePrice * 0.9).toFixed(4) },
      { min_units: 1000, price_per_unit: (basePrice * 0.75).toFixed(4) },
    ];

    const sla: SLARequirement = {
      metrics: [
        { name: 'p99_latency_ms', target: 10000, comparison: 'lte' },
        { name: 'uptime_pct', target: 99, comparison: 'gte' },
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
        unit: 'image',
        pricing_model: 'fixed' as const,
        volume_discounts: volumeDiscounts,
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, keypair.secretKey);
    const quote: QuoteParams = { ...unsigned, signature };

    console.log(`[image-gen] Quoting ${basePrice.toFixed(4)} USDC/image for RFQ ${rfq.rfq_id}`);
    return quote;
  });

  return agent;
}
