# Ophir Gateway Deployment

Deploy the Ophir inference gateway — a drop-in OpenAI-compatible API at `api.ophir.ai` with automatic provider negotiation.

## Architecture

```
    Developers (OpenAI SDK)
           |
  base_url = api.ophir.ai/v1
           |
    +------v-------+
    |   Gateway     |  :3000
    |  (api.ophir)  |
    +------+-------+
           |
    +------v-------+          +-------------+
    |   Router      |<-------->  Registry    |
    |  negotiation  |  lookup  |  discovery  |
    +------+-------+          +------+------+
           |                         |
           v                         v
    [ Provider A ]           [ Provider B ]
```

The gateway wraps the Ophir router with a landing page, health endpoint, and well-known discovery files. Any OpenAI-compatible client works out of the box — just change the base URL.

## Fly.io Deployment

### Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated
- Repository cloned locally

### 1. Create the app

```bash
fly apps create ophir-gateway
```

### 2. Set secrets

```bash
# Registry URL is set in fly.toml, but override if using a custom registry:
fly secrets set OPHIR_REGISTRY_URL=https://your-registry.example.com/v1 -a ophir-gateway

# Optional: configure routing
fly secrets set OPHIR_STRATEGY=cheapest -a ophir-gateway
fly secrets set OPHIR_MAX_BUDGET=1.00 -a ophir-gateway
```

### 3. Deploy

From the repository root:

```bash
fly deploy --config deploy/gateway/fly.toml --dockerfile deploy/gateway/Dockerfile
```

Or from the deploy/gateway directory:

```bash
cd deploy/gateway
fly deploy
```

> **Note:** The Dockerfile build context is the repository root. When deploying from a subdirectory, flyctl automatically detects the correct context from the workspace structure.

### 4. Verify

```bash
# Health check
curl https://ophir-gateway.fly.dev/health

# Landing page
curl https://ophir-gateway.fly.dev/

# Chat completion test
curl https://ophir-gateway.fly.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### 5. Custom domain (api.ophir.ai)

```bash
# Add the custom domain
fly certs create api.ophir.ai -a ophir-gateway

# Get the DNS target
fly certs show api.ophir.ai -a ophir-gateway
```

Then add a CNAME record in your DNS provider:

```
api.ophir.ai  CNAME  ophir-gateway.fly.dev
```

Fly.io will automatically provision and renew TLS certificates.

### 6. Scaling

```bash
# Scale to multiple regions for lower latency
fly scale count 2 --region iad,lax -a ophir-gateway

# Adjust VM size for higher throughput
fly scale vm shared-cpu-1x --memory 512 -a ophir-gateway
```

## Docker Local Testing

### Standalone

Build and run the gateway image by itself:

```bash
# From the repo root
docker build -f deploy/gateway/Dockerfile -t ophir-gateway .
docker run -p 3000:3000 \
  -e OPHIR_REGISTRY_URL=http://host.docker.internal:8420 \
  ophir-gateway
```

### Full stack (with registry + router + seller)

```bash
cd deploy
docker compose up -d --build
```

The gateway will be available at `http://localhost:3000`. Test it:

```bash
# Landing page
curl http://localhost:3000

# Health check
curl http://localhost:3000/health

# Chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello from Ophir!"}]
  }'
```

## Environment Variables

| Variable             | Default                              | Description                                              |
|----------------------|--------------------------------------|----------------------------------------------------------|
| `PORT`               | `3000`                               | HTTP listen port                                         |
| `NODE_ENV`           | `production`                         | Node environment                                         |
| `OPHIR_REGISTRY_URL` | `https://registry.ophir.ai/v1`       | Registry URL for provider discovery                      |
| `OPHIR_STRATEGY`     | `cheapest`                           | Routing strategy (`cheapest`, `fastest`, `round-robin`)  |
| `OPHIR_MAX_BUDGET`   | `1.00`                               | Max budget per request (USD)                             |

## Endpoints

| Path                            | Method | Description                        |
|---------------------------------|--------|------------------------------------|
| `/`                             | GET    | Landing page with live stats       |
| `/health`                       | GET    | Health check (JSON)                |
| `/v1/chat/completions`          | POST   | OpenAI-compatible chat completions |
| `/v1/models`                    | GET    | List available models              |
| `/.well-known/ophir.json`       | GET    | Ophir protocol discovery           |
| `/.well-known/agent.json`       | GET    | A2A agent card                     |

## Dockerfile Details

The build uses a three-stage approach optimised for turbo monorepos:

1. **Pruner stage** — Copies the full repo and runs `turbo prune @ophirai/gateway --docker` to extract only the packages in the gateway's dependency graph (`protocol -> sdk -> router -> gateway`). Outputs a minimal workspace with separate `json/` (package manifests for install caching) and `full/` (source code) directories.
2. **Builder stage** — Installs dependencies from the pruned `json/` output (maximises Docker layer cache), copies full source from `full/`, builds via turbo, then prunes dev dependencies with `npm prune --omit=dev`.
3. **Runtime stage** — Minimal Alpine image with only `curl` (for health checks), production `node_modules`, and compiled JavaScript. Runs as non-root user `ophir` (UID 1001).

The image exposes port 3000 and includes a `HEALTHCHECK` directive that polls `/health` every 30 seconds.
