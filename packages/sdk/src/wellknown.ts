import type { Express } from 'express';
import type { AgentCard } from './discovery.js';

/** Configuration for .well-known endpoint responses. */
export interface WellKnownConfig {
  /** Override the agent card (otherwise auto-generated from SellerAgent). */
  agentCard?: AgentCard;
  /** Additional Ophir-specific metadata for /.well-known/ophir.json. */
  ophirMeta?: {
    protocol_version: string;
    registry_endpoints?: string[];
    supported_payments: Array<{ network: string; token: string }>;
    sla_dispute_method: string;
  };
}

/**
 * Attaches /.well-known/agent.json and /.well-known/ophir.json routes
 * to an Express app. The agent.json follows the A2A Agent Card spec.
 * The ophir.json provides Ophir-specific discovery metadata.
 * @param app - Express application instance
 * @param agentCard - The AgentCard to serve at /.well-known/agent.json
 * @param config - Optional overrides for the well-known responses
 */
export function attachWellKnown(
  app: Express,
  agentCard: AgentCard,
  config?: WellKnownConfig,
): void {
  const card = config?.agentCard ?? agentCard;

  app.get('/.well-known/agent.json', (_req, res) => {
    res.set('Content-Type', 'application/json');
    res.set('Access-Control-Allow-Origin', '*');
    res.status(200).json(card);
  });

  const negotiation = card.capabilities?.negotiation;
  const services = negotiation?.services ?? [];
  const meta = config?.ophirMeta;

  const ophirJson = {
    protocol: 'ophir',
    version: meta?.protocol_version ?? '1.0',
    negotiation_endpoint: negotiation?.endpoint ?? card.url,
    services,
    supported_payments: meta?.supported_payments ??
      (negotiation?.acceptedPayments ?? [{ network: 'solana', token: 'USDC' }]),
    sla_dispute_method: meta?.sla_dispute_method ?? 'lockstep_verification',
    registry_endpoints: meta?.registry_endpoints ?? ['https://registry.ophir.ai/v1'],
  };

  app.get('/.well-known/ophir.json', (_req, res) => {
    res.set('Content-Type', 'application/json');
    res.set('Access-Control-Allow-Origin', '*');
    res.status(200).json(ophirJson);
  });
}
