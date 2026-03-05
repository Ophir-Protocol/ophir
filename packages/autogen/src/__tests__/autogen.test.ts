import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  negotiateFunction,
  discoverFunction,
  executeInferenceFunction,
  registerOphirTools,
} from "../index.js";
import type { AutoGenFunction, AutoGenToolRegistration } from "../index.js";

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
      registeredAt: "2026-01-01T00:00:00Z",
      lastHeartbeat: "2026-03-05T00:00:00Z",
      reputation: { score: 95, total_agreements: 100, disputes_won: 2, disputes_lost: 0 },
    },
    {
      agentId: "did:key:seller2",
      endpoint: "http://seller2:3000",
      services: [{ category: "inference", description: "Fast inference", base_price: "0.02", currency: "USDC", unit: "request" }],
      registeredAt: "2026-01-15T00:00:00Z",
      lastHeartbeat: "2026-03-05T00:00:00Z",
      reputation: { score: 40, total_agreements: 10, disputes_won: 0, disputes_lost: 3 },
    },
  ]),
}));

function assertValidFunctionDefinition(def: AutoGenFunction) {
  expect(def.type).toBe("function");
  expect(typeof def.function.name).toBe("string");
  expect(def.function.name.length).toBeGreaterThan(0);
  expect(typeof def.function.description).toBe("string");
  expect(def.function.description.length).toBeGreaterThan(0);
  expect(def.function.parameters.type).toBe("object");
  expect(typeof def.function.parameters.properties).toBe("object");
  expect(Array.isArray(def.function.parameters.required)).toBe(true);
}

describe("negotiateFunction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has a valid OpenAI function calling definition", () => {
    assertValidFunctionDefinition(negotiateFunction.definition);
    expect(negotiateFunction.definition.function.name).toBe("ophir_negotiate");
    expect(negotiateFunction.definition.function.description).toContain("Negotiate");
  });

  it("definition includes all expected parameter properties", () => {
    const props = negotiateFunction.definition.function.parameters.properties;
    expect(props).toHaveProperty("service_category");
    expect(props).toHaveProperty("model");
    expect(props).toHaveProperty("max_price_per_unit");
    expect(props).toHaveProperty("currency");
    expect(props).toHaveProperty("ranking");
    expect(props).toHaveProperty("sla_requirements");
    expect(props).toHaveProperty("sellers");
    expect(props).toHaveProperty("timeout_ms");
  });

  it("handler calls negotiate and returns success JSON", async () => {
    const result = await negotiateFunction.handler({
      service_category: "inference",
      model: "llama-3-70b",
      max_price_per_unit: 0.01,
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.agreement).toBeDefined();
    expect(parsed.agreement.agreement_id).toBe("agr-1");
    expect(parsed.agreement.endpoint).toBe("http://seller1:3000");
    expect(parsed.quotes_received).toBe(1);
    expect(parsed.sellers_contacted).toBe(2);
  });

  it("handler passes correct options to negotiate()", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    const mockNegotiate = vi.mocked(negotiate);

    await negotiateFunction.handler({
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

  it("handler returns error JSON on negotiate failure", async () => {
    const { negotiate } = await import("@ophirai/sdk");
    vi.mocked(negotiate).mockRejectedValueOnce(new Error("Network timeout"));

    const result = await negotiateFunction.handler({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Network timeout");
  });
});

describe("discoverFunction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has a valid OpenAI function calling definition", () => {
    assertValidFunctionDefinition(discoverFunction.definition);
    expect(discoverFunction.definition.function.name).toBe("ophir_discover");
    expect(discoverFunction.definition.function.description).toContain("Discover");
  });

  it("handler returns discovered providers", async () => {
    const result = await discoverFunction.handler({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.total_found).toBe(2);
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.providers[0].agent_id).toBe("did:key:seller1");
  });

  it("handler filters by min_reputation", async () => {
    const result = await discoverFunction.handler({
      service_category: "inference",
      min_reputation: 50,
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.total_found).toBe(1);
    expect(parsed.providers[0].agent_id).toBe("did:key:seller1");
  });

  it("handler returns error JSON on discovery failure", async () => {
    const { autoDiscover } = await import("@ophirai/sdk");
    vi.mocked(autoDiscover).mockRejectedValueOnce(new Error("Registry unreachable"));

    const result = await discoverFunction.handler({ service_category: "inference" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Registry unreachable");
  });
});

describe("executeInferenceFunction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("has a valid OpenAI function calling definition with required fields", () => {
    assertValidFunctionDefinition(executeInferenceFunction.definition);
    expect(executeInferenceFunction.definition.function.name).toBe("ophir_execute_inference");
    expect(executeInferenceFunction.definition.function.parameters.required).toEqual(
      expect.arrayContaining(["agreement_id", "endpoint", "prompt"]),
    );
  });

  it("handler returns error when required fields are missing", async () => {
    const result = await executeInferenceFunction.handler({ agreement_id: "agr-1" });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("required");
  });

  it("handler calls fetch with correct headers and body", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({ choices: [{ message: { content: "Hello!" } }] }),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await executeInferenceFunction.handler({
      agreement_id: "agr-1",
      endpoint: "http://seller1:3000/v1/chat/completions",
      prompt: "Say hello",
      model: "llama-3-70b",
      max_tokens: 100,
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.agreement_id).toBe("agr-1");
    expect(fetch).toHaveBeenCalledWith(
      "http://seller1:3000/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Ophir-Agreement-Id": "agr-1",
        }),
      }),
    );
  });

  it("handler returns error on non-ok response", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("Internal Server Error"),
    };
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await executeInferenceFunction.handler({
      agreement_id: "agr-1",
      endpoint: "http://seller1:3000/v1/chat/completions",
      prompt: "Say hello",
    });
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("500");
  });
});

describe("registerOphirTools", () => {
  it("returns all 3 tool registrations", () => {
    const tools = registerOphirTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.definition.function.name)).toEqual([
      "ophir_negotiate",
      "ophir_discover",
      "ophir_execute_inference",
    ]);
  });

  it("all tools have valid definitions and callable handlers", () => {
    const tools = registerOphirTools();
    for (const tool of tools) {
      assertValidFunctionDefinition(tool.definition);
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("all tool definitions have unique names", () => {
    const tools = registerOphirTools();
    const names = tools.map((t) => t.definition.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all JSON Schema definitions have valid type structure", () => {
    const tools = registerOphirTools();
    for (const tool of tools) {
      const params = tool.definition.function.parameters;
      expect(params.type).toBe("object");
      expect(typeof params.properties).toBe("object");
      expect(Array.isArray(params.required)).toBe(true);

      // Each property should have a type and description
      for (const [key, prop] of Object.entries(params.properties)) {
        const propObj = prop as Record<string, unknown>;
        expect(propObj).toHaveProperty("type", expect.any(String));
        expect(propObj).toHaveProperty("description", expect.any(String));
      }
    }
  });
});
