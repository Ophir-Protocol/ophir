import express from 'express';
import cors from 'cors';
import { OphirRouter } from './router.js';
import type { RouterConfig } from './router.js';
import { createRouterAPI } from './api.js';

export interface RouterServerConfig extends RouterConfig {
  port?: number;
}

export function createRouterServer(config?: RouterServerConfig) {
  const { port = 8421, ...routerConfig } = config ?? {};

  const router = new OphirRouter(routerConfig);
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(createRouterAPI(router));

  let server: ReturnType<typeof app.listen> | null = null;

  return {
    app,
    router,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server = app.listen(port, () => resolve());
        server.on('error', reject);
      });
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    },
  };
}
