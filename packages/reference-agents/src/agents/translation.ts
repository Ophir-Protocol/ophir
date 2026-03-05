import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_CONFIG } from '@ophir/protocol';
import type { RFQParams, QuoteParams, SLARequirement } from '@ophir/protocol';
import { SellerAgent, signMessage, generateKeyPair } from '@ophir/sdk';
import type { SellerAgentConfig } from '@ophir/sdk';

const SERVICE = {
  category: 'translation',
  description: 'AI-powered multilingual translation service',
  base_price: '0.02',
  currency: 'USDC',
  unit: 'word',
};

// Common language pairs get discounts, rare pairs cost more
const PAIR_MULTIPLIERS: Record<string, number> = {
  'en-es': 0.8,
  'en-fr': 0.8,
  'en-de': 0.85,
  'en-zh': 1.0,
  'en-ja': 1.2,
  'en-ko': 1.2,
  'en-ar': 1.3,
  'en-ru': 1.0,
  'zh-en': 1.0,
  'ja-en': 1.2,
  'de-en': 0.85,
  'fr-en': 0.8,
  'es-en': 0.8,
};

/** Create a multilingual translation seller agent with language-pair pricing. */
export function createTranslationAgent(config?: { port?: number }): SellerAgent {
  const keypair = generateKeyPair();
  const port = config?.port ?? 3004;

  const agentConfig: SellerAgentConfig = {
    keypair,
    endpoint: `http://localhost:${port}`,
    services: [SERVICE],
    pricingStrategy: { type: 'fixed' },
  };

  const agent = new SellerAgent(agentConfig);

  agent.onRFQ(async (rfq: RFQParams): Promise<QuoteParams | null> => {
    if (rfq.service.category !== 'translation') {
      console.log(`[translation] Ignoring RFQ ${rfq.rfq_id} — category mismatch`);
      return null;
    }

    console.log(`[translation] Received RFQ ${rfq.rfq_id} from ${rfq.buyer.agent_id}`);

    let basePrice = parseFloat(SERVICE.base_price);

    // Language pair pricing
    const sourceLang = rfq.service.requirements?.source_language as string | undefined;
    const targetLang = rfq.service.requirements?.target_language as string | undefined;
    if (sourceLang && targetLang) {
      const pair = `${sourceLang.toLowerCase()}-${targetLang.toLowerCase()}`;
      const multiplier = PAIR_MULTIPLIERS[pair] ?? 1.5;
      basePrice *= multiplier;
      console.log(`[translation] Language pair "${pair}" → multiplier ${multiplier}`);
    }

    const volumeDiscounts = [
      { min_units: 1000, price_per_unit: (basePrice * 0.85).toFixed(6) },
      { min_units: 10000, price_per_unit: (basePrice * 0.7).toFixed(6) },
    ];

    const sla: SLARequirement = {
      metrics: [
        { name: 'accuracy_pct', target: 95, comparison: 'gte' },
        { name: 'p99_latency_ms', target: 3000, comparison: 'lte' },
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
        unit: 'word',
        pricing_model: 'fixed' as const,
        volume_discounts: volumeDiscounts,
      },
      sla_offered: sla,
      expires_at: new Date(Date.now() + DEFAULT_CONFIG.quote_timeout_ms).toISOString(),
    };

    const signature = signMessage(unsigned, keypair.secretKey);
    const quote: QuoteParams = { ...unsigned, signature };

    console.log(`[translation] Quoting ${basePrice.toFixed(6)} USDC/word for RFQ ${rfq.rfq_id}`);
    return quote;
  });

  return agent;
}
