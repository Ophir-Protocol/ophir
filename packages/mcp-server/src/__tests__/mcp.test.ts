import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OphirMCPServer,
  TOOLS,
  handleListServices,
  handleCheckAgreementStatus,
  handleNegotiateService,
} from '../index.js';
import { StdioTransport } from '../stdio.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../stdio.js';

// Mock @ophirai/sdk to avoid real network calls
const mockRequestQuotes = vi.fn();
const mockWaitForQuotes = vi.fn();
const mockRankQuotes = vi.fn();
const mockClose = vi.fn();
const mockAutoDiscover = vi.fn();

vi.mock('@ophirai/sdk', () => ({
  BuyerAgent: vi.fn().mockImplementation(() => ({
    requestQuotes: mockRequestQuotes,
    waitForQuotes: mockWaitForQuotes,
    rankQuotes: mockRankQuotes,
    close: mockClose,
  })),
  autoDiscover: (...args: unknown[]) => mockAutoDiscover(...args),
  OphirRegistry: vi.fn().mockImplementation(() => ({
    find: vi.fn().mockResolvedValue([]),
  })),
  negotiate: vi.fn(),
}));

// ── Protocol Tests ──────────────────────────────────────────────────

describe('MCP Protocol', () => {
  let server: OphirMCPServer;

  beforeEach(() => {
    server = new OphirMCPServer({ sellers: [] });
  });

  it('initialize returns correct protocol version and server info', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });

    expect(res).not.toBeNull();
    expect(res!.id).toBe(1);
    const result = res!.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: '@ophirai/mcp-server', version: '0.2.0' });
    expect(result.capabilities).toEqual({ tools: {} });
  });

  it('tools/list returns all 6 tools with valid schemas', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(res).not.toBeNull();
    const result = res!.result as { tools: typeof TOOLS };
    expect(result.tools).toHaveLength(6);

    const names = result.tools.map((t) => t.name);
    expect(names).toContain('negotiate_service');
    expect(names).toContain('check_agreement_status');
    expect(names).toContain('list_services');
    expect(names).toContain('ophir_discover');
    expect(names).toContain('ophir_accept_quote');
    expect(names).toContain('ophir_monitor_sla');

    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description).toBeTruthy();
    }
  });

  it('tools/call with unknown tool returns error', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    expect(res).not.toBeNull();
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32602);
    expect(res!.error!.message).toContain('Unknown tool');
  });

  it('unknown method returns method-not-found error', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'completions/complete',
    });

    expect(res).not.toBeNull();
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32601);
    expect(res!.error!.message).toContain('Method not found');
  });

  it('notification (no id) returns null', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(res).toBeNull();
  });
});

// ── Tool Tests ──────────────────────────────────────────────────────

