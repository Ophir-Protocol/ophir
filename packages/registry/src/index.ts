import express from 'express';
import cors from 'cors';
import { RegistryDB } from './db.js';
import { createAuthMiddleware } from './auth.js';
import { createRouter } from './routes.js';
import { computeReputationScore } from './reputation.js';

export { RegistryDB } from './db.js';
export type { AgentRow, ReputationRow } from './db.js';
export { createAuthMiddleware } from './auth.js';
export type { AuthMiddleware } from './auth.js';
export { createRouter } from './routes.js';
export { computeReputationScore } from './reputation.js';

export interface RegistryServerConfig {
  port?: number;
  dbPath?: string;
  corsOrigin?: string;
  staleCheckInterval?: number;
}

export function createRegistryServer(config?: RegistryServerConfig) {
  const port = config?.port ?? 8420;
  const dbPath = config?.dbPath ?? './ophir-registry.db';
  const corsOrigin = config?.corsOrigin ?? '*';
  const staleCheckInterval = config?.staleCheckInterval ?? 5;

  const db = new RegistryDB(dbPath);
  const app = express();
  const auth = createAuthMiddleware(db);

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  const startTime = Date.now();

  app.get('/health', (_req, res) => {
    const agents = db.findAgents({}).length;
    res.json({
      status: 'healthy',
      agents,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  app.use(createRouter(db, auth));

  let staleTimer: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof app.listen> | undefined;

  const start = (): Promise<void> =>
    new Promise((resolve) => {
      staleTimer = setInterval(() => {
        db.markStaleAgents();
      }, staleCheckInterval * 60 * 1000);

      server = app.listen(port, () => resolve());
    });

  const stop = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (staleTimer) {
        clearInterval(staleTimer);
        staleTimer = undefined;
      }
      if (server) {
        server.close((err) => {
          db.close();
          if (err) reject(err);
          else resolve();
        });
        server = undefined;
      } else {
        db.close();
        resolve();
      }
    });

  return { app, db, start, stop };
}
