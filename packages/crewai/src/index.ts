/**
 * @module @ophirai/crewai
 *
 * CrewAI-compatible tools for Ophir agent negotiation protocol.
 *
 * Provides both a class-based API mirroring CrewAI's BaseTool pattern
 * (with `_run`, `args_schema`, and `result_as_answer`) and a plain
 * object API following the generic function-calling convention.
 *
 * @example Class-based (CrewAI pattern)
 * ```typescript
 * import { OphirNegotiateTool, OphirDiscoverTool, OphirCheckSLATool } from '@ophirai/crewai';
 *
 * const negotiate = new OphirNegotiateTool({ registryUrl: 'https://my-registry.example.com/v1' });
 * const result = await negotiate._run({ service_category: 'inference', model: 'llama-3-70b' });
 * ```
 *
 * @example Plain-object (generic function-calling)
 * ```typescript
 * import { getOphirToolkit, toFunctionDefinition, handleToolCall } from '@ophirai/crewai';
 *
 * const tools = getOphirToolkit();
 * const functions = tools.map(toFunctionDefinition);
 * const result = await handleToolCall(tools, 'ophir_negotiate', { service_category: 'inference' });
 * ```
 */

import { negotiate, autoDiscover, LockstepMonitor } from "@ophirai/sdk";
import type { NegotiateOptions, NegotiateResult, RegisteredAgent, ComplianceResult } from "@ophirai/sdk";
import type { SLAMetric, SLARequirement } from "@ophirai/protocol";

// ── Re-exports for convenience ──────────────────────────────────────
export type { NegotiateOptions, NegotiateResult, RegisteredAgent, ComplianceResult };
export type { SLAMetric, SLARequirement };

// ── Tool interface (plain object) ───────────────────────────────────

/** Generic tool interface compatible with CrewAI and function-calling frameworks. */
export interface OphirCrewTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<string>;
}

/** Configuration for customizing Ophir CrewAI tools. */
export interface OphirCrewConfig {
  /** Default registry URL for provider discovery. */
  registryUrl?: string;
  /** Default timeout in milliseconds for negotiation. */
  timeoutMs?: number;
  /** Default ranking strategy: 'cheapest' | 'fastest' | 'best_sla'. */
  defaultRanking?: "cheapest" | "fastest" | "best_sla";
  /** Default payment currency. */
  defaultCurrency?: string;
  /** Lockstep verification endpoint URL for SLA monitoring. */
  lockstepEndpoint?: string;
}

const DEFAULT_REGISTRY = "https://registry.ophir.ai/v1";

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── CrewAI BaseTool abstract class ──────────────────────────────────

/**
 * Abstract base class mirroring CrewAI's BaseTool pattern.
 *
 * CrewAI tools follow a class-based convention with:
 * - `name` — unique tool identifier
 * - `description` — LLM-consumable description of when/how to use
 * - `args_schema` — JSON Schema describing accepted parameters
 * - `result_as_answer` — whether the LLM should use the result directly
 * - `_run(args)` — the execution method
 *
 * Subclasses implement `_run()` with their specific logic. The `run()`
 * wrapper adds error handling and JSON serialization.
 */
export abstract class OphirBaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly args_schema: Record<string, unknown>;

  /**
   * When true, the agent framework should treat the tool's output as a
   * direct answer rather than intermediate reasoning. CrewAI uses this
   * to short-circuit the agent loop when a tool produces a final result.
   */
  result_as_answer = false;

  /**
   * Optional cache key function. If provided, CrewAI will cache results
   * for identical inputs. Return a stable string key from the arguments,
   * or null to skip caching for that call.
   */
  cache_function?: (args: Record<string, unknown>) => string | null;

  /** Internal execution — subclasses implement this. */
  abstract _run(args: Record<string, unknown>): Promise<string>;

  /** Public entry point with error handling (mirrors CrewAI's run()). */
  async run(args: Record<string, unknown>): Promise<string> {
    try {
      return await this._run(args);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ success: false, error: message });
    }
  }

  /** Convert this class-based tool to the plain OphirCrewTool interface. */
  asTool(): OphirCrewTool {
    return {
      name: this.name,
      description: this.description,
      parameters: this.args_schema,
      execute: (params) => this.run(params),
    };
  }
}

