/** @module @ophirai/mcp-server — MCP tool wrapper for Ophir negotiation protocol */
import type { SellerInfo, Agreement } from '@ophirai/sdk';
import type { SLAMetric } from '@ophirai/protocol';

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

// ── JSON-RPC MCP Server ───────────────────────────────────────────────

/** JSON-RPC 2.0 request envelope for MCP. */
interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** JSON-RPC 2.0 response envelope for MCP. */
interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcResult(id: string | number, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: string | number,
  code: number,
  message: string,
): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * MCP server that exposes Ophir negotiation capabilities as MCP tools.
 *
 * Supports three tools: negotiate_service, check_agreement_status, and list_services.
 */
export class OphirMCPServer {
  private config: OphirMCPServerConfig;

  constructor(config: OphirMCPServerConfig) {
    this.config = {
      ...config,
      agreements: config.agreements ?? new Map(),
    };
  }

  /** Handle an incoming MCP JSON-RPC request and return the response. */
  async handleRequest(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    switch (req.method) {
      case 'tools/list':
        return rpcResult(req.id, { tools: TOOLS });

      case 'tools/call': {
        const name = req.params?.name ?? '';
        const args = req.params?.arguments ?? {};
        return this.callTool(req.id, name, args);
      }

      case 'initialize':
        return rpcResult(req.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '@ophirai/mcp-server', version: '0.1.0' },
        });

      default:
        return rpcError(req.id, -32601, `Method not found: ${req.method}`);
    }
  }

  private async callTool(
    id: string | number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpJsonRpcResponse> {
    switch (name) {
      case 'negotiate_service':
        return rpcResult(
          id,
          await handleNegotiateService(args as unknown as NegotiateServiceInput, this.config),
        );

      case 'check_agreement_status':
        return rpcResult(
          id,
          await handleCheckAgreementStatus(
            args as unknown as CheckAgreementStatusInput,
            this.config,
          ),
        );

      case 'list_services':
        return rpcResult(id, handleListServices(this.config));

      default:
        return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
  }
}
