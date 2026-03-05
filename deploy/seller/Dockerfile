# multi-stage build: builder → runtime
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root config
COPY package.json package-lock.json turbo.json tsconfig.json ./

# Copy only packages needed for live-seller
COPY packages/protocol/ packages/protocol/
COPY packages/sdk/ packages/sdk/
COPY packages/providers/ packages/providers/
COPY packages/live-seller/ packages/live-seller/

# Install deps — use npm install (not ci) since workspace set differs from lockfile
RUN npm install --workspace=packages/protocol --workspace=packages/sdk --workspace=packages/providers --workspace=packages/live-seller

# Build with turbo (respects dependency graph: protocol → sdk → providers → live-seller)
RUN npx turbo run build --filter=@ophirai/live-seller

# --- Runtime stage ---
FROM node:20-alpine AS runtime

WORKDIR /app

# Copy node_modules (resolved workspace deps)
COPY --from=builder /app/node_modules ./node_modules

# Copy built package outputs preserving workspace structure
COPY --from=builder /app/packages/live-seller/dist ./packages/live-seller/dist
COPY --from=builder /app/packages/live-seller/package.json ./packages/live-seller/package.json
COPY --from=builder /app/packages/providers/dist ./packages/providers/dist
COPY --from=builder /app/packages/providers/package.json ./packages/providers/package.json
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/sdk/package.json ./packages/sdk/package.json

# Copy root package.json so Node resolves workspaces correctly
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV SELLER_PORT=8422
EXPOSE 8422

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8422/health || exit 1

WORKDIR /app/packages/live-seller
CMD ["node", "dist/index.js"]
