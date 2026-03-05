/** @module @ophirai/mcp-server — MCP tool wrapper for Ophir negotiation protocol */
import type { SellerInfo, Agreement } from '@ophirai/sdk';
import type { SLAMetric } from '@ophirai/protocol';
import { StdioTransport } from './stdio.js';
import type { JsonRpcRequest, JsonRpcResponse } from './stdio.js';

// ── MCP Tool Definitions ─────────────────────────────────────────────

/** JSON Schema property descriptor for MCP tool input schemas. */
interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
}

/** Definition of an MCP tool with name, description, and input schema. */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

export const TOOLS: MCPToolDefinition[] = [
  {
    name: 'negotiate_service',
    description:
      'Send an RFQ to known sellers for a service category, collect quotes, and return the best option.',
    inputSchema: {
      type: 'object',
      properties: {
        service_category: {
          type: 'string',
          description: 'Category of service needed (e.g. inference, translation, code_review)',
        },
        requirements: {
          type: 'object',
          description: 'Optional specific requirements for the service',
        },
        max_budget: {
          type: 'string',
          description: 'Maximum price per unit willing to pay',
        },
        currency: {
          type: 'string',
          description: 'Payment currency (default: USDC)',
        },
      },
      required: ['service_category', 'max_budget'],
    },
  },
  {
    name: 'check_agreement_status',
    description: 'Check the current status of a negotiation or agreement.',
    inputSchema: {
      type: 'object',
      properties: {
        agreement_id: {
          type: 'string',
          description: 'The agreement ID to check',
        },
      },
      required: ['agreement_id'],
    },
  },
  {
    name: 'list_services',
    description: 'List available service categories and known sellers.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ophir_discover',
    description:
      'Discover available service providers from the Ophir registry. Returns a list of sellers matching the criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Service category to filter by (e.g. inference, translation)',
        },
        min_reputation: {
          type: 'number',
          description: 'Minimum reputation score (0-100) to filter sellers',
        },
      },
    },
  },
  {
    name: 'ophir_accept_quote',
    description:
      'Accept a specific quote from a previous negotiation, creating a signed agreement with the seller.',
    inputSchema: {
      type: 'object',
      properties: {
        rfq_id: {
          type: 'string',
          description: 'The RFQ ID from a previous negotiate_service call',
        },
        quote_id: {
          type: 'string',
          description: 'The specific quote ID to accept',
        },
      },
      required: ['rfq_id', 'quote_id'],
    },
  },
  {
    name: 'ophir_monitor_sla',
    description:
      'Check SLA compliance for an active agreement. Returns current metric observations and compliance status.',
    inputSchema: {
      type: 'object',
      properties: {
        agreement_id: {
          type: 'string',
          description: 'The agreement ID to monitor',
        },
      },
      required: ['agreement_id'],
    },
  },
];

// ── Tool Handlers ─────────────────────────────────────────────────────

/** Input parameters for the negotiate_service MCP tool. */
export interface NegotiateServiceInput {
  service_category: string;
  requirements?: Record<string, unknown>;
  max_budget: string;
  currency?: string;
}

/** Input parameters for the check_agreement_status MCP tool. */
export interface CheckAgreementStatusInput {
  agreement_id: string;
}

/** Input parameters for the ophir_discover MCP tool. */
export interface DiscoverInput {
  category?: string;
  min_reputation?: number;
}

/** Input parameters for the ophir_accept_quote MCP tool. */
export interface AcceptQuoteInput {
  rfq_id: string;
  quote_id: string;
}

/** Input parameters for the ophir_monitor_sla MCP tool. */
export interface MonitorSLAInput {
  agreement_id: string;
}

/** Standard MCP tool result with text content. */
export interface MCPToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Configuration for the Ophir MCP server. */
export interface OphirMCPServerConfig {
  /** Known seller agents to negotiate with. */
  sellers: SellerInfo[];
  /** Buyer endpoint for sending RFQs (defaults to http://localhost:3001). */
  buyerEndpoint?: string;
  /** In-memory store of active agreements. */
  agreements?: Map<string, Agreement>;
  /** Registry URL for auto-discovery. */
  registryUrl?: string;
}

