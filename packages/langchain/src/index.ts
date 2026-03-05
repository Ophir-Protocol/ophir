/**
 * @module @ophirai/langchain
 *
 * LangChain.js tool for Ophir agent negotiation protocol.
 * Exposes Ophir negotiation as a LangChain StructuredTool so that
 * any LangChain-powered agent can negotiate with AI service providers.
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { negotiate } from "@ophirai/sdk";
import type { NegotiateOptions } from "@ophirai/sdk";
import type { SLAMetric, SLARequirement } from "@ophirai/protocol";

const negotiateSchema = z.object({
  service_category: z
    .string()
    .default("inference")
    .describe("Service category to negotiate for (e.g. inference, translation, embedding)"),
  model: z
    .string()
    .optional()
    .describe("Specific model name (e.g. gpt-4, llama-3-70b)"),
  max_price_per_unit: z
    .number()
    .optional()
    .describe("Maximum price per unit in the specified currency"),
  currency: z
    .string()
    .default("USDC")
    .describe("Payment currency"),
  sla_requirements: z
    .object({
      p99_latency_ms: z.number().optional().describe("Maximum p99 latency in milliseconds"),
      uptime_pct: z.number().optional().describe("Minimum uptime percentage (e.g. 99.9)"),
      error_rate: z.number().optional().describe("Maximum error rate (e.g. 0.01 for 1%)"),
    })
    .optional()
    .describe("SLA requirements for the service"),
  registry_url: z
    .string()
    .default("https://registry.ophir.ai/v1")
    .describe("Ophir registry URL for discovering service providers"),
});

export type OphirNegotiateInput = z.infer<typeof negotiateSchema>;

function buildSLA(
  args?: OphirNegotiateInput["sla_requirements"],
): SLARequirement | undefined {
  if (!args) return undefined;

  const metrics: SLAMetric[] = [];
  if (args.p99_latency_ms !== undefined) {
    metrics.push({ name: "p99_latency_ms", target: args.p99_latency_ms, comparison: "lte" });
  }
  if (args.uptime_pct !== undefined) {
    metrics.push({ name: "uptime_pct", target: args.uptime_pct, comparison: "gte" });
  }
  if (args.error_rate !== undefined) {
    metrics.push({ name: "error_rate_pct", target: args.error_rate, comparison: "lte" });
  }

  if (metrics.length === 0) return undefined;

  return {
    metrics,
    dispute_resolution: { method: "automatic_escrow" },
  };
}

export class OphirNegotiateTool extends StructuredTool {
  name = "ophir_negotiate";

  description =
    "Negotiate with AI service providers to get the best price and SLA guarantees " +
    "for inference requests. Use this tool when you need to: (1) find cheaper inference " +
    "than your current provider, (2) get SLA guarantees (uptime, latency, error rate), " +
    "(3) compare multiple AI providers automatically, (4) switch providers dynamically " +
    "based on cost or performance. Returns a signed agreement with the best provider " +
    "including the endpoint URL you can use for inference.";

  schema = negotiateSchema;

  private registryUrl: string;

  constructor(config?: { registryUrl?: string }) {
    super();
    this.registryUrl = config?.registryUrl ?? "https://registry.ophir.ai/v1";
  }

  async _call(input: OphirNegotiateInput): Promise<string> {
    try {
      const opts: NegotiateOptions = {
        service: input.service_category,
        model: input.model,
        maxBudget: input.max_price_per_unit?.toString() ?? "1.00",
        currency: input.currency,
        sla: buildSLA(input.sla_requirements),
        registries: [input.registry_url ?? this.registryUrl],
        autoAccept: true,
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
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({
        success: false,
        error: message,
      });
    }
  }
}

export function createOphirTools(config?: { registryUrl?: string }): OphirNegotiateTool[] {
  return [new OphirNegotiateTool(config)];
}
