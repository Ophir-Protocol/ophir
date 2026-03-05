# multi-stage build: builder → runtime
FROM node:20-alpine AS builder

# better-sqlite3 needs native build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root config
COPY package.json package-lock.json turbo.json tsconfig.json ./

# Copy only packages needed for registry
COPY packages/protocol/ packages/protocol/
COPY packages/sdk/ packages/sdk/
COPY packages/registry/ packages/registry/

# Install deps — use npm install (not ci) since workspace set differs from lockfile
RUN npm install --workspace=packages/protocol --workspace=packages/sdk --workspace=packages/registry

# Build with turbo (respects dependency graph: protocol → sdk → registry)
RUN npx turbo run build --filter=@ophirai/registry

# --- Runtime stage ---
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy the full node_modules (includes native better-sqlite3 bindings + resolved workspace deps)
COPY --from=builder /app/node_modules ./node_modules

# Copy built package outputs preserving workspace structure
COPY --from=builder /app/packages/registry/dist ./packages/registry/dist
COPY --from=builder /app/packages/registry/package.json ./packages/registry/package.json
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/package.json

# Copy root package.json so Node resolves workspaces correctly
COPY --from=builder /app/package.json ./package.json

# SQLite data volume
VOLUME /data
ENV DB_PATH=/data/ophir-registry.db
ENV NODE_ENV=production
ENV PORT=8420
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8420/health || exit 1

WORKDIR /app/packages/registry
CMD ["node", "dist/bin.js"]