describe('Tool Handlers', () => {
  it('negotiate_service with no matching sellers returns error', async () => {
    const server = new OphirMCPServer({ sellers: [] });
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'negotiate_service',
        arguments: { service_category: 'inference', max_budget: '0.01' },
      },
    });

    const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No sellers found');
  });

  it('negotiate_service with known sellers returns best quote', async () => {
    mockRequestQuotes.mockResolvedValue({ rfqId: 'rfq-test-1' });
    mockWaitForQuotes.mockResolvedValue([
      {
        seller: { agent_id: 'seller-1' },
        pricing: { price_per_unit: '0.001', currency: 'USDC', unit: 'request' },
        sla_offered: { metrics: [{ name: 'latency', target: 100 }] },
      },
    ]);
    mockRankQuotes.mockReturnValue([
      {
        seller: { agent_id: 'seller-1' },
        pricing: { price_per_unit: '0.001', currency: 'USDC', unit: 'request' },
        sla_offered: { metrics: [{ name: 'latency', target: 100 }] },
      },
    ]);

    const config = {
      sellers: [
        {
          agentId: 'seller-1',
          endpoint: 'http://fake-seller:9000',
          services: [{ category: 'inference', description: 'LLM', base_price: '0.001', currency: 'USDC', unit: 'request' }],
        },
      ],
      buyerEndpoint: 'http://localhost:3001',
      agreements: new Map(),
    };

    const result = await handleNegotiateService(
      { service_category: 'inference', max_budget: '0.01' },
      config,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.best_quote.seller).toBe('seller-1');
    expect(parsed.rfq_id).toBe('rfq-test-1');
    expect(parsed.total_quotes).toBe(1);
    expect(mockClose).toHaveBeenCalled();
  });

  it('list_services returns service categories', async () => {
    const server = new OphirMCPServer({
      sellers: [
        {
          agentId: 'seller-1',
          endpoint: 'http://localhost:9001',
          services: [
            { category: 'inference', description: 'LLM inference', base_price: '0.001', currency: 'USDC', unit: 'request' },
            { category: 'translation', description: 'Text translation', base_price: '0.005', currency: 'USDC', unit: 'request' },
          ],
        },
      ],
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'list_services', arguments: {} },
    });

    const result = res!.result as { content: { type: string; text: string }[] };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.services).toHaveLength(2);
    expect(parsed.services.map((s: { category: string }) => s.category)).toContain('inference');
    expect(parsed.services.map((s: { category: string }) => s.category)).toContain('translation');
  });

  it('check_agreement_status with unknown ID returns error', async () => {
    const server = new OphirMCPServer({ sellers: [] });
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'check_agreement_status',
        arguments: { agreement_id: 'nonexistent-id' },
      },
    });

    const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No agreement found');
  });

  it('ophir_discover returns agents from registry', async () => {
    mockAutoDiscover.mockResolvedValue([
      {
        agentId: 'mock-seller',
        endpoint: 'http://mock:9000',
        services: [{ category: 'inference', description: 'Mock LLM', base_price: '0.001', currency: 'USDC', unit: 'request' }],
        reputation: { score: 85 },
      },
    ]);

    const server = new OphirMCPServer({ sellers: [] });
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'ophir_discover',
        arguments: { category: 'inference' },
      },
    });

    const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].agent_id).toBe('mock-seller');
    expect(parsed.total).toBe(1);
  });

  it('ophir_monitor_sla with unknown agreement returns error', async () => {
    const server = new OphirMCPServer({ sellers: [] });
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'ophir_monitor_sla',
        arguments: { agreement_id: 'unknown-agreement' },
      },
    });

    const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No agreement found');
  });

  it('ophir_accept_quote returns not-implemented or error status', async () => {
    const server = new OphirMCPServer({ sellers: [] });
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'ophir_accept_quote',
        arguments: { rfq_id: 'rfq-123', quote_id: 'quote-456' },
      },
    });

    const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBeTruthy();
    // May return not_implemented_yet JSON or a tool error string
    expect(result.content[0].type).toBe('text');
  });
});

// ── StdioTransport Tests ────────────────────────────────────────────

describe('StdioTransport', () => {
  it('buffers partial messages until newline', async () => {
    const responses: JsonRpcResponse[] = [];
    const handler = vi.fn().mockResolvedValue({
      jsonrpc: '2.0' as const,
      id: 1,
      result: { ok: true },
    });

    const transport = new StdioTransport(handler);

    // Access the private onData method via type assertion
    const onData = (transport as unknown as { onData(chunk: string): Promise<void> }).onData.bind(transport);

    // Capture stdout writes
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Send partial message (no newline yet)
    await onData('{"jsonrpc":"2.0","id":1,');
    expect(handler).not.toHaveBeenCalled();

    // Complete the message with newline
    await onData('"method":"initialize"}\n');
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'initialize', id: 1 }),
    );

    writeSpy.mockRestore();
  });

  it('dispatches multiple messages in a single chunk', async () => {
    const handler = vi.fn().mockResolvedValue({
      jsonrpc: '2.0' as const,
      id: null,
      result: {},
    });

    const transport = new StdioTransport(handler);
    const onData = (transport as unknown as { onData(chunk: string): Promise<void> }).onData.bind(transport);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const msg1 = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const msg2 = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    await onData(msg1 + '\n' + msg2 + '\n');
    expect(handler).toHaveBeenCalledTimes(2);

    writeSpy.mockRestore();
  });

  it('handles parse errors gracefully', async () => {
    const handler = vi.fn();

    const transport = new StdioTransport(handler);
    const onData = (transport as unknown as { onData(chunk: string): Promise<void> }).onData.bind(transport);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await onData('not valid json\n');

    expect(handler).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledOnce();

    const written = writeSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.replace('\n', ''));
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toBe('Parse error');

    writeSpy.mockRestore();
  });

  it('skips empty lines', async () => {
    const handler = vi.fn().mockResolvedValue({
      jsonrpc: '2.0' as const,
      id: 1,
      result: {},
    });

    const transport = new StdioTransport(handler);
    const onData = (transport as unknown as { onData(chunk: string): Promise<void> }).onData.bind(transport);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await onData('\n\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n\n');
    expect(handler).toHaveBeenCalledOnce();

    writeSpy.mockRestore();
  });
});
