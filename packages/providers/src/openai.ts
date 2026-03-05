import { BaseProvider } from './base.js';
import type { ProviderConfig, InferenceResult } from './base.js';

interface OpenAIChatMessage {
  role: string;
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream: false;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIErrorResponse {
  error: { message: string; type: string; code: string | null };
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  readonly models = [
    { id: 'gpt-4o', name: 'GPT-4o', category: 'inference', inputPrice: 2.50, outputPrice: 10.00 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', category: 'inference', inputPrice: 0.15, outputPrice: 0.60 },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', category: 'inference', inputPrice: 0.50, outputPrice: 1.50 },
    { id: 'text-embedding-3-large', name: 'Embedding 3 Large', category: 'embedding', inputPrice: 0.13, outputPrice: 0 },
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
    const apiKey = this.config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAI API key required (config.apiKey or OPENAI_API_KEY env)');

    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const body: OpenAIChatRequest = {
      model: params.model,
      messages: params.messages,
      stream: false,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.max_tokens !== undefined && { max_tokens: params.max_tokens }),
    };

    const start = performance.now();
    const response = await this.fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const latencyMs = performance.now() - start;

    if (!response.ok) {
      const err = (await response.json()) as OpenAIErrorResponse;
      throw new Error(`OpenAI API error (${response.status}): ${err.error?.message ?? response.statusText}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    this.metrics.record('p99_latency_ms', latencyMs);

    return {
      content: data.choices[0]?.message?.content ?? '',
      model: data.model,
      usage: data.usage,
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
