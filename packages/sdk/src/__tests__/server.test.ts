import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { NegotiationServer } from '../server.js';
import { OphirError, OphirErrorCode } from '@ophirai/protocol';

function jsonrpcRequest(url: string, body: Record<string, unknown>) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('NegotiationServer', () => {
  let server: NegotiationServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new NegotiationServer();
  });

  afterEach(async () => {
    await server.close();
  });

  async function startServer(): Promise<string> {
    await server.listen(0);
    const port = server.getPort()!;
    return `http://localhost:${port}`;
  }

  // 1. Returns -32600 for invalid jsonrpc version
  it('returns -32600 for invalid jsonrpc version', async () => {
    baseUrl = await startServer();
    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '1.0',
      method: 'test',
      id: 1,
    });
    const json = await res.json();

    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
    });
  });

  // 2. Returns -32601 for unknown method
  it('returns -32601 for unknown method', async () => {
    baseUrl = await startServer();
    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'nonexistent',
      id: 42,
    });
    const json = await res.json();

    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32601, message: 'Method not found: nonexistent' },
    });
  });

  // 3. Returns 204 for notifications (no id) with unknown method
  it('returns 204 for notification with unknown method', async () => {
    baseUrl = await startServer();
    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'nonexistent',
    });

    expect(res.status).toBe(204);
    const body = await res.text();
    expect(body).toBe('');
  });

  // 4. Returns 204 for notifications with known method
  it('returns 204 for notification with known method', async () => {
    baseUrl = await startServer();
    server.handle('ping', async () => 'pong');

    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'ping',
    });

    expect(res.status).toBe(204);
    const body = await res.text();
    expect(body).toBe('');
  });

  // 5. Returns result for valid request with handler
  it('returns result for valid request with handler', async () => {
    server.handle('add', async (params) => {
      const { a, b } = params as { a: number; b: number };
      return a + b;
    });
    baseUrl = await startServer();

    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'add',
      params: { a: 3, b: 7 },
      id: 1,
    });
    const json = await res.json();

    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: 10,
    });
  });

  // 6. Returns OphirError with code -32000 when handler throws OphirError
  it('returns -32000 with OphirError code when handler throws OphirError', async () => {
    server.handle('fail', async () => {
      throw new OphirError(OphirErrorCode.INVALID_MESSAGE, 'bad message');
    });
    baseUrl = await startServer();

    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'fail',
      id: 5,
    });
    const json = await res.json();

    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: {
        code: -32000,
        message: 'bad message',
        data: { ophir_code: OphirErrorCode.INVALID_MESSAGE },
      },
    });
  });

  // 7. Returns generic error with code -32603 when handler throws non-OphirError
  it('returns -32603 when handler throws a generic Error', async () => {
    server.handle('boom', async () => {
      throw new Error('something broke');
    });
    baseUrl = await startServer();

    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'boom',
      id: 6,
    });
    const json = await res.json();

    expect(json).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: {
        code: -32603,
        message: 'something broke',
        data: undefined,
      },
    });
  });

  // 8. handle() registers method handlers
  it('handle() registers method handlers that are callable', async () => {
    server.handle('echo', async (params) => params);
    baseUrl = await startServer();

    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'echo',
      params: { hello: 'world' },
      id: 1,
    });
    const json = await res.json();

    expect(json.result).toEqual({ hello: 'world' });
  });

  // 9. getPort() returns the bound port after listen
  it('getPort() returns the bound port after listen', async () => {
    await server.listen(0);
    const port = server.getPort();

    expect(port).toBeDefined();
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
  });

  // 10. getPort() returns undefined before listen
  it('getPort() returns undefined before listen', () => {
    expect(server.getPort()).toBeUndefined();
  });

  // 11. close() resolves when server not started
  it('close() resolves when server not started', async () => {
    await expect(server.close()).resolves.toBeUndefined();
  });

  // 12. close() stops the server
  it('close() stops the server', async () => {
    baseUrl = await startServer();

    // Verify server is running
    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '2.0',
      method: 'ping',
      id: 1,
    });
    expect(res.status).toBe(200);

    await server.close();

    // Prevent afterEach from double-closing (which would throw "Server is not running")
    server = new NegotiationServer();

    // Verify server is stopped — fetch should reject
    try {
      await jsonrpcRequest(baseUrl, {
        jsonrpc: '2.0',
        method: 'ping',
        id: 2,
      });
      expect.fail('Request should have failed after server close');
    } catch {
      // Expected — connection refused or similar error
    }
  });

  // 13. Returns null id when jsonrpc is wrong and no id provided
  it('returns null id when jsonrpc is invalid and no id provided', async () => {
    baseUrl = await startServer();
    const res = await jsonrpcRequest(baseUrl, {
      jsonrpc: '1.0',
      method: 'test',
    });
    const json = await res.json();

    expect(json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
    });
  });

  // 14. Multiple handlers can be registered
  it('multiple handlers can be registered and dispatched independently', async () => {
    server.handle('greet', async (params) => {
      const { name } = params as { name: string };
      return `Hello, ${name}`;
    });
    server.handle('multiply', async (params) => {
      const { x, y } = params as { x: number; y: number };
      return x * y;
    });
    baseUrl = await startServer();

    const [greetRes, multiplyRes] = await Promise.all([
      jsonrpcRequest(baseUrl, {
        jsonrpc: '2.0',
        method: 'greet',
        params: { name: 'Ophir' },
        id: 1,
      }).then((r) => r.json()),
      jsonrpcRequest(baseUrl, {
        jsonrpc: '2.0',
        method: 'multiply',
        params: { x: 4, y: 5 },
        id: 2,
      }).then((r) => r.json()),
    ]);

    expect(greetRes.result).toBe('Hello, Ophir');
    expect(multiplyRes.result).toBe(20);
  });
});
