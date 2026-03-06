import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { OphirError } from '@ophirai/protocol';

/**
 * Express-based JSON-RPC 2.0 server for receiving Ophir negotiation messages.
 * Dispatches incoming requests to registered method handlers.
 */
export class NegotiationServer {
  private app: Express;
  private handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  private server?: Server;
  private boundPort?: number;

  constructor() {
    this.app = express();
    this.app.use(express.json({ limit: '64kb' }));

    this.app.post('/', async (req, res) => {
      if (!req.body || typeof req.body !== 'object') {
        res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: request body must be a JSON object' },
        });
        return;
      }

      const { jsonrpc, method, params, id } = req.body as {
        jsonrpc?: string;
        method?: string;
        params?: unknown;
        id?: string;
      };

      if (jsonrpc !== '2.0') {
        res.json({
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
        });
        return;
      }

      if (!method || typeof method !== 'string') {
        res.json({
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32600, message: 'Invalid Request: method must be a string' },
        });
        return;
      }

      const handler = this.handlers.get(method);
      if (!handler) {
        // Notifications (no id) get no response
        if (id === undefined) {
          res.status(204).end();
          return;
        }
        res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
        return;
      }

      try {
        const result = await handler(params);
        // Notifications get no response
        if (id === undefined) {
          res.status(204).end();
          return;
        }
        res.json({ jsonrpc: '2.0', id, result });
      } catch (err) {
        if (id === undefined) {
          res.status(204).end();
          return;
        }
        if (err instanceof OphirError) {
          res.json({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: err.message,
              data: { ophir_code: err.code, ...err.data },
            },
          });
        } else {
          console.error('Unhandled server error:', err);
          res.json({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: 'Internal server error',
            },
          });
        }
      }
    });
  }

  /** Register an async handler for a JSON-RPC method name.
   * @param method - The JSON-RPC method name to handle (e.g. "ophir.propose")
   * @param handler - Async function that receives params and returns the result
   * @returns void
   * @example
   * ```typescript
   * server.handle('ophir.propose', async (params) => {
   *   return { accepted: true };
   * });
   * ```
   */
  handle(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.handlers.set(method, handler);
  }

  /** Start listening for JSON-RPC requests on the given port.
   * @param port - The TCP port to bind to; pass 0 for an OS-assigned port
   * @returns Resolves when the server is ready to accept connections
   * @example
   * ```typescript
   * const server = new NegotiationServer();
   * await server.listen(3000);
   * console.log('Listening on port', server.getPort());
   * ```
   */
  async listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        if (this.server) {
          const addr = this.server.address();
          if (addr && typeof addr === 'object') {
            this.boundPort = addr.port;
          }
        }
        resolve();
      });
    });
  }

  /** Get the actual bound port (useful when port 0 was passed to listen).
   * @returns The bound port number, or undefined if the server is not listening
   * @example
   * ```typescript
   * await server.listen(0);
   * const port = server.getPort(); // e.g. 49152
   * ```
   */
  getPort(): number | undefined {
    return this.boundPort;
  }

  /** Get the underlying Express app instance for attaching additional routes.
   * @returns The Express application
   */
  getApp(): Express {
    return this.app;
  }

  /** Stop the server and close all connections.
   * @returns Resolves when the server has fully shut down
   * @throws {Error} When the underlying HTTP server fails to close
   * @example
   * ```typescript
   * await server.close();
   * ```
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
