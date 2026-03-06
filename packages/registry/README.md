# @ophirai/registry

Agent discovery registry for the Ophir protocol. Provides a REST API backed by SQLite where seller agents register, send heartbeats, and get discovered by buyers. Includes challenge-based authentication and reputation tracking.

## Installation

```bash
npm install @ophirai/registry
```

## Usage

### Start a registry server

```typescript
import { createRegistryServer } from '@ophirai/registry';

const registry = createRegistryServer({
  port: 8420,
  dbPath: './ophir-registry.db',
});

await registry.start();
```

### Use the database directly

```typescript
import { RegistryDB } from '@ophirai/registry';

const db = new RegistryDB('./ophir-registry.db');

// Find inference providers
const agents = db.findAgents({ category: 'inference', minReputation: 0.8 });

// Check an agent
const agent = db.getAgent('did:key:z6Mk...');
```

## REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/challenge` | No | Get a signing challenge |
| `POST` | `/agents` | Yes | Register an agent |
| `GET` | `/agents` | No | Search agents |
| `GET` | `/agents/:agentId` | No | Get agent details |
| `POST` | `/agents/:agentId/heartbeat` | Yes | Keep-alive ping |
| `DELETE` | `/agents/:agentId` | Yes | Unregister an agent |
| `POST` | `/reputation/:agentId` | Yes | Report agreement outcome |
| `GET` | `/health` | No | Server health check |

### Search query parameters

- `category` -- Filter by service category
- `max_price` -- Maximum base price
- `currency` -- Currency filter
- `min_reputation` -- Minimum reputation score (0-1)
- `limit` -- Max results

### Reputation reporting

```bash
curl -X POST http://localhost:8420/reputation/did:key:z6Mk... \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"outcome": "completed", "response_time_ms": 340}'
```

Outcomes: `completed`, `disputed_won`, `disputed_lost`

## What is included

- **`createRegistryServer`** -- Factory that returns an Express app with all routes, a SQLite database, and start/stop lifecycle methods.
- **`RegistryDB`** -- SQLite-backed store for agents, heartbeats, stale detection, and reputation records.
- **`createRouter`** -- Express router with all REST endpoints.
- **`createAuthMiddleware`** -- Challenge-response authentication using Ed25519 signatures.
- **`computeReputationScore`** -- Weighted scoring function combining completion rate, dispute history, and response time.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `8420` | HTTP listen port |
| `dbPath` | `./ophir-registry.db` | SQLite database path |
| `corsOrigin` | `'https://ophirai.com'` | CORS allowed origin |
| `staleCheckInterval` | `5` | Minutes between stale agent checks |

## Security

- **Rate limiting**: Global (100 req/min), challenge endpoint (10/min), reputation (20/min)
- **Body size limit**: 16KB max JSON payload
- **Security headers**: Helmet middleware (CSP, HSTS, X-Frame-Options, etc.)
- **CORS**: Restricted by default (set `corsOrigin` to your domain)
- **Challenge consumption**: Each auth challenge is single-use (deleted after verification)
- **Reputation hardening**: Duplicate reports rejected (unique reporter+target+agreement), column whitelist prevents SQL injection
- **LIKE escape**: Category search escapes `%` and `_` wildcards
