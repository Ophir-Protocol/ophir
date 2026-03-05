/**
 * @module @ophirai/openai-adapter
 *
 * OpenAI function calling adapter for Ophir negotiation protocol.
 * Exposes Ophir negotiation as OpenAI-compatible tool definitions so that
 * any OpenAI-powered agent can negotiate with Ophir service providers
 * through native function calling.
 */

import { negotiate, autoDiscover } from '@ophirai/sdk';
import type { NegotiateOptions } from '@ophirai/sdk';
import type { SLAMetric, SLARequirement } from '@ophirai/protocol';

/** An OpenAI-compatible function tool definition. */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

/** OpenAI function tool definitions for Ophir negotiation. */
export const OPHIR_TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'ophir_negotiate',
      description:
        'Negotiate with AI service providers using the Ophir protocol. Discovers sellers, sends RFQs, collects quotes, and optionally auto-accepts the best offer.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Service category (e.g. inference, translation, embedding)',
          },
          model: {
            type: 'string',
            description: 'Specific model name (e.g. gpt-4, llama-3-70b)',
          },
          max_budget: {
            type: 'string',
            description: 'Maximum price per unit (e.g. 0.01)',
          },
          currency: {
            type: 'string',
            description: 'Payment currency',
            default: 'USDC',
          },
          sla_requirements: {
            type: 'object',
            description: 'SLA requirements',
            properties: {
              uptime_pct: { type: 'number', description: 'Minimum uptime percentage' },
              max_latency_ms: {
                type: 'number',
                description: 'Maximum p99 latency in milliseconds',
              },
              min_accuracy_pct: {
                type: 'number',
                description: 'Minimum accuracy percentage',
              },
            },
          },
          auto_accept: {
            type: 'boolean',
            description: 'Auto-accept best quote',
            default: true,
          },
        },
        required: ['service', 'max_budget'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ophir_list_services',
      description: 'List available Ophir service providers and their offerings.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by service category' },
        },
      },
    },
  },
];

/** Arguments for the ophir_negotiate function call. */
interface NegotiateArgs {
  service: string;
  model?: string;
  max_budget: string;
  currency?: string;
  sla_requirements?: {
    uptime_pct?: number;
    max_latency_ms?: number;
    min_accuracy_pct?: number;
  };
  auto_accept?: boolean;
}

/** Arguments for the ophir_list_services function call. */
interface ListServicesArgs {
  category?: string;
}

/**
 * Build an {@link SLARequirement} from the simplified SLA args provided via
 * the OpenAI function call interface.
 */
function buildSLA(
  args?: NegotiateArgs['sla_requirements'],
): SLARequirement | undefined {
  if (!args) return undefined;

  const metrics: SLAMetric[] = [];
  if (args.uptime_pct !== undefined) {
    metrics.push({ name: 'uptime_pct', target: args.uptime_pct, comparison: 'gte' });
  }
  if (args.max_latency_ms !== undefined) {
    metrics.push({ name: 'p99_latency_ms', target: args.max_latency_ms, comparison: 'lte' });
  }
  if (args.min_accuracy_pct !== undefined) {
    metrics.push({ name: 'accuracy_pct', target: args.min_accuracy_pct, comparison: 'gte' });
  }

  if (metrics.length === 0) return undefined;

  return {
    metrics,
    dispute_resolution: { method: 'automatic_escrow' },
  };
}

/**
 * Handle an OpenAI function call result by dispatching to Ophir SDK.
 * Use this in your tool_calls processing loop:
 *
 * ```typescript
 * if (call.function.name.startsWith('ophir_')) {
 *   const result = await handleOphirFunctionCall(
 *     call.function.name,
 *     JSON.parse(call.function.arguments),
 *   );
 * }
 * ```
 *
 * @param name - The function name from the OpenAI tool call (e.g. 'ophir_negotiate').
 * @param args - The parsed arguments object from the function call.
 * @returns A JSON string suitable for returning as the tool call result.
 * @throws {Error} If the function name is not a known Ophir function.
 */
export async function handleOphirFunctionCall(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'ophir_negotiate': {
      const a = args as unknown as NegotiateArgs;
      const opts: NegotiateOptions = {
        service: a.service,
        maxBudget: a.max_budget,
        currency: a.currency,
        model: a.model,
        sla: buildSLA(a.sla_requirements),
        autoAccept: a.auto_accept ?? true,
      };
      const result = await negotiate(opts);
      return JSON.stringify(result);
    }
    case 'ophir_list_services': {
      const a = args as unknown as ListServicesArgs;
      const agents = await autoDiscover(a.category ?? '');
      const services = agents.map((agent) => ({
        agentId: agent.agentId,
        endpoint: agent.endpoint,
        services: agent.services,
        reputation: agent.reputation,
      }));
      return JSON.stringify({ providers: services });
    }
    default:
      throw new Error(`Unknown Ophir function: ${name}`);
  }
}