// ── Negotiate tool (class) ──────────────────────────────────────────

const NEGOTIATE_SCHEMA = {
  type: "object" as const,
  properties: {
    service_category: {
      type: "string",
      description: "Service category to negotiate for (e.g. inference, translation, embedding, image-generation)",
      default: "inference",
    },
    model: {
      type: "string",
      description: "Specific model name to request (e.g. gpt-4, llama-3-70b, claude-sonnet-4-6, mixtral-8x7b)",
    },
    max_price_per_unit: {
      type: "number",
      description: "Maximum price per unit you are willing to pay in the specified currency (e.g. 0.01 for 1 cent per request)",
    },
    currency: {
      type: "string",
      description: "Payment currency for the negotiation (e.g. USDC, USDT, SOL, ETH)",
      default: "USDC",
    },
    unit: {
      type: "string",
      description: "Pricing unit that prices are denominated in (e.g. request, token, minute, image)",
      default: "request",
    },
    ranking: {
      type: "string",
      enum: ["cheapest", "fastest", "best_sla"],
      description: "Strategy for ranking provider quotes: 'cheapest' selects lowest price, 'fastest' selects lowest latency, 'best_sla' selects strongest service guarantees",
      default: "cheapest",
    },
    auto_accept: {
      type: "boolean",
      description: "When true, automatically accept the best-ranked quote and return a signed agreement. When false, return quotes for manual review.",
      default: true,
    },
    timeout_ms: {
      type: "number",
      description: "Timeout in milliseconds for the entire negotiation round (discovery + quoting + acceptance)",
    },
    sellers: {
      type: "array",
      items: { type: "string" },
      description: "Direct seller endpoint URLs to contact, bypassing registry discovery. Use when you already know specific providers.",
    },
    sla_requirements: {
      type: "object",
      description: "Service Level Agreement requirements that providers must meet. Only providers who can guarantee these metrics will be considered.",
      properties: {
        p99_latency_ms: { type: "number", description: "Maximum p99 latency in milliseconds (e.g. 200 for 200ms)" },
        uptime_pct: { type: "number", description: "Minimum uptime percentage (e.g. 99.9 for three-nines)" },
        error_rate: { type: "number", description: "Maximum error rate as percentage (e.g. 1.0 for 1%)" },
        throughput_rps: { type: "number", description: "Minimum throughput in requests per second" },
      },
      additionalProperties: false,
    },
    registry_url: {
      type: "string",
      description: "Ophir registry URL for discovering service providers. Override to use a private or staging registry.",
      default: DEFAULT_REGISTRY,
    },
  },
  required: [] as string[],
  additionalProperties: false,
};

/**
 * CrewAI tool that negotiates with AI service providers via the Ophir protocol.
 *
 * Discovers available sellers, broadcasts an RFQ (Request for Quote), collects
 * and ranks responses, and optionally auto-accepts the best offer — returning
 * a signed agreement with endpoint URL, pricing, and SLA guarantees.
 *
 * @example
 * ```typescript
 * const tool = new OphirNegotiateTool({ registryUrl: 'https://registry.ophir.ai/v1' });
 * const result = await tool._run({
 *   service_category: 'inference',
 *   model: 'llama-3-70b',
 *   max_price_per_unit: 0.01,
 *   sla_requirements: { p99_latency_ms: 200, uptime_pct: 99.9 },
 * });
 * const { agreement } = JSON.parse(result);
 * // agreement.endpoint → use this URL for inference calls
 * ```
 */
export class OphirNegotiateTool extends OphirBaseTool {
  readonly name = "ophir_negotiate";

  readonly description =
    "Negotiate with AI service providers to get the best price and SLA guarantees " +
    "for inference, embedding, translation, or other AI service requests. Use this " +
    "tool when you need to: (1) find cheaper inference than your current provider, " +
    "(2) get enforceable SLA guarantees like uptime, latency, and error rate backed " +
    "by escrow, (3) compare multiple AI providers automatically and get the best deal, " +
    "(4) switch providers dynamically based on cost or performance requirements. " +
    "Returns a cryptographically signed agreement with the best provider including " +
    "the endpoint URL you can immediately use for inference calls, the final " +
    "negotiated price, and the SLA terms both parties committed to.";

