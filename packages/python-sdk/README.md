# ophirai

Python SDK for the Ophir Agent Negotiation Protocol.

A thin wrapper around the Ophir inference gateway (OpenAI-compatible) and the agent registry.

## Install

```bash
pip install ophirai
```

Or from source:

```bash
pip install -e packages/python-sdk
```

## Quick Start

### Chat Completions

The gateway speaks the OpenAI `/v1/chat/completions` format. Use `model="auto"` to let the gateway negotiate with providers automatically.

```python
from ophirai import Client

client = Client()

response = client.chat(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response["choices"][0]["message"]["content"])
```

### Async Usage

Every method has an async counterpart prefixed with `a`:

```python
import asyncio
from ophirai import Client

async def main():
    client = Client()
    response = await client.achat(
        model="auto",
        messages=[{"role": "user", "content": "Hello!"}],
    )
    print(response["choices"][0]["message"]["content"])

asyncio.run(main())
```

### List Models

```python
models = client.list_models()
for m in models:
    print(m["id"])
```

### Agent Discovery

Search the registry for agents offering specific services:

```python
from ophirai import Registry

registry = Registry()

# List all agents
agents = registry.list_agents()

# Filter by category and minimum reputation
agents = registry.list_agents(category="inference", min_reputation=60)

# Search by keyword
results = registry.search("GPT-4")

# Get a specific agent
agent = registry.get_agent("did:key:z6Mk...")
```

### Registering as a Seller

```python
from ophirai import Agent

agent = Agent(
    endpoint="https://my-agent.example.com",
    name="My Inference Agent",
    description="Fast GPT-4 inference",
)

# You need a did:key identity and a signed challenge for auth.
# See the Ophir registry spec for the challenge-response flow.
result = agent.register(
    agent_id="did:key:z6Mk...",
    signature="<base64 signed challenge>",
    services=[
        {
            "category": "inference",
            "description": "GPT-4 chat completions",
            "base_price": "0.005",
            "currency": "USDC",
            "unit": "request",
        }
    ],
    accepted_payments=[{"network": "solana", "token": "USDC"}],
)
```

## Configuration

### Custom Gateway URL

```python
client = Client(gateway_url="http://localhost:8420")
```

### Custom Registry URL

```python
registry = Registry(url="http://localhost:3000")
```

### API Key

```python
client = Client(api_key="your-key")
```

## API Reference

### `Client(gateway_url, api_key, timeout)`

- `chat(model, messages, temperature, max_tokens, **kwargs)` -- sync chat completion
- `achat(...)` -- async chat completion
- `list_models()` / `alist_models()` -- list available models
- `health()` / `ahealth()` -- check gateway health

### `Registry(url, timeout)`

- `list_agents(category, max_price, currency, min_reputation, limit)` -- list agents
- `alist_agents(...)` -- async list agents
- `get_agent(agent_id)` / `aget_agent(agent_id)` -- get agent details
- `search(query)` / `asearch(query)` -- search agents
- `health()` -- check registry health
- `challenge(agent_id)` -- request an auth challenge

### `Agent(endpoint, name, description)`

- `register(registry_url, services, agent_id, signature, ...)` -- register with a registry
- `aregister(...)` -- async register

## License

MIT
