# @ophirai/mcp-server

MCP server that gives your AI agent the ability to discover, negotiate with, and manage AI service providers through the Ophir protocol.

No API keys required — connects to the public Ophir registry.

## Installation

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ophir": {
      "command": "npx",
      "args": ["@ophirai/mcp-server"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "ophir": {
    "command": "npx",
    "args": ["@ophirai/mcp-server"]
  }
}
```

### Windsurf

Add to your Windsurf MCP config:

```json
{
  "mcpServers": {
    "ophir": {
      "command": "npx",
      "args": ["@ophirai/mcp-server"]
    }
  }
}
```

### Cline

Add to your Cline MCP settings:

```json
{
  "mcpServers": {
    "ophir": {
      "command": "npx",
      "args": ["@ophirai/mcp-server"]
    }
  }
}
```

### Any MCP client (npx)

```bash
npx @ophirai/mcp-server
```

### Smithery

```bash
smithery install ophir-negotiate
```

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `OPHIR_REGISTRY_URL` | Ophir registry endpoint | `https://registry.ophir.ai/v1` |
| `OPHIR_SELLERS` | Comma-separated seller endpoints | Auto-discovered |
| `OPHIR_BUYER_ENDPOINT` | Local buyer agent endpoint | `http://localhost:3001` |

## What can it do?

### ophir_discover — Find providers

> "Find me inference providers with a reputation score above 80."

Returns a list of providers with their services, pricing, and reputation scores:

```json
{
  "providers": [
    {
      "agent_id": "provider-abc",
      "endpoint": "https://provider-abc.ophir.ai",
      "services": [{ "category": "inference", "base_price": "0.002", "currency": "USDC", "unit": "request" }],
      "reputation": { "score": 92, "total_agreements": 1847 }
    }
  ],
  "total": 3
}
```

### ophir_negotiate — Full negotiation flow

> "Negotiate inference service with a max budget of 0.005 USDC per request."

Sends an RFQ to all matching providers, collects quotes, ranks them, and returns the best option:

```json
{
  "best_quote": {
    "seller": "provider-abc",
    "price": "0.0018",
    "currency": "USDC",
    "unit": "request",
    "sla": [
      { "metric": "latency_p99", "target": "500ms" },
      { "metric": "uptime", "target": "99.9%" }
    ]
  },
  "total_quotes": 5,
  "rfq_id": "rfq_01HXYZ..."
}
```

### ophir_accept_quote — Accept a quote

> "Accept quote qt_abc123 from RFQ rfq_01HXYZ."

Creates a signed agreement with the selected provider, locking in the negotiated terms.

### ophir_check_agreement — Monitor SLA compliance

> "Check if agreement agr_xyz is meeting its SLA targets."

Returns current SLA metric observations and compliance status:

```json
{
  "agreement_id": "agr_xyz",
  "sla_metrics": [
    { "name": "latency_p99", "target": "500ms", "comparison": "lte" },
    { "name": "uptime", "target": "99.9%", "comparison": "gte" }
  ],
  "compliance_status": "monitoring_available"
}
```

### ophir_list_agreements — View active agreements

> "Show me all my active provider agreements."

Lists all agreements with their pricing, status, and SLA terms.

### ophir_dispute — File an SLA dispute

> "File a dispute against agreement agr_xyz for latency violations."

Submits a dispute with cryptographic evidence of SLA violations, triggering the protocol's dispute resolution process.

## License

MIT
