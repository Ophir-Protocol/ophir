# @ophirai/crewai

CrewAI-compatible tools for the Ophir agent negotiation protocol. Provides both class-based tools (matching CrewAI's `BaseTool` pattern) and plain-object tools for generic function-calling frameworks.

## Install

```bash
npm install @ophirai/crewai
```

## Usage

### Class-based (CrewAI pattern)

```typescript
import { OphirNegotiateTool, OphirDiscoverTool, OphirCheckSLATool } from "@ophirai/crewai";

const negotiate = new OphirNegotiateTool({ registryUrl: "https://registry.ophir.ai/v1" });
const result = await negotiate._run({
  service_category: "inference",
  model: "llama-3-70b",
  max_price_per_unit: 0.01,
  sla_requirements: { p99_latency_ms: 200, uptime_pct: 99.9 },
});
const { agreement } = JSON.parse(result);
// agreement.endpoint -> use this URL for inference calls
```

### Plain-object (function-calling)

```typescript
import { getOphirToolkit, toFunctionDefinition, handleToolCall } from "@ophirai/crewai";

const tools = getOphirToolkit();
const functions = tools.map(toFunctionDefinition);

// In your agent loop, when the LLM returns a tool call:
const result = await handleToolCall(tools, "ophir_negotiate", {
  service_category: "inference",
});
```

### Custom configuration

```typescript
import { createOphirToolkit } from "@ophirai/crewai";

const tools = createOphirToolkit({
  registryUrl: "https://my-registry.example.com/v1",
  defaultRanking: "best_sla",
  defaultCurrency: "USDT",
  timeoutMs: 30_000,
});
```

## Tools

| Tool | Description |
|---|---|
| `ophir_negotiate` | Negotiate with AI providers — discover, quote, rank, and accept the best deal |
| `ophir_discover` | Survey available providers, their services, pricing, and reputation |
| `ophir_check_sla` | Verify SLA compliance for an active agreement via Lockstep verification |

## API

| Export | Description |
|---|---|
| `createOphirToolkit(config?)` | Plain-object tools with custom config |
| `createOphirCrewTools(config?)` | Class-based `OphirBaseTool` instances with `_run()` and `args_schema` |
| `getOphirToolkit()` | Default plain-object toolkit |
| `toFunctionDefinition(tool)` | Convert to OpenAI function-calling format |
| `handleToolCall(tools, name, params)` | Dispatch a function call by name |
