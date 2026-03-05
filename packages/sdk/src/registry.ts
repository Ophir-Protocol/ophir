import type { ServiceOffering } from './types.js';
import type { AgentCard, NegotiationCapability } from './discovery.js';

/** A registered agent in the Ophir registry. */
export interface RegisteredAgent {
  agentId: string;
  endpoint: string;
  services: ServiceOffering[];
  capabilities: NegotiationCapability;
  registeredAt: string;
  lastHeartbeat: string;
  reputation?: { score: number; total_agreements: number; disputes_won: number; disputes_lost: number };
}

/** Query parameters for finding agents in the registry. */
export interface RegistryQuery {
  category?: string;
  maxPrice?: string;
  currency?: string;
  minReputation?: number;
  limit?: number;
}

/**
 * Client for the Ophir Agent Registry — a lightweight discovery service
 * where agents register their services and buyers find sellers.
 *
 * The registry is optional. Agents can also discover each other via
 * A2A Agent Cards at /.well-known/agent.json, or via direct endpoints.
 *
 * Supports multiple registry endpoints for redundancy.
 */
export class OphirRegistry {
  private endpoints: string[];
  private agentId?: string;
  private signature?: string;

  constructor(endpoints?: string[]) {
    this.endpoints = endpoints ?? ['https://registry.ophir.ai/v1'];
  }

  /** Authenticate with the registry using a did:key and signed challenge. */
  authenticate(agentId: string, signature: string): void {
    this.agentId = agentId;
    this.signature = signature;
  }

  /** Register this agent's services with the registry. */
  async register(card: AgentCard): Promise<{ success: boolean; agentId: string }> {
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint}/agents`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.agentId ? { 'X-Agent-Id': this.agentId } : {}),
            ...(this.signature ? { 'X-Agent-Signature': this.signature } : {}),
          },
          body: JSON.stringify(card),
        });
        if (res.ok) {
          const data = await res.json() as { agent_id: string };
          return { success: true, agentId: data.agent_id };
        }
      } catch {
        continue;
      }
    }
    return { success: false, agentId: '' };
  }

  /** Send a heartbeat to keep the registration alive. */
  async heartbeat(agentId: string): Promise<boolean> {
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint}/agents/${encodeURIComponent(agentId)}/heartbeat`, {
          method: 'POST',
          headers: {
            ...(this.agentId ? { 'X-Agent-Id': this.agentId } : {}),
          },
        });
        if (res.ok) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /** Find agents matching a query. */
  async find(query: RegistryQuery): Promise<RegisteredAgent[]> {
    const params = new URLSearchParams();
    if (query.category) params.set('category', query.category);
    if (query.maxPrice) params.set('max_price', query.maxPrice);
    if (query.currency) params.set('currency', query.currency);
    if (query.minReputation !== undefined) params.set('min_reputation', String(query.minReputation));
    if (query.limit !== undefined) params.set('limit', String(query.limit));

    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint}/agents?${params.toString()}`);
        if (res.ok) {
          const data = await res.json() as { agents: RegisteredAgent[] };
          return data.agents;
        }
      } catch {
        continue;
      }
    }
    return [];
  }

  /** Unregister this agent from the registry. */
  async unregister(agentId: string): Promise<boolean> {
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetch(`${endpoint}/agents/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
          headers: {
            ...(this.agentId ? { 'X-Agent-Id': this.agentId } : {}),
            ...(this.signature ? { 'X-Agent-Signature': this.signature } : {}),
          },
        });
        if (res.ok) return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}

/**
 * Well-known bootstrap endpoints for Ophir agent discovery.
 * These can be embedded in agent frameworks so that any agent
 * with the Ophir SDK can automatically find and negotiate with
 * service providers without prior configuration.
 */
export const BOOTSTRAP_REGISTRIES = [
  'https://registry.ophir.ai/v1',
] as const;

/**
 * Auto-discover Ophir sellers for a service category.
 * Tries the registry first, falls back to A2A discovery via known endpoints.
 */
export async function autoDiscover(
  category: string,
  options?: { registries?: string[]; fallbackEndpoints?: string[]; maxResults?: number },
): Promise<RegisteredAgent[]> {
  const registry = new OphirRegistry(options?.registries);
  const results = await registry.find({
    category,
    limit: options?.maxResults ?? 10,
  });

  if (results.length > 0) return results;

  // Fallback: A2A discovery via known endpoints
  if (options?.fallbackEndpoints) {
    const { discoverAgents, parseAgentCard } = await import('./discovery.js');
    const cards = await discoverAgents(options.fallbackEndpoints);
    return cards
      .map((card) => {
        const neg = card.capabilities?.negotiation;
        if (!neg?.supported) return null;
        const services: ServiceOffering[] = (neg.services ?? [])
          .filter((s) => !category || s.category === category)
          .map((s) => ({
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
          capabilities: neg,
          registeredAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        } as RegisteredAgent;
      })
      .filter((a): a is RegisteredAgent => a !== null);
  }

  return [];
}
