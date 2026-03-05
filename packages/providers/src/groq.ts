import { BaseProvider } from './base.js';
import type { ProviderConfig, InferenceResult } from './base.js';
import { openaiCompatibleRequest } from './openai-compat.js';

export class GroqProvider extends BaseProvider {
  readonly name = 'groq';
  readonly models = [
    { id: 'llama3-70b-8192', name: 'Llama 3 70B (Groq)', category: 'inference', inputPrice: 0.59, outputPrice: 0.79 },
    { id: 'llama3-8b-8192', name: 'Llama 3 8B (Groq)', category: 'inference', inputPrice: 0.05, outputPrice: 0.08 },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B (Groq)', category: 'inference', inputPrice: 0.24, outputPrice: 0.24 },
    { id: 'gemma-7b-it', name: 'Gemma 7B (Groq)', category: 'inference', inputPrice: 0.07, outputPrice: 0.07 },
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
    const apiKey = this.config.apiKey ?? process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('Groq API key required (config.apiKey or GROQ_API_KEY env)');

    const baseUrl = this.config.baseUrl ?? 'https://api.groq.com/openai/v1';
    const result = await openaiCompatibleRequest({
      baseUrl,
      apiKey,
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      providerName: 'Groq',
    });

    this.metrics.record('p99_latency_ms', result.latencyMs);
    return result;
  }
}
