import { OphirError, OphirErrorCode } from '@ophir/protocol';

/** Configuration options for the JSON-RPC HTTP client. */
export interface JsonRpcClientConfig {
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const USER_AGENT = 'ophir-sdk/0.1.0';

/**
 * JSON-RPC 2.0 HTTP client for Ophir agent-to-agent communication.
 * Handles request/response lifecycle, timeouts, and error mapping.
 */
export class JsonRpcClient {
  private timeout: number;

  constructor(config?: JsonRpcClientConfig) {
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Send a JSON-RPC 2.0 request and return the typed result.
   * @param endpoint - The URL of the remote JSON-RPC server
   * @param method - The JSON-RPC method name to invoke
   * @param params - The parameters object to include in the request
   * @param id - Optional request ID; a random UUID is generated if omitted
   * @returns The parsed result field from the JSON-RPC response
   * @throws {OphirError} SELLER_UNREACHABLE on network/timeout/HTTP errors
   * @throws {OphirError} INVALID_MESSAGE on malformed JSON or JSON-RPC error responses
   * @example
   * ```typescript
   * const client = new JsonRpcClient();
   * const result = await client.send<Quote>('https://agent.example/rpc', 'ophir.propose', { terms });
   * ```
   */
  async send<T>(endpoint: string, method: string, params: object, id?: string): Promise<T> {
    if (!endpoint || typeof endpoint !== 'string') {
      throw new OphirError(
        OphirErrorCode.SELLER_UNREACHABLE,
        'Endpoint must be a non-empty string',
      );
    }
    const requestId = id ?? crypto.randomUUID();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: requestId,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OphirError(
          OphirErrorCode.SELLER_UNREACHABLE,
          `Request to ${endpoint} timed out after ${this.timeout}ms`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.SELLER_UNREACHABLE,
        `Network error reaching ${endpoint}: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new OphirError(
        OphirErrorCode.SELLER_UNREACHABLE,
        `HTTP ${response.status} from ${endpoint}`,
        { status: response.status, statusText: response.statusText },
      );
    }

    let json: Record<string, unknown>;
    try {
      json = await response.json() as Record<string, unknown>;
    } catch {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Invalid JSON response from ${endpoint}`,
      );
    }

    // Validate response ID matches request ID to prevent response spoofing
    if (json.id !== undefined && json.id !== requestId) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `JSON-RPC response ID mismatch: expected ${requestId}, got ${String(json.id)}`,
      );
    }

    if (json.error && typeof json.error === 'object') {
      const err = json.error as Record<string, unknown>;
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        (err.message as string) ?? 'JSON-RPC error',
        { code: err.code as number, data: err.data as Record<string, unknown> },
      );
    }

    if (!('result' in json)) {
      throw new OphirError(
        OphirErrorCode.INVALID_MESSAGE,
        `Missing 'result' field in JSON-RPC response from ${endpoint}`,
      );
    }

    return json.result as T;
  }

  /** Send a JSON-RPC 2.0 notification (fire-and-forget, no response expected).
   * @param endpoint - The URL of the remote JSON-RPC server
   * @param method - The JSON-RPC method name to invoke
   * @param params - The parameters object to include in the notification
   * @returns Resolves when the request has been sent
   * @throws {OphirError} SELLER_UNREACHABLE on network or timeout errors
   * @example
   * ```typescript
   * const client = new JsonRpcClient();
   * await client.sendNotification('https://agent.example/rpc', 'ophir.cancel', { agreement_id });
   * ```
   */
  async sendNotification(endpoint: string, method: string, params: object): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OphirError(
          OphirErrorCode.SELLER_UNREACHABLE,
          `Notification to ${endpoint} timed out after ${this.timeout}ms`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new OphirError(
        OphirErrorCode.SELLER_UNREACHABLE,
        `Network error sending notification to ${endpoint}: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
