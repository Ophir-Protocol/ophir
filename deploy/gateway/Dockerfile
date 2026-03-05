# ============================================================================
# Ophir Inference Gateway — Production Docker Image
# ============================================================================
# Build context: repository root
#   docker build -f deploy/gateway/Dockerfile -t ophir-gateway .
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Prune monorepo to only gateway-relevant packages
# ---------------------------------------------------------------------------
# turbo prune generates a minimal subset of the monorepo containing only the
# packages in @ophirai/gateway's dependency graph, with proper lockfile.
FROM node:20-alpine AS pruner

RUN apk add --no-cache libc6-compat
RUN npm install -g turbo@^2

WORKDIR /app
COPY . .
RUN turbo prune @ophirai/gateway --docker

# ---------------------------------------------------------------------------
# Stage 2: Install dependencies and build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

RUN apk add --no-cache libc6-compat

WORKDIR /app

# First, install dependencies using only package.json files (maximises cache)
COPY --from=pruner /app/out/json/ .
RUN npm install

# Copy full source and build the dependency graph
COPY --from=pruner /app/out/full/ .
COPY turbo.json turbo.json
RUN npx turbo run build --filter=@ophirai/gateway

# Remove dev dependencies to shrink the production footprint
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3: Minimal production runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

RUN apk add --no-cache curl \
    && addgroup -g 1001 -S ophir \
    && adduser  -u 1001 -S ophir -G ophir

WORKDIR /app

# Copy pruned production node_modules and built outputs
COPY --from=builder --chown=ophir:ophir /app/package.json ./package.json
COPY --from=builder --chown=ophir:ophir /app/node_modules ./node_modules

# Preserve workspace directory structure for Node module resolution
COPY --from=builder --chown=ophir:ophir /app/packages/protocol/dist         ./packages/protocol/dist
COPY --from=builder --chown=ophir:ophir /app/packages/protocol/package.json ./packages/protocol/package.json

COPY --from=builder --chown=ophir:ophir /app/packages/sdk/dist              ./packages/sdk/dist
COPY --from=builder --chown=ophir:ophir /app/packages/sdk/package.json      ./packages/sdk/package.json

COPY --from=builder --chown=ophir:ophir /app/packages/router/dist           ./packages/router/dist
COPY --from=builder --chown=ophir:ophir /app/packages/router/package.json   ./packages/router/package.json

COPY --from=builder --chown=ophir:ophir /app/packages/gateway/dist          ./packages/gateway/dist
COPY --from=builder --chown=ophir:ophir /app/packages/gateway/package.json  ./packages/gateway/package.json

# Copy per-package node_modules for workspace symlink resolution
COPY --from=builder --chown=ophir:ophir /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=builder --chown=ophir:ophir /app/packages/sdk/node_modules      ./packages/sdk/node_modules
COPY --from=builder --chown=ophir:ophir /app/packages/router/node_modules   ./packages/router/node_modules
COPY --from=builder --chown=ophir:ophir /app/packages/gateway/node_modules  ./packages/gateway/node_modules

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER ophir

WORKDIR /app/packages/gateway
CMD ["node", "dist/index.js"]