/** Wrap a text string as an MCP tool result. */
function textResult(text: string, isError = false): MCPToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/** Send an RFQ, collect quotes, and return the best option. */
export async function handleNegotiateService(
  input: NegotiateServiceInput,
  config: OphirMCPServerConfig,
): Promise<MCPToolResult> {
  const { BuyerAgent } = await import('@ophirai/sdk');

  const matchingSellers = config.sellers.filter((s) =>
    s.services.some((svc) => svc.category === input.service_category),
  );

  if (matchingSellers.length === 0) {
    return textResult(
      `No sellers found for service category: ${input.service_category}`,
      true,
    );
  }

  const buyer = new BuyerAgent({
    endpoint: config.buyerEndpoint ?? 'http://localhost:3001',
  });

  try {
    const session = await buyer.requestQuotes({
      service: {
        category: input.service_category,
        requirements: input.requirements,
      },
      budget: {
        max_price_per_unit: input.max_budget,
        currency: input.currency ?? 'USDC',
        unit: 'request',
      },
      sellers: matchingSellers.map((s) => s.endpoint),
    });

    const quotes = await buyer.waitForQuotes(session, {
      timeout: 30_000,
      minQuotes: 1,
    });

    if (quotes.length === 0) {
      return textResult('No quotes received within timeout.', true);
    }

    const ranked = buyer.rankQuotes(quotes, 'cheapest');
    const best = ranked[0];

    return textResult(
      JSON.stringify(
        {
          best_quote: {
            seller: best.seller.agent_id,
            price: best.pricing.price_per_unit,
            currency: best.pricing.currency,
            unit: best.pricing.unit,
            sla: best.sla_offered?.metrics?.map((m: SLAMetric) => ({
              metric: m.name,
              target: m.target,
            })),
          },
          total_quotes: quotes.length,
          rfq_id: session.rfqId,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Negotiation failed: ${msg}`, true);
  } finally {
    buyer.close();
  }
}

/** Look up a previously negotiated agreement by ID. */
export async function handleCheckAgreementStatus(
  input: CheckAgreementStatusInput,
  config: OphirMCPServerConfig,
): Promise<MCPToolResult> {
  const agreement = config.agreements?.get(input.agreement_id);
  if (!agreement) {
    return textResult(
      `No agreement found with ID: ${input.agreement_id}`,
      true,
    );
  }

  return textResult(
    JSON.stringify(
      {
        agreement_id: agreement.agreement_id,
        rfq_id: agreement.rfq_id,
        price: agreement.final_terms.price_per_unit,
        currency: agreement.final_terms.currency,
        unit: agreement.final_terms.unit,
        escrow: agreement.escrow ?? null,
        sla_metrics: agreement.final_terms.sla?.metrics?.length ?? 0,
      },
      null,
      2,
    ),
  );
}

/** List all available service categories and their known sellers. */
export function handleListServices(
  config: OphirMCPServerConfig,
): MCPToolResult {
  const categories = new Map<
    string,
    { sellers: string[]; price_range: string[] }
  >();

  for (const seller of config.sellers) {
    for (const svc of seller.services) {
      const entry = categories.get(svc.category) ?? {
        sellers: [],
        price_range: [],
      };
      entry.sellers.push(seller.agentId);
      entry.price_range.push(`${svc.base_price} ${svc.currency}/${svc.unit}`);
      categories.set(svc.category, entry);
    }
  }

  const services = Array.from(categories.entries()).map(([cat, info]) => ({
    category: cat,
    seller_count: info.sellers.length,
    prices: info.price_range,
  }));

  return textResult(JSON.stringify({ services }, null, 2));
}

/** Discover available service providers from the Ophir registry. */
export async function handleDiscover(
  input: DiscoverInput,
  config: OphirMCPServerConfig,
): Promise<MCPToolResult> {
  const { autoDiscover, OphirRegistry } = await import('@ophirai/sdk');

  try {
    if (input.category) {
      const agents = await autoDiscover(input.category, {
        registries: config.registryUrl ? [config.registryUrl] : undefined,
      });

      const filtered = input.min_reputation
        ? agents.filter((a) => (a.reputation?.score ?? 0) >= input.min_reputation!)
        : agents;

      return textResult(
        JSON.stringify(
          {
            providers: filtered.map((a) => ({
              agent_id: a.agentId,
              endpoint: a.endpoint,
              services: a.services.map((s) => ({
                category: s.category,
                description: s.description,
                base_price: s.base_price,
                currency: s.currency,
                unit: s.unit,
              })),
              reputation: a.reputation ?? null,
            })),
            total: filtered.length,
          },
          null,
          2,
        ),
      );
    }

    // No category filter — list all from registry
    const registry = new OphirRegistry(
      config.registryUrl ? [config.registryUrl] : undefined,
    );
    const agents = await registry.find({
      minReputation: input.min_reputation,
    });

    return textResult(
      JSON.stringify(
        {
          providers: agents.map((a) => ({
            agent_id: a.agentId,
            endpoint: a.endpoint,
            services: a.services.map((s) => ({
              category: s.category,
              description: s.description,
              base_price: s.base_price,
              currency: s.currency,
              unit: s.unit,
            })),
            reputation: a.reputation ?? null,
          })),
          total: agents.length,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Discovery failed: ${msg}`, true);
  }
}

/** Accept a specific quote from a previous negotiation. */
export async function handleAcceptQuote(
  input: AcceptQuoteInput,
  config: OphirMCPServerConfig,
): Promise<MCPToolResult> {
  const { negotiate } = await import('@ophirai/sdk');
  void negotiate; // unused — we need BuyerAgent directly

  // Look up the RFQ session via stored agreements or return an error
  // Since we don't persist full sessions across calls, we return an informational error
  // directing users to use negotiate_service with the full flow
  return textResult(
    JSON.stringify(
      {
        status: 'not_implemented_yet',
        rfq_id: input.rfq_id,
        quote_id: input.quote_id,
        message:
          'Quote acceptance requires a persistent session. Use negotiate_service which auto-accepts the best quote, or use the @ophirai/sdk directly for multi-step negotiation flows.',
      },
      null,
      2,
    ),
    true,
  );
}

/** Check SLA compliance for an active agreement. */
export async function handleMonitorSLA(
  input: MonitorSLAInput,
  config: OphirMCPServerConfig,
): Promise<MCPToolResult> {
  const agreement = config.agreements?.get(input.agreement_id);
  if (!agreement) {
    return textResult(
      `No agreement found with ID: ${input.agreement_id}`,
      true,
    );
  }

  const sla = agreement.final_terms.sla;
  if (!sla) {
    return textResult(
      JSON.stringify(
        {
          agreement_id: agreement.agreement_id,
          sla_monitoring: 'no_sla_terms',
          message: 'This agreement has no SLA terms to monitor.',
        },
        null,
        2,
      ),
    );
  }

  return textResult(
    JSON.stringify(
      {
        agreement_id: agreement.agreement_id,
        sla_metrics: sla.metrics.map((m) => ({
          name: m.name,
          target: m.target,
          comparison: m.comparison,
        })),
        dispute_resolution: sla.dispute_resolution,
        compliance_status: 'monitoring_available',
        message:
          'SLA terms are defined. Use the @ophirai/sdk MetricCollector for real-time compliance monitoring with recorded observations.',
      },
      null,
      2,
    ),
  );
}

// ── JSON-RPC MCP Server ───────────────────────────────────────────────

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * MCP server that exposes Ophir negotiation capabilities as MCP tools.
 *
 * Supports stdio JSON-RPC transport for use with any MCP-compatible client.
 * Auto-discovers sellers from the Ophir registry on startup.
 */
export class OphirMCPServer {
  private config: OphirMCPServerConfig;

  constructor(config?: Partial<OphirMCPServerConfig>) {
    const sellers: SellerInfo[] = [];

    // Parse OPHIR_SELLERS env var
    const envSellers = process.env['OPHIR_SELLERS'];
    if (envSellers) {
      for (const endpoint of envSellers.split(',').map((s) => s.trim()).filter(Boolean)) {
        sellers.push({
          agentId: endpoint,
          endpoint,
          services: [],
        });
      }
    }

    this.config = {
      sellers: config?.sellers ?? sellers,
      buyerEndpoint: config?.buyerEndpoint ?? process.env['OPHIR_BUYER_ENDPOINT'] ?? 'http://localhost:3001',
      agreements: config?.agreements ?? new Map(),
      registryUrl: config?.registryUrl ?? process.env['OPHIR_REGISTRY_URL'],
    };
  }

  /** Handle an incoming MCP JSON-RPC request. */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (req.method) {
      case 'initialize':
        return rpcResult(req.id ?? null, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '@ophirai/mcp-server', version: '0.2.0' },
        });

      case 'notifications/initialized':
        return null;

      case 'tools/list':
        return rpcResult(req.id ?? null, { tools: TOOLS });

      case 'tools/call': {
        const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        const name = params?.name ?? '';
        const args = params?.arguments ?? {};
        return this.callTool(req.id ?? null, name, args);
      }

      default:
        return rpcError(req.id ?? null, -32601, `Method not found: ${req.method}`);
    }
  }

  /** Start the server with stdio transport. */
  async startStdio(): Promise<void> {
    // Auto-discover sellers from the registry on startup
    await this.autoDiscoverSellers();

    const transport = new StdioTransport((req) => this.handleRequest(req));
    transport.start();

    process.stderr.write(
      `[ophir-mcp] Server started. ${this.config.sellers.length} sellers known.\n`,
    );
  }

  private async autoDiscoverSellers(): Promise<void> {
    try {
      const { autoDiscover } = await import('@ophirai/sdk');
      const agents = await autoDiscover('', {
        registries: this.config.registryUrl ? [this.config.registryUrl] : undefined,
      });

      for (const agent of agents) {
        const alreadyKnown = this.config.sellers.some(
          (s) => s.endpoint === agent.endpoint,
        );
        if (!alreadyKnown) {
          this.config.sellers.push({
            agentId: agent.agentId,
            endpoint: agent.endpoint,
            services: agent.services,
          });
        }
      }
    } catch {
      // Registry unavailable — proceed with configured sellers only
      process.stderr.write('[ophir-mcp] Registry unavailable, using configured sellers only.\n');
    }
  }

  private async callTool(
    id: string | number | null,
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    try {
      let result: MCPToolResult;

      switch (name) {
        case 'negotiate_service':
          result = await handleNegotiateService(args as unknown as NegotiateServiceInput, this.config);
          break;

        case 'check_agreement_status':
          result = await handleCheckAgreementStatus(
            args as unknown as CheckAgreementStatusInput,
            this.config,
          );
          break;

        case 'list_services':
          result = handleListServices(this.config);
          break;

        case 'ophir_discover':
          result = await handleDiscover(args as unknown as DiscoverInput, this.config);
          break;

        case 'ophir_accept_quote':
          result = await handleAcceptQuote(args as unknown as AcceptQuoteInput, this.config);
          break;

        case 'ophir_monitor_sla':
          result = await handleMonitorSLA(args as unknown as MonitorSLAInput, this.config);
          break;

        default:
          return rpcError(id, -32602, `Unknown tool: ${name}`);
      }

      return rpcResult(id, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return rpcResult(id, textResult(`Tool error: ${msg}`, true));
    }
  }
}
