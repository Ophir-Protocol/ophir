import type { PaymentMethod } from '@ophirai/protocol';
import type { SellerInfo, ServiceOffering } from './types.js';

/** Negotiation capability advertised in an A2A Agent Card. */
export interface NegotiationCapability {
  supported: boolean;
  endpoint: string;
  protocols: string[];
  acceptedPayments: PaymentMethod[];
  negotiationStyles: string[];
  maxNegotiationRounds: number;
  services: {
    category: string;
    description: string;
    base_price: string;
    currency: string;
    unit: string;
  }[];
}

/** A2A-compatible Agent Card describing an agent's identity and capabilities. */
export interface AgentCard {
  name: string;
  description: string;
  url: string;
  capabilities: {
    negotiation?: NegotiationCapability;
    [key: string]: unknown;
  };
}

/** Fetch /.well-known/agent.json from each endpoint and filter to agents with negotiation capability.
 * @param endpoints - Base URLs of agents to probe (e.g. `['https://agent.example.com']`)
 * @returns Agent cards for all reachable agents that support negotiation; unreachable endpoints are silently skipped
 * @example
 * ```typescript
 * const agents = await discoverAgents(['https://agent1.io', 'https://agent2.io']);
 * ```
 */
export async function discoverAgents(endpoints: string[]): Promise<AgentCard[]> {
  const results = await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      const url = endpoint.replace(/\/$/, '') + '/.well-known/agent.json';
      const res = await fetch(url);
      if (!res.ok) return null;
      const card: AgentCard = await res.json();
      if (!card.capabilities?.negotiation?.supported) return null;
      return card;
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<AgentCard> =>
        r.status === 'fulfilled' && r.value !== null,
    )
    .map((r) => r.value);
}

/** Extract SellerInfo from an agent card's negotiation capability.
 * @param card - An A2A Agent Card to extract seller information from
 * @returns Parsed seller info with endpoint and service offerings, or null if the card has no negotiation capability or no services
 * @example
 * ```typescript
 * const seller = parseAgentCard(card);
 * if (seller) console.log(seller.services);
 * ```
 */
export function parseAgentCard(card: AgentCard): SellerInfo | null {
  const neg = card.capabilities?.negotiation;
  if (!neg?.supported) return null;

  const services: ServiceOffering[] = (neg.services ?? []).map((s) => ({
    category: s.category,
    description: s.description,
    base_price: s.base_price,
    currency: s.currency,
    unit: s.unit,
  }));

  if (services.length === 0) return null;

  return {
    agentId: card.url,
    endpoint: neg.endpoint,
    services,
  };
}
