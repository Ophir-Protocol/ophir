import { BaseProvider } from './base.js';
import type { ProviderConfig, InferenceResult } from './base.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  stream: false;
}

interface AnthropicResponse {
  id: string;
  type: string;
  model: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicErrorResponse {
  type: string;
  error: { type: string; message: string };
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  readonly models = [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', category: 'inference', inputPrice: 3.00, outputPrice: 15.00 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', category: 'inference', inputPrice: 0.80, outputPrice: 4.00 },
  ];

  constructor(config: ProviderConfig = {}) {
    super(config);
  }

  async executeInference(params: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
  }): Promise<InferenceResult> {
    const apiKey = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Anthropic API key required (config.apiKey or ANTHROPIC_API_KEY env)');

    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com/v1';

    // Extract system message and convert to Anthropic format
    let system: string | undefined;
    const messages: AnthropicMessage[] = [];
    for (const msg of params.messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else {
        messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }

    const body: AnthropicRequest = {
      model: params.model,
      messages,
      max_tokens: params.max_tokens ?? 4096,
      stream: false,
      ...(system && { system }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    };

    const start = performance.now();
    const response = await this.fetchWithRetry(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const latencyMs = performance.now() - start;

    if (!response.ok) {
      const err = (await response.json()) as AnthropicErrorResponse;
      throw new Error(`Anthropic API error (${response.status}): ${err.error?.message ?? response.statusText}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const content = data.content.find((c) => c.type === 'text')?.text ?? '';

    this.metrics.record('p99_latency_ms', latencyMs);

    return {
      content,
      model: data.model,
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      latencyMs,
      raw: data,
    };
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    maxRetries = 3,
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, init);
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = response.headers.get('retry-after');
        const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs));
        lastError = new Error(`Rate limited (attempt ${attempt + 1})`);
        continue;
      }
      return response;
    }
    throw lastError ?? new Error('Max retries exceeded');
  }
}
