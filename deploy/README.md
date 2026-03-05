# Ophir Deployment

Deploy the Ophir ecosystem: a registry for agent discovery, an inference router, and a live seller backed by OpenRouter.

## Architecture

```
                    Agents / Clients
                         |
            +------------+------------+
            |                         |
     POST /agents?...          POST /v1/chat/completions
            |                         |
      +-----v------+          +-------v------+
      |  Registry   |<--------+   Router     |
      |  :8420      |  lookup  |  :8421      |
      +-----+------+          +-------+------+
            |                         |
            |   registered            |  forwards
            |                         |
      +-----v-------------------------v------+
      |          Live Seller :8422            |
      |     (OpenRouter - 100+ models)       |
      +--------------------------------------+
```

- **Registry** (`localhost:8420`) -- Agent discovery and registration. SQLite-backed, persistent volume.
- **Router** (`localhost:8421`) -- OpenAI-compatible inference gateway. Queries the registry for available sellers and routes requests using configurable strategies (cheapest, fastest, etc.).
- **Seller** (`localhost:8422`) -- A live inference seller wrapping OpenRouter. Auto-registers with the registry on startup and responds to RFQs.

## Prerequisites

- Docker and Docker Compose (v2)
- An [OpenRouter API key](https://openrouter.ai/keys) for the live seller
- (Optional) [Fly CLI](https://fly.io/docs/flyctl/install/) for cloud deployment

## Quick Start -- Full Stack

### 1. Configure your OpenRouter API key

Copy the example env file and add your key:

```bash
cd deploy
cp env.example .env
```

Edit `.env` and set your key:

```
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Or export it directly in your shell:

```bash
export OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

### 2. Start the stack

```bash
cd deploy
docker-compose up -d --build
```

This builds and starts all three services. The registry starts first; the router and seller wait for it to be healthy before starting.

### 3. Verify health

```bash
# Registry
curl http://localhost:8420/health

# Router
curl http://localhost:8421/health
```

### 4. Discover sellers through the registry

Once the seller has started and registered, it appears in the registry:

```bash
curl http://localhost:8420/agents?category=inference
```

You should see the OpenRouter-backed seller listed with its available models and pricing.

### 5. Make an inference request through the router

The router is an OpenAI-compatible endpoint. Send a chat completion request and it will find the best seller via the registry and route the request:

```bash
curl http://localhost:8421/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello from Ophir!"}]
  }'
```

The `"model": "auto"` setting lets the router pick the best available model based on pricing and availability.

### 6. Stop the stack

```bash
cd deploy
docker-compose down
```

To also remove the registry data volume:

```bash
docker-compose down -v
```

## Dev Mode (Hot Reload)

For development with live source reloading via `tsx`:

```bash
cd deploy
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

This overlays development settings on the production compose file:
- Mounts your local `packages/` directory into each container
- Replaces the compiled `node dist/...` command with `npx tsx` for hot reloading
- Source changes are reflected immediately without rebuilding images

## Environment Variables

### Registry

| Variable  | Default                    | Description             |
|-----------|----------------------------|-------------------------|
| `PORT`    | `8420`                     | HTTP listen port        |
| `DB_PATH` | `/data/ophir-registry.db`  | SQLite database path    |

### Router

| Variable             | Default    | Description                  |
|----------------------|------------|------------------------------|
| `PORT`               | `8421`     | HTTP listen port             |
| `OPHIR_REGISTRY_URL` | *(set by compose)* | Registry URL to query |
| `OPHIR_STRATEGY`     | `cheapest` | Routing strategy (`cheapest`, `fastest`, `round-robin`) |
| `OPHIR_MAX_BUDGET`   | `1.00`     | Max budget per request (USD) |

### Seller

| Variable             | Default    | Description                       |
|----------------------|------------|-----------------------------------|
| `SELLER_PORT`        | `8422`     | HTTP listen port                  |
| `SELLER_ENDPOINT`    | *(set by compose)* | Public endpoint for registration |
| `OPHIR_REGISTRY_URL` | *(set by compose)* | Registry to register with |
| `OPENROUTER_API_KEY` | --         | OpenRouter API key (**required**) |

## Deploy to Fly.io

### 1. Create apps and volumes

```bash
# Create the registry app with a persistent volume for SQLite
fly apps create ophir-registry
fly volumes create registry_data --size 1 --region iad -a ophir-registry

# Create the router app (stateless, no volume needed)
fly apps create ophir-router

# Create the seller app (stateless)
fly apps create ophir-seller
```

### 2. Set secrets

```bash
fly secrets set OPENROUTER_API_KEY=sk-or-v1-your-key -a ophir-seller
```

### 3. Deploy each service

Deploy in order -- registry first, then router and seller:

```bash
# From the repo root
cd deploy/registry && fly deploy
cd ../router && fly deploy
cd ../seller && fly deploy
```

### 4. Verify

```bash
curl https://ophir-registry.fly.dev/health
curl https://ophir-router.fly.dev/health
curl https://ophir-registry.fly.dev/agents?category=inference
```

## Monitoring

```bash
# Stream logs from any service
fly logs -a ophir-registry
fly logs -a ophir-router
fly logs -a ophir-seller

# Check deployment status
fly status -a ophir-registry

# SSH into a running instance
fly ssh console -a ophir-registry
```

## Troubleshooting

**Seller not appearing in registry**: The seller auto-registers on startup. Check its logs for registration errors:
```bash
docker-compose logs seller
```

**Router returning empty responses**: Ensure at least one seller is registered. Check the registry:
```bash
curl http://localhost:8420/agents?category=inference
```

**Health check failing**: Services take a few seconds to start. The compose healthcheck has a start period of 10-15s. Check individual service logs:
```bash
docker-compose logs -f registry
docker-compose logs -f router
```

**OpenRouter API errors**: Verify your API key is set correctly in `.env` and has credits available.

**Rebuilding from scratch**: If you need a clean start:
```bash
docker-compose down -v --rmi local
docker-compose up -d --build
```