  readonly args_schema: Record<string, unknown>;

  private registryUrl: string;
  private defaultCurrency: string;
  private defaultRanking: NegotiateOptions["ranking"];
  private defaultTimeout?: number;

  constructor(config: OphirCrewConfig = {}) {
    super();
    this.registryUrl = config.registryUrl ?? DEFAULT_REGISTRY;
    this.defaultCurrency = config.defaultCurrency ?? "USDC";
    this.defaultRanking = config.defaultRanking ?? "cheapest";
    this.defaultTimeout = config.timeoutMs;

    // Build schema with config-specific defaults
    this.args_schema = {
      ...NEGOTIATE_SCHEMA,
      properties: {
        ...NEGOTIATE_SCHEMA.properties,
        currency: { ...NEGOTIATE_SCHEMA.properties.currency, default: this.defaultCurrency },
        ranking: { ...NEGOTIATE_SCHEMA.properties.ranking, default: this.defaultRanking },
        registry_url: { ...NEGOTIATE_SCHEMA.properties.registry_url, default: this.registryUrl },
      },
    };
  }

  async _run(params: Record<string, unknown>): Promise<string> {
    const sellers = params.sellers as string[] | undefined;
    const opts: NegotiateOptions = {
      service: (params.service_category as string) ?? "inference",
      model: params.model as string | undefined,
      maxBudget: params.max_price_per_unit != null
        ? String(params.max_price_per_unit)
        : "1.00",
      currency: (params.currency as string) ?? this.defaultCurrency,
      unit: (params.unit as string) ?? "request",
      ranking: (params.ranking as NegotiateOptions["ranking"]) ?? this.defaultRanking,
      autoAccept: params.auto_accept != null ? Boolean(params.auto_accept) : true,
      sla: buildSLA(params.sla_requirements as Record<string, unknown> | undefined),
      sellers: sellers && sellers.length > 0 ? sellers : undefined,
      registries: [(params.registry_url as string) ?? this.registryUrl],
      timeout: params.timeout_ms != null ? Number(params.timeout_ms) : this.defaultTimeout,
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
  }
}

// ── Discover tool (class) ───────────────────────────────────────────

const DISCOVER_SCHEMA = {
  type: "object" as const,
  properties: {
    service_category: {
      type: "string",
      description: "Service category to search for (e.g. inference, translation, embedding, image-generation, speech-to-text)",
      default: "inference",
    },
    max_results: {
      type: "number",
      description: "Maximum number of providers to return. Higher values give more options but take longer.",
      default: 10,
    },
    min_reputation: {
      type: "number",
      description: "Minimum reputation score (0-100) to filter providers. Higher values ensure more reliable providers.",
    },
    registry_url: {
      type: "string",
      description: "Ophir registry URL for provider discovery",
      default: DEFAULT_REGISTRY,
    },
  },
  required: [] as string[],
  additionalProperties: false,
};

/**
 * CrewAI tool that discovers available AI service providers on the Ophir network.
 *
 * Queries the Ophir registry to find providers matching your criteria,
 * returning their services, pricing, reputation, and endpoints.
 * Use this before negotiating to survey the market.
 *
 * @example
 * ```typescript
 * const tool = new OphirDiscoverTool();
 * const result = await tool._run({ service_category: 'inference', min_reputation: 80 });
 * const { providers } = JSON.parse(result);
 * // providers[0].endpoint → seller endpoint for direct negotiation
 * ```
 */
export class OphirDiscoverTool extends OphirBaseTool {
  readonly name = "ophir_discover";

  readonly description =
    "Discover available AI service providers registered on the Ophir decentralized " +
    "network. Use this tool before negotiating to survey the market and see what " +
    "providers are available, what services they offer (inference, embedding, " +
    "translation, etc.), their current pricing, and their reputation scores based " +
    "on past agreement history. You can filter by service category and minimum " +
    "reputation to find only high-quality, reliable providers. Returns a ranked " +
    "list of providers with their endpoints, service catalogs, and trust metrics.";

  readonly args_schema: Record<string, unknown>;

  private registryUrl: string;

