import { BaseProvider } from './base.js';
import type { ProviderConfig, InferenceResult } from './base.js';
import { openaiCompatibleRequest } from './openai-compat.js';

export class OpenRouterProvider extends BaseProvider {
  readonly name = 'openrouter';
  readonly models = [
    { id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)', category: 'inference', inputPrice: 2.50, outputPrice: 10.00 },
    { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (via OpenRouter)', category: 'inference', inputPrice: 3.00, outputPrice: 15.00 },
    { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B (via OpenRouter)', category: 'inference', inputPrice: 0.59, outputPrice: 0.79 },
    { id: 'google/gemini-pro', name: 'Gemini Pro (via OpenRouter)', category: 'inference', inputPrice: 0.125, outputPrice: 0.375 },
    { id: 'mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B (via OpenRouter)', category: 'inference', inputPrice: 0.24, outputPrice: 0.24 },
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
    const apiKey = this.config.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OpenRouter API key required (config.apiKey or OPENROUTER_API_KEY env)');

    const baseUrl = this.config.baseUrl ?? 'https://openrouter.ai/api/v1';
    const result = await openaiCompatibleRequest({
      baseUrl,
      apiKey,
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      providerName: 'OpenRouter',
    });

    this.metrics.record('p99_latency_ms', result.latencyMs);
    return result;
  }
}
