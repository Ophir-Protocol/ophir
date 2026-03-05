import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ophirNegotiateTool,
  ophirDiscoverTool,
  ophirCheckSLATool,
  getOphirToolkit,
  createOphirToolkit,
  createOphirCrewTools,
  toFunctionDefinition,
  handleToolCall,
  OphirNegotiateTool,
  OphirDiscoverTool,
  OphirCheckSLATool,
  OphirBaseTool,
} from "../index.js";
import type { OphirCrewTool } from "../index.js";

vi.mock("@ophirai/sdk", () => ({
  negotiate: vi.fn().mockResolvedValue({
    quotes: [
      {
        rfq_id: "rfq-1",
        seller: { agent_id: "did:key:seller1", endpoint: "http://seller1:3000" },
        pricing: { price: "0.008", currency: "USDC", unit: "request" },
      },
    ],
    agreement: {
      agreement_id: "agr-1",
      rfq_id: "rfq-1",
      final_terms: { price: "0.008", currency: "USDC", unit: "request" },
    },
    acceptedQuote: {
      rfq_id: "rfq-1",
      seller: { agent_id: "did:key:seller1", endpoint: "http://seller1:3000" },
      pricing: { price: "0.008", currency: "USDC", unit: "request" },
    },
    sellersContacted: 2,
    durationMs: 1234,
  }),
  autoDiscover: vi.fn().mockResolvedValue([
    {
      agentId: "did:key:seller1",
      endpoint: "http://seller1:3000",
      services: [{ category: "inference", description: "LLM inference", base_price: "0.01", currency: "USDC", unit: "request" }],
      capabilities: { supported: true },
      registeredAt: "2026-01-01T00:00:00Z",
      lastHeartbeat: "2026-03-05T00:00:00Z",
      reputation: { score: 95, total_agreements: 100, disputes_won: 2, disputes_lost: 0 },
    },
    {
      agentId: "did:key:seller2",
      endpoint: "http://seller2:3000",
      services: [{ category: "inference", description: "Fast inference", base_price: "0.02", currency: "USDC", unit: "request" }],
      capabilities: { supported: true },
      registeredAt: "2026-01-15T00:00:00Z",
      lastHeartbeat: "2026-03-05T00:00:00Z",
      reputation: { score: 40, total_agreements: 10, disputes_won: 0, disputes_lost: 3 },
    },
  ]),
  LockstepMonitor: vi.fn().mockImplementation(() => ({
    startMonitoring: vi.fn().mockResolvedValue({ monitoringId: "mon_agr-1" }),
    checkCompliance: vi.fn().mockResolvedValue({
      compliant: true,
      violations: [],
    }),
  })),
}));

