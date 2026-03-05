export { BaseProvider } from './base.js';
export type { ProviderConfig, InferenceResult } from './base.js';
export { openaiCompatibleRequest } from './openai-compat.js';
export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { TogetherProvider } from './together.js';
export { GroqProvider } from './groq.js';
export { OpenRouterProvider } from './openrouter.js';
export { ReplicateProvider } from './replicate.js';
export { dynamicPrice } from './pricing.js';
export type { PricingContext } from './pricing.js';

import type { ProviderConfig } from './base.js';
import { BaseProvider } from './base.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { TogetherProvider } from './together.js';
import { GroqProvider } from './groq.js';
import { OpenRouterProvider } from './openrouter.js';
import { ReplicateProvider } from './replicate.js';

/** All provider classes mapped by name. */
export const PROVIDERS = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  together: TogetherProvider,
  groq: GroqProvider,
  openrouter: OpenRouterProvider,
  replicate: ReplicateProvider,
} as const;

/** Create a provider by name. */
export function createProvider(name: keyof typeof PROVIDERS, config: ProviderConfig): BaseProvider {
  const Provider = PROVIDERS[name];
  return new Provider(config);
}
