#!/usr/bin/env node
import { createRouterServer } from './server.js';
import type { RoutingStrategy } from './strategies.js';

const port = parseInt(process.env.PORT ?? '8421', 10);
const strategy = (process.env.OPHIR_STRATEGY ?? 'cheapest') as RoutingStrategy;
const registryUrl = process.env.OPHIR_REGISTRY_URL;
const maxBudget = process.env.OPHIR_MAX_BUDGET ?? '1.00';
const sellersEnv = process.env.OPHIR_SELLERS;

const registries = registryUrl ? [registryUrl] : undefined;
const sellers = sellersEnv ? sellersEnv.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

const { start } = createRouterServer({
  port,
  strategy,
  registries,
  sellers,
  maxBudget,
});

start().then(() => {
  console.log(`Ophir Router listening on port ${port} (strategy: ${strategy})`);
}).catch((err) => {
  console.error('Failed to start Ophir Router:', err);
  process.exit(1);
});