describe("OphirNegotiateTool (class)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extends OphirBaseTool", () => {
    const tool = new OphirNegotiateTool();
    expect(tool).toBeInstanceOf(OphirBaseTool);
  });

  it("has correct name, description, and args_schema", () => {
    const tool = new OphirNegotiateTool();
    expect(tool.name).toBe("ophir_negotiate");
    expect(tool.description).toContain("Negotiate with AI service providers");
    expect(tool.description).toContain("SLA guarantees");
    expect(tool.args_schema).toHaveProperty("type", "object");
    expect(tool.args_schema).toHaveProperty("properties");
    expect(tool.args_schema).toHaveProperty("additionalProperties", false);
  });

  it("has all parameter fields in args_schema", () => {
    const tool = new OphirNegotiateTool();
    const props = tool.args_schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("service_category");
    expect(props).toHaveProperty("model");
    expect(props).toHaveProperty("max_price_per_unit");
    expect(props).toHaveProperty("currency");
    expect(props).toHaveProperty("sla_requirements");
    expect(props).toHaveProperty("registry_url");
    expect(props).toHaveProperty("ranking");
    expect(props).toHaveProperty("auto_accept");
    expect(props).toHaveProperty("timeout_ms");
    expect(props).toHaveProperty("sellers");
    expect(props).toHaveProperty("unit");
  });

  it("_run executes negotiate and returns success JSON", async () => {
    const tool = new OphirNegotiateTool();
    const result = await tool._run({
      service_category: "inference",
      model: "llama-3-70b",
      max_price_per_unit: 0.01,
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.agreement).toBeDefined();
    expect(parsed.agreement.agreement_id).toBe("agr-1");
    expect(parsed.agreement.endpoint).toBe("http://seller1:3000");
    expect(parsed.sellers_contacted).toBe(2);
    expect(parsed.quotes_received).toBe(1);
  });

  it("run() wraps errors from _run", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    vi.mocked(negotiate).mockRejectedValueOnce(new Error("Network timeout"));

    const tool = new OphirNegotiateTool();
    const result = await tool.run({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Network timeout");
  });

  it("passes correct options to negotiate()", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    const mockNegotiate = vi.mocked(negotiate);

    const tool = new OphirNegotiateTool();
    await tool._run({
      service_category: "inference",
      model: "gpt-4",
      max_price_per_unit: 0.05,
      currency: "USDT",
      ranking: "best_sla",
      sla_requirements: { p99_latency_ms: 200, uptime_pct: 99.9 },
    });

    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "inference",
        model: "gpt-4",
        maxBudget: "0.05",
        currency: "USDT",
        ranking: "best_sla",
        autoAccept: true,
        sla: {
          metrics: expect.arrayContaining([
            { name: "p99_latency_ms", target: 200, comparison: "lte" },
            { name: "uptime_pct", target: 99.9, comparison: "gte" },
          ]),
          dispute_resolution: { method: "automatic_escrow" },
        },
      }),
    );
  });

  it("asTool() converts to OphirCrewTool interface", () => {
    const tool = new OphirNegotiateTool();
    const crewTool = tool.asTool();

    expect(crewTool.name).toBe("ophir_negotiate");
    expect(typeof crewTool.execute).toBe("function");
    expect(crewTool.parameters).toBe(tool.args_schema);
  });

  it("respects custom config", () => {
    const tool = new OphirNegotiateTool({
      registryUrl: "https://custom.example.com/v1",
      defaultCurrency: "ETH",
      defaultRanking: "fastest",
    });

    const props = tool.args_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.currency.default).toBe("ETH");
    expect(props.ranking.default).toBe("fastest");
    expect(props.registry_url.default).toBe("https://custom.example.com/v1");
  });
});

describe("OphirDiscoverTool (class)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extends OphirBaseTool with correct name", () => {
    const tool = new OphirDiscoverTool();
    expect(tool).toBeInstanceOf(OphirBaseTool);
    expect(tool.name).toBe("ophir_discover");
    expect(tool.description).toContain("Discover available AI service providers");
  });

  it("_run returns discovered providers", async () => {
    const tool = new OphirDiscoverTool();
    const result = await tool._run({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.total_found).toBe(2);
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.providers[0].agent_id).toBe("did:key:seller1");
    expect(parsed.providers[0].reputation.score).toBe(95);
  });

  it("filters by min_reputation", async () => {
    const tool = new OphirDiscoverTool();
    const result = await tool._run({
      service_category: "inference",
      min_reputation: 50,
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.total_found).toBe(1);
    expect(parsed.providers[0].agent_id).toBe("did:key:seller1");
  });

  it("handles discovery failure gracefully via run()", async () => {
    const { autoDiscover } = await import("@ophirai/sdk");
    vi.mocked(autoDiscover).mockRejectedValueOnce(new Error("Registry unreachable"));

    const tool = new OphirDiscoverTool();
    const result = await tool.run({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Registry unreachable");
  });
});

describe("OphirCheckSLATool (class)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("extends OphirBaseTool with correct name", () => {
    const tool = new OphirCheckSLATool();
    expect(tool).toBeInstanceOf(OphirBaseTool);
    expect(tool.name).toBe("ophir_check_sla");
    expect(tool.description).toContain("Check SLA compliance");
  });

  it("checks compliance and returns result", async () => {
    const tool = new OphirCheckSLATool();
    const result = await tool._run({
      agreement_id: "agr-1",
      agreement_hash: "abc123",
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.compliant).toBe(true);
    expect(parsed.violations).toEqual([]);
    expect(parsed.agreement_id).toBe("agr-1");
    expect(parsed.monitoring_id).toBe("mon_agr-1");
  });

  it("returns error when agreement_id is missing", async () => {
    const tool = new OphirCheckSLATool();
    const result = await tool._run({ agreement_hash: "abc123" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("agreement_id");
  });

  it("has required fields in args_schema", () => {
    const tool = new OphirCheckSLATool();
    expect(tool.args_schema.required).toContain("agreement_id");
    expect(tool.args_schema.required).toContain("agreement_hash");
  });
});

describe("ophirNegotiateTool (plain object)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has correct name and description", () => {
    expect(ophirNegotiateTool.name).toBe("ophir_negotiate");
    expect(ophirNegotiateTool.description).toContain("Negotiate with AI service providers");
  });

  it("executes negotiate and returns success JSON", async () => {
    const result = await ophirNegotiateTool.execute({
      service_category: "inference",
      model: "llama-3-70b",
      max_price_per_unit: 0.01,
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.agreement.agreement_id).toBe("agr-1");
  });

  it("handles negotiate failure gracefully", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    vi.mocked(negotiate).mockRejectedValueOnce(new Error("Network timeout"));

    const result = await ophirNegotiateTool.execute({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Network timeout");
  });
});

describe("ophirDiscoverTool (plain object)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has correct name and returns providers", async () => {
    expect(ophirDiscoverTool.name).toBe("ophir_discover");
    const result = await ophirDiscoverTool.execute({ service_category: "inference" });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.total_found).toBe(2);
  });
});

