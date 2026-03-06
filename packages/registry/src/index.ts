import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
  rateLimitMax?: number;
}

export function createRegistryServer(config?: RegistryServerConfig) {
  const port = config?.port ?? 8420;
  const dbPath = config?.dbPath ?? './ophir-registry.db';
  const corsOrigin = config?.corsOrigin ?? 'https://ophirai.com';
  const staleCheckInterval = config?.staleCheckInterval ?? 5;
  const rateLimitMax = config?.rateLimitMax ?? 100;

  const db = new RegistryDB(dbPath);
  const app = express();
  const auth = createAuthMiddleware(db);

  app.use(helmet());
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '16kb' }));

  // Global rate limit: 100 requests per minute per IP
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // Stricter limit for challenge endpoint: 10 per minute per IP
  app.use('/auth/challenge', rateLimit({
    windowMs: 60 * 1000,
    max: Math.max(10, Math.ceil(rateLimitMax / 10)),
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // Stricter limit for reputation endpoint: 20 per minute per IP
  app.use('/reputation', rateLimit({
    windowMs: 60 * 1000,
    max: Math.max(20, Math.ceil(rateLimitMax / 5)),
    standardHeaders: true,
    legacyHeaders: false,
  }));

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
