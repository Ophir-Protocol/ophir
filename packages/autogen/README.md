# @ophirai/autogen

AutoGen-compatible tools for the Ophir agent negotiation protocol. Exports tools in the OpenAI function calling format that AutoGen uses natively.

## Install

```bash
npm install @ophirai/autogen
```

## Usage

```typescript
import { registerOphirTools } from "@ophirai/autogen";

const tools = registerOphirTools();

// Register with an AutoGen agent:
for (const tool of tools) {
  agent.register_function(tool.definition, tool.handler);
}
```

### Individual tools

```typescript
import { negotiateFunction, discoverFunction, executeInferenceFunction } from "@ophirai/autogen";

// Use the negotiate handler directly
const result = await negotiateFunction.handler({
  service_category: "inference",
  model: "llama-3-70b",
  max_price_per_unit: 0.01,
  sla_requirements: { p99_latency_ms: 200, uptime_pct: 99.9 },
});
const { agreement } = JSON.parse(result);

// Then execute inference using the agreement
const inference = await executeInferenceFunction.handler({
  agreement_id: agreement.agreement_id,
  endpoint: agreement.endpoint,
  prompt: "Explain quantum computing",
});
```

## Tools

| Tool | Description |
|---|---|
| `ophir_negotiate` | Negotiate with AI providers for best price and SLA guarantees |
| `ophir_discover` | Discover available providers on the Ophir network |
| `ophir_execute_inference` | Execute inference using an existing Ophir agreement |

## API

| Export | Description |
|---|---|
| `registerOphirTools()` | Returns all tool registrations as an array |
| `negotiateFunction` | Negotiate tool registration (definition + handler) |
| `discoverFunction` | Discover tool registration (definition + handler) |
| `executeInferenceFunction` | Execute inference tool registration (definition + handler) |
| `AutoGenFunction` | TypeScript type for OpenAI function definitions |
| `AutoGenToolRegistration` | TypeScript type for definition + handler pairs |