describe("ophirCheckSLATool (plain object)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has correct name and checks compliance", async () => {
    expect(ophirCheckSLATool.name).toBe("ophir_check_sla");
    const result = await ophirCheckSLATool.execute({
      agreement_id: "agr-1",
      agreement_hash: "abc123",
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.compliant).toBe(true);
  });
});

describe("getOphirToolkit", () => {
  it("returns all 3 tools", () => {
    const tools = getOphirToolkit();
    expect(tools).toHaveLength(3);
    expect(tools.map((t: OphirCrewTool) => t.name)).toEqual([
      "ophir_negotiate",
      "ophir_discover",
      "ophir_check_sla",
    ]);
  });

  it("all tools have required interface properties", () => {
    const tools = getOphirToolkit();
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.parameters).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });
});

describe("createOphirToolkit", () => {
  it("creates toolkit with custom config", () => {
    const tools = createOphirToolkit({
      registryUrl: "https://custom-registry.example.com/v1",
      defaultRanking: "best_sla",
      defaultCurrency: "USDT",
    });

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "ophir_negotiate",
      "ophir_discover",
      "ophir_check_sla",
    ]);

    const negotiateParams = tools[0].parameters.properties as Record<string, Record<string, unknown>>;
    expect(negotiateParams.currency.default).toBe("USDT");
    expect(negotiateParams.ranking.default).toBe("best_sla");
    expect(negotiateParams.registry_url.default).toBe("https://custom-registry.example.com/v1");
  });

  it("passes custom config to negotiate execute", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    const mockNegotiate = vi.mocked(negotiate);

    const tools = createOphirToolkit({
      registryUrl: "https://custom.example.com/v1",
      defaultCurrency: "ETH",
      defaultRanking: "fastest",
      timeoutMs: 15_000,
    });

    await tools[0].execute({ service_category: "inference" });

    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "ETH",
        ranking: "fastest",
        timeout: 15_000,
        registries: ["https://custom.example.com/v1"],
      }),
    );
  });
});

describe("createOphirCrewTools", () => {
  it("returns OphirBaseTool instances", () => {
    const tools = createOphirCrewTools();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(OphirBaseTool);
      expect(typeof tool._run).toBe("function");
      expect(typeof tool.run).toBe("function");
      expect(tool.result_as_answer).toBe(false);
    }
  });

  it("applies config to all tools", () => {
    const tools = createOphirCrewTools({
      registryUrl: "https://private.example.com/v1",
    });
    const negotiateTool = tools[0] as OphirNegotiateTool;
    const props = negotiateTool.args_schema.properties as Record<string, Record<string, unknown>>;
    expect(props.registry_url.default).toBe("https://private.example.com/v1");
  });
});

describe("toFunctionDefinition", () => {
  it("converts tool to OpenAI function format", () => {
    const funcDef = toFunctionDefinition(ophirNegotiateTool);

    expect(funcDef.type).toBe("function");
    expect(funcDef.function.name).toBe("ophir_negotiate");
    expect(funcDef.function.description).toContain("Negotiate");
    expect(funcDef.function.parameters).toBe(ophirNegotiateTool.parameters);
  });
});

describe("handleToolCall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dispatches to correct tool by name", async () => {
    const tools = getOphirToolkit();
    const result = await handleToolCall(tools, "ophir_discover", {
      service_category: "inference",
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.providers).toBeDefined();
  });

  it("returns error for unknown tool name", async () => {
    const tools = getOphirToolkit();
    const result = await handleToolCall(tools, "unknown_tool", {});
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown tool");
    expect(parsed.error).toContain("Available tools");
  });
});
