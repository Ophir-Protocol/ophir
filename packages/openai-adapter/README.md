# @ophirai/openai-adapter

OpenAI function calling adapter for the Ophir negotiation protocol. Exposes Ophir negotiation and service discovery as OpenAI-compatible tool definitions, so any agent using OpenAI function calling can negotiate with Ophir providers natively.

## Installation

```bash
npm install @ophirai/openai-adapter
```

## Usage

### Add Ophir tools to your OpenAI call

```typescript
import OpenAI from 'openai';
import { OPHIR_TOOLS, handleOphirFunctionCall } from '@ophirai/openai-adapter';

const client = new OpenAI();

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Find me a cheap inference provider' }],
  tools: OPHIR_TOOLS,
});

// Handle Ophir tool calls in your processing loop
for (const call of response.choices[0].message.tool_calls ?? []) {
  if (call.function.name.startsWith('ophir_')) {
    const result = await handleOphirFunctionCall(
      call.function.name,
      JSON.parse(call.function.arguments),
    );
    console.log(result);
  }
}
```

### Available tools

**`ophir_negotiate`** -- Discovers sellers, sends RFQs, collects quotes, and optionally auto-accepts the best offer.

Parameters:
- `service` (required) -- Service category (e.g. `inference`, `embedding`)
- `max_budget` (required) -- Maximum price per unit
- `model` -- Specific model name
- `currency` -- Payment currency (default: `USDC`)
- `sla_requirements` -- Object with `uptime_pct`, `max_latency_ms`, `min_accuracy_pct`
- `auto_accept` -- Auto-accept best quote (default: `true`)

**`ophir_list_services`** -- Lists available providers and their service offerings.

Parameters:
- `category` -- Filter by service category

## What is included

- **`OPHIR_TOOLS`** -- Array of OpenAI-compatible tool definitions ready to pass to `tools` in a chat completion request.
- **`handleOphirFunctionCall`** -- Dispatcher that executes Ophir SDK calls based on the function name and arguments from a tool call, returning a JSON string result.
