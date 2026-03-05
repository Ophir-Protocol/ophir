/**
 * Reads newline-delimited JSON-RPC messages from stdin and dispatches them
 * to a handler function. Writes JSON-RPC responses to stdout.
 *
 * This is the standard MCP transport — no HTTP, no WebSocket, just pipes.
 */

// ── JSON-RPC Types (MCP-specific, not Ophir protocol types) ─────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Stdio Transport ─────────────────────────────────────────────────

export class StdioTransport {
  private handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>;
  private buffer = '';

  constructor(handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>) {
    this.handler = handler;
  }

  /** Start reading from stdin. Call this once to begin the event loop. */
  start(): void {
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  /** Process incoming data, splitting on newlines to handle buffered messages. */
  private async onData(chunk: string): Promise<void> {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? ''; // keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const request = JSON.parse(trimmed) as JsonRpcRequest;
        const response = await this.handler(request);
        if (response) {
          this.send(response);
        }
      } catch {
        this.send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    }
  }

  /** Write a JSON-RPC response to stdout. */
  send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}
