# @ophirai/langchain

LangChain.js tool for the Ophir agent negotiation protocol. Lets any LangChain-powered agent discover, negotiate with, and transact with AI service providers automatically.

## Install

```bash
npm install @ophirai/langchain @langchain/core
```

## Usage

```typescript
import { createOphirTools } from "@ophirai/langchain";
import { ChatOpenAI } from "@langchain/openai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";

const tools = createOphirTools();

const llm = new ChatOpenAI({ model: "gpt-4" });
const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a helpful assistant that can negotiate with AI providers."],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const agent = createToolCallingAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const result = await executor.invoke({
  input: "Find me the cheapest inference provider for llama-3-70b with p99 latency under 200ms",
});
```

## Custom Registry

```typescript
const tools = createOphirTools({ registryUrl: "https://my-registry.example.com/v1" });
```

## Exported Tool

- **`OphirNegotiateTool`** — A LangChain `StructuredTool` that negotiates with AI service providers. Accepts service category, model, budget, currency, SLA requirements, and registry URL. Returns a signed agreement with endpoint URL, pricing, and SLA terms.

## API

| Export | Description |
|---|---|
| `createOphirTools(config?)` | Returns an array of LangChain tools ready for use with any agent |
| `OphirNegotiateTool` | The tool class — use directly if you need more control |
| `OphirNegotiateInput` | TypeScript type for the tool's input schema |