  constructor(config: OphirCrewConfig = {}) {
    super();
    this.registryUrl = config.registryUrl ?? DEFAULT_REGISTRY;
    this.args_schema = {
      ...DISCOVER_SCHEMA,
      properties: {
        ...DISCOVER_SCHEMA.properties,
        registry_url: { ...DISCOVER_SCHEMA.properties.registry_url, default: this.registryUrl },
      },
    };
  }

  async _run(params: Record<string, unknown>): Promise<string> {
    const maxResults = params.max_results != null ? Number(params.max_results) : 10;

    const agents = await autoDiscover(
      (params.service_category as string) ?? "inference",
      {
        registries: [(params.registry_url as string) ?? this.registryUrl],
        maxResults,
      },
    );

    const filtered = agents.filter((agent) => {
      if (params.min_reputation != null && agent.reputation) {
        if (agent.reputation.score < (params.min_reputation as number)) return false;
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
  }
}

// ── Check SLA tool (class) ──────────────────────────────────────────

const CHECK_SLA_SCHEMA = {
  type: "object" as const,
  properties: {
    agreement_id: {
      type: "string",
      description: "The agreement ID from a completed negotiation (returned in the negotiate tool's response)",
    },
    agreement_hash: {
      type: "string",
      description: "The cryptographic agreement hash for verification (ensures the agreement hasn't been tampered with)",
    },
    seller_endpoint: {
      type: "string",
      description: "The seller's endpoint URL from the agreement, used for direct health checks",
    },
    sla_metrics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Metric name (e.g. p99_latency_ms, uptime_pct, error_rate_pct, throughput_rpm)" },
          target: { type: "number", description: "Target value the provider committed to" },
          comparison: {
            type: "string",
            enum: ["lte", "gte", "eq"],
            description: "Comparison operator: 'lte' (must be at or below target), 'gte' (must be at or above target), 'eq' (must equal target)",
          },
        },
        required: ["name", "target", "comparison"],
        additionalProperties: false,
      },
      description: "SLA metrics to verify against — should match the terms from the original agreement",
    },
    verification_endpoint: {
      type: "string",
      description: "Custom Lockstep verification endpoint URL. Overrides the default Lockstep API.",
    },
  },
  required: ["agreement_id", "agreement_hash"],
  additionalProperties: false,
};

/**
 * CrewAI tool that checks SLA compliance for an active Ophir agreement.
 *
 * Connects to the Lockstep verification service to determine whether a
 * provider is meeting its agreed-upon service level guarantees. Use the
 * results to decide whether to continue with a provider, trigger a dispute,
 * or re-negotiate with a different provider.
 *
 * @example
 * ```typescript
 * const tool = new OphirCheckSLATool();
 * const result = await tool._run({
 *   agreement_id: 'agr-abc123',
 *   agreement_hash: 'sha256:...',
 *   sla_metrics: [{ name: 'p99_latency_ms', target: 200, comparison: 'lte' }],
 * });
 * const { compliant, violations } = JSON.parse(result);
 * if (!compliant) {
 *   // Provider is violating SLA — trigger dispute or switch
 * }
 * ```
 */
export class OphirCheckSLATool extends OphirBaseTool {
  readonly name = "ophir_check_sla";

  readonly description =
    "Check SLA compliance for an active Ophir agreement using the Lockstep " +
    "verification service. Use this tool to verify whether a provider is meeting " +
    "the agreed-upon service level guarantees including latency, uptime, error " +
    "rate, and throughput commitments. If violations are detected, you can use " +
    "that evidence to trigger an escrow dispute (releasing funds back to the buyer) " +
    "or to re-negotiate with a different provider. Requires the agreement_id and " +
    "agreement_hash from a previous successful negotiation.";

  readonly args_schema: Record<string, unknown> = CHECK_SLA_SCHEMA;

  private lockstepEndpoint?: string;

  constructor(config: OphirCrewConfig = {}) {
    super();
    this.lockstepEndpoint = config.lockstepEndpoint;
  }

