import { describe, it, expect, vi, beforeEach } from "vitest";
import { OphirNegotiateTool, createOphirTools } from "../index.js";

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
}));

describe("OphirNegotiateTool", () => {
  let tool: OphirNegotiateTool;

  beforeEach(() => {
    tool = new OphirNegotiateTool();
    vi.clearAllMocks();
  });

  it("has the correct name", () => {
    expect(tool.name).toBe("ophir_negotiate");
  });

  it("has a rich description mentioning key use cases", () => {
    expect(tool.description).toContain("Negotiate with AI service providers");
    expect(tool.description).toContain("SLA guarantees");
    expect(tool.description).toContain("cheaper inference");
    expect(tool.description).toContain("signed agreement");
  });

  it("schema accepts valid input with defaults", async () => {
    const result = tool.schema.parse({});
    expect(result.service_category).toBe("inference");
    expect(result.currency).toBe("USDC");
    expect(result.registry_url).toBe("https://registry.ophir.ai/v1");
  });

  it("schema accepts full input", () => {
    const input = {
      service_category: "translation",
      model: "gpt-4",
      max_price_per_unit: 0.05,
      currency: "USDT",
      sla_requirements: { p99_latency_ms: 200, uptime_pct: 99.9, error_rate: 0.01 },
      registry_url: "http://localhost:8080/v1",
    };
    const result = tool.schema.parse(input);
    expect(result.service_category).toBe("translation");
    expect(result.model).toBe("gpt-4");
    expect(result.sla_requirements?.p99_latency_ms).toBe(200);
  });

  it("schema rejects invalid sla_requirements type", () => {
    expect(() =>
      tool.schema.parse({ sla_requirements: "bad" }),
    ).toThrow();
  });

  it("schema rejects invalid max_price_per_unit type", () => {
    expect(() =>
      tool.schema.parse({ max_price_per_unit: "not-a-number" }),
    ).toThrow();
  });

  it("calls negotiate and returns success JSON", async () => {
    const result = await tool.invoke({
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

  it("passes correct options to negotiate()", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    const mockNegotiate = vi.mocked(negotiate);

    await tool.invoke({
      service_category: "inference",
      model: "llama-3-70b",
      max_price_per_unit: 0.02,
      currency: "USDC",
      sla_requirements: { uptime_pct: 99.9, p99_latency_ms: 200 },
    });

    expect(mockNegotiate).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "inference",
        model: "llama-3-70b",
        maxBudget: "0.02",
        currency: "USDC",
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

  it("handles negotiate failure gracefully", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    vi.mocked(negotiate).mockRejectedValueOnce(new Error("Network timeout"));

    const result = await tool.invoke({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Network timeout");
  });

  it("uses custom registry URL from constructor", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    const customTool = new OphirNegotiateTool({ registryUrl: "http://custom:9000/v1" });

    await customTool.invoke({ service_category: "inference" });

    expect(vi.mocked(negotiate)).toHaveBeenCalledWith(
      expect.objectContaining({
        registries: ["https://registry.ophir.ai/v1"],
      }),
    );
  });

  it("uses default maxBudget when max_price_per_unit is not provided", async () => {
    const { negotiate } = await import("@ophirai/sdk");

    await tool.invoke({ service_category: "inference" });

    expect(vi.mocked(negotiate)).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBudget: "1.00",
      }),
    );
  });
});

describe("createOphirTools", () => {
  it("returns an array with one tool", () => {
    const tools = createOphirTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toBeInstanceOf(OphirNegotiateTool);
  });

  it("passes config through to the tool", () => {
    const tools = createOphirTools({ registryUrl: "http://custom:9000/v1" });
    expect(tools[0]).toBeInstanceOf(OphirNegotiateTool);
  });
});
