import { BaseProvider } from './base.js';
import type { ProviderConfig, InferenceResult } from './base.js';
import { openaiCompatibleRequest } from './openai-compat.js';

export class TogetherProvider extends BaseProvider {
  readonly name = 'together';
  readonly models = [
    { id: 'meta-llama/Llama-3-70b-chat-hf', name: 'Llama 3 70B', category: 'inference', inputPrice: 0.90, outputPrice: 0.90 },
    { id: 'meta-llama/Llama-3-8b-chat-hf', name: 'Llama 3 8B', category: 'inference', inputPrice: 0.20, outputPrice: 0.20 },
    { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B', category: 'inference', inputPrice: 0.60, outputPrice: 0.60 },
    { id: 'togethercomputer/m2-bert-80M-8k-retrieval', name: 'M2 BERT Retrieval', category: 'embedding', inputPrice: 0.008, outputPrice: 0 },
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
    const apiKey = this.config.apiKey ?? process.env.TOGETHER_API_KEY;
    if (!apiKey) throw new Error('Together API key required (config.apiKey or TOGETHER_API_KEY env)');

    const baseUrl = this.config.baseUrl ?? 'https://api.together.xyz/v1';
    const result = await openaiCompatibleRequest({
      baseUrl,
      apiKey,
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.max_tokens,
      providerName: 'Together',
    });

    this.metrics.record('p99_latency_ms', result.latencyMs);
    return result;
  }
}