  async _run(params: Record<string, unknown>): Promise<string> {
    const agreementId = params.agreement_id as string;
    const agreementHash = params.agreement_hash as string;

    if (!agreementId || !agreementHash) {
      return JSON.stringify({
        success: false,
        error: "Both agreement_id and agreement_hash are required to verify SLA compliance",
      });
    }

    const slaMetrics = (params.sla_metrics as SLAMetric[] | undefined) ?? [];

    const monitor = new LockstepMonitor({
      verificationEndpoint:
        (params.verification_endpoint as string) ?? this.lockstepEndpoint,
    });

    const agreement = {
      agreement_id: agreementId,
      agreement_hash: agreementHash,
      rfq_id: "",
      accepting_message_id: "",
      buyer_signature: "",
      final_terms: {
        price_per_unit: "0",
        currency: "USDC",
        unit: "request",
        sla: {
          metrics: slaMetrics,
          dispute_resolution: { method: "automatic_escrow" as const },
        },
      },
    };

    const { monitoringId } = await monitor.startMonitoring(agreement);
    const compliance = await monitor.checkCompliance(monitoringId);

    return JSON.stringify({
      success: true,
      agreement_id: agreementId,
      compliant: compliance.compliant,
      violations: compliance.violations,
      monitoring_id: monitoringId,
      seller_endpoint: params.seller_endpoint ?? null,
    });
  }
}

// ── Conversion utilities ────────────────────────────────────────────

/**
 * Convert an OphirCrewTool to a standard function definition format
 * compatible with OpenAI, Anthropic, and other function-calling APIs.
 */
export function toFunctionDefinition(tool: OphirCrewTool): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Dispatch a function call by name to the appropriate tool's execute method.
 * Useful for integrating with agent loops that return function names and arguments.
 *
 * @example
 * ```typescript
 * const tools = getOphirToolkit();
 * // In your agent loop, when the LLM returns a tool call:
 * const result = await handleToolCall(tools, toolName, toolArgs);
 * ```
 */
export async function handleToolCall(
  tools: OphirCrewTool[],
  name: string,
  params: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return JSON.stringify({ success: false, error: `Unknown tool: ${name}. Available tools: ${tools.map(t => t.name).join(", ")}` });
  }
  return tool.execute(params);
}

// ── Public API (plain objects) ──────────────────────────────────────

/** Pre-configured negotiate tool using default settings. */
export const ophirNegotiateTool: OphirCrewTool = new OphirNegotiateTool().asTool();

/** Pre-configured discover tool using default settings. */
export const ophirDiscoverTool: OphirCrewTool = new OphirDiscoverTool().asTool();

/** Pre-configured SLA check tool using default settings. */
export const ophirCheckSLATool: OphirCrewTool = new OphirCheckSLATool().asTool();

/** Returns all Ophir CrewAI tools as an array with default configuration. */
export function getOphirToolkit(): OphirCrewTool[] {
  return [ophirNegotiateTool, ophirDiscoverTool, ophirCheckSLATool];
}

/**
 * Create a configured Ophir toolkit with custom settings.
 * Returns plain OphirCrewTool objects with configuration baked in.
 *
 * @example
 * ```typescript
 * const tools = createOphirToolkit({
 *   registryUrl: 'https://my-registry.example.com/v1',
 *   defaultRanking: 'best_sla',
 *   timeoutMs: 30_000,
 * });
 * // Register with any agent framework
 * for (const tool of tools) {
 *   agent.registerTool(tool.name, tool.parameters, tool.execute);
 * }
 * ```
 */
export function createOphirToolkit(config: OphirCrewConfig = {}): OphirCrewTool[] {
  return [
    new OphirNegotiateTool(config).asTool(),
    new OphirDiscoverTool(config).asTool(),
    new OphirCheckSLATool(config).asTool(),
  ];
}

/**
 * Create class-based CrewAI tool instances with custom settings.
 * Returns OphirBaseTool subclasses with `_run()`, `args_schema`,
 * and `result_as_answer` — matching CrewAI's native tool convention.
 *
 * @example
 * ```typescript
 * const [negotiate, discover, checkSla] = createOphirCrewTools({
 *   registryUrl: 'https://my-registry.example.com/v1',
 *   defaultRanking: 'fastest',
 * });
 * // Use in CrewAI agent
 * const agent = new Agent({ tools: [negotiate, discover, checkSla] });
 * ```
 */
export function createOphirCrewTools(config: OphirCrewConfig = {}): OphirBaseTool[] {
  return [
    new OphirNegotiateTool(config),
    new OphirDiscoverTool(config),
    new OphirCheckSLATool(config),
  ];
}
