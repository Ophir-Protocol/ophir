# multi-stage build: builder → runtime
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root config
COPY package.json package-lock.json turbo.json tsconfig.json ./

# Copy only packages needed for gateway
COPY packages/protocol/ packages/protocol/
COPY packages/sdk/ packages/sdk/
COPY packages/router/ packages/router/
COPY packages/gateway/ packages/gateway/

# Install deps
RUN npm install --workspace=packages/protocol --workspace=packages/sdk --workspace=packages/router --workspace=packages/gateway

# Build with turbo (respects dependency graph: protocol → sdk → router → gateway)
RUN npx turbo run build --filter=@ophirai/gateway

# --- Runtime stage ---
FROM node:20-alpine AS runtime

RUN apk add --no-cache curl \
    && addgroup -g 1001 -S ophir \
    && adduser  -u 1001 -S ophir -G ophir

WORKDIR /app

# Copy node_modules (resolved workspace deps)
COPY --from=builder /app/node_modules ./node_modules

# Copy built package outputs preserving workspace structure
COPY --from=builder --chown=ophir:ophir /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=builder --chown=ophir:ophir /app/packages/gateway/package.json ./packages/gateway/package.json
COPY --from=builder --chown=ophir:ophir /app/packages/router/dist ./packages/router/dist
COPY --from=builder --chown=ophir:ophir /app/packages/router/package.json ./packages/router/package.json
COPY --from=builder --chown=ophir:ophir /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder --chown=ophir:ophir /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder --chown=ophir:ophir /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder --chown=ophir:ophir /app/packages/sdk/package.json ./packages/sdk/package.json

# Copy root package.json so Node resolves workspaces correctly
COPY --from=builder --chown=ophir:ophir /app/package.json ./package.json

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1

USER ophir

WORKDIR /app/packages/gateway
CMD ["node", "dist/index.js"]
