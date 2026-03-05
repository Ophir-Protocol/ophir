/**
 * @module @ophirai/autogen
 *
 * AutoGen-compatible tools for Ophir agent negotiation protocol.
 *
 * Exports tools in the OpenAI function calling format that AutoGen uses
 * natively. Each tool provides a JSON Schema definition and an async handler.
 *
 * @example
 * ```typescript
 * import { registerOphirTools } from '@ophirai/autogen';
 *
 * const tools = registerOphirTools();
 * // Register with AutoGen agent:
 * for (const tool of tools) {
 *   agent.register_function(tool.definition, tool.handler);
 * }
 * ```
 */

import { negotiate, autoDiscover } from "@ophirai/sdk";
import type { NegotiateOptions } from "@ophirai/sdk";
import type { SLAMetric, SLARequirement } from "@ophirai/protocol";

// ── Types ────────────────────────────────────────────────────────────

export interface AutoGenFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface AutoGenToolRegistration {
  definition: AutoGenFunction;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────

const DEFAULT_REGISTRY = "https://registry.ophir.ai/v1";

function buildSLA(
  sla?: Record<string, unknown>,
): SLARequirement | undefined {
  if (!sla) return undefined;

  const metrics: SLAMetric[] = [];
  if (typeof sla.p99_latency_ms === "number") {
    metrics.push({ name: "p99_latency_ms", target: sla.p99_latency_ms, comparison: "lte" });
  }
  if (typeof sla.uptime_pct === "number") {
    metrics.push({ name: "uptime_pct", target: sla.uptime_pct, comparison: "gte" });
  }
  if (typeof sla.error_rate === "number") {
    metrics.push({ name: "error_rate_pct", target: sla.error_rate, comparison: "lte" });
  }
  if (typeof sla.throughput_rps === "number") {
    metrics.push({ name: "throughput_rpm", target: sla.throughput_rps, comparison: "gte" });
  }

  if (metrics.length === 0) return undefined;

  return {
    metrics,
    dispute_resolution: { method: "automatic_escrow" },
  };
}

// ── Negotiate function ───────────────────────────────────────────────

export const negotiateFunction: AutoGenToolRegistration = {
  definition: {
    type: "function",
    function: {
      name: "ophir_negotiate",
      description:
        "Negotiate with AI service providers to get the best price and SLA guarantees " +
        "for inference, embedding, translation, or other AI service requests. Use this " +
        "when you need to: (1) find cheaper inference than your current provider, " +
        "(2) get enforceable SLA guarantees like uptime, latency, and error rate backed " +
        "by escrow, (3) compare multiple AI providers automatically and get the best deal, " +
        "(4) switch providers dynamically based on cost or performance requirements. " +
        "Returns a cryptographically signed agreement with the best provider including " +
        "the endpoint URL, negotiated price, and SLA terms.",
      parameters: {
        type: "object",
        properties: {
          service_category: {
            type: "string",
            description: "Service category to negotiate for (e.g. inference, translation, embedding, image-generation)",
          },
          model: {
            type: "string",
            description: "Specific model name to request (e.g. gpt-4, llama-3-70b, claude-sonnet-4-6)",
          },
          max_price_per_unit: {
            type: "number",
            description: "Maximum price per unit you are willing to pay (e.g. 0.01 for 1 cent per request)",
          },
          currency: {
            type: "string",
            description: "Payment currency (e.g. USDC, USDT, SOL, ETH)",
          },
          unit: {
            type: "string",
            description: "Pricing unit (e.g. request, token, minute, image)",
          },
          ranking: {
            type: "string",
            enum: ["cheapest", "fastest", "best_sla"],
            description: "Strategy for ranking provider quotes: 'cheapest', 'fastest', or 'best_sla'",
          },
          auto_accept: {
            type: "boolean",
            description: "When true, automatically accept the best-ranked quote and return a signed agreement",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds for the entire negotiation round",
          },
          sellers: {
            type: "array",
            items: { type: "string" },
            description: "Direct seller endpoint URLs to contact, bypassing registry discovery",
          },
          sla_requirements: {
            type: "object",
            description: "Service Level Agreement requirements that providers must meet",
            properties: {
              p99_latency_ms: { type: "number", description: "Maximum p99 latency in milliseconds" },
              uptime_pct: { type: "number", description: "Minimum uptime percentage (e.g. 99.9)" },
              error_rate: { type: "number", description: "Maximum error rate as percentage" },
              throughput_rps: { type: "number", description: "Minimum throughput in requests per second" },
            },
          },
          registry_url: {
            type: "string",
            description: "Ophir registry URL for discovering service providers",
          },
        },
        required: [],
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    try {
      const sellers = args.sellers as string[] | undefined;
      const opts: NegotiateOptions = {
        service: (args.service_category as string) ?? "inference",
        model: args.model as string | undefined,
        maxBudget: args.max_price_per_unit != null
          ? String(args.max_price_per_unit)
          : "1.00",
        currency: (args.currency as string) ?? "USDC",
        unit: (args.unit as string) ?? "request",
        ranking: (args.ranking as NegotiateOptions["ranking"]) ?? "cheapest",
        autoAccept: args.auto_accept != null ? Boolean(args.auto_accept) : true,
        sla: buildSLA(args.sla_requirements as Record<string, unknown> | undefined),
        sellers: sellers && sellers.length > 0 ? sellers : undefined,
        registries: [(args.registry_url as string) ?? DEFAULT_REGISTRY],
        timeout: args.timeout_ms != null ? Number(args.timeout_ms) : undefined,
      };

      const result = await negotiate(opts);

      return JSON.stringify({
        success: true,
        agreement: result.agreement
          ? {
              agreement_id: result.agreement.agreement_id,
              endpoint: result.acceptedQuote?.seller.endpoint,
              final_terms: result.agreement.final_terms,
            }
          : null,
        quotes_received: result.quotes.length,
        sellers_contacted: result.sellersContacted,
        duration_ms: result.durationMs,
        ranking: opts.ranking,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: false, error: message });
    }
  },
};

// ── Discover function ────────────────────────────────────────────────

export const discoverFunction: AutoGenToolRegistration = {
  definition: {
    type: "function",
    function: {
      name: "ophir_discover",
      description:
        "Discover available AI service providers registered on the Ophir decentralized " +
        "network. Use this to survey the market before negotiating — see what providers " +
        "are available, what services they offer, their pricing, and reputation scores. " +
        "Filter by service category and minimum reputation to find reliable providers.",
      parameters: {
        type: "object",
        properties: {
          service_category: {
            type: "string",
            description: "Service category to search for (e.g. inference, translation, embedding, image-generation)",
          },
          max_results: {
            type: "number",
            description: "Maximum number of providers to return",
          },
          min_reputation: {
            type: "number",
            description: "Minimum reputation score (0-100) to filter providers",
          },
          registry_url: {
            type: "string",
            description: "Ophir registry URL for provider discovery",
          },
        },
        required: [],
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    try {
      const maxResults = args.max_results != null ? Number(args.max_results) : 10;

      const agents = await autoDiscover(
        (args.service_category as string) ?? "inference",
        {
          registries: [(args.registry_url as string) ?? DEFAULT_REGISTRY],
          maxResults,
        },
      );

      const filtered = agents.filter((agent) => {
        if (args.min_reputation != null && agent.reputation) {
          if (agent.reputation.score < (args.min_reputation as number)) return false;
        }
        return true;
      });

      return JSON.stringify({
        success: true,
        providers: filtered.map((agent) => ({
          agent_id: agent.agentId,
          endpoint: agent.endpoint,
          services: agent.services,
          reputation: agent.reputation ?? null,
          last_heartbeat: agent.lastHeartbeat,
        })),
        total_found: filtered.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: false, error: message });
    }
  },
};

// ── Execute inference function ───────────────────────────────────────

export const executeInferenceFunction: AutoGenToolRegistration = {
  definition: {
    type: "function",
    function: {
      name: "ophir_execute_inference",
      description:
        "Execute an inference request using an existing Ophir agreement. After negotiating " +
        "with a provider via ophir_negotiate, use this tool to send prompts to the agreed-upon " +
        "endpoint. The agreement's SLA guarantees (latency, uptime, error rate) are enforced " +
        "by the protocol. Pass the agreement_id from a previous negotiation and your prompt.",
      parameters: {
        type: "object",
        properties: {
          agreement_id: {
            type: "string",
            description: "The agreement ID from a completed negotiation (returned by ophir_negotiate)",
          },
          endpoint: {
            type: "string",
            description: "The provider endpoint URL from the negotiation agreement",
          },
          prompt: {
            type: "string",
            description: "The inference prompt to send to the provider",
          },
          model: {
            type: "string",
            description: "Model to use for inference (must match the negotiated agreement)",
          },
          max_tokens: {
            type: "number",
            description: "Maximum number of tokens to generate in the response",
          },
          temperature: {
            type: "number",
            description: "Sampling temperature (0-2). Lower values are more deterministic.",
          },
        },
        required: ["agreement_id", "endpoint", "prompt"],
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    try {
      const agreementId = args.agreement_id as string;
      const endpoint = args.endpoint as string;
      const prompt = args.prompt as string;

      if (!agreementId || !endpoint || !prompt) {
        return JSON.stringify({
          success: false,
          error: "agreement_id, endpoint, and prompt are required",
        });
      }

      const body: Record<string, unknown> = {
        model: (args.model as string) ?? undefined,
        messages: [{ role: "user", content: prompt }],
        max_tokens: args.max_tokens != null ? Number(args.max_tokens) : undefined,
        temperature: args.temperature != null ? Number(args.temperature) : undefined,
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ophir-Agreement-Id": agreementId,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return JSON.stringify({
          success: false,
          error: `Inference request failed with status ${response.status}: ${await response.text()}`,
        });
      }

      const data = await response.json();

      return JSON.stringify({
        success: true,
        agreement_id: agreementId,
        response: data,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: false, error: message });
    }
  },
};

// ── Register all tools ───────────────────────────────────────────────

export function registerOphirTools(): AutoGenToolRegistration[] {
  return [negotiateFunction, discoverFunction, executeInferenceFunction];
}
